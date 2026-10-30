// HP-GL and HP-GL/2 plot files (.plt, .hpgl …), also when wrapped in a PCL/PJL job.
// Produces a DwgDatabase-like object: polylines, circles, fills and labels on one layer
// per pen ("PEN n"), in millimetres (plotter units are 40 per mm).
import { FormatError } from './errors.js';

const PLU_PER_MM = 40;
const DEG = Math.PI / 180;
const ETX = '\x03';

// HP-GL/2 default palette: 0 white, 1 black, 2 red, 3 green, 4 yellow, 5 blue, 6 magenta, 7 cyan.
const PALETTE = [0xffffff, 0x000000, 0xff0000, 0x00ff00, 0xffff00, 0x0000ff, 0xff00ff, 0x00ffff];

// Fixed line types as % of the pattern length: dash, gap, dash, gap… (0 is a dot).
const LINE_TYPES = {
  0: [0, 100], 1: [0, 100], 2: [50, 50], 3: [70, 30], 4: [80, 10, 0, 10], 5: [70, 10, 10, 10],
  6: [50, 10, 10, 10, 10, 10], 7: [70, 10, 0, 10, 0, 10], 8: [50, 10, 0, 10, 10, 10, 0, 10],
};

/**
 * Extracts the HP-GL text from a file that may be plain HP-GL or a PCL/PJL job
 * (ESC%#B enters HP-GL/2, ESC%#A returns to PCL; PCL binary payloads are skipped).
 */
export function extractHpgl(bytes) {
  const n = bytes.length;
  let i = 0;
  while (i < n && (bytes[i] <= 32)) i++;
  const startsPcl = bytes[i] === 0x1b && bytes[i + 1] !== 0x2e;
  const startsPjl = bytes[i] === 0x40 && bytes[i + 1] === 0x50; // "@P"
  let hpgl = !(startsPcl || startsPjl);
  const chunks = [];
  let chunkStart = hpgl ? i : -1;
  const flush = (end) => {
    if (chunkStart >= 0 && end > chunkStart) chunks.push(latin1(bytes, chunkStart, end));
    chunkStart = -1;
  };
  while (i < n) {
    const c = bytes[i];
    if (c === 0x1b) {
      if (hpgl) flush(i);
      const esc = readEscape(bytes, i);
      if (esc.enterHpgl) hpgl = true;
      else if (esc.leaveHpgl) hpgl = false;
      i = esc.next;
      if (hpgl) chunkStart = i;
      continue;
    }
    if (!hpgl && c === 0x40 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x4a && bytes[i + 3] === 0x4c) {
      // A PJL line: "@PJL ENTER LANGUAGE = HPGL2" switches straight to HP-GL/2.
      let e = i;
      while (e < n && bytes[e] !== 0x0a) e++;
      const line = latin1(bytes, i, e);
      i = e + 1;
      if (/ENTER\s+LANGUAGE\s*=\s*HPGL/i.test(line)) { hpgl = true; chunkStart = i; }
      continue;
    }
    i++;
  }
  if (hpgl) flush(n);
  return chunks.join(';');
}

function latin1(bytes, a, b) {
  let s = '';
  for (let k = a; k < b; k += 8192) s += String.fromCharCode.apply(null, bytes.subarray(k, Math.min(b, k + 8192)));
  return s;
}

/** Parses one escape sequence starting at `i` (bytes[i] === ESC). */
function readEscape(b, i) {
  const n = b.length;
  const c1 = b[i + 1];
  if (c1 === undefined) return { next: n };
  if (c1 === 0x25) {
    // ESC % [-]digits A|B|X
    let k = i + 2;
    let num = '';
    while (k < n && /[-+0-9]/.test(String.fromCharCode(b[k]))) num += String.fromCharCode(b[k++]);
    const term = String.fromCharCode(b[k] ?? 0);
    if (term === 'B') return { next: k + 1, enterHpgl: true };
    if (term === 'A' || term === 'X') return { next: k + 1, leaveHpgl: true };
    return { next: k + 1 };
  }
  if (c1 === 0x2e) {
    // ESC . x [params] [:] — HP-GL device control, ignored.
    let k = i + 3;
    while (k < n && ((b[k] >= 0x30 && b[k] <= 0x39) || b[k] === 0x3b)) k++;
    if (b[k] === 0x3a) k++;
    return { next: k };
  }
  if (c1 === 0x45) return { next: i + 2, leaveHpgl: true }; // ESC E: printer reset
  if (c1 >= 0x21 && c1 <= 0x2f) {
    // Parameterised PCL command, e.g. ESC*b100W<100 bytes>. Group char then value+letter pairs.
    let k = i + 3;
    for (;;) {
      let num = '';
      while (k < n && /[-+.0-9]/.test(String.fromCharCode(b[k]))) num += String.fromCharCode(b[k++]);
      const p = b[k++];
      if (p === undefined) return { next: n };
      const upper = String.fromCharCode(p).toUpperCase();
      // W (and &p#X) carry a binary payload of `num` bytes.
      if ((upper === 'W' || (b[i + 1] === 0x26 && b[i + 2] === 0x70 && upper === 'X')) && Number(num) > 0) k += Math.floor(Number(num));
      if (p >= 0x40 && p <= 0x5e) return { next: k };
      if (!(p >= 0x60 && p <= 0x7e)) return { next: k };
    }
  }
  return { next: i + 2 };
}

/** Sequential reader of HP-GL instructions. */
class Lexer {
  constructor(s) {
    this.s = s;
    this.i = 0;
  }

  /** Next two-letter mnemonic (upper case), or null at the end. */
  mnemonic() {
    const s = this.s;
    while (this.i < s.length) {
      const c = s.charCodeAt(this.i);
      const isLetter = (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
      if (isLetter) {
        const d = s.charCodeAt(this.i + 1);
        if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122)) {
          this.i += 2;
          return s.substr(this.i - 2, 2).toUpperCase();
        }
      }
      this.i++;
    }
    return null;
  }

  /** Numeric parameters up to the next instruction. */
  params() {
    const s = this.s, out = [];
    while (this.i < s.length) {
      const c = s.charCodeAt(this.i);
      if (c === 59) { this.i++; break; } // ;
      if (c === 44 || c <= 32) { this.i++; continue; }
      if (c === 34) { // quoted string parameter: skip
        const e = s.indexOf('"', this.i + 1);
        this.i = e < 0 ? s.length : e + 1;
        continue;
      }
      if ((c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) {
        let j = this.i + 1;
        while (j < s.length) {
          const d = s.charCodeAt(j);
          if ((d >= 48 && d <= 57) || d === 46) j++;
          else break;
        }
        const v = parseFloat(s.slice(this.i, j));
        if (Number.isFinite(v)) out.push(v);
        this.i = j;
        continue;
      }
      break; // the next mnemonic (or garbage) starts here
    }
    return out;
  }

  /** Raw text up to (excluding) `term`; the terminator is consumed. */
  until(term) {
    const e = this.s.indexOf(term, this.i);
    const end = e < 0 ? this.s.length : e;
    const text = this.s.slice(this.i, end);
    this.i = e < 0 ? end : end + term.length;
    return text;
  }

  char() { return this.s[this.i++] ?? ''; }
}

class Plotter {
  constructor() {
    this.entities = [];
    this.pens = new Map(); // pen -> { rgb, width }
    this.ltypes = new Map();
    this.colors = PALETTE.slice();
    this.isHpgl2 = false;
    this.handle = 0;
    this.page = 0;
    this.reset();
  }

  reset() {
    this.x = 0; this.y = 0; // plotter units
    this.down = false;
    this.abs = true;
    this.pen = 1;
    this.p1 = [0, 0]; this.p2 = [10365, 7962];
    this.sc = null;
    this.lt = null;
    this.width = new Map();
    this.defaultWidth = 0.35;
    this.relWidth = false;
    this.term = ETX;
    this.termPrint = false;
    this.dir = 0;
    this.charW = 0.19 * 400; this.charH = 0.27 * 400; // plotter units
    this.lo = 1;
    this.fill = { type: 1, spacing: 0, angle: 0 };
    this.poly = null;
    this.path = null;
    this.colorRange = [0, 255, 0, 255, 0, 255];
  }

  // ---------- coordinates ----------
  toPlot(ux, uy) {
    const s = this.sc;
    return s ? [(ux - s.ux) * s.sx + s.px, (uy - s.uy) * s.sy + s.py] : [ux, uy];
  }

  /** Relative user-unit offset in plotter units. */
  relPlot(dx, dy) {
    const s = this.sc;
    return s ? [dx * s.sx, dy * s.sy] : [dx, dy];
  }

  setScale(p) {
    if (p.length < 4) { this.sc = null; return; }
    const [xmin, a, ymin, b, type = 0, left = 50, bottom = 50] = p;
    const [P1x, P1y] = this.p1, [P2x, P2y] = this.p2;
    if (type === 2) { // point factor: a, b are plotter units per user unit
      this.sc = { ux: xmin, uy: ymin, sx: a, sy: b, px: P1x, py: P1y };
      return;
    }
    const xmax = a, ymax = b;
    if (xmax === xmin || ymax === ymin) return;
    let sx = (P2x - P1x) / (xmax - xmin), sy = (P2y - P1y) / (ymax - ymin);
    let px = P1x, py = P1y;
    if (type === 1) { // isotropic: same scale both ways, positioned by left/bottom %
      const k = Math.min(Math.abs(sx), Math.abs(sy));
      const fx = Math.sign(sx) * k, fy = Math.sign(sy) * k;
      px += ((P2x - P1x) - (xmax - xmin) * fx) * (left / 100);
      py += ((P2y - P1y) - (ymax - ymin) * fy) * (bottom / 100);
      sx = fx; sy = fy;
    }
    this.sc = { ux: xmin, uy: ymin, sx, sy, px, py };
  }

  // ---------- output ----------
  penInfo(pen) {
    let info = this.pens.get(pen);
    if (!info) {
      info = { rgb: this.colors[pen < 8 ? pen : ((pen - 1) % 7) + 1] ?? 0, width: this.penWidth(pen) };
      this.pens.set(pen, info);
    }
    return info;
  }

  penWidth(pen) {
    return this.width.get(pen) ?? this.defaultWidth;
  }

  base(type) {
    const layer = `PEN ${this.pen}`;
    this.penInfo(this.pen);
    return {
      type, handle: (++this.handle).toString(16).toUpperCase(), layer, colorIndex: 256,
      lineweight: Math.max(5, Math.round(this.penWidth(this.pen) * 100)), lineTypeScale: 1, isVisible: true, page: this.page,
    };
  }

  lineTypeName() {
    if (!this.lt) return undefined;
    const { type, length } = this.lt;
    const name = `HPGL_LT${type}_${length.toFixed(1)}`;
    if (!this.ltypes.has(name)) {
      const pct = LINE_TYPES[Math.abs(type)] ?? LINE_TYPES[2];
      this.ltypes.set(name, {
        name, description: `HP-GL line type ${type}`, totalPatternLength: length,
        pattern: pct.map((v, i) => ({ elementLength: (i % 2 ? -1 : 1) * (v / 100) * length, elementTypeFlag: 0 })),
      });
    }
    return name;
  }

  /** Starts or extends the current pen-down path. */
  lineTo(x, y, bulge = 0) {
    if (this.pen === 0 && !this.poly) { this.x = x; this.y = y; return; }
    if (this.poly) {
      const ring = this.poly.ring;
      if (!ring.length) ring.push({ x: this.x / PLU_PER_MM, y: this.y / PLU_PER_MM, bulge: 0 });
      ring[ring.length - 1].bulge = bulge;
      ring.push({ x: x / PLU_PER_MM, y: y / PLU_PER_MM, bulge: 0 });
    } else {
      if (!this.path) this.path = [{ x: this.x / PLU_PER_MM, y: this.y / PLU_PER_MM, bulge: 0 }];
      const p = this.path;
      p[p.length - 1].bulge = bulge;
      p.push({ x: x / PLU_PER_MM, y: y / PLU_PER_MM, bulge: 0 });
    }
    this.x = x; this.y = y;
  }

  moveTo(x, y) {
    if (this.poly) {
      // In polygon mode a pen-up move starts a new sub-polygon.
      if (this.poly.ring.length > 1) this.poly.rings.push(this.poly.ring);
      this.poly.ring = [];
    } else this.flushPath();
    this.x = x; this.y = y;
  }

  flushPath() {
    const p = this.path;
    this.path = null;
    if (!p) return;
    if (p.length === 1 || (p.length === 2 && p[0].x === p[1].x && p[0].y === p[1].y && !p[0].bulge)) {
      const e = this.base('POINT');
      e.position = { x: p[0].x, y: p[0].y, z: 0 };
      this.entities.push(e);
      return;
    }
    const e = this.base('LWPOLYLINE');
    const last = p[p.length - 1];
    const closed = p.length > 2 && Math.abs(last.x - p[0].x) < 1e-9 && Math.abs(last.y - p[0].y) < 1e-9;
    if (closed) p.pop();
    e.vertices = p;
    e.flag = closed ? 1 : 0;
    e.lineType = this.lineTypeName();
    this.entities.push(e);
  }

  /** Pen movement to plotter point (x, y) honouring the pen state. */
  plotTo(x, y) {
    if (this.down) this.lineTo(x, y);
    else this.moveTo(x, y);
  }

  plotPoints(p) {
    for (let k = 0; k + 1 < p.length; k += 2) {
      const [x, y] = this.abs ? this.toPlot(p[k], p[k + 1]) : (([dx, dy]) => [this.x + dx, this.y + dy])(this.relPlot(p[k], p[k + 1]));
      this.plotTo(x, y);
    }
  }

  /** Arc around plotter-space centre (cx, cy) by `sweep` degrees from the current point. */
  arcTo(cx, cy, sweepDeg, draw) {
    const r = Math.hypot(this.x - cx, this.y - cy);
    if (!(r > 0) || !sweepDeg) return;
    const mirror = this.sc && this.sc.sx * this.sc.sy < 0 ? -1 : 1;
    const sweep = sweepDeg * DEG * mirror;
    const a0 = Math.atan2(this.y - cy, this.x - cx);
    // Split so each bulge stays well below a half circle.
    const parts = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2)));
    for (let k = 1; k <= parts; k++) {
      const a = a0 + (sweep * k) / parts;
      const x = cx + r * Math.cos(a), y = cy + r * Math.sin(a);
      if (draw) this.lineTo(x, y, Math.tan(sweep / parts / 4));
      else { this.x = x; this.y = y; }
    }
  }

  circle(r) {
    const R = Math.abs(this.relPlot(r, 0)[0]);
    if (!(R > 0) || (this.pen === 0 && !this.poly)) return;
    if (this.poly) {
      const ring = [{ x: (this.x + R) / PLU_PER_MM, y: this.y / PLU_PER_MM, bulge: 1 }, { x: (this.x - R) / PLU_PER_MM, y: this.y / PLU_PER_MM, bulge: 1 }];
      if (this.poly.ring.length > 1) this.poly.rings.push(this.poly.ring);
      this.poly.rings.push(ring);
      this.poly.ring = [];
      return;
    }
    this.flushPath();
    const e = this.base('CIRCLE');
    e.center = { x: this.x / PLU_PER_MM, y: this.y / PLU_PER_MM, z: 0 };
    e.radius = R / PLU_PER_MM;
    e.lineType = this.lineTypeName();
    this.entities.push(e);
  }

  /** Closed ring (plotter units) drawn as outline or filled. */
  shape(ring, filled) {
    if (this.pen === 0) return;
    this.flushPath();
    const verts = ring.map(([x, y, bulge = 0]) => ({ x: x / PLU_PER_MM, y: y / PLU_PER_MM, bulge }));
    if (filled) this.fillRings([verts]);
    else {
      const e = this.base('LWPOLYLINE');
      e.vertices = verts;
      e.flag = 1;
      e.lineType = this.lineTypeName();
      this.entities.push(e);
    }
  }

  fillRings(rings) {
    rings = rings.filter((r) => r.length >= 3 || (r.length === 2 && r.some((v) => v.bulge)));
    if (!rings.length || this.pen === 0) return;
    const e = this.base('HATCH');
    e.boundaryPaths = rings.map((r) => ({ vertices: r, isClosed: true }));
    const f = this.fill;
    if ((f.type === 3 || f.type === 4) && f.spacing > 0) {
      const lines = [];
      for (const ang of f.type === 4 ? [f.angle, f.angle + 90] : [f.angle]) {
        const a = ang * DEG;
        lines.push({ angle: a, base: { x: 0, y: 0 }, offset: { x: -Math.sin(a) * f.spacing, y: Math.cos(a) * f.spacing }, dashLengths: [] });
      }
      e.patternName = 'HPGL';
      e.solidFill = 0;
      e.definitionLines = lines;
    } else {
      e.patternName = 'SOLID';
      e.solidFill = 1;
    }
    this.entities.push(e);
  }

  wedge(r, start, sweep, filled) {
    const [R] = this.relPlot(r, 0);
    const cx = this.x, cy = this.y;
    const ring = [[cx, cy]];
    const n = Math.max(2, Math.ceil(Math.abs(sweep) / 5));
    for (let k = 0; k <= n; k++) {
      const a = (start + (sweep * k) / n) * DEG;
      ring.push([cx + Math.abs(R) * Math.cos(a), cy + Math.abs(R) * Math.sin(a)]);
    }
    this.shape(ring, filled);
  }

  label(text) {
    if (this.poly || this.pen === 0) return;
    this.flushPath();
    const lines = text.replace(/\r\n?/g, '\r').split(/[\r\n]/);
    const h = this.charH / PLU_PER_MM, w = this.charW / PLU_PER_MM;
    const c = Math.cos(this.dir), s = Math.sin(this.dir);
    const lo = this.lo % 10 || 1;
    const col = Math.floor((lo - 1) / 3), row = (lo - 1) % 3; // col: left/centre/right, row: bottom/middle/top
    let x0 = this.x / PLU_PER_MM, y0 = this.y / PLU_PER_MM;
    lines.forEach((line, k) => {
      const str = line.replace(/[\x00-\x1f]/g, '');
      if (str.trim()) {
        const off = k * 2 * h; // character cells are twice the cap height
        const px = x0 + s * off, py = y0 - c * off;
        const e = this.base('TEXT');
        Object.assign(e, {
          text: str, textHeight: h, rotation: this.dir, xScale: 1,
          halign: col, valign: row === 0 ? 0 : row === 1 ? 2 : 3,
          startPoint: { x: px, y: py, z: 0 }, endPoint: { x: px, y: py, z: 0 },
        });
        this.entities.push(e);
      }
    });
    // The pen ends after the last character (character cells are 1.5 × the width).
    const last = lines[lines.length - 1].length;
    const adv = col === 0 ? last * 1.5 * w : 0;
    const off = (lines.length - 1) * 2 * h;
    this.x = (x0 + c * adv + s * off) * PLU_PER_MM;
    this.y = (y0 + s * adv - c * off) * PLU_PER_MM;
  }

  // ---------- polyline encoded (PE) ----------
  polylineEncoded(data) {
    let i = 0, seven = false, fbits = 0, up = false, absNext = false;
    const num = () => {
      let v = 0, mult = 1;
      while (i < data.length) {
        const c = data.charCodeAt(i++);
        if (seven) {
          if (c >= 63 && c <= 94) { v += (c - 63) * mult; mult *= 32; } else if (c >= 95 && c <= 126) { v += (c - 95) * mult; break; }
        } else if (c >= 63 && c <= 126) { v += (c - 63) * mult; mult *= 64; } else if (c >= 191 && c <= 254) { v += (c - 191) * mult; break; }
      }
      return v % 2 ? -(v - 1) / 2 : v / 2;
    };
    const isDigit = (c) => (c >= 63 && c <= 126) || (!seven && c >= 191 && c <= 254);
    while (i < data.length) {
      const ch = data[i];
      const code = data.charCodeAt(i);
      if (ch === ':') { i++; this.flushPath(); this.pen = Math.max(0, Math.round(num())); continue; }
      if (ch === '<') { i++; up = true; continue; }
      if (ch === '>') { i++; fbits = num(); continue; }
      if (ch === '=') { i++; absNext = true; continue; }
      if (ch === '7') { i++; seven = true; continue; }
      if (!isDigit(code)) { i++; continue; }
      const k = 2 ** -fbits;
      const ux = num() * k, uy = num() * k;
      const [x, y] = absNext ? this.toPlot(ux, uy) : (([dx, dy]) => [this.x + dx, this.y + dy])(this.relPlot(ux, uy));
      if (up) this.moveTo(x, y);
      else this.lineTo(x, y);
      this.down = !up;
      up = false; absNext = false;
    }
  }

  // ---------- instructions ----------
  run(lex) {
    for (let op = lex.mnemonic(); op; op = lex.mnemonic()) {
      switch (op) {
        case 'LB': this.label(this.labelText(lex)); break;
        case 'BL': this.labelText(lex); break;
        case 'WD': this.labelText(lex); break;
        case 'DT': {
          const c = lex.char();
          if (c === ';' || c === '') { this.term = ETX; this.termPrint = false; break; }
          this.term = c;
          const p = lex.params();
          this.termPrint = p[0] === 0;
          break;
        }
        case 'PE': this.isHpgl2 = true; this.polylineEncoded(lex.until(';')); break;
        case 'CO': lex.params(); break;
        case 'SM': { const c = lex.char(); if (c !== ';') lex.params(); break; }
        default: this.command(op, lex.params());
      }
    }
    this.flushPath();
  }

  labelText(lex) {
    let text = lex.until(this.term);
    if (this.termPrint) text += this.term;
    return text;
  }

  command(op, p) {
    switch (op) {
      case 'IN': case 'DF': {
        this.flushPath();
        const pens = this.pens, ltypes = this.ltypes;
        this.reset();
        this.pens = pens; this.ltypes = ltypes;
        break;
      }
      case 'BP': case 'PS': case 'NP': case 'MG': case 'QL': this.isHpgl2 = true; break;
      case 'SP': this.flushPath(); this.pen = Math.max(0, Math.round(p[0] ?? 0)); break;
      case 'PU': this.down = false; this.flushPath(); this.plotPoints(p); break;
      case 'PD': this.down = true; this.plotPoints(p); break;
      case 'PA': this.abs = true; this.plotPoints(p); break;
      case 'PR': this.abs = false; this.plotPoints(p); break;
      case 'IP':
        this.p1 = p.length >= 2 ? [p[0], p[1]] : [0, 0];
        this.p2 = p.length >= 4 ? [p[2], p[3]] : p.length >= 2 ? [p[0] + (this.p2[0] - this.p1[0]), p[1] + (this.p2[1] - this.p1[1])] : [10365, 7962];
        break;
      case 'SC': this.setScale(p); break;
      case 'CI': if (p.length) this.circle(p[0]); break;
      case 'AA': case 'AR': {
        if (p.length < 3) break;
        const [cx, cy] = op === 'AA' ? this.toPlot(p[0], p[1]) : (([dx, dy]) => [this.x + dx, this.y + dy])(this.relPlot(p[0], p[1]));
        this.arcTo(cx, cy, p[2], this.down || !!this.poly);
        break;
      }
      case 'AT': case 'RT': {
        if (p.length < 4) break;
        const conv = (a, b) => (op === 'AT' ? this.toPlot(a, b) : (([dx, dy]) => [this.x + dx, this.y + dy])(this.relPlot(a, b)));
        const [mx, my] = conv(p[0], p[1]), [ex, ey] = conv(p[2], p[3]);
        const c = circleThrough(this.x, this.y, mx, my, ex, ey);
        const draw = this.down || !!this.poly;
        if (!c) { if (draw) this.lineTo(ex, ey); else { this.x = ex; this.y = ey; } break; }
        // Sweep from start through the middle point to the end.
        const a0 = Math.atan2(this.y - c.y, this.x - c.x), am = Math.atan2(my - c.y, mx - c.x), a1 = Math.atan2(ey - c.y, ex - c.x);
        const norm = (a) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
        let sweep = norm(a1 - a0);
        if (norm(am - a0) > sweep) sweep -= 2 * Math.PI;
        this.arcTo(c.x, c.y, sweep / DEG / (this.sc && this.sc.sx * this.sc.sy < 0 ? -1 : 1), draw);
        break;
      }
      case 'EA': case 'RA': case 'ER': case 'RR': {
        if (p.length < 2) break;
        const [x, y] = op[1] === 'A' ? this.toPlot(p[0], p[1]) : (([dx, dy]) => [this.x + dx, this.y + dy])(this.relPlot(p[0], p[1]));
        this.shape([[this.x, this.y], [x, this.y], [x, y], [this.x, y]], op[0] === 'R');
        break;
      }
      case 'EW': case 'WG': if (p.length >= 3) this.wedge(p[0], p[1], p[2], op === 'WG'); break;
      case 'PM': {
        const mode = p[0] ?? 0;
        if (mode === 0) { this.flushPath(); this.poly = { rings: [], ring: [], done: null }; }
        else if (this.poly) {
          if (this.poly.ring.length > 1) this.poly.rings.push(this.poly.ring);
          this.poly.ring = [];
          if (mode === 2) { this.polygon = this.poly.rings; this.poly = null; }
        }
        break;
      }
      case 'EP': case 'FP': {
        const rings = this.polygon || [];
        if (op === 'FP') this.fillRings(rings.map((r) => r.map((v) => ({ ...v }))));
        else for (const r of rings) {
          const e = this.base('LWPOLYLINE');
          e.vertices = r.map((v) => ({ ...v }));
          e.flag = 1;
          this.entities.push(e);
        }
        break;
      }
      case 'FT':
        this.fill = { type: p[0] ?? 1, spacing: p[1] !== undefined ? Math.abs(this.relPlot(p[1], 0)[0]) / PLU_PER_MM : this.fill.spacing || 2, angle: p[2] ?? 0 };
        break;
      case 'LT':
        this.flushPath();
        if (!p.length || p[0] === undefined) { this.lt = null; break; }
        {
          const diag = Math.hypot(this.p2[0] - this.p1[0], this.p2[1] - this.p1[1]) / PLU_PER_MM;
          const len = p[1] !== undefined ? (p[2] === 1 ? p[1] : (p[1] / 100) * diag) : 0.04 * diag;
          this.lt = { type: Math.round(p[0]), length: Math.max(0.5, len) };
        }
        break;
      case 'PW': {
        this.isHpgl2 = true;
        this.flushPath();
        let w = p[0] ?? 0.35;
        if (this.relWidth) w = (w / 100) * Math.hypot(this.p2[0] - this.p1[0], this.p2[1] - this.p1[1]) / PLU_PER_MM;
        if (p.length >= 2) this.width.set(Math.round(p[1]), w);
        else { this.width.clear(); this.defaultWidth = w; }
        for (const [pen, info] of this.pens) info.width = this.penWidth(pen);
        break;
      }
      case 'WU': this.relWidth = p[0] === 1; break;
      case 'PC': {
        if (p.length >= 4) {
          const [r0, r1, g0, g1, b0, b1] = this.colorRange;
          const k = (v, a, b) => Math.max(0, Math.min(255, Math.round(((v - a) / (b - a || 1)) * 255)));
          const rgb = (k(p[1], r0, r1) << 16) | (k(p[2], g0, g1) << 8) | k(p[3], b0, b1);
          const pen = Math.round(p[0]);
          this.colors[pen] = rgb;
          if (this.pens.has(pen)) this.pens.get(pen).rgb = rgb;
        }
        break;
      }
      case 'CR': if (p.length >= 6) this.colorRange = p.slice(0, 6); break;
      case 'DI': case 'DR': this.dir = p.length >= 2 && (p[0] || p[1]) ? Math.atan2(p[1], p[0]) : 0; break;
      case 'SI': if (p.length >= 2) { this.charW = p[0] * 400; this.charH = p[1] * 400; } break;
      case 'SR': {
        const w = p.length >= 2 ? p[0] : 0.75, h = p.length >= 2 ? p[1] : 1.5;
        this.charW = (w / 100) * Math.abs(this.p2[0] - this.p1[0]);
        this.charH = (h / 100) * Math.abs(this.p2[1] - this.p1[1]);
        break;
      }
      case 'SD': case 'AD':
        // Font definition pairs: kind 4 is the height in points.
        for (let k = 0; k + 1 < p.length; k += 2) if (p[k] === 4 && p[k + 1] > 0) { this.charH = p[k + 1] * (25.4 / 72) * 0.7 * PLU_PER_MM; this.charW = this.charH * 0.7; }
        break;
      case 'LO': this.lo = p[0] ?? 1; break;
      case 'CP': {
        const c = Math.cos(this.dir), s = Math.sin(this.dir);
        const sp = (p[0] ?? 0) * this.charW * 1.5, ln = p.length ? (p[1] ?? 0) * this.charH * 2 : -this.charH * 2;
        this.flushPath();
        this.x += c * sp - s * ln; this.y += s * sp + c * ln;
        break;
      }
      case 'PG': case 'FR': this.flushPath(); this.page++; break;
      default: break;
    }
  }
}

function circleThrough(x1, y1, x2, y2, x3, y3) {
  const d = 2 * (x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2));
  if (Math.abs(d) < 1e-9) return null;
  const s1 = x1 * x1 + y1 * y1, s2 = x2 * x2 + y2 * y2, s3 = x3 * x3 + y3 * y3;
  return { x: (s1 * (y2 - y3) + s2 * (y3 - y1) + s3 * (y1 - y2)) / d, y: (s1 * (x3 - x2) + s2 * (x1 - x3) + s3 * (x2 - x1)) / d };
}

/** Shifts later plot pages to the right of the previous ones so they don't overlap. */
function layoutPages(entities) {
  const pages = new Map();
  for (const e of entities) {
    const bb = pages.get(e.page) ?? [Infinity, Infinity, -Infinity, -Infinity];
    forEachPoint(e, (p) => {
      bb[0] = Math.min(bb[0], p.x); bb[1] = Math.min(bb[1], p.y); bb[2] = Math.max(bb[2], p.x); bb[3] = Math.max(bb[3], p.y);
    });
    pages.set(e.page, bb);
  }
  if (pages.size < 2) return;
  const order = [...pages.keys()].sort((a, b) => a - b);
  const shift = new Map();
  let right = -Infinity;
  for (const k of order) {
    const bb = pages.get(k);
    if (!Number.isFinite(bb[0])) continue;
    const dx = Number.isFinite(right) ? right + (bb[2] - bb[0]) * 0.05 + 10 - bb[0] : 0;
    shift.set(k, dx);
    right = bb[2] + dx;
  }
  for (const e of entities) {
    const dx = shift.get(e.page);
    if (dx) forEachPoint(e, (p) => { p.x += dx; });
  }
}

function forEachPoint(e, fn) {
  for (const key of ['position', 'center', 'startPoint']) if (e[key]) fn(e[key]);
  if (e.endPoint && e.endPoint !== e.startPoint) fn(e.endPoint);
  for (const v of e.vertices ?? []) fn(v);
  for (const path of e.boundaryPaths ?? []) for (const v of path.vertices) fn(v);
}

/** Parses an HP-GL / HP-GL/2 file (ArrayBuffer) into a DwgDatabase-like object. */
export function parseHpgl(buffer) {
  const bytes = new Uint8Array(buffer);
  const text = extractHpgl(bytes);
  // Binary data (a mislabelled or damaged file) would otherwise produce random strokes.
  let control = 0;
  for (let k = 0; k < text.length; k++) {
    const c = text.charCodeAt(k);
    if (c < 9 || (c > 13 && c < 32 && c !== 27 && c !== 3)) control++;
  }
  if (control > text.length * 0.02) throw new FormatError('This file does not look like an HP-GL plot file.');
  const plotter = new Plotter();
  plotter.run(new Lexer(text));
  const entities = plotter.entities;
  if (!entities.length) throw new FormatError('No HP-GL drawing instructions were found in this file.');
  layoutPages(entities);
  for (const e of entities) delete e.page;
  const layers = [...plotter.pens.entries()].sort((a, b) => a[0] - b[0]).map(([pen, info]) => {
    // Black and white pens follow the background (like AutoCAD colour 7).
    const fg = info.rgb === 0 || info.rgb === 0xffffff;
    return {
      name: `PEN ${pen}`, colorIndex: fg ? 7 : 256, color: fg ? undefined : info.rgb, off: false, frozen: false, locked: false,
      lineweight: Math.max(5, Math.round(info.width * 100)), lineType: 'Continuous', plotFlag: 1,
    };
  });
  return {
    source: 'hpgl',
    header: { ACADVER: plotter.isHpgl2 ? 'HP-GL/2' : 'HP-GL', INSUNITS: 4 },
    tables: { LAYER: { entries: layers }, LTYPE: { entries: [...plotter.ltypes.values()] }, STYLE: { entries: [] }, BLOCK_RECORD: { entries: [] } },
    objects: { LAYOUT: [] },
    entities,
  };
}
