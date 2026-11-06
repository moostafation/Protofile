// PCF (Piping Component File) reader: the isometric exchange format written by AVEVA E3D/PDMS,
// AutoCAD Plant 3D, SmartPlant/S3D, CADWorx and others and read by ISOGEN.
//
// A PCF is line based. Header lines (ISOGEN-FILES, UNITS-BORE, UNITS-CO-ORDS, UNITS-WEIGHT…)
// come first; PIPELINE-REFERENCE starts a pipeline whose indented lines are its attributes;
// every other keyword at the start of a line starts a component (PIPE, ELBOW, TEE, FLANGE,
// VALVE…) whose indented lines are its attributes: END-POINT x y z bore, CENTRE-POINT x y z,
// BRANCH1-POINT x y z bore, CO-ORDS x y z (supports, welds), SKEY, ITEM-CODE, ITEM-DESCRIPTION…
// An optional MATERIALS section maps ITEM-CODE to DESCRIPTION.
import { FormatError } from './errors.js';

/** Millimetres per unit, for UNITS-CO-ORDS and UNITS-BORE. */
const UNIT_MM = { MM: 1, MILLIMETRE: 1, MILLIMETER: 1, CM: 10, M: 1000, METRE: 1000, METER: 1000, INCH: 25.4, INCHES: 25.4, IN: 25.4, 'INCH-SIXTEENTH': 25.4 / 16, FOOT: 304.8, FEET: 304.8, FT: 304.8 };
const UNIT_LABEL = { MM: 'mm', MILLIMETRE: 'mm', MILLIMETER: 'mm', CM: 'cm', M: 'm', METRE: 'm', METER: 'm', INCH: 'in', INCHES: 'in', IN: 'in', 'INCH-SIXTEENTH': 'in/16', FOOT: 'ft', FEET: 'ft', FT: 'ft' };

/** Attribute keywords that some writers put at the start of the line (not indented). */
const ATTR_AT_COL0 = /^(END-POINT|CENTRE-POINT|CENTER-POINT|BRANCH\d-POINT|CO-ORDS|SKEY|ITEM-CODE|ITEM-DESCRIPTION|WEIGHT|ANGLE|BEND-RADIUS|UCI|FABRICATION-ITEM|ERECTION-ITEM|COMPONENT-[A-Z0-9-]+|MATERIAL-[A-Z-]+|SPINDLE-DIRECTION|FLAT-DIRECTION|SUPPORT-[A-Z-]+|BOLT-[A-Z-]+|CUT-PIECE-LENGTH|PIPING-SPEC|TAG|NAME)$/;

/** Components that are annotations or connections, not parts of the piping (no BOM line, no solid). */
export const NON_PHYSICAL = /^(END-CONNECTION|END-POSITION|MESSAGE|ISOGEN|TEXT|DIMENSION|CONTINUATION|INSTRUMENT-DIAL|SPOOL|CUT-PIECE|ITEM-)/;

/** BOM category of a component type. */
export function categoryOf(type) {
  if (/^PIPE/.test(type)) return 'Pipe';
  if (/^(FLANGE|LAP-JOINT-RING)/.test(type)) return 'Flanges';
  if (/^GASKET/.test(type)) return 'Gaskets';
  if (/^BOLT/.test(type)) return 'Bolts';
  if (/^VALVE/.test(type)) return 'Valves';
  if (/^INSTRUMENT/.test(type)) return 'Instruments';
  if (/^SUPPORT/.test(type)) return 'Supports';
  if (/^WELD/.test(type)) return 'Welds';
  if (/^(ELBOW|BEND|TEE|OLET|CROSS|REDUCER|CAP|COUPLING|UNION|Y-PIECE|LAP-JOINT|SWAGE|PLUG|NIPPLE|STUB|LATERAL|ELBOLET|SWEEPOLET)/.test(type)) return 'Fittings';
  return 'Specials';
}
const CATEGORY_ORDER = ['Pipe', 'Fittings', 'Flanges', 'Gaskets', 'Bolts', 'Valves', 'Instruments', 'Specials', 'Supports', 'Welds'];

function decode(input) {
  if (typeof input === 'string') return input;
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('latin1').decode(bytes); // older Windows writers
  }
}

/** "x y z [bore] [more]" -> { x, y, z, bore } or null. */
export function parsePoint(text) {
  const nums = [];
  for (const tok of String(text).trim().split(/\s+/)) {
    const v = Number(tok.replace(/(MM|IN|")$/i, ''));
    if (!Number.isFinite(v)) break;
    nums.push(v);
  }
  if (nums.length < 3) return null;
  return { x: nums[0], y: nums[1], z: nums[2], bore: nums.length > 3 ? nums[3] : null };
}

/** True when the first bytes look like a PCF (for format sniffing). */
export function looksLikePcf(head) {
  return /(^|\n)\s*(ISOGEN-FILES|UNITS-CO-ORDS|UNITS-BORE|PIPELINE-REFERENCE)\b/.test(head) && !/^\s*ISO-10303-21/.test(head);
}

/**
 * Parses a PCF.
 * @param {string|ArrayBuffer|Uint8Array} input
 * @returns {{ header, units, pipelines, components, materials: Map<string, string>, warnings: string[] }}
 */
export function parsePcf(input) {
  const text = decode(input);
  const header = {};
  const pipelines = [];
  const components = [];
  const materials = new Map();
  const warnings = [];
  let pipeline = null;
  let cur = null; // pipeline or component receiving indented attributes
  let section = 'header';
  let mat = null;
  const lines = text.split(/\r?\n|\r/);
  for (let ln = 0; ln < lines.length; ln++) {
    const raw = lines[ln];
    if (!raw.trim()) continue;
    const indented = /^[ \t]/.test(raw);
    const line = raw.trim();
    const sp = line.search(/\s/);
    const key = (sp < 0 ? line : line.slice(0, sp)).toUpperCase();
    const rest = sp < 0 ? '' : line.slice(sp + 1).trim();
    if (section === 'materials') {
      if (!indented && key === 'ITEM-CODE') { mat = { code: rest, desc: '' }; materials.set(rest, ''); continue; }
      if (indented && mat) {
        if (key === 'DESCRIPTION') materials.set(mat.code, mat.desc = mat.desc ? `${mat.desc} ${rest}` : rest);
        continue;
      }
      if (indented) continue;
      // A component or pipeline after MATERIALS (unusual): fall through.
      section = 'body';
    }
    if (indented) {
      if (cur) cur.attrs.push([key, rest]);
      else header[key] = rest;
      continue;
    }
    if (key === 'MATERIALS') { section = 'materials'; cur = null; continue; }
    if (key === 'PIPELINE-REFERENCE') {
      pipeline = { ref: rest || `Pipeline ${pipelines.length + 1}`, attrs: [], components: [] };
      pipelines.push(pipeline);
      cur = pipeline;
      section = 'body';
      continue;
    }
    if (!pipeline && (key.startsWith('UNITS-') || key === 'ISOGEN-FILES' || section === 'header' && !cur && /^[A-Z][A-Z0-9-]*$/.test(key) && !rest.match(/^-?\d/) && isHeaderKey(key))) {
      header[key] = rest;
      continue;
    }
    if (cur?.type && ATTR_AT_COL0.test(key)) { cur.attrs.push([key, rest]); continue; }
    if (!/^[A-Z][A-Z0-9-]*$/.test(key)) { warnings.push(`line ${ln + 1}: ${line.slice(0, 40)}`); continue; }
    if (!pipeline) {
      pipeline = { ref: '(no pipeline reference)', attrs: [], components: [] };
      pipelines.push(pipeline);
    }
    const comp = { type: key, attrs: [], pipeline: pipeline.ref, line: ln + 1, extra: rest };
    pipeline.components.push(comp);
    components.push(comp);
    cur = comp;
    section = 'body';
  }
  for (const c of components) finishComponent(c, materials);
  // An olet's centre point sits on its header pipe: the header gives its first size (150 × 50).
  for (const c of components) {
    if (!/OLET/.test(c.type) || !c.centre || c.centre.bore > 0) continue;
    const host = components.find((p) => p !== c && p.pipeline === c.pipeline && p.endPoints.length >= 2 && p.bore > 0 && onSegment(c.centre, p.endPoints[0], p.endPoints[1]));
    if (host) {
      c.headerBore = host.bore;
      c.bores = [...new Set([host.bore, ...c.bores])];
      c.bore = Math.max(c.bore ?? 0, host.bore);
    }
  }
  const units = unitsOf(header);
  if (!components.some((c) => c.endPoints.length || c.coords)) {
    throw new FormatError('No piping components with coordinates were found in this file (it may not be a PCF, or it is empty).');
  }
  return { header, units, pipelines, components, materials, warnings };
}

/** True when point p lies on segment a-b (within a small tolerance). */
function onSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  const L2 = dx * dx + dy * dy + dz * dz;
  if (!(L2 > 0)) return false;
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy + (p.z - a.z) * dz) / L2;
  if (t < -1e-6 || t > 1 + 1e-6) return false;
  const tol = Math.max(1e-3, Math.sqrt(L2) * 1e-5);
  return Math.hypot(a.x + dx * t - p.x, a.y + dy * t - p.y, a.z + dz * t - p.z) <= tol;
}

function isHeaderKey(key) {
  return /^(ISOGEN-FILES|UNITS-|PROJECT|DATE|REVISION|SPEC|PIPING-SPEC)/.test(key);
}

function unitsOf(header) {
  const co = String(header['UNITS-CO-ORDS'] ?? 'MM').toUpperCase().split(/\s+/)[0];
  const bo = String(header['UNITS-BORE'] ?? co).toUpperCase().split(/\s+/)[0];
  return {
    coords: UNIT_LABEL[co] ? co : 'MM',
    bore: UNIT_LABEL[bo] ? bo : 'MM',
    coordMm: UNIT_MM[co] ?? 1,
    boreMm: UNIT_MM[bo] ?? 1,
    coordLabel: UNIT_LABEL[co] ?? 'mm',
    weight: header['UNITS-WEIGHT'] ?? null,
  };
}

function finishComponent(c, materials) {
  const get = (k) => c.attrs.find(([a]) => a === k)?.[1];
  c.endPoints = c.attrs.filter(([a]) => a === 'END-POINT').map(([, v]) => parsePoint(v)).filter(Boolean);
  c.centre = parsePoint(get('CENTRE-POINT') ?? get('CENTER-POINT') ?? '');
  c.branches = c.attrs.filter(([a]) => /^BRANCH\d-POINT$/.test(a)).map(([, v]) => parsePoint(v)).filter(Boolean);
  c.coords = parsePoint(get('CO-ORDS') ?? '');
  c.skey = get('SKEY') ?? '';
  c.itemCode = get('ITEM-CODE') ?? '';
  c.description = get('ITEM-DESCRIPTION') ?? (c.itemCode && materials.get(c.itemCode)) ?? '';
  c.tag = get('TAG') ?? get('COMPONENT-TAG') ?? get('NAME') ?? get('COMPONENT-IDENTIFIER') ?? '';
  const bores = [...c.endPoints, ...c.branches, c.coords].filter((p) => p && p.bore > 0).map((p) => p.bore);
  c.bore = bores.length ? Math.max(...bores) : null;
  c.bores = [...new Set(bores)];
  c.category = categoryOf(c.type);
  c.physical = !NON_PHYSICAL.test(c.type);
}

const fmt = (v, d = 1) => (Number.isInteger(v) ? String(v) : String(+v.toFixed(d)));

/** Nominal size label of a bore in the file's bore units: 150 mm, 6", 3/4". */
export function sizeLabel(bore, units) {
  if (!(bore > 0)) return '';
  if (units.bore === 'INCH-SIXTEENTH') bore /= 16;
  if (units.boreMm === 25.4 || units.bore === 'INCH-SIXTEENTH') {
    const whole = Math.floor(bore + 1e-6), frac = bore - whole;
    const f = [[0.125, '1/8'], [0.25, '1/4'], [0.375, '3/8'], [0.5, '1/2'], [0.75, '3/4']].find(([v]) => Math.abs(frac - v) < 0.01);
    if (f) return `${whole ? whole + '-' : ''}${f[1]}"`;
    return `${fmt(bore, 2)}"`;
  }
  return `${fmt(bore)} ${UNIT_LABEL[units.bore] ?? 'mm'}`;
}

/** Size of a component: "150 mm", or "150 × 100 mm" for reducing items. */
export function componentSize(c, units) {
  if (c.type === 'BOLT' || c.type.startsWith('BOLT')) {
    const d = c.attrs.find(([a]) => a === 'BOLT-DIA')?.[1], l = c.attrs.find(([a]) => a === 'BOLT-LENGTH')?.[1];
    if (d) return `${d}${l ? ' × ' + l : ''}`;
  }
  const b = c.bores.slice().sort((a, z) => z - a);
  if (!b.length) return '';
  if (b.length === 1) return sizeLabel(b[0], units);
  const unit = units.boreMm === 25.4 || units.bore === 'INCH-SIXTEENTH' ? '' : ` ${UNIT_LABEL[units.bore] ?? 'mm'}`;
  return b.map((x) => sizeLabel(x, units).replace(/ \S+$/, '')).join(' × ') + unit;
}

/** Length of a component along its run (pipes: end to end), in coordinate units. */
export function componentLength(c) {
  const [a, b] = c.endPoints;
  if (!a || !b) return 0;
  return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
}

/** Length unit for the BOM: metres for metric files, feet for imperial ones. */
function lengthUnit(units) {
  return units.coordMm === 25.4 || units.coordMm === 304.8 ? { label: 'ft', perUnit: units.coordMm / 304.8 } : { label: 'm', perUnit: units.coordMm / 1000 };
}

/**
 * Bill of materials: one row per item code (or type + SKEY + size when there is none), pipe as
 * total length, everything else counted; plus the pipe length per nominal size.
 * @param {ReturnType<typeof parsePcf>} pcf
 * @param {{ pipeline?: string|null }} [opts] only the components of this pipeline
 */
export function pcfBom(pcf, opts = {}) {
  const lu = lengthUnit(pcf.units);
  const rows = new Map();
  const perBore = new Map();
  for (const c of pcf.components) {
    if (!c.physical) continue;
    if (opts.pipeline && c.pipeline !== opts.pipeline) continue;
    const size = componentSize(c, pcf.units);
    const key = c.itemCode ? `code:${c.itemCode}|${size}` : `${c.type}|${c.skey}|${size}`;
    let r = rows.get(key);
    if (!r) {
      const desc = c.description || [c.type.replace(/-/g, ' ').toLowerCase().replace(/^./, (s) => s.toUpperCase()), c.skey].filter(Boolean).join(' ');
      rows.set(key, r = { category: c.category, itemCode: c.itemCode, description: desc, size, qty: 0, unit: c.category === 'Pipe' ? lu.label : 'pcs', pipelines: new Set(), bore: c.bore ?? 0 });
    }
    r.pipelines.add(c.pipeline);
    if (c.category === 'Pipe') {
      const L = componentLength(c) * lu.perUnit;
      r.qty += L;
      const bk = c.bore ?? 0;
      perBore.set(bk, (perBore.get(bk) ?? 0) + L);
    } else {
      const q = Number(c.attrs.find(([a]) => a === 'BOLT-QUANTITY' || a === 'QUANTITY')?.[1]);
      r.qty += Number.isFinite(q) && q > 0 ? q : 1;
    }
  }
  const list = [...rows.values()].sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) || b.bore - a.bore || a.itemCode.localeCompare(b.itemCode) || a.description.localeCompare(b.description));
  for (const r of list) {
    if (r.unit !== 'pcs') r.qty = Math.round(r.qty * 1000) / 1000;
    r.pipelines = [...r.pipelines];
  }
  const pipeLengths = [...perBore.entries()].sort((a, b) => b[0] - a[0]).map(([bore, length]) => ({ bore, size: sizeLabel(bore, pcf.units) || '(no size)', length: Math.round(length * 1000) / 1000, unit: lu.label }));
  const total = pipeLengths.reduce((s, p) => s + p.length, 0);
  return { rows: list, pipeLengths, totalPipe: Math.round(total * 1000) / 1000, lengthUnit: lu.label };
}

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** The BOM as CSV (bill of materials, then pipe length per size). */
export function pcfBomCsv(bom, title = '') {
  const out = [];
  if (title) out.push(csvCell(title), '');
  out.push(['Category', 'Item code', 'Description', 'Size', 'Quantity', 'Unit', 'Pipelines'].join(','));
  for (const r of bom.rows) out.push([r.category, r.itemCode, r.description, r.size, r.qty, r.unit, r.pipelines.join(' ')].map(csvCell).join(','));
  out.push('', 'Pipe length per size', ['Size', 'Length', 'Unit'].join(','));
  for (const p of bom.pipeLengths) out.push([p.size, p.length, p.unit].map(csvCell).join(','));
  out.push(['Total', bom.totalPipe, bom.lengthUnit].map(csvCell).join(','));
  return out.join('\r\n') + '\r\n';
}
