// ASCII DXF writer: AutoCAD 2013 (AC1027) format, from a Drawing (any source: DWG, DXF, DGN,
// HP-GL, plus edits). The file structure follows what AutoCAD itself writes: HEADER, CLASSES,
// TABLES (VPORT, LTYPE, LAYER, STYLE, VIEW, UCS, APPID, DIMSTYLE, BLOCK_RECORD), BLOCKS,
// ENTITIES (model space and the active layout), OBJECTS (root dictionary, groups, layouts,
// materials, multiline and plot styles), with consistent handles and owner pointers.
// Objects DXF cannot carry as they are read here are converted (MULTILEADER, MLINE, tables,
// raster images) or skipped (3D solids, proxies), and listed in the report.
import { lineweightToMm, LW_BYLAYER, LW_BYBLOCK, LW_DEFAULT } from './drawing.js';
import { nearestAci } from './aci.js';
import { mlineToPolylines, multileaderParts } from '../edit/entities.js';

const DEG = 180 / Math.PI;
const TAU = Math.PI * 2;
const VALID_LW = [0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100, 106, 120, 140, 158, 200, 211];
const ANON = /^\*[UDTXEA]\d+$/i;
const BAD_CHARS = /[<>/\\":;?*|=`\r\n\t]/g;
const SKIPPED_TYPES = new Set(['3DSOLID', 'REGION', 'BODY', 'OLE2FRAME', 'OLEFRAME', 'PROXY', 'ACAD_PROXY_ENTITY', 'SURFACE', 'MESH', 'SECTION', 'LIGHT', 'HELIX', 'UNDERLAY', 'PDFUNDERLAY', 'DWFUNDERLAY', 'DGNUNDERLAY', 'SHAPE', 'ARCALIGNEDTEXT']);

// Header and object boilerplate taken from AutoCAD/ezdxf R2013 files.
const MATERIAL_BODY = '100\nAcDbMaterial\n1\n{NAME}\n2\n\n70\n0\n40\n1.0\n71\n1\n41\n1.0\n91\n-1023410177\n42\n1.0\n72\n1\n3\n\n73\n1\n74\n1\n75\n1\n44\n0.5\n73\n0\n45\n1.0\n46\n1.0\n77\n1\n4\n\n78\n1\n79\n1\n170\n1\n48\n1.0\n171\n1\n6\n\n172\n1\n173\n1\n174\n1\n140\n1.0\n141\n1.0\n175\n1\n7\n\n176\n1\n177\n1\n178\n1\n143\n1.0\n179\n1\n8\n\n270\n1\n271\n1\n272\n1\n145\n1.0\n146\n1.0\n273\n1\n9\n\n274\n1\n275\n1\n276\n1\n42\n1.0\n72\n1\n3\n\n73\n1\n74\n1\n75\n1\n94\n63';

/** Formats a real number for DXF (shortest exact form; never NaN). */
function num(v) {
  if (!Number.isFinite(v)) return '0.0';
  if (Object.is(v, -0)) v = 0;
  const s = String(v);
  return /[.e]/.test(s) ? s : s + '.0';
}

const int = (v) => String(Math.trunc(Number.isFinite(v) ? v : 0));

/** Single-line string value: no line breaks, no control characters. */
function str(v) {
  return String(v ?? '').replace(/\r\n|\r|\n/g, ' ').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

class Out {
  constructor() { this.parts = []; }
  add(code, value) { this.parts.push(code < 10 ? `  ${code}` : code < 100 ? ` ${code}` : String(code), value); }
  s(code, v) { this.add(code, str(v)); }
  n(code, v) { this.add(code, num(v)); }
  i(code, v) { this.add(code, int(v)); }
  h(code, v) { this.add(code, v || '0'); }
  p(code, p, z = true) {
    this.n(code, p?.x ?? 0);
    this.n(code + 10, p?.y ?? 0);
    if (z) this.n(code + 20, p?.z ?? 0);
  }
  raw(text) { for (const line of text.split('\n')) this.parts.push(line); }
  text() { return this.parts.join('\r\n') + '\r\n'; }
}

/** Counts of what was written, converted and skipped, for the summary shown after saving. */
export class SaveReport {
  constructor() {
    this.written = 0;
    this.converted = new Map(); // description -> count
    this.skipped = new Map(); // type -> count
  }
  convert(what) { this.converted.set(what, (this.converted.get(what) || 0) + 1); }
  skip(type) { this.skipped.set(type, (this.skipped.get(type) || 0) + 1); }
  /** One line, e.g. "2 MULTILEADER written as lines and text, 1 3DSOLID skipped". */
  summary() {
    const parts = [];
    for (const [what, n] of this.converted) parts.push(`${n} ${what}`);
    for (const [type, n] of this.skipped) parts.push(`${n} ${type} skipped`);
    return parts.join(', ');
  }
}

const CONVERSIONS = {
  MULTILEADER: 'MULTILEADER written as lines and text',
  MLINE: 'MLINE written as polylines',
  ACAD_TABLE: 'ACAD_TABLE written as a block reference',
  IMAGE: 'IMAGE written as its frame (the image file is not embedded)',
  DIMBLOCK: 'special dimension written as a block reference',
  MESH: 'POLYGONMESH written as 3D polylines',
};

/**
 * Writes a drawing as AutoCAD 2013 ASCII DXF.
 * @param drawing the Drawing (see buildDrawing), possibly edited
 * @param opts { extents?: [x0, y0, x1, y1] model extents in drawing units, handleSeed?: number }
 * @returns {{ text: string, report: SaveReport }}
 */
export function writeDxf(drawing, opts = {}) {
  return new DxfWriter(drawing, opts).write();
}

class DxfWriter {
  constructor(drawing, opts) {
    this.d = drawing;
    this.opts = opts;
    this.source = drawing.source;
    this.report = new SaveReport();
    this.used = new Set();
    this.next = 1;
  }

  // ------------------------------------------------------------ handles
  /** Entity handles are kept when valid and unique; structure handles are new. */
  scanHandles() {
    let max = 0;
    const see = (h) => {
      if (typeof h === 'string' && /^[0-9A-Fa-f]{1,15}$/.test(h)) max = Math.max(max, parseInt(h, 16));
    };
    const visit = (list) => { for (const e of list) { see(e.handle); for (const a of e.attribs ?? []) see(a.handle); } };
    visit(this.d.modelEntities);
    for (const l of this.layoutDefs) visit(l.entities);
    for (const b of this.d.blocks.values()) visit(b.entities);
    this.next = Math.max(max + 1, this.opts.handleSeed || 0, 0x30);
  }

  newHandle() {
    let h;
    do { h = (this.next++).toString(16).toUpperCase(); } while (this.used.has(h));
    this.used.add(h);
    return h;
  }

  entityHandle(e) {
    const h = typeof e?.handle === 'string' ? e.handle.toUpperCase() : '';
    if (/^[0-9A-F]{1,15}$/.test(h) && h !== '0' && !this.used.has(h)) { this.used.add(h); return h; }
    return this.newHandle();
  }

  // ------------------------------------------------------------ names
  setupNames() {
    const d = this.d;
    // Spaces: model, the active layout (*Paper_Space) and the other layouts (*Paper_Space0, 1...).
    this.layoutDefs = d.layoutDefs?.length ? d.layoutDefs : (d.layouts ?? []).map((l, i) => ({ ...l, block: null, tabOrder: l.tabOrder ?? i + 1 }));
    const spaceBlocks = new Set();
    for (const b of d.blocks.values()) if (/^\*(model|paper)_space/i.test(b.name)) spaceBlocks.add(b);
    this.spaceBlocks = spaceBlocks;
    let active = this.layoutDefs.findIndex((l) => /^\*paper_space$/i.test(l.block?.name ?? ''));
    if (active < 0) active = 0;
    this.layouts = this.layoutDefs.map((l, i) => ({ def: l, name: l.name || `Layout${i + 1}`, entities: l.entities, active: i === active }));
    if (!this.layouts.length) this.layouts.push({ def: { limits: [] }, name: 'Layout1', entities: [], active: true });
    let n = 0;
    for (const l of this.layouts) l.blockName = l.active ? '*Paper_Space' : `*Paper_Space${n++}`;

    // Block names AutoCAD accepts: anonymous ones are *U/*D/*T..., DGN cells get their cell names.
    const display = new Map();
    const visitNames = (list) => { for (const e of list) if (e.type === 'INSERT' && e.blockName && e.blockName !== e.name && !display.has(e.blockName)) display.set(e.blockName, e.name); };
    visitNames(d.modelEntities);
    for (const l of this.layoutDefs) visitNames(l.entities);
    for (const b of d.blocks.values()) visitNames(b.entities);
    this.blockNames = new Map();
    const taken = new Set(['*MODEL_SPACE', ...this.layouts.map((l) => l.blockName.toUpperCase())]);
    const claim = (name) => {
      let out = name, k = 2;
      while (taken.has(out.toUpperCase())) out = `${name}_${k++}`;
      taken.add(out.toUpperCase());
      return out;
    };
    let anon = 0;
    for (const b of d.blocks.values()) if (ANON.test(b.name)) { taken.add(b.name.toUpperCase()); anon = Math.max(anon, parseInt(b.name.slice(2), 10) || 0); }
    this.anonSeq = anon;
    const tableBlocks = new Set();
    for (const name of d.tableBlocks?.values() ?? []) tableBlocks.add(name);
    for (const b of d.blocks.values()) {
      if (spaceBlocks.has(b) || ANON.test(b.name) && !tableBlocks.has(b.name)) continue;
      let name;
      if (tableBlocks.has(b.name)) name = `*U${++this.anonSeq}`;
      else if (b.name.startsWith('*')) {
        const shown = display.get(b.name);
        const clean = shown && !shown.startsWith('*') ? shown.replace(BAD_CHARS, '_').trim() : '';
        name = clean ? claim(clean) : `*U${++this.anonSeq}`;
      } else {
        const clean = b.name.replace(BAD_CHARS, '_').trim() || 'BLOCK';
        name = clean === b.name && !taken.has(clean.toUpperCase()) ? (taken.add(clean.toUpperCase()), clean) : claim(clean);
      }
      this.blockNames.set(b.name, name);
    }
    taken.add('*U');
  }

  blockName(name) {
    return this.blockNames.get(name) ?? name;
  }

  layerName(name) {
    const n = (name ?? '0').replace(BAD_CHARS, '_').trim();
    return n || '0';
  }

  // ------------------------------------------------------------ tables data
  collectTables() {
    const d = this.d;
    this.layers = new Map(); // upper name -> { name, ... }
    const addLayer = (name, l) => {
      const n = this.layerName(name);
      if (!this.layers.has(n.toUpperCase())) this.layers.set(n.toUpperCase(), { name: n, l });
    };
    addLayer('0', d.layers.get('0'));
    for (const l of d.layers.values()) addLayer(l.name, l);
    this.ltypes = new Map([['BYBLOCK', { name: 'ByBlock', pattern: [] }], ['BYLAYER', { name: 'ByLayer', pattern: [] }], ['CONTINUOUS', { name: 'Continuous', description: 'Solid line', pattern: [] }]]);
    for (const t of d.ltypes.values()) {
      const key = t.name.toUpperCase();
      if (!this.ltypes.has(key) && !BAD_CHARS.test(t.name)) this.ltypes.set(key, { name: t.name, description: t.description, pattern: t.pattern });
      BAD_CHARS.lastIndex = 0;
    }
    this.styles = new Map([['STANDARD', { name: 'Standard', font: 'txt', widthFactor: 1, fixedTextHeight: 0 }]]);
    for (const s of d.styles ?? []) if (s.name && !this.styles.has(s.name.toUpperCase())) this.styles.set(s.name.toUpperCase(), s);
    this.dimstyles = new Map([['STANDARD', { name: 'Standard' }]]);
    for (const s of d.dimstyles ?? []) if (s.name && !this.dimstyles.has(s.name.toUpperCase())) this.dimstyles.set(s.name.toUpperCase(), s);
    // Anything referenced but missing from the tables is added, so every reference resolves.
    const visit = (e) => {
      addLayer(e.layer ?? '0');
      const lt = e.lineType;
      if (lt && !this.ltypes.has(lt.toUpperCase())) this.ltypes.set(lt.toUpperCase(), { name: lt, pattern: [] });
      const st = e.styleName ?? e.text?.styleName;
      if (typeof st === 'string' && st && ['TEXT', 'MTEXT', 'ATTRIB', 'ATTDEF'].includes(e.type) && !this.styles.has(st.toUpperCase())) this.styles.set(st.toUpperCase(), { name: st, font: 'txt' });
      if (typeof st === 'string' && st && (e.type?.includes('DIMENSION') || e.type === 'LEADER' || e.type === 'TOLERANCE') && !this.dimstyles.has(st.toUpperCase())) this.dimstyles.set(st.toUpperCase(), { name: st });
      for (const a of e.attribs ?? []) visit(a);
    };
    for (const e of d.modelEntities) visit(e);
    for (const l of this.layouts) for (const e of l.entities) visit(e);
    for (const b of d.blocks.values()) for (const e of b.entities) visit(e);
    for (const { l } of this.layers.values()) {
      const lt = l?.ltype;
      if (lt && !this.ltypes.has(lt.toUpperCase())) this.ltypes.set(lt.toUpperCase(), { name: lt, pattern: [] });
    }
  }

  ltypeName(name) {
    if (!name || /^bylayer$/i.test(name)) return null;
    return this.ltypes.get(name.toUpperCase())?.name ?? null;
  }

  styleName(name) {
    return (name && this.styles.get(String(name).toUpperCase())?.name) || 'Standard';
  }

  dimstyleName(name) {
    return (name && this.dimstyles.get(String(name).toUpperCase())?.name) || 'Standard';
  }

  // ------------------------------------------------------------ main
  write() {
    this.setupNames();
    this.scanHandles();
    this.collectTables();
    // Fixed structure handles first, so tables and objects can point at each other.
    const H = (this.H = {});
    for (const k of ['vportTable', 'ltypeTable', 'layerTable', 'styleTable', 'viewTable', 'ucsTable', 'appidTable', 'dimstyleTable', 'brTable',
      'root', 'groupDict', 'layoutDict', 'materialDict', 'mlsDict', 'plotSettingsDict', 'psnDict', 'placeholder', 'scaleDict', 'tableStyleDict', 'visualStyleDict', 'colorDict', 'mleaderDict',
      'matByBlock', 'matByLayer', 'matGlobal', 'mlsStandard', 'vportActive', 'modelBR', 'modelBlock', 'modelEnd', 'modelLayout']) H[k] = this.newHandle();
    for (const l of this.layouts) { l.br = this.newHandle(); l.block = this.newHandle(); l.end = this.newHandle(); l.layout = this.newHandle(); }
    this.blockList = [];
    for (const b of this.d.blocks.values()) {
      if (this.spaceBlocks.has(b)) continue;
      this.blockList.push({ b, name: this.blockName(b.name), br: this.newHandle(), block: this.newHandle(), end: this.newHandle() });
    }
    this.brByName = new Map(this.blockList.map((x) => [x.name.toUpperCase(), x]));
    this.extraBlocks = []; // blocks created while writing (e.g. for special dimensions)

    // Entities are written before the tables and header, which need what the entities used.
    const ents = new Out();
    this.writeList(ents, this.d.modelEntities, H.modelBR, false);
    const active = this.layouts.find((l) => l.active);
    this.writeList(ents, active.entities, active.br, true);
    const blocks = this.writeBlocks();

    const out = new Out();
    this.writeHeader(out);
    this.writeClasses(out);
    this.writeTables(out);
    out.s(0, 'SECTION'); out.s(2, 'BLOCKS');
    const head = out.text();
    const tail = new Out();
    tail.s(0, 'ENDSEC');
    tail.s(0, 'SECTION'); tail.s(2, 'ENTITIES');
    const mid = tail.text();
    const end = new Out();
    end.s(0, 'ENDSEC');
    this.writeObjects(end);
    end.s(0, 'EOF');
    // Large drawings have millions of lines: join the sections separately.
    return { text: head + blocks.text() + mid + ents.text() + end.text(), report: this.report };
  }

  writeBlocks() {
    const out = new Out();
    const H = this.H;
    this.blockEntry(out, { name: '*Model_Space', br: H.modelBR, block: H.modelBlock, end: H.modelEnd, base: null, flags: 0, paper: false }, null);
    for (const l of this.layouts) {
      this.blockEntry(out, { name: l.blockName, br: l.br, block: l.block, end: l.end, base: null, flags: 0, paper: true }, l.active ? null : l.entities);
    }
    for (const x of this.blockList) {
      const ents = x.b.entities;
      const flags = (x.name.startsWith('*') ? 1 : 0) | (ents.some((e) => e.type === 'ATTDEF') ? 2 : 0);
      this.blockEntry(out, { name: x.name, br: x.br, block: x.block, end: x.end, base: x.b.base, flags, paper: false }, ents);
    }
    // Blocks made while writing the entities above (they may add more: loop until done).
    for (let i = 0; i < this.extraBlocks.length; i++) {
      const x = this.extraBlocks[i];
      this.blockEntry(out, { name: x.name, br: x.br, block: x.block, end: x.end, base: x.base, flags: 1, paper: false }, x.entities);
    }
    return out;
  }

  blockEntry(out, x, entities) {
    out.s(0, 'BLOCK'); out.h(5, x.block); out.h(330, x.br); out.s(100, 'AcDbEntity');
    if (x.paper) out.i(67, 1);
    out.s(8, '0'); out.s(100, 'AcDbBlockBegin'); out.s(2, x.name); out.i(70, x.flags);
    out.p(10, x.base ?? { x: 0, y: 0, z: 0 }); out.s(3, x.name); out.s(1, '');
    if (entities) this.writeList(out, entities, x.br, x.paper);
    out.s(0, 'ENDBLK'); out.h(5, x.end); out.h(330, x.br); out.s(100, 'AcDbEntity');
    if (x.paper) out.i(67, 1);
    out.s(8, '0'); out.s(100, 'AcDbBlockEnd');
  }

  writeList(out, list, owner, paper) {
    for (const e of list) {
      try {
        this.entity(out, e, owner, paper);
      } catch (err) {
        this.report.skip(`${e.type} (${err.message})`);
      }
    }
  }

  // ------------------------------------------------------------ entities
  /** Common entity part; returns the entity's handle. */
  head(out, type, e, owner, paper, handle = this.entityHandle(e)) {
    out.s(0, type); out.h(5, handle); out.h(330, owner); out.s(100, 'AcDbEntity');
    if (paper) out.i(67, 1);
    out.s(8, this.layerName(e.layer));
    const lt = this.ltypeName(e.lineType);
    if (lt) out.s(6, lt);
    const hasTrue = typeof e.color === 'number' && e.color >= 0;
    const ci = Math.abs(e.colorIndex ?? 256);
    if (hasTrue) {
      out.i(62, ci >= 1 && ci <= 255 ? ci : nearestAci(e.color));
      out.i(420, e.color & 0xffffff);
    } else if (ci !== 256 && ci <= 256) out.i(62, ci);
    const lw = this.lineweight(e.lineweight);
    if (lw !== -1) out.i(370, lw);
    if (e.lineTypeScale && e.lineTypeScale !== 1) out.n(48, e.lineTypeScale);
    if (e.isVisible === false) out.i(60, 1);
    this.report.written++;
    return handle;
  }

  lineweight(raw) {
    const mm = lineweightToMm(raw, this.source);
    if (mm === LW_BYLAYER) return -1;
    if (mm === LW_BYBLOCK) return -2;
    if (mm === LW_DEFAULT || mm < 0) return -3;
    const v = mm * 100;
    return VALID_LW.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));
  }

  ext(out, e, key = 'extrusionDirection') {
    const x = e[key];
    if (x && (Math.abs(x.x ?? 0) > 1e-12 || Math.abs(x.y ?? 0) > 1e-12 || (x.z ?? 1) < 0)) {
      const l = Math.hypot(x.x ?? 0, x.y ?? 0, x.z ?? 1) || 1;
      out.p(210, { x: (x.x ?? 0) / l, y: (x.y ?? 0) / l, z: (x.z ?? 1) / l });
    }
  }

  entity(out, e, owner, paper) {
    const t = e.type;
    if (SKIPPED_TYPES.has(t) || t?.startsWith('DGN_')) { this.report.skip(t); return; }
    const w = this.writers[t];
    if (w) { w.call(this, out, e, owner, paper); return; }
    if (t?.includes('DIMENSION')) { this.specialDimension(out, e, owner, paper); return; }
    this.report.skip(t || 'unknown');
  }

  get writers() { return WRITERS; }

  /** Writes substitute entities (with new handles) in place of an entity DXF cannot hold as read. */
  substitutes(out, list, owner, paper, what) {
    if (!list.length) { this.report.skip(what); return; }
    for (const s of list) { s.handle = ''; this.entity(out, s, owner, paper); }
    this.report.convert(CONVERSIONS[what] ?? what);
  }

  specialDimension(out, e, owner, paper) {
    if (e.name && this.d.blocks.has(e.name)) {
      this.insertOf(out, e, this.blockName(e.name), owner, paper);
      this.report.convert(CONVERSIONS.DIMBLOCK);
    } else this.report.skip(e.type);
  }

  /** An INSERT of a block at its base point (identity placement), with e's properties. */
  insertOf(out, e, blockName, owner, paper) {
    const block = [...this.d.blocks.values()].find((b) => this.blockName(b.name) === blockName);
    this.head(out, 'INSERT', e, owner, paper, this.newHandle());
    out.s(100, 'AcDbBlockReference'); out.s(2, blockName); out.p(10, block?.base ?? { x: 0, y: 0, z: 0 });
  }

  text(out, e, base, kind, owner, paper) {
    // TEXT, ATTRIB and ATTDEF share the AcDbText part.
    let s = str(base.text);
    if (s.length > 255) s = s.slice(0, 255);
    out.s(100, 'AcDbText');
    out.p(10, base.startPoint);
    out.n(40, base.textHeight > 0 ? base.textHeight : 1);
    out.s(1, s);
    if (base.rotation) out.n(50, normDeg(base.rotation));
    if ((base.xScale ?? 1) !== 1 && base.xScale > 0) out.n(41, base.xScale);
    if (base.obliqueAngle) out.n(51, normDeg(base.obliqueAngle));
    out.s(7, this.styleName(base.styleName));
    if (base.generationFlag) out.i(71, base.generationFlag);
    const ha = base.halign ?? 0, va = base.valign ?? 0;
    if (ha) out.i(72, ha);
    if (ha || va) {
      const ep = base.endPoint && (base.endPoint.x || base.endPoint.y) ? base.endPoint : base.startPoint;
      out.p(11, ep);
    }
    this.ext(out, base.extrusionDirection ? base : e);
    if (kind === 'TEXT') { out.s(100, 'AcDbText'); if (va) out.i(73, va); }
  }
}

function normDeg(rad) {
  let d = (rad * DEG) % 360;
  if (d < 0) d += 360;
  return Math.abs(d - 360) < 1e-10 ? 0 : d;
}

function mtextChunks(s) {
  const out = [];
  for (let i = 0; i < s.length; i += 250) out.push(s.slice(i, i + 250));
  return out.length ? out : [''];
}

/** Clamped uniform knot vector for n control points of a degree. */
function clampedKnots(n, p) {
  const k = [];
  for (let i = 0; i <= n + p; i++) k.push(i <= p ? 0 : i >= n ? n - p : i - p);
  return k;
}

const WRITERS = {
  LINE(out, e, owner, paper) {
    this.head(out, 'LINE', e, owner, paper);
    out.s(100, 'AcDbLine'); out.p(10, e.startPoint); out.p(11, e.endPoint); this.ext(out, e);
  },
  POINT(out, e, owner, paper) {
    this.head(out, 'POINT', e, owner, paper);
    out.s(100, 'AcDbPoint'); out.p(10, e.position); this.ext(out, e);
  },
  CIRCLE(out, e, owner, paper) {
    if (!(e.radius > 0)) { this.report.skip('CIRCLE (zero radius)'); return; }
    this.head(out, 'CIRCLE', e, owner, paper);
    out.s(100, 'AcDbCircle'); out.p(10, e.center); out.n(40, e.radius); this.ext(out, e);
  },
  ARC(out, e, owner, paper) {
    if (!(e.radius > 0)) { this.report.skip('ARC (zero radius)'); return; }
    this.head(out, 'ARC', e, owner, paper);
    out.s(100, 'AcDbCircle'); out.p(10, e.center); out.n(40, e.radius); this.ext(out, e);
    out.s(100, 'AcDbArc'); out.n(50, normDeg(e.startAngle ?? 0)); out.n(51, normDeg(e.endAngle ?? 0));
  },
  ELLIPSE(out, e, owner, paper) {
    let m = { ...e.majorAxisEndPoint }, ratio = e.axisRatio ?? 1, t0 = e.startAngle ?? 0, t1 = e.endAngle ?? TAU;
    if (!(Math.hypot(m.x, m.y, m.z ?? 0) > 0) || !(ratio > 0)) { this.report.skip('ELLIPSE (degenerate)'); return; }
    if (ratio > 1) {
      // DXF needs ratio <= 1: the minor axis becomes the major one.
      m = { x: -m.y * ratio, y: m.x * ratio, z: 0 };
      ratio = 1 / ratio;
      t0 -= Math.PI / 2; t1 -= Math.PI / 2;
    }
    const full = Math.abs(Math.abs(t1 - t0) - TAU) < 1e-9 || (t0 === 0 && t1 === 0);
    this.head(out, 'ELLIPSE', e, owner, paper);
    out.s(100, 'AcDbEllipse'); out.p(10, e.center); out.p(11, m);
    out.p(210, e.extrusionDirection ?? { x: 0, y: 0, z: 1 });
    out.n(40, Math.max(1e-6, ratio));
    if (full) { out.n(41, 0); out.n(42, TAU); } else { out.n(41, ((t0 % TAU) + TAU) % TAU); out.n(42, ((t1 % TAU) + TAU) % TAU || TAU); }
  },
  LWPOLYLINE(out, e, owner, paper) {
    const verts = e.vertices ?? [];
    if (verts.length < 2) { this.report.skip('LWPOLYLINE (fewer than 2 vertices)'); return; }
    this.head(out, 'LWPOLYLINE', e, owner, paper);
    out.s(100, 'AcDbPolyline'); out.i(90, verts.length); out.i(70, (e.flag ?? 0) & 129);
    const perVertex = verts.some((v) => v.startWidth || v.endWidth);
    if (e.constantWidth && !perVertex) out.n(43, e.constantWidth);
    if (e.elevation) out.n(38, e.elevation);
    for (const v of verts) {
      out.n(10, v.x); out.n(20, v.y);
      if (perVertex) { out.n(40, v.startWidth || 0); out.n(41, v.endWidth || 0); }
      if (v.bulge) out.n(42, v.bulge);
    }
    this.ext(out, e);
  },
  POLYLINE2D(out, e, owner, paper) { polyline.call(this, out, e, owner, paper, '2d'); },
  POLYLINE3D(out, e, owner, paper) { polyline.call(this, out, e, owner, paper, '3d'); },
  POLYFACE(out, e, owner, paper) { polyline.call(this, out, e, owner, paper, 'face'); },
  POLYGONMESH(out, e, owner, paper) {
    const n = (e.vertices ?? []).length;
    const M = e.meshMVertexCount, N = e.meshNVertexCount;
    if (M >= 2 && N >= 2 && M * N === n) { polyline.call(this, out, e, owner, paper, 'mesh'); return; }
    // Unknown mesh size: the vertices as one 3D polyline.
    this.substitutes(out, [{ ...e, type: 'POLYLINE3D', flag: 0 }], owner, paper, 'MESH');
  },
  SPLINE(out, e, owner, paper) {
    const cps = e.controlPoints ?? [], fits = e.fitPoints ?? [];
    let degree = e.degree || 3;
    if (cps.length < 2 && fits.length < 2) { this.report.skip('SPLINE (no points)'); return; }
    let knots = e.knots ?? [];
    if (cps.length >= 2) {
      degree = Math.min(degree, cps.length - 1);
      if (knots.length !== cps.length + degree + 1) knots = clampedKnots(cps.length, degree);
    } else knots = [];
    const weights = cps.length && (e.weights ?? []).length === cps.length && e.weights.some((w) => w !== 1) ? e.weights : null;
    let flag = (e.flag ?? 0) & ~4;
    if (weights) flag |= 4;
    flag |= 8; // planar
    this.head(out, 'SPLINE', e, owner, paper);
    out.s(100, 'AcDbSpline');
    out.p(210, e.normal ?? { x: 0, y: 0, z: 1 });
    out.i(70, flag); out.i(71, degree); out.i(72, knots.length); out.i(73, cps.length); out.i(74, cps.length ? 0 : fits.length);
    out.n(42, 1e-10); out.n(43, 1e-10);
    if (!cps.length) out.n(44, 1e-10);
    for (const k of knots) out.n(40, k);
    if (weights) for (const w of weights) out.n(41, w);
    for (const p of cps) out.p(10, p);
    if (!cps.length) {
      if (e.startTangent) out.p(12, e.startTangent);
      if (e.endTangent) out.p(13, e.endTangent);
      for (const p of fits) out.p(11, p);
    }
  },
  TEXT(out, e, owner, paper) {
    if (!String(e.text ?? '').length) { this.report.skip('TEXT (empty)'); return; }
    this.head(out, 'TEXT', e, owner, paper);
    this.text(out, e, e, 'TEXT', owner, paper);
  },
  ATTDEF(out, e, owner, paper) {
    const t = e.text ?? {};
    this.head(out, 'ATTDEF', e, owner, paper);
    this.text(out, e, t, 'ATTDEF', owner, paper);
    out.s(100, 'AcDbAttributeDefinition'); out.i(280, 0);
    out.s(3, e.prompt ?? ''); out.s(2, (e.tag || 'TAG').replace(/\s/g, '_')); out.i(70, (e.flags ?? 0) & 15);
    out.i(73, e.fieldLength ?? 0);
    if (t.valign) out.i(74, t.valign);
    out.i(280, e.lockPositionFlag ? 1 : 0);
  },
  MTEXT(out, e, owner, paper) {
    this.head(out, 'MTEXT', e, owner, paper);
    out.s(100, 'AcDbMText'); out.p(10, e.insertionPoint);
    out.n(40, e.textHeight > 0 ? e.textHeight : 1);
    out.n(41, e.rectWidth > 0 ? e.rectWidth : 0);
    out.i(71, e.attachmentPoint >= 1 && e.attachmentPoint <= 9 ? e.attachmentPoint : 1);
    out.i(72, e.drawingDirection === 3 ? 3 : e.drawingDirection === 5 ? 5 : 1);
    const content = String(e.text ?? '').replace(/\r\n|\r|\n/g, '\\P');
    const chunks = mtextChunks(content);
    for (let i = 0; i < chunks.length - 1; i++) out.add(3, chunks[i]);
    out.add(1, chunks[chunks.length - 1]);
    out.s(7, this.styleName(e.styleName));
    this.ext(out, e);
    if (e.direction && (e.direction.x || e.direction.y)) out.p(11, { x: e.direction.x, y: e.direction.y, z: 0 });
    else out.n(50, normDeg(e.rotation || 0));
    out.i(73, e.lineSpacingStyle === 2 ? 2 : 1);
    out.n(44, e.lineSpacing > 0 ? Math.min(4, Math.max(0.25, e.lineSpacing)) : 1);
  },
  INSERT(out, e, owner, paper) {
    const blockName = this.blockName(e.blockName ?? e.name);
    if (!this.brByName.has(blockName.toUpperCase())) { this.report.skip(`INSERT (missing block ${e.name})`); return; }
    const attribs = (e.attribs ?? []).filter((a) => a.text);
    const h = this.head(out, 'INSERT', e, owner, paper);
    out.s(100, 'AcDbBlockReference');
    if (attribs.length) out.i(66, 1);
    out.s(2, blockName); out.p(10, e.insertionPoint);
    const sx = e.xScale ?? 1, sy = e.yScale ?? 1, sz = e.zScale ?? 1;
    if (sx !== 1) out.n(41, sx || 1);
    if (sy !== 1) out.n(42, sy || 1);
    if (sz !== 1) out.n(43, sz || 1);
    if (e.rotation) out.n(50, normDeg(e.rotation));
    const cols = e.columnCount || 1, rows = e.rowCount || 1;
    if (cols > 1) out.i(70, cols);
    if (rows > 1) out.i(71, rows);
    if (cols > 1 && e.columnSpacing) out.n(44, e.columnSpacing);
    if (rows > 1 && e.rowSpacing) out.n(45, e.rowSpacing);
    this.ext(out, e);
    if (!attribs.length) return;
    for (const a of attribs) {
      this.head(out, 'ATTRIB', a, h, paper);
      this.text(out, a, a.text, 'ATTRIB', h, paper);
      out.s(100, 'AcDbAttribute'); out.i(280, 0);
      out.s(2, (a.tag || 'TAG').replace(/\s/g, '_')); out.i(70, (a.flags ?? 0) & 15);
      out.i(73, a.fieldLength ?? 0);
      if (a.text.valign) out.i(74, a.text.valign);
      out.i(280, a.lockPositionFlag ? 1 : 0);
    }
    out.s(0, 'SEQEND'); out.h(5, this.newHandle()); out.h(330, h); out.s(100, 'AcDbEntity');
    if (paper) out.i(67, 1);
    out.s(8, this.layerName(e.layer));
  },
  DIMENSION(out, e, owner, paper) {
    const block = e.name && this.d.blocks.has(e.name) ? this.blockName(e.name) : null;
    if (!block) { this.report.skip('DIMENSION (no graphics block)'); return; }
    const kind = (e.dimensionType ?? 0) & 7;
    this.head(out, 'DIMENSION', e, owner, paper);
    out.s(100, 'AcDbDimension'); out.i(280, 0); out.s(2, block);
    out.p(10, e.definitionPoint); out.p(11, e.textPoint);
    out.i(70, ((e.dimensionType ?? 0) & 0xff) | 32);
    out.i(71, e.attachmentPoint >= 1 && e.attachmentPoint <= 9 ? e.attachmentPoint : 5);
    out.i(72, e.textLineSpacingStyle === 2 ? 2 : 1);
    out.n(41, e.textLineSpacingFactor > 0 ? e.textLineSpacingFactor : 1);
    if (Number.isFinite(e.measurement)) out.n(42, e.measurement);
    out.s(1, e.text ?? '');
    if (e.textRotation) out.n(53, normDeg(e.textRotation));
    this.ext(out, e);
    out.s(3, this.dimstyleName(e.styleName));
    if (kind === 0 || kind === 1) {
      out.s(100, 'AcDbAlignedDimension'); out.p(13, e.subDefinitionPoint1); out.p(14, e.subDefinitionPoint2);
      if (kind === 0) { out.n(50, normDeg(e.rotationAngle ?? 0)); if (e.obliqueAngle) out.n(52, normDeg(e.obliqueAngle)); out.s(100, 'AcDbRotatedDimension'); }
    } else if (kind === 2) {
      out.s(100, 'AcDb2LineAngularDimension'); out.p(13, e.subDefinitionPoint1); out.p(14, e.subDefinitionPoint2); out.p(15, e.centerPoint); out.p(16, e.arcPoint);
    } else if (kind === 5) {
      out.s(100, 'AcDb3PointAngularDimension'); out.p(13, e.subDefinitionPoint1); out.p(14, e.subDefinitionPoint2); out.p(15, e.centerPoint);
    } else if (kind === 3 || kind === 4) {
      out.s(100, kind === 3 ? 'AcDbDiametricDimension' : 'AcDbRadialDimension'); out.p(15, e.centerPoint); out.n(40, e.leaderLength ?? 0);
    } else if (kind === 6) {
      out.s(100, 'AcDbOrdinateDimension'); out.p(13, e.subDefinitionPoint1); out.p(14, e.subDefinitionPoint2);
    }
  },
  LEADER(out, e, owner, paper) {
    const v = e.vertices ?? [];
    if (v.length < 2) { this.report.skip('LEADER (fewer than 2 vertices)'); return; }
    this.head(out, 'LEADER', e, owner, paper);
    out.s(100, 'AcDbLeader'); out.s(3, this.dimstyleName(e.styleName));
    out.i(71, e.isArrowheadEnabled === false ? 0 : 1); out.i(72, e.isSpline ? 1 : 0);
    out.i(73, 3); out.i(74, 0); out.i(75, 0); out.n(40, 0); out.n(41, 0);
    out.i(76, v.length);
    for (const p of v) out.p(10, p);
  },
  HATCH(out, e, owner, paper) {
    const paths = (e.boundaryPaths ?? []).filter((p) => (p.vertices ? p.vertices.length >= 2 : (p.edges ?? []).length));
    if (!paths.length) { this.report.skip('HATCH (no boundary)'); return; }
    const solid = e.solidFill === 1 || /^solid$/i.test(e.patternName || '');
    const gradient = e.gradientFlag === 1;
    let defs = e.definitionLines ?? [];
    let name = solid || gradient ? 'SOLID' : (e.patternName || 'USER').replace(BAD_CHARS, '_');
    let ptype = e.patternType ?? 1;
    if (!solid && !gradient && !defs.length) {
      // No pattern lines were read: a user-defined 45 degree hatch keeps it visible.
      const bb = [Infinity, Infinity, -Infinity, -Infinity];
      for (const p of paths) for (const q of p.vertices ?? p.edges.flatMap((g) => [g.start, g.end, g.center].filter(Boolean))) {
        bb[0] = Math.min(bb[0], q.x); bb[1] = Math.min(bb[1], q.y); bb[2] = Math.max(bb[2], q.x); bb[3] = Math.max(bb[3], q.y);
      }
      const sp = Math.max(bb[2] - bb[0], bb[3] - bb[1]) / 40 || 1;
      defs = [{ angle: Math.PI / 4, base: { x: 0, y: 0 }, offset: { x: -sp * Math.SQRT1_2, y: sp * Math.SQRT1_2 }, dashLengths: [] }];
      name = 'USER'; ptype = 0;
    }
    this.head(out, 'HATCH', e, owner, paper);
    out.s(100, 'AcDbHatch');
    out.p(10, { x: 0, y: 0, z: e.elevation ?? 0 });
    out.p(210, e.extrusionDirection ?? { x: 0, y: 0, z: 1 });
    out.s(2, name); out.i(70, solid || gradient ? 1 : 0); out.i(71, 0);
    out.i(91, paths.length);
    for (const p of paths) {
      if (p.vertices) {
        out.i(92, ((p.boundaryPathTypeFlag ?? 1) | 2) & 0x1f);
        const bulges = p.vertices.some((v) => v.bulge);
        out.i(72, bulges ? 1 : 0); out.i(73, p.isClosed === false ? 0 : 1); out.i(93, p.vertices.length);
        for (const v of p.vertices) { out.n(10, v.x); out.n(20, v.y); if (bulges) out.n(42, v.bulge || 0); }
      } else {
        out.i(92, (p.boundaryPathTypeFlag ?? 1) & ~2 & 0x1f);
        out.i(93, p.edges.length);
        for (const g of p.edges) {
          out.i(72, g.type);
          if (g.type === 1) { out.n(10, g.start.x); out.n(20, g.start.y); out.n(11, g.end.x); out.n(21, g.end.y); }
          else if (g.type === 2) {
            out.n(10, g.center.x); out.n(20, g.center.y); out.n(40, g.radius);
            out.n(50, g.startAngle * DEG); out.n(51, g.endAngle * DEG); out.i(73, g.isCCW === false ? 0 : 1);
          } else if (g.type === 3) {
            out.n(10, g.center.x); out.n(20, g.center.y); out.n(11, g.end.x); out.n(21, g.end.y); out.n(40, g.lengthOfMinorAxis);
            out.n(50, g.startAngle * DEG); out.n(51, g.endAngle * DEG); out.i(73, g.isCCW === false ? 0 : 1);
          } else if (g.type === 4) {
            const cps = g.controlPoints ?? [];
            const deg = Math.max(1, Math.min(g.degree || 3, Math.max(1, cps.length - 1)));
            const knots = (g.knots ?? []).length === cps.length + deg + 1 ? g.knots : clampedKnots(cps.length, deg);
            const rational = cps.some((c) => c.weight !== undefined && c.weight !== 1);
            out.i(94, deg); out.i(73, rational ? 1 : 0); out.i(74, g.isPeriodic ? 1 : 0);
            out.i(95, knots.length); out.i(96, cps.length);
            for (const k of knots) out.n(40, k);
            for (const c of cps) { out.n(10, c.x); out.n(20, c.y); if (rational) out.n(42, c.weight ?? 1); }
            const fit = g.fitDatum ?? [];
            out.i(97, fit.length);
            for (const f of fit) { out.n(11, f.x); out.n(21, f.y); }
            if (fit.length) {
              const st = g.startTangent ?? { x: 0, y: 0 }, et = g.endTangent ?? { x: 0, y: 0 };
              out.n(12, st.x); out.n(22, st.y); out.n(13, et.x); out.n(23, et.y);
            }
          }
        }
      }
      out.i(97, 0);
    }
    out.i(75, e.hatchStyle ?? 0); out.i(76, solid || gradient ? 1 : ptype);
    if (!solid && !gradient) {
      out.n(52, normDeg(e.patternAngle ?? 0)); out.n(41, e.patternScale > 0 ? e.patternScale : 1); out.i(77, 0);
      out.i(78, defs.length);
      for (const d of defs) {
        out.n(53, normDeg(d.angle ?? 0)); out.n(43, d.base?.x ?? 0); out.n(44, d.base?.y ?? 0); out.n(45, d.offset?.x ?? 0); out.n(46, d.offset?.y ?? 0);
        const dashes = (d.dashLengths ?? []).filter(Number.isFinite);
        out.i(79, dashes.length);
        for (const v of dashes) out.n(49, v);
      }
    }
    const seeds = e.seedPoints ?? [];
    out.i(98, seeds.length);
    for (const s of seeds) { out.n(10, s.x); out.n(20, s.y); }
    if (gradient) {
      const colors = e.gradientColors?.length ? e.gradientColors.map((c) => c.rgb & 0xffffff)
        : [typeof e.gradientRgb === 'number' ? e.gradientRgb : 0x0000ff, 0xffffff];
      while (colors.length < 2) colors.push(0xffffff);
      out.i(450, 1); out.i(451, 0); out.i(452, e.gradientColorFlag === 1 ? 1 : 0); out.i(453, 2);
      out.n(460, e.gradientRotation ?? 0); out.n(461, e.gradientDefinition ?? 0); out.n(462, e.colorTint ?? 0);
      colors.slice(0, 2).forEach((c, k) => { out.n(463, k); out.i(63, nearestAci(c)); out.i(421, c); });
      out.s(470, e.gradientName || 'LINEAR');
    }
  },
  SOLID(out, e, owner, paper) { solid.call(this, out, e, owner, paper, 'SOLID'); },
  TRACE(out, e, owner, paper) { solid.call(this, out, e, owner, paper, 'TRACE'); },
  '3DFACE'(out, e, owner, paper) {
    this.head(out, '3DFACE', e, owner, paper);
    out.s(100, 'AcDbFace');
    out.p(10, e.corner1); out.p(11, e.corner2); out.p(12, e.corner3); out.p(13, e.corner4 ?? e.corner3);
    out.i(70, (e.flag ?? 0) & 15);
  },
  XLINE(out, e, owner, paper) {
    this.head(out, 'XLINE', e, owner, paper);
    out.s(100, 'AcDbXline'); out.p(10, e.firstPoint); out.p(11, e.unitDirection);
  },
  RAY(out, e, owner, paper) {
    this.head(out, 'RAY', e, owner, paper);
    out.s(100, 'AcDbRay'); out.p(10, e.firstPoint); out.p(11, e.unitDirection);
  },
  TOLERANCE(out, e, owner, paper) {
    if (!e.text || !e.insertionPoint) { this.report.skip('TOLERANCE (empty)'); return; }
    this.head(out, 'TOLERANCE', e, owner, paper);
    out.s(100, 'AcDbFcf'); out.s(3, this.dimstyleName(e.styleName)); out.p(10, e.insertionPoint); out.s(1, e.text);
    this.ext(out, e);
    out.p(11, e.xAxisDirection ?? { x: 1, y: 0, z: 0 });
  },
  WIPEOUT(out, e, owner, paper) {
    const pts = e.clippingBoundaryPath?.length ? e.clippingBoundaryPath : e.boundaryPoints ?? [];
    if (!e.position || !e.uPixel || !e.vPixel) { this.report.skip('WIPEOUT (no frame)'); return; }
    this.usesWipeout = true;
    this.head(out, 'WIPEOUT', e, owner, paper);
    out.s(100, 'AcDbWipeout'); out.i(90, 0);
    out.p(10, e.position); out.p(11, e.uPixel); out.p(12, e.vPixel);
    out.n(13, e.imageSize?.x ?? 1); out.n(23, e.imageSize?.y ?? 1);
    out.h(340, '0'); out.i(70, 7); out.i(280, 1); out.i(281, 50); out.i(282, 50); out.i(283, 0); out.h(360, '0');
    const rect = pts.length === 2;
    out.i(71, rect ? 1 : 2); out.i(91, pts.length);
    for (const p of pts) { out.n(14, p.x); out.n(24, p.y); }
  },
  IMAGE(out, e, owner, paper) {
    // The image file itself is not part of the drawing data: its frame keeps the layout.
    const pos = e.position, u = e.uPixel, v = e.vPixel;
    if (!pos || !u || !v) { this.report.skip('IMAGE'); return; }
    const size = e.imageSize ?? { x: 1, y: 1 };
    const corner = (px, py) => ({ x: pos.x + u.x * px + v.x * py, y: pos.y + u.y * px + v.y * py, bulge: 0 });
    const frame = { ...e, type: 'LWPOLYLINE', flag: 1, vertices: [corner(0, 0), corner(size.x, 0), corner(size.x, size.y), corner(0, size.y)] };
    this.substitutes(out, [frame], owner, paper, 'IMAGE');
  },
  VIEWPORT(out, e, owner, paper) {
    if (!paper) { this.report.skip('VIEWPORT (in model space)'); return; }
    this.head(out, 'VIEWPORT', e, owner, true);
    out.s(100, 'AcDbViewport');
    out.p(10, e.viewportCenter); out.n(40, e.width ?? 0); out.n(41, e.height ?? 0);
    out.i(68, e.status ?? 1); out.i(69, e.viewportId ?? 2);
    out.n(12, (e.viewCenter ?? e.displayCenter)?.x ?? 0); out.n(22, (e.viewCenter ?? e.displayCenter)?.y ?? 0);
    out.n(13, e.snapBase?.x ?? 0); out.n(23, e.snapBase?.y ?? 0);
    out.n(14, e.snapSpacing?.x ?? 10); out.n(24, e.snapSpacing?.y ?? 10);
    out.n(15, e.gridSpacing?.x ?? 10); out.n(25, e.gridSpacing?.y ?? 10);
    out.p(16, e.viewDirection ?? { x: 0, y: 0, z: 1 }); out.p(17, e.targetPoint ?? { x: 0, y: 0, z: 0 });
    out.n(42, e.perspectiveLensLength ?? 50); out.n(43, e.frontClipZ ?? 0); out.n(44, e.backClipZ ?? 0);
    out.n(45, e.viewHeight > 0 ? e.viewHeight : e.height || 1);
    out.n(50, normDeg(e.snapAngle ?? 0)); out.n(51, normDeg(e.viewTwistAngle ?? 0)); out.i(72, e.circleZoomPercent ?? 1000);
    out.i(90, e.statusBitFlags ?? 32864); out.s(1, ''); out.i(281, e.renderMode ?? 0);
    out.i(71, 1); out.i(74, 0);
    out.p(110, e.ucsOrigin ?? { x: 0, y: 0, z: 0 }); out.p(111, e.ucsXAxis ?? { x: 1, y: 0, z: 0 }); out.p(112, e.ucsYAxis ?? { x: 0, y: 1, z: 0 });
    out.i(79, 0); out.n(146, e.elevation ?? 0); out.i(170, 0); out.i(61, 5);
  },
  ACAD_TABLE(out, e, owner, paper) {
    const name = e.blockName || this.d.tableBlocks?.get(e);
    if (!name || !this.d.blocks.has(name)) { this.report.skip('ACAD_TABLE (no graphics block)'); return; }
    this.insertOf(out, e, this.blockName(name), owner, paper);
    this.report.convert(CONVERSIONS.ACAD_TABLE);
  },
  MULTILEADER(out, e, owner, paper) {
    this.substitutes(out, multileaderParts(e, { arrowSize: this.d.header?.DIMASZ }), owner, paper, 'MULTILEADER');
  },
  MLINE(out, e, owner, paper) {
    this.substitutes(out, mlineToPolylines(e), owner, paper, 'MLINE');
  },
};

function solid(out, e, owner, paper, type) {
  this.head(out, type, e, owner, paper);
  out.s(100, 'AcDbTrace');
  out.p(10, e.corner1); out.p(11, e.corner2); out.p(12, e.corner3); out.p(13, e.corner4 ?? e.corner3);
  this.ext(out, e);
}

function polyline(out, e, owner, paper, kind) {
  let verts = e.vertices ?? [];
  if (kind === '2d' || kind === '3d') verts = verts.filter((v) => !((v.flag ?? 0) & 16));
  if (verts.length < 2) { this.report.skip(`${e.type} (fewer than 2 vertices)`); return; }
  const h = this.head(out, 'POLYLINE', e, owner, paper);
  const sub = { '2d': 'AcDb2dPolyline', '3d': 'AcDb3dPolyline', face: 'AcDbPolyFaceMesh', mesh: 'AcDbPolygonMesh' }[kind];
  out.s(100, sub); out.i(66, 1);
  out.p(10, { x: 0, y: 0, z: kind === '2d' ? e.elevation ?? 0 : 0 });
  const base = (e.flag ?? 0) & ~(8 | 16 | 64);
  const flag = kind === '3d' ? base | 8 : kind === 'face' ? (base & ~1) | 64 : kind === 'mesh' ? base | 16 : base;
  out.i(70, flag & 255);
  if (kind === '2d') {
    if (e.startWidth) out.n(40, e.startWidth);
    if (e.endWidth) out.n(41, e.endWidth);
  }
  if (kind === 'face') {
    out.i(71, verts.filter((v) => (v.flag ?? 0) & 64).length);
    out.i(72, verts.filter((v) => (v.flag ?? 0) & 128 && !((v.flag ?? 0) & 64)).length);
  } else if (kind === 'mesh') {
    out.i(71, e.meshMVertexCount); out.i(72, e.meshNVertexCount);
  }
  if (e.smoothType) out.i(75, e.smoothType);
  if (kind === '2d') this.ext(out, e);
  const vsub = { '2d': 'AcDb2dVertex', '3d': 'AcDb3dPolylineVertex', mesh: 'AcDbPolygonMeshVertex' }[kind];
  for (const v of verts) {
    out.s(0, 'VERTEX'); out.h(5, this.newHandle()); out.h(330, h); out.s(100, 'AcDbEntity');
    if (paper) out.i(67, 1);
    out.s(8, this.layerName(e.layer));
    out.s(100, 'AcDbVertex');
    const vf = v.flag ?? 0;
    if (kind === 'face') {
      const isPos = vf & 64;
      out.s(100, isPos ? 'AcDbPolyFaceMeshVertex' : 'AcDbFaceRecord');
      out.p(10, isPos ? v : { x: 0, y: 0, z: 0 });
      out.i(70, isPos ? 192 : 128);
      if (!isPos) for (const [code, k] of [[71, 'polyfaceIndex0'], [72, 'polyfaceIndex1'], [73, 'polyfaceIndex2'], [74, 'polyfaceIndex3']]) if (v[k]) out.i(code, v[k]);
      continue;
    }
    out.s(100, vsub);
    out.p(10, v);
    if (kind === '2d') {
      if (v.startWidth) out.n(40, v.startWidth);
      if (v.endWidth) out.n(41, v.endWidth);
      if (v.bulge) out.n(42, v.bulge);
      out.i(70, vf & ~(32 | 64 | 128));
    } else out.i(70, kind === '3d' ? 32 : 64);
  }
  out.s(0, 'SEQEND'); out.h(5, this.newHandle()); out.h(330, h); out.s(100, 'AcDbEntity');
  if (paper) out.i(67, 1);
  out.s(8, this.layerName(e.layer));
}

// ------------------------------------------------------------------ header, classes, tables, objects
Object.assign(DxfWriter.prototype, {
  extents() {
    if (this.opts.extents) return this.opts.extents;
    const bb = [Infinity, Infinity, -Infinity, -Infinity];
    const add = (p, r = 0) => {
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
      bb[0] = Math.min(bb[0], p.x - r); bb[1] = Math.min(bb[1], p.y - r); bb[2] = Math.max(bb[2], p.x + r); bb[3] = Math.max(bb[3], p.y + r);
    };
    for (const e of this.d.modelEntities) {
      add(e.startPoint); add(e.endPoint); add(e.center, e.radius || 0); add(e.insertionPoint); add(e.position);
      for (const v of e.vertices ?? []) add(v.vertex ?? v);
    }
    return Number.isFinite(bb[0]) ? bb : [0, 0, 0, 0];
  },

  writeHeader(out) {
    const hd = this.d.header ?? {};
    const numOr = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
    const [x0, y0, x1, y1] = this.extents();
    const units = this.d.units ?? 0;
    const clayer = hd.CLAYER && this.layers.has(this.layerName(hd.CLAYER).toUpperCase()) ? this.layerName(hd.CLAYER) : '0';
    const dimstyle = this.dimstyleName(typeof hd.DIMSTYLE === 'string' ? hd.DIMSTYLE : 'Standard');
    const textStyle = this.styleName(typeof hd.TEXTSTYLE === 'string' ? hd.TEXTSTYLE : 'Standard');
    const v = (name, code, value) => { out.s(9, `$${name}`); if (code === 'pt') { out.n(10, value[0]); out.n(20, value[1]); out.n(30, value[2] ?? 0); } else if (code === 'pt2') { out.n(10, value[0]); out.n(20, value[1]); } else if (typeof value === 'number' && [10, 40].includes(Math.floor(code / 10) * 10) && code >= 40 && code < 60) out.n(code, value); else out.add(code, typeof value === 'number' ? (code >= 40 && code < 60 ? num(value) : int(value)) : str(value)); };
    out.s(0, 'SECTION'); out.s(2, 'HEADER');
    v('ACADVER', 1, 'AC1027');
    v('ACADMAINTVER', 70, 105);
    v('DWGCODEPAGE', 3, 'ANSI_1252');
    v('INSBASE', 'pt', [0, 0, 0]);
    v('EXTMIN', 'pt', [x0, y0, 0]);
    v('EXTMAX', 'pt', [x1, y1, 0]);
    v('LIMMIN', 'pt2', [0, 0]);
    v('LIMMAX', 'pt2', [420, 297]);
    v('ORTHOMODE', 70, 0);
    v('REGENMODE', 70, 1);
    v('FILLMODE', 70, 1);
    v('QTEXTMODE', 70, 0);
    v('MIRRTEXT', 70, 0);
    v('LTSCALE', 40, numOr(hd.LTSCALE, 1) || 1);
    v('ATTMODE', 70, 1);
    v('TEXTSIZE', 40, numOr(hd.TEXTSIZE, 2.5) || 2.5);
    v('TEXTSTYLE', 7, textStyle);
    v('CLAYER', 8, clayer);
    v('CELTYPE', 6, 'ByLayer');
    v('CECOLOR', 62, 256);
    v('CELTSCALE', 40, 1);
    v('DIMSCALE', 40, numOr(hd.DIMSCALE, 1) || 1);
    v('DIMASZ', 40, numOr(hd.DIMASZ, 2.5));
    v('DIMTXT', 40, numOr(hd.DIMTXT, 2.5));
    v('DIMSTYLE', 2, dimstyle);
    v('LUNITS', 70, numOr(hd.LUNITS, 2));
    v('LUPREC', 70, numOr(hd.LUPREC, 4));
    v('AUNITS', 70, numOr(hd.AUNITS, 0));
    v('AUPREC', 70, numOr(hd.AUPREC, 0));
    v('PDMODE', 70, numOr(hd.PDMODE, 0));
    v('PDSIZE', 40, numOr(hd.PDSIZE, 0));
    v('PLINEWID', 40, 0);
    v('HANDSEED', 5, this.next.toString(16).toUpperCase());
    v('TILEMODE', 70, 1);
    v('PSLTSCALE', 70, 1);
    v('CMLSTYLE', 2, 'Standard');
    v('MEASUREMENT', 70, [1, 2, 3, 10].includes(units) ? 0 : 1);
    v('CELWEIGHT', 370, -1);
    v('LWDISPLAY', 290, 0);
    v('INSUNITS', 70, units);
    v('PSTYLEMODE', 290, 1);
    v('DIMASSOC', 280, 2);
    out.s(0, 'ENDSEC');
  },

  writeClasses(out) {
    out.s(0, 'SECTION'); out.s(2, 'CLASSES');
    const cls = (name, cpp, app, flags, entity) => { out.s(0, 'CLASS'); out.s(1, name); out.s(2, cpp); out.s(3, app); out.i(90, flags); out.i(91, 0); out.i(280, 0); out.i(281, entity ? 1 : 0); };
    cls('ACDBDICTIONARYWDFLT', 'AcDbDictionaryWithDefault', 'ObjectDBX Classes', 0);
    cls('MATERIAL', 'AcDbMaterial', 'ObjectDBX Classes', 1153);
    cls('ACDBPLACEHOLDER', 'AcDbPlaceHolder', 'ObjectDBX Classes', 0);
    cls('LAYOUT', 'AcDbLayout', 'ObjectDBX Classes', 0);
    if (this.usesWipeout) cls('WIPEOUT', 'AcDbWipeout', 'WipeOut|AutoCAD Express Tool|expresstools@autodesk.com', 127, true);
    out.s(0, 'ENDSEC');
  },

  table(out, name, handle, count) {
    out.s(0, 'TABLE'); out.s(2, name); out.h(5, handle); out.h(330, '0'); out.s(100, 'AcDbSymbolTable'); out.i(70, count);
  },

  record(out, type, owner, sub, handleCode = 5) {
    const h = this.newHandle();
    out.s(0, type); out.h(handleCode, h); out.h(330, owner); out.s(100, 'AcDbSymbolTableRecord'); out.s(100, sub);
    return h;
  },

  writeTables(out) {
    const H = this.H;
    out.s(0, 'SECTION'); out.s(2, 'TABLES');
    // VPORT: one *Active viewport framing the model extents.
    const [x0, y0, x1, y1] = this.extents();
    this.table(out, 'VPORT', H.vportTable, 1);
    out.s(0, 'VPORT'); out.h(5, H.vportActive); out.h(330, H.vportTable); out.s(100, 'AcDbSymbolTableRecord'); out.s(100, 'AcDbViewportTableRecord');
    out.s(2, '*Active'); out.i(70, 0);
    out.n(10, 0); out.n(20, 0); out.n(11, 1); out.n(21, 1);
    out.n(12, (x0 + x1) / 2); out.n(22, (y0 + y1) / 2);
    out.n(13, 0); out.n(23, 0); out.n(14, 10); out.n(24, 10); out.n(15, 10); out.n(25, 10);
    out.n(16, 0); out.n(26, 0); out.n(36, 1); out.n(17, 0); out.n(27, 0); out.n(37, 0);
    out.n(40, Math.max(y1 - y0, (x1 - x0) / 1.6, 1e-6) * 1.1); out.n(41, 1.6); out.n(42, 50); out.n(43, 0); out.n(44, 0); out.n(50, 0); out.n(51, 0);
    out.i(71, 0); out.i(72, 1000); out.i(73, 1); out.i(74, 3); out.i(75, 0); out.i(76, 0); out.i(77, 0); out.i(78, 0);
    out.i(281, 0); out.i(65, 0); out.n(146, 0);
    out.s(0, 'ENDTAB');

    this.table(out, 'LTYPE', H.ltypeTable, this.ltypes.size);
    for (const t of this.ltypes.values()) {
      this.record(out, 'LTYPE', H.ltypeTable, 'AcDbLinetypeTableRecord');
      const pattern = (t.pattern ?? []).map((p) => (typeof p === 'number' ? p : p.elementLength ?? 0)).filter(Number.isFinite);
      out.s(2, t.name); out.i(70, 0); out.s(3, t.description ?? ''); out.i(72, 65); out.i(73, pattern.length);
      out.n(40, pattern.reduce((a, v) => a + Math.abs(v), 0));
      for (const v of pattern) { out.n(49, v); out.i(74, 0); }
    }
    out.s(0, 'ENDTAB');

    this.table(out, 'LAYER', H.layerTable, this.layers.size);
    for (const { name, l } of this.layers.values()) {
      this.record(out, 'LAYER', H.layerTable, 'AcDbLayerTableRecord');
      out.s(2, name);
      out.i(70, (l?.frozen ? 1 : 0) | (l?.locked ? 4 : 0));
      const aci = l?.aci >= 1 && l.aci <= 255 ? l.aci : 7;
      out.i(62, l && l.on === false ? -aci : aci);
      if (typeof l?.trueColor === 'number') out.i(420, l.trueColor & 0xffffff);
      out.s(6, this.ltypeName(l?.ltype) && !/^by(layer|block)$/i.test(l.ltype) ? this.ltypeName(l.ltype) : 'Continuous');
      if (l?.plot === false || /^defpoints$/i.test(name)) out.i(290, 0);
      const lw = l && l.lw >= 0 ? VALID_LW.reduce((a, b) => (Math.abs(b - l.lw * 100) < Math.abs(a - l.lw * 100) ? b : a)) : -3;
      out.i(370, lw);
      out.h(390, H.placeholder);
      out.h(347, H.matGlobal);
    }
    out.s(0, 'ENDTAB');

    this.table(out, 'STYLE', H.styleTable, this.styles.size);
    for (const s of this.styles.values()) {
      this.record(out, 'STYLE', H.styleTable, 'AcDbTextStyleTableRecord');
      out.s(2, s.name); out.i(70, 0); out.n(40, s.fixedTextHeight > 0 ? s.fixedTextHeight : 0);
      out.n(41, s.widthFactor > 0 ? s.widthFactor : 1); out.n(50, s.obliqueAngle ? normDeg(s.obliqueAngle) : 0); out.i(71, 0);
      out.n(42, s.lastHeight > 0 ? s.lastHeight : 2.5); out.s(3, s.font || 'txt'); out.s(4, s.bigFont || '');
    }
    out.s(0, 'ENDTAB');

    this.table(out, 'VIEW', H.viewTable, 0); out.s(0, 'ENDTAB');
    this.table(out, 'UCS', H.ucsTable, 0); out.s(0, 'ENDTAB');

    this.table(out, 'APPID', H.appidTable, 1);
    this.record(out, 'APPID', H.appidTable, 'AcDbRegAppTableRecord');
    out.s(2, 'ACAD'); out.i(70, 0);
    out.s(0, 'ENDTAB');

    this.table(out, 'DIMSTYLE', H.dimstyleTable, this.dimstyles.size);
    out.s(100, 'AcDbDimStyleTable');
    const hd = this.d.header ?? {};
    for (const s of this.dimstyles.values()) {
      this.record(out, 'DIMSTYLE', H.dimstyleTable, 'AcDbDimStyleTableRecord', 105);
      const val = (k, d) => (typeof s[k] === 'number' && Number.isFinite(s[k]) ? s[k] : typeof hd[k] === 'number' && Number.isFinite(hd[k]) ? hd[k] : d);
      out.s(2, s.name); out.i(70, 0);
      out.n(40, val('DIMSCALE', 1) || 1); out.n(41, val('DIMASZ', 2.5)); out.n(42, val('DIMEXO', 0.625)); out.n(43, val('DIMDLI', 3.75));
      out.n(44, val('DIMEXE', 1.25)); out.n(140, val('DIMTXT', 2.5)); out.n(141, val('DIMCEN', 2.5)); out.n(147, val('DIMGAP', 0.625));
      out.i(77, val('DIMTAD', 1)); out.i(78, val('DIMZIN', 8)); out.i(271, val('DIMDEC', 2)); out.i(277, val('DIMLUNIT', 2)); out.i(278, val('DIMDSEP', 44));
    }
    out.s(0, 'ENDTAB');

    const total = 1 + this.layouts.length + this.blockList.length + this.extraBlocks.length;
    this.table(out, 'BLOCK_RECORD', H.brTable, total);
    const br = (handle, name, layout) => {
      out.s(0, 'BLOCK_RECORD'); out.h(5, handle); out.h(330, H.brTable); out.s(100, 'AcDbSymbolTableRecord'); out.s(100, 'AcDbBlockTableRecord');
      out.s(2, name); out.h(340, layout || '0'); out.i(70, 0); out.i(280, 1); out.i(281, 0);
    };
    br(H.modelBR, '*Model_Space', H.modelLayout);
    for (const l of this.layouts) br(l.br, l.blockName, l.layout);
    for (const x of this.blockList) br(x.br, x.name, null);
    for (const x of this.extraBlocks) br(x.br, x.name, null);
    out.s(0, 'ENDTAB');
    out.s(0, 'ENDSEC');
  },

  writeObjects(out) {
    const H = this.H;
    out.s(0, 'SECTION'); out.s(2, 'OBJECTS');
    const dict = (handle, owner, entries, type = 'DICTIONARY') => {
      out.s(0, type); out.h(5, handle); out.h(330, owner); out.s(100, 'AcDbDictionary'); out.i(281, 1);
      for (const [k, v] of entries) { out.s(3, k); out.h(350, v); }
    };
    dict(H.root, '0', [['ACAD_COLOR', H.colorDict], ['ACAD_GROUP', H.groupDict], ['ACAD_LAYOUT', H.layoutDict], ['ACAD_MATERIAL', H.materialDict],
      ['ACAD_MLEADERSTYLE', H.mleaderDict], ['ACAD_MLINESTYLE', H.mlsDict], ['ACAD_PLOTSETTINGS', H.plotSettingsDict], ['ACAD_PLOTSTYLENAME', H.psnDict],
      ['ACAD_SCALELIST', H.scaleDict], ['ACAD_TABLESTYLE', H.tableStyleDict], ['ACAD_VISUALSTYLE', H.visualStyleDict]]);
    dict(H.colorDict, H.root, []);
    dict(H.groupDict, H.root, []);
    dict(H.layoutDict, H.root, [['Model', H.modelLayout], ...this.layouts.map((l) => [l.name, l.layout])]);
    dict(H.materialDict, H.root, [['ByBlock', H.matByBlock], ['ByLayer', H.matByLayer], ['Global', H.matGlobal]]);
    dict(H.mleaderDict, H.root, []);
    dict(H.mlsDict, H.root, [['Standard', H.mlsStandard]]);
    dict(H.plotSettingsDict, H.root, []);
    dict(H.psnDict, H.root, [['Normal', H.placeholder]], 'ACDBDICTIONARYWDFLT');
    out.s(100, 'AcDbDictionaryWithDefault'); out.h(340, H.placeholder);
    out.s(0, 'ACDBPLACEHOLDER'); out.h(5, H.placeholder); out.h(330, H.psnDict);
    dict(H.scaleDict, H.root, []);
    dict(H.tableStyleDict, H.root, []);
    dict(H.visualStyleDict, H.root, []);
    const layout = (handle, name, tab, br, limits, model) => {
      out.s(0, 'LAYOUT'); out.h(5, handle); out.s(102, '{ACAD_REACTORS'); out.h(330, H.layoutDict); out.s(102, '}'); out.h(330, H.layoutDict);
      out.s(100, 'AcDbPlotSettings'); out.s(1, ''); out.s(2, 'none_device'); out.s(4, 'ISO_A3_(420.00_x_297.00_MM)'); out.s(6, '');
      out.n(40, 7.5); out.n(41, 20); out.n(42, 7.5); out.n(43, 20); out.n(44, 420); out.n(45, 297);
      out.n(46, 0); out.n(47, 0); out.n(48, 0); out.n(49, 0); out.n(140, 0); out.n(141, 0); out.n(142, 1); out.n(143, 1);
      out.i(70, model ? 1024 : 0); out.i(72, 1); out.i(73, 0); out.i(74, 5); out.s(7, ''); out.i(75, 16); out.i(76, 0); out.i(77, 2); out.i(78, 300);
      out.n(147, 1); out.n(148, 0); out.n(149, 0);
      out.s(100, 'AcDbLayout'); out.s(1, name); out.i(70, 1); out.i(71, tab);
      const lo = limits?.[0], hi = limits?.[1];
      out.n(10, lo?.x ?? 0); out.n(20, lo?.y ?? 0); out.n(11, hi?.x ?? 420); out.n(21, hi?.y ?? 297);
      out.p(12, { x: 0, y: 0, z: 0 }); out.p(14, { x: 1e20, y: 1e20, z: 1e20 }); out.p(15, { x: -1e20, y: -1e20, z: -1e20 });
      out.n(146, 0); out.p(13, { x: 0, y: 0, z: 0 }); out.p(16, { x: 1, y: 0, z: 0 }); out.p(17, { x: 0, y: 1, z: 0 });
      out.i(76, 1); out.h(330, br);
    };
    layout(H.modelLayout, 'Model', 0, H.modelBR, null, true);
    this.layouts.forEach((l, i) => layout(l.layout, l.name, i + 1, l.br, l.def.limits, false));
    for (const [name, h] of [['ByBlock', H.matByBlock], ['ByLayer', H.matByLayer], ['Global', H.matGlobal]]) {
      out.s(0, 'MATERIAL'); out.h(5, h); out.s(102, '{ACAD_REACTORS'); out.h(330, H.materialDict); out.s(102, '}'); out.h(330, H.materialDict);
      out.raw(MATERIAL_BODY.replace('{NAME}', name));
    }
    out.s(0, 'MLINESTYLE'); out.h(5, H.mlsStandard); out.s(102, '{ACAD_REACTORS'); out.h(330, H.mlsDict); out.s(102, '}'); out.h(330, H.mlsDict);
    out.s(100, 'AcDbMlineStyle'); out.s(2, 'Standard'); out.i(70, 0); out.s(3, ''); out.i(62, 256); out.n(51, 90); out.n(52, 90); out.i(71, 2);
    out.n(49, 0.5); out.i(62, 256); out.s(6, 'BYLAYER'); out.n(49, -0.5); out.i(62, 256); out.s(6, 'BYLAYER');
    out.s(0, 'ENDSEC');
  },
});
