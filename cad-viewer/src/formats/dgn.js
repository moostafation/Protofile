// MicroStation DGN V7 (Intergraph ISFF) reader. Produces the same DwgDatabase-like
// object as the DXF parser, so drawing, tessellation, measuring, search and plotting
// work unchanged. Levels become layers "Level n", cells become block references.
//
// Layout notes (see GDAL's dgnlib): every element starts with a 36-byte header
// (level/type, size, range, graphic group, attribute offset, properties, symbology);
// 32-bit integers use VAX word order and reals are VAX D-floats. Coordinates are
// integer UORs, converted to master units with the TCB (type 9) settings.
import { FormatError } from './errors.js';

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;

const int32 = (b, o) => (b[o + 2] | (b[o + 3] << 8) | (b[o] << 16) | (b[o + 1] << 24));
const u16 = (b, o) => b[o] | (b[o + 1] << 8);

/** VAX D-float (8 bytes) to a JS number. */
export function vaxDouble(b, o) {
  const hi = ((b[o + 1] << 24) | (b[o] << 16) | (b[o + 3] << 8) | b[o + 2]) >>> 0;
  const lo = ((b[o + 5] << 24) | (b[o + 4] << 16) | (b[o + 7] << 8) | b[o + 6]) >>> 0;
  const exp = (hi >>> 23) & 0xff;
  if (!exp) return 0;
  const mant = 1 + ((hi & 0x7fffff) * 4294967296 + lo) / 2 ** 55;
  return (hi >>> 31 ? -1 : 1) * mant * 2 ** (exp - 129);
}

const RAD50 = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ$. 0123456789';
function rad50(v) {
  return RAD50[Math.floor(v / 1600) % 40] + RAD50[Math.floor(v / 40) % 40] + RAD50[v % 40];
}

// MicroStation's default colour table (used when the file has none): 16 fixed colours,
// then white/blue/green/red/yellow/magenta/orange/cyan in 15 darkening steps.
function defaultPalette() {
  const pal = [
    0xffffff, 0x0000ff, 0x00ff00, 0xff0000, 0xffff00, 0xff00ff, 0xff7f00, 0x00ffff,
    0x404040, 0xc0c0c0, 0xfe0060, 0xa0e000, 0x00fea0, 0x8000a0, 0xb0b0b0, 0x00f0f0,
  ];
  for (let k = 0; k < 238; k++) {
    const step = Math.floor((k + 1) / 16);
    const v = 240 - 15 * step, o = 122 - 5 * step;
    const rgb = [[v, v, v], [0, 0, v], [0, v, 0], [v, 0, 0], [v, v, 0], [v, 0, v], [v, o, 0], [0, v, v]][k % 8];
    pal.push((rgb[0] << 16) | (rgb[1] << 8) | rgb[2]);
  }
  pal.push(0xc0c0c0, 0x1c0064);
  return pal;
}

// Line styles 0-7 are display styles; patterns are in "dash units" (a fraction of the drawing size).
const STYLE_PATTERNS = {
  1: [0, -1.5], 2: [4, -2], 3: [8, -2], 4: [6, -1.5, 0, -1.5],
  5: [2, -1.5], 6: [6, -1.5, 0, -1.5, 0, -1.5], 7: [8, -1.5, 3, -1.5],
};

const UNIT_CODES = { M: 6, MM: 4, CM: 5, KM: 7, FT: 2, "'": 2, IN: 1, '"': 1, MI: 3, YD: 10, DM: 14 };

// Graphic element types that are recognised but not drawn (reported as warnings).
const UNSUPPORTED = { 23: 'DGN_CONE', 24: 'DGN_BSPLINE_SURFACE', 33: 'DGN_DIM', 34: 'DGN_SHARED_CELL_DEFN', 35: 'DGN_SHARED_CELL', 36: 'DGN_MULTILINE', 37: 'DGN_TAG', 87: 'DGN_RASTER', 88: 'DGN_RASTER' };

export function isDgnV8(bytes) {
  return bytes.length >= 4 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;
}

/** True when the bytes look like a DGN V7 design file (or cell library). */
export function isDgnV7(bytes) {
  if (bytes.length < 4) return false;
  if (bytes[0] === 0x08 && bytes[1] === 0x05 && bytes[2] === 0x17 && bytes[3] === 0x00) return true;
  return (bytes[0] === 0x08 || bytes[0] === 0xc8) && bytes[1] === 0x09 && bytes[2] === 0xfe && bytes[3] === 0x02;
}

/** Splits the file into element records. */
function scanElements(b) {
  const out = [];
  let pos = 0;
  while (pos + 4 <= b.length) {
    if (b[pos] === 0xff && b[pos + 1] === 0xff) break; // end of design
    const size = u16(b, pos + 2) * 2 + 4;
    if (pos + size > b.length) break; // truncated file: keep what was read
    out.push({ off: pos, size, level: b[pos] & 0x3f, complex: (b[pos] & 0x80) !== 0, type: b[pos + 1] & 0x7f, deleted: (b[pos + 1] & 0x80) !== 0 });
    pos += size;
  }
  return out;
}

class DgnReader {
  constructor(bytes) {
    this.b = bytes;
    this.dim = bytes[0] === 0xc8 ? 3 : 2;
    this.scale = 1;
    this.origin = [0, 0, 0];
    this.palette = defaultPalette();
    this.layers = new Map();
    this.blocks = [];
    this.styles = new Set();
    this.ext = [Infinity, Infinity, -Infinity, -Infinity];
    this.unitCode = 0;
    this.unitName = '';
    this.cellSeq = 0;
  }

  // ---------- file settings ----------
  readTcb(el) {
    const b = this.b, o = el.off;
    if (el.size < 1264) return;
    if (b[o + 1214] & 0x40) this.dim = 3;
    const uorPerSub = int32(b, o + 1112), subPerMaster = int32(b, o + 1116);
    const div = uorPerSub > 0 && subPerMaster > 0 ? uorPerSub * subPerMaster : 1;
    this.scale = 1 / div;
    this.origin = [vaxDouble(b, o + 1240) / div, vaxDouble(b, o + 1248) / div, vaxDouble(b, o + 1256) / div];
    if (!this.origin.every(Number.isFinite)) this.origin = [0, 0, 0];
    const name = String.fromCharCode(b[o + 1120], b[o + 1121]).replace(/[^\x20-\x7e]/g, '').trim();
    this.unitName = name;
    this.unitCode = UNIT_CODES[name.toUpperCase()] ?? 0;
  }

  readColorTable(el) {
    const b = this.b, o = el.off;
    if (el.size < 806) return;
    const rgb = (k) => (b[k] << 16) | (b[k + 1] << 8) | b[k + 2];
    this.palette[255] = rgb(o + 38);
    for (let i = 0; i < 255; i++) this.palette[i] = rgb(o + 41 + i * 3);
  }

  // ---------- coordinates ----------
  pt(x, y, z = 0) {
    const p = { x: x * this.scale - this.origin[0], y: y * this.scale - this.origin[1], z: this.dim === 3 ? z * this.scale - this.origin[2] : 0 };
    this.grow(p.x, p.y);
    return p;
  }

  /** Tracks the drawing extents (master units). */
  grow(x, y) {
    const e = this.ext;
    if (x < e[0]) e[0] = x;
    if (y < e[1]) e[1] = y;
    if (x > e[2]) e[2] = x;
    if (y > e[3]) e[3] = y;
  }

  intPoint(o) {
    const b = this.b;
    return this.dim === 3 ? this.pt(int32(b, o), int32(b, o + 4), int32(b, o + 8)) : this.pt(int32(b, o), int32(b, o + 4));
  }

  realPoint(o) {
    const b = this.b;
    return this.dim === 3
      ? this.pt(vaxDouble(b, o), vaxDouble(b, o + 8), vaxDouble(b, o + 16))
      : this.pt(vaxDouble(b, o), vaxDouble(b, o + 8));
  }

  /** Vertex list (count word followed by points), clamped to the element size. */
  vertices(el) {
    const b = this.b, o = el.off;
    const step = this.dim * 4;
    const n = Math.min(u16(b, o + 36), Math.floor((el.size - 38) / step));
    const out = [];
    for (let i = 0; i < n; i++) out.push(this.intPoint(o + 38 + i * step));
    return out;
  }

  /**
   * Rotation matrix (local -> world, row-major 3x3) from a stored quaternion (w, x, y, z).
   * The file stores the inverse rotation (GDAL writes angle θ as the quaternion of -θ),
   * hence the transposed matrix.
   */
  quatMatrix(o) {
    const b = this.b;
    const w = int32(b, o) / 2 ** 31, x = int32(b, o + 4) / 2 ** 31, y = int32(b, o + 8) / 2 ** 31, z = int32(b, o + 12) / 2 ** 31;
    return [
      w * w + x * x - y * y - z * z, 2 * (x * y + z * w), 2 * (x * z - y * w),
      2 * (x * y - z * w), w * w - x * x + y * y - z * z, 2 * (y * z + x * w),
      2 * (x * z + y * w), 2 * (y * z - x * w), w * w - x * x - y * y + z * z,
    ];
  }

  // ---------- entity helpers ----------
  base(el, type) {
    const b = this.b, o = el.off;
    const layer = `Level ${el.level}`;
    if (!this.layers.has(layer)) this.layers.set(layer, el.level);
    const e = { type, handle: (o / 2).toString(16).toUpperCase(), layer, colorIndex: 256, lineweight: -1, lineTypeScale: 1, isVisible: true };
    if (el.size >= 36) {
      const sym = b[o + 34];
      const style = sym & 7, weight = sym >> 3;
      e.color = this.palette[b[o + 35]] ?? 0xffffff;
      e.dgnColor = b[o + 35];
      // Weight 0 is the thinnest line; each step adds roughly 0.12 mm on paper.
      e.lineweight = weight ? Math.round((0.13 + 0.12 * weight) * 100) : -3;
      if (style) { e.lineType = `DGN_STYLE_${style}`; this.styles.add(style); }
    }
    return e;
  }

  /** Fill colour from a shape-fill attribute linkage (user data 0x0041), or null. */
  fillColor(el) {
    const b = this.b, o = el.off;
    if (el.size < 36) return null;
    let k = o + 32 + u16(b, o + 30) * 2;
    const end = o + el.size;
    while (k + 4 <= end) {
      let size;
      if (b[k] === 0 && (b[k + 1] === 0 || b[k + 1] === 0x80)) size = 8; // DMRS database linkage
      else if (b[k + 1] & 0x10) size = b[k] * 2 + 2;
      else break;
      if (size <= 4 || k + size > end) break;
      if (size >= 9 && u16(b, k + 2) === 0x41) return this.palette[b[k + 8]] ?? null;
      k += size;
    }
    return null;
  }

  // ---------- element conversion ----------
  /** Arc / ellipse geometry: { origin, a, b, rot (deg), start, sweep (deg), m (3D matrix) }. */
  conic(el, isArc) {
    const b = this.b, o = el.off;
    let start = 0, sweep = 360, p = o + 36;
    if (isArc) {
      start = int32(b, o + 36) / 360000;
      const neg = b[o + 41] & 0x80;
      const raw = (b[o + 42] | (b[o + 43] << 8) | (b[o + 40] << 16) | ((b[o + 41] & 0x7f) << 24));
      sweep = (neg ? -raw : raw) / 360000;
      if (sweep === 0) sweep = 360;
      p = o + 44;
    }
    const a = vaxDouble(b, p) * this.scale, bb = vaxDouble(b, p + 8) * this.scale;
    let rot = 0, origin, m = null;
    if (this.dim === 2) {
      rot = int32(b, p + 16) / 360000;
      origin = this.pt(vaxDouble(b, p + 20), vaxDouble(b, p + 28));
    } else {
      m = this.quatMatrix(p + 16);
      origin = this.realPoint(p + 32);
      rot = Math.atan2(m[3], m[0]) / DEG;
    }
    const r = Math.max(a, bb);
    if (Number.isFinite(r)) { this.grow(origin.x - r, origin.y - r); this.grow(origin.x + r, origin.y + r); }
    return { origin, a, b: bb, rot, start, sweep, m };
  }

  conicEntity(el, isArc) {
    const c = this.conic(el, isArc);
    if (!(c.a > 0) || !(c.b > 0) || !Number.isFinite(c.origin.x)) return null;
    const full = Math.abs(c.sweep) >= 360 - 1e-9;
    // A 3D conic that is not parallel to the XY plane is drawn as its plan projection.
    if (c.m && (Math.abs(c.m[6]) > 1e-6 || Math.abs(c.m[7]) > 1e-6)) {
      const pts = conicPoints(c, 96);
      const e = this.base(el, 'LWPOLYLINE');
      e.vertices = pts.map(([x, y]) => ({ x, y, bulge: 0 }));
      if (full) e.vertices.pop();
      e.flag = full ? 1 : 0;
      return e;
    }
    // Mirrored 3D planes (normal pointing down) flip the sweep direction.
    const flip = c.m && c.m[8] < 0 ? -1 : 1;
    let s0 = c.start * flip, sw = c.sweep * flip;
    if (sw < 0) { s0 += sw; sw = -sw; }
    const rot = c.rot;
    if (Math.abs(c.a - c.b) <= 1e-9 * Math.max(c.a, c.b)) {
      const e = this.base(el, full ? 'CIRCLE' : 'ARC');
      e.center = c.origin;
      e.radius = c.a;
      if (!full) { e.startAngle = (s0 + rot) * DEG; e.endAngle = (s0 + sw + rot) * DEG; }
      return e;
    }
    const e = this.base(el, 'ELLIPSE');
    e.center = c.origin;
    let t0 = s0 * DEG, t1 = (s0 + sw) * DEG;
    if (c.a >= c.b) {
      e.majorAxisEndPoint = { x: c.a * Math.cos(rot * DEG), y: c.a * Math.sin(rot * DEG), z: 0 };
      e.axisRatio = c.b / c.a;
    } else {
      // Secondary axis is the longer one: rotate the parameter by 90°.
      e.majorAxisEndPoint = { x: -c.b * Math.sin(rot * DEG), y: c.b * Math.cos(rot * DEG), z: 0 };
      e.axisRatio = c.a / c.b;
      t0 -= Math.PI / 2; t1 -= Math.PI / 2;
    }
    e.startAngle = full ? 0 : t0;
    e.endAngle = full ? TAU : t1;
    return e;
  }

  textEntity(el) {
    const b = this.b, o = el.off;
    const font = b[o + 36];
    const lengthMult = int32(b, o + 38) * this.scale * 6 / 1000;
    const heightMult = int32(b, o + 42) * this.scale * 6 / 1000;
    let rot, origin, n, textOff;
    if (this.dim === 2) {
      rot = int32(b, o + 46) / 360000 * DEG;
      origin = this.pt(int32(b, o + 50), int32(b, o + 54));
      n = b[o + 58];
      textOff = o + 60;
    } else {
      const m = this.quatMatrix(o + 46);
      rot = Math.atan2(m[3], m[0]);
      origin = this.pt(int32(b, o + 62), int32(b, o + 66), int32(b, o + 70));
      n = b[o + 74];
      textOff = o + 76;
    }
    n = Math.max(0, Math.min(n, o + el.size - textOff));
    const text = decodeText(b.subarray(textOff, textOff + n));
    if (!text.trim() || !(heightMult > 0)) return null;
    const e = this.base(el, 'TEXT');
    // The stored origin is the lower-left corner of the text whatever its justification.
    Object.assign(e, {
      text, textHeight: heightMult, rotation: rot, xScale: lengthMult > 0 ? lengthMult / heightMult : 1,
      halign: 0, valign: 0, startPoint: origin, endPoint: { x: 0, y: 0, z: 0 }, styleName: `font ${font}`,
    });
    return e;
  }

  /** Points of a member of a complex chain/shape, in order. */
  memberPoints(el) {
    switch (el.type) {
      case 3: return [this.intPoint(el.off + 36), this.intPoint(el.off + 36 + this.dim * 4)].map((p) => [p.x, p.y]);
      case 4: case 6: return this.vertices(el).map((p) => [p.x, p.y]);
      case 11: return curvePoints(this.vertices(el));
      case 15: case 16: {
        const c = this.conic(el, el.type === 16);
        return c.a > 0 && c.b > 0 ? conicPoints(c, 48) : [];
      }
      default: return [];
    }
  }

  // ---------- main walk ----------
  /** Converts elements from index `i`, appending entities to `out`. Returns the next index. */
  convert(els, i, out, depth = 0) {
    const el = els[i];
    const next = i + 1;
    if (el.deleted) return next;
    const b = this.b, o = el.off;
    switch (el.type) {
      case 3: {
        const p0 = this.intPoint(o + 36), p1 = this.intPoint(o + 36 + this.dim * 4);
        if (p0.x === p1.x && p0.y === p1.y) {
          const e = this.base(el, 'POINT');
          e.position = p0;
          out.push(e);
        } else {
          const e = this.base(el, 'LINE');
          e.startPoint = p0;
          e.endPoint = p1;
          out.push(e);
        }
        return next;
      }
      case 4: case 6: case 22: {
        const v = this.vertices(el);
        if (!v.length) return next;
        if (el.type === 22 || v.every((p) => p.x === v[0].x && p.y === v[0].y)) {
          for (const p of el.type === 22 ? v : [v[0]]) {
            const e = this.base(el, 'POINT');
            e.position = p;
            out.push(e);
          }
          return next;
        }
        const closed = el.type === 6;
        if (closed && v.length > 2 && v[0].x === v[v.length - 1].x && v[0].y === v[v.length - 1].y) v.pop();
        const pts = v.map((p) => [p.x, p.y]);
        if (closed) this.pushFill(el, out, pts);
        out.push(this.polyline(el, pts, closed));
        return next;
      }
      case 11: {
        const v = this.vertices(el);
        if (v.length < 2) return next;
        const e = this.base(el, 'SPLINE');
        // The first and last two vertices only define the end tangents.
        const fit = v.length > 4 ? v.slice(2, -2) : v;
        Object.assign(e, { controlPoints: [], fitPoints: fit, knots: [], weights: [], degree: 3, flag: 0 });
        out.push(e);
        return next;
      }
      case 12: case 14: {
        const count = u16(b, o + 38);
        const pts = [];
        let j = next;
        for (let k = 0; k < count && j < els.length && els[j].complex; k++, j++) {
          if (els[j].deleted) continue;
          for (const p of this.memberPoints(els[j])) {
            const last = pts[pts.length - 1];
            if (!last || Math.abs(last[0] - p[0]) > 1e-12 || Math.abs(last[1] - p[1]) > 1e-12) pts.push(p);
          }
        }
        const closed = el.type === 14;
        if (closed && pts.length > 2) {
          const [f, l] = [pts[0], pts[pts.length - 1]];
          if (Math.abs(f[0] - l[0]) < 1e-9 && Math.abs(f[1] - l[1]) < 1e-9) pts.pop();
        }
        if (pts.length >= 2) {
          if (closed) this.pushFill(el, out, pts);
          out.push(this.polyline(el, pts, closed));
        }
        return j;
      }
      case 15: case 16: {
        const e = this.conicEntity(el, el.type === 16);
        if (e) {
          if (el.type === 15) {
            const fill = this.fillColor(el);
            if (fill !== null) out.push(this.hatch(el, [conicPoints(this.conic(el, false), 96)], fill));
          }
          out.push(e);
        }
        return next;
      }
      case 17: {
        const e = this.textEntity(el);
        if (e) out.push(e);
        return next;
      }
      case 7: {
        // Text node: the member texts carry their own positions.
        const count = u16(b, o + 38);
        let j = next;
        for (let k = 0; k < count && j < els.length && els[j].complex; k++) j = this.convert(els, j, out, depth + 1);
        return j;
      }
      case 2: return this.cell(els, i, out, depth);
      case 27: return this.bspline(els, i, out);
      default: {
        if (UNSUPPORTED[el.type]) out.push(this.base(el, UNSUPPORTED[el.type]));
        return next;
      }
    }
  }

  polyline(el, pts, closed) {
    const e = this.base(el, 'LWPOLYLINE');
    e.vertices = pts.map(([x, y]) => ({ x, y, bulge: 0 }));
    e.flag = closed ? 1 : 0;
    return e;
  }

  hatch(el, rings, rgb) {
    const e = this.base(el, 'HATCH');
    e.color = rgb;
    e.solidFill = 1;
    e.patternName = 'SOLID';
    e.boundaryPaths = rings.map((r) => ({ vertices: r.map(([x, y]) => ({ x, y, bulge: 0 })), isClosed: true }));
    return e;
  }

  pushFill(el, out, pts) {
    const fill = this.fillColor(el);
    if (fill !== null && pts.length >= 3) out.push(this.hatch(el, [pts], fill));
  }

  cell(els, i, out, depth) {
    const el = els[i], b = this.b, o = el.off;
    // A top-level cell runs until the next element without the complex bit. Nested cells
    // use their length word (writers disagree on whether it counts the header's attributes).
    const attrStart = 32 + u16(b, o + 30) * 2;
    const end = depth ? o + 38 + u16(b, o + 36) * 2 + Math.max(0, el.size - attrStart) : Infinity;
    const name = (rad50(u16(b, o + 38)) + rad50(u16(b, o + 40))).trim();
    const members = [];
    let j = i + 1;
    while (j < els.length && els[j].complex && els[j].off < end) j = this.convert(els, j, members, depth + 1);
    if (!members.length) return j;
    let origin;
    if (this.dim === 2) origin = this.intPoint(o + 84);
    else origin = this.intPoint(o + 112);
    // Members are stored in design coordinates, so the block is used without a transform.
    const key = `*DGNCELL${++this.cellSeq}`;
    this.blocks.push({ name: key, handle: key, flags: 0, basePoint: origin, entities: members });
    const e = this.base(el, 'INSERT');
    Object.assign(e, { name: name || '*CELL', blockName: key, insertionPoint: origin, xScale: 1, yScale: 1, zScale: 1, rotation: 0, attribs: [] });
    out.push(e);
    return j;
  }

  bspline(els, i, out) {
    const el = els[i], b = this.b, o = el.off;
    const order = (b[o + 40] & 0x0f) + 2;
    const closed = (b[o + 40] & 0x80) !== 0;
    let poles = [], weights = null;
    let j = i + 1;
    while (j < els.length && els[j].complex && [21, 26, 28].includes(els[j].type)) {
      const m = els[j];
      if (m.type === 21) poles = poles.concat(this.vertices(m));
      else if (m.type === 28) {
        const n = Math.floor((m.size - 36) / 4);
        weights = [];
        for (let k = 0; k < n; k++) weights.push(int32(b, m.off + 36 + k * 4) / 2147483647);
      }
      j++;
    }
    if (poles.length < 2) return j;
    if (closed) poles = poles.concat(poles.slice(0, order - 1));
    const e = this.base(el, 'SPLINE');
    Object.assign(e, {
      degree: Math.min(order - 1, poles.length - 1), controlPoints: poles, fitPoints: [], knots: [],
      weights: weights && weights.length === poles.length ? weights : [], flag: closed ? 1 : 0,
    });
    out.push(e);
    return j;
  }

  /** Converts the whole file into a DwgDatabase-like object. */
  read() {
    const els = scanElements(this.b);
    if (!els.length) throw new FormatError('This DGN file is empty or damaged.');
    // Settings first, so units and colours apply to every element. Only the first TCB counts.
    const tcb = els.find((el) => el.type === 9 && !el.deleted);
    if (tcb) this.readTcb(tcb);
    for (const el of els) if (el.type === 5 && el.level === 1 && !el.deleted) this.readColorTable(el);
    const entities = [];
    let i = 0;
    while (i < els.length) {
      const el = els[i];
      if (el.type === 9 || el.type === 5) { i++; continue; }
      i = this.convert(els, i, entities);
    }
    if (!entities.length) throw new FormatError('No drawable elements were found in this DGN file (it may be empty or damaged).');
    const [x0, y0, x1, y1] = this.ext;
    const unit = Number.isFinite(x0) ? Math.max(x1 - x0, y1 - y0) / 400 || 1 : 1;
    const layers = [...this.layers.entries()].sort((a, c) => a[1] - c[1]).map(([name]) => ({
      name, colorIndex: 7, color: undefined, off: false, frozen: false, locked: false, lineweight: -3, lineType: 'Continuous', plotFlag: 1,
    }));
    const ltypes = [...this.styles].map((s) => ({
      name: `DGN_STYLE_${s}`, description: `MicroStation line style ${s}`,
      pattern: STYLE_PATTERNS[s].map((v) => ({ elementLength: v * unit, elementTypeFlag: 0 })),
    }));
    const header = { ACADVER: `V7 ${this.dim}D`, INSUNITS: this.unitCode, DGN_MASTER_UNITS: this.unitName };
    if (Number.isFinite(x0)) {
      header.EXTMIN = { x: x0, y: y0, z: 0 };
      header.EXTMAX = { x: x1, y: y1, z: 0 };
    }
    return {
      source: 'dgn',
      header,
      tables: { LAYER: { entries: layers }, LTYPE: { entries: ltypes }, STYLE: { entries: [] }, BLOCK_RECORD: { entries: this.blocks } },
      objects: { LAYOUT: [] },
      entities,
    };
  }
}

/** Points of an arc/ellipse (plan projection), from start over sweep. */
function conicPoints(c, segs) {
  const n = Math.max(8, Math.ceil(segs * Math.abs(c.sweep) / 360));
  const out = [];
  const r = c.rot * DEG, cr = Math.cos(r), sr = Math.sin(r);
  for (let i = 0; i <= n; i++) {
    const t = (c.start + (c.sweep * i) / n) * DEG;
    const lx = c.a * Math.cos(t), ly = c.b * Math.sin(t);
    if (c.m) out.push([c.origin.x + c.m[0] * lx + c.m[1] * ly, c.origin.y + c.m[3] * lx + c.m[4] * ly]);
    else out.push([c.origin.x + lx * cr - ly * sr, c.origin.y + lx * sr + ly * cr]);
  }
  return out;
}

/** Curve element through its interior vertices (Catmull-Rom). */
function curvePoints(v) {
  const p = v.length > 4 ? v.slice(2, -2) : v;
  if (p.length < 3) return p.map((q) => [q.x, q.y]);
  const out = [];
  const P = (i) => p[Math.max(0, Math.min(p.length - 1, i))];
  for (let i = 0; i < p.length - 1; i++) {
    const a = P(i - 1), b = P(i), c = P(i + 1), d = P(i + 2);
    for (let s = i ? 1 : 0; s <= 8; s++) {
      const t = s / 8, t2 = t * t, t3 = t2 * t;
      const f = (w, x, y, z) => 0.5 * (2 * x + (-w + y) * t + (2 * w - 5 * x + 4 * y - z) * t2 + (-w + 3 * x - 3 * y + z) * t3);
      out.push([f(a.x, b.x, c.x, d.x), f(a.y, b.y, c.y, d.y)]);
    }
  }
  return out;
}

function decodeText(bytes) {
  // Multi-byte text is flagged with 0xFF 0xFD and stored as 16-bit words.
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfd) {
    const raw = [];
    for (let i = 2; i + 1 < bytes.length; i += 2) {
      const w = bytes[i] | (bytes[i + 1] << 8);
      if (w < 256) raw.push(w);
      else raw.push(w >> 8, w & 0xff);
    }
    try { return new TextDecoder('euc-kr').decode(new Uint8Array(raw)).replace(/\0+$/, ''); } catch { /* fall through */ }
    return String.fromCharCode(...raw);
  }
  let end = bytes.indexOf(0);
  if (end < 0) end = bytes.length;
  return new TextDecoder('windows-1252').decode(bytes.subarray(0, end));
}

/** Parses a DGN V7 file (ArrayBuffer) into a DwgDatabase-like object. */
export function parseDgn(buffer) {
  const bytes = new Uint8Array(buffer);
  if (isDgnV8(bytes)) {
    throw new FormatError('This is a MicroStation DGN V8 file, which cannot be opened in the browser.', 'dgnV8', 'DGN V8');
  }
  if (!isDgnV7(bytes)) throw new FormatError('This file is not a MicroStation DGN V7 design file.');
  return new DgnReader(bytes).read();
}
