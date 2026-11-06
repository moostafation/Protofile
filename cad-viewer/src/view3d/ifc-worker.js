// Reads IFC (IFC2x3, IFC4, IFC4x3) off the main thread with web-ifc (WebAssembly, MPL-2.0):
// geometry merged by material (repeated geometry instanced), the spatial structure
// (Project / Site / Building / Storey / elements), element attributes, materials, type objects and
// pipe/duct lengths from quantity sets. The model stays open for property and search requests
// until the worker is terminated (when another file is opened).
import * as W from 'web-ifc';
import wasmUrl from 'web-ifc/web-ifc.wasm?url';
import { MergeBuilder, transferables } from './merge.js';

let api = null;
let modelID = -1;
let ready = null;
const elementOf = new Map(); // expressID -> element index
let elements = [];
let searchIndex = null;

function init() {
  ready ??= (async () => {
    const a = new W.IfcAPI();
    await a.Init((path) => (path.endsWith('.wasm') ? wasmUrl : path), true);
    try { a.SetLogLevel(W.LogLevel?.LOG_LEVEL_OFF ?? 6); } catch { /* older versions */ }
    api = a;
  })();
  return ready;
}

const val = (x) => (x && typeof x === 'object' && 'value' in x ? x.value : x);
const typeName = (id) => { try { return api.GetNameFromTypeCode(api.GetLineType(modelID, id)); } catch { return 'IfcProduct'; } };
const line = (id, flatten = false) => { try { return api.GetLine(modelID, id, flatten); } catch { return null; } };
const ids = (type) => { const v = api.GetLineIDsWithType(modelID, type); const out = []; for (let i = 0; i < v.size(); i++) out.push(v.get(i)); return out; };
const refs = (x) => (Array.isArray(x) ? x : x ? [x] : []).map(val).filter((v) => typeof v === 'number');

/** Length unit of the project: label and units per metre. */
function lengthUnit() {
  const PREFIX = { EXA: 1e18, PETA: 1e15, TERA: 1e12, GIGA: 1e9, MEGA: 1e6, KILO: 1e3, HECTO: 100, DECA: 10, DECI: 0.1, CENTI: 0.01, MILLI: 0.001, MICRO: 1e-6, NANO: 1e-9 };
  const LABEL = { 1: 'm', 0.001: 'mm', 0.01: 'cm', 0.1: 'dm', 1000: 'km' };
  for (const ua of ids(W.IFCUNITASSIGNMENT)) {
    const l = line(ua);
    for (const r of refs(l?.Units)) {
      const u = line(r);
      if (!u || val(u.UnitType) !== 'LENGTHUNIT') continue;
      const name = String(val(u.Name) ?? '').toUpperCase();
      if (name === 'METRE' || name === 'METER') {
        const m = PREFIX[val(u.Prefix)] ?? 1;
        return { label: LABEL[m] ?? `${m} m`, perMeter: 1 / m };
      }
      if (/FOOT|FEET/.test(name)) return { label: 'ft', perMeter: 1 / 0.3048 };
      if (/INCH/.test(name)) return { label: 'in', perMeter: 1 / 0.0254 };
      // Other conversion-based units: the conversion factor to metres when it is given.
      const f = line(refs(u.ConversionFactor)[0]);
      const k = Number(val(f?.ValueComponent));
      if (k > 0) return { label: name.toLowerCase(), perMeter: 1 / k };
    }
  }
  return { label: 'm', perMeter: 1 };
}

/** Names of the materials behind a material definition (sets, layers, profiles, constituents). */
function materialNames(id, depth = 0, out = new Set()) {
  if (depth > 5 || id == null) return out;
  const l = line(id);
  if (!l) return out;
  const t = l.type;
  if (t === W.IFCMATERIAL) { if (val(l.Name)) out.add(String(val(l.Name))); return out; }
  for (const k of ['ForLayerSet', 'ForProfileSet', 'Material', 'MaterialLayers', 'Materials', 'MaterialProfiles', 'MaterialConstituents']) {
    for (const r of refs(l[k])) materialNames(r, depth + 1, out);
  }
  return out;
}

function elementFor(id) {
  let i = elementOf.get(id);
  if (i === undefined) {
    i = elements.length;
    elementOf.set(id, i);
    elements.push({ ifcId: id });
  }
  return i;
}

function describe(el) {
  const l = line(el.ifcId);
  el.type = typeName(el.ifcId);
  if (!l) return;
  const s = (k) => { const v = val(l[k]); return v === null || v === undefined || v === '' ? undefined : String(v); };
  el.guid = s('GlobalId');
  el.ifcName = s('Name');
  el.objectType = s('ObjectType');
  el.predefinedType = s('PredefinedType');
  el.tag = s('Tag');
  el.longName = s('LongName');
  el.description = s('Description');
  if (l.Elevation !== undefined) el.elevation = Number(val(l.Elevation));
}

async function load(buffer, report) {
  await init();
  if (modelID >= 0) { api.CloseModel(modelID); modelID = -1; }
  elementOf.clear();
  elements = [];
  searchIndex = null;
  const bytes = new Uint8Array(buffer);
  const t0 = performance.now();
  modelID = api.OpenModel(bytes, { COORDINATE_TO_ORIGIN: false, CIRCLE_SEGMENTS: 16 });
  let schema = '';
  try { schema = api.GetModelSchema(modelID); } catch { /* reported below */ }
  if (modelID < 0 || !schema) throw new Error('This IFC file could not be read (it is damaged or uses an unsupported schema).');
  report({ phase: 'structure' });
  const units = lengthUnit();
  // Spatial structure.
  let spatial = null;
  try { spatial = await api.properties.getSpatialStructure(modelID, false); } catch { spatial = null; }
  // Geometry, first pass: placements and shared geometry (web-ifc gives Y up; back to the file's Z up).
  const ZUP = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1]; // column-major: (x, y, z) -> (x, -z, y)
  const mulM = (a, b) => {
    const o = new Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    return o;
  };
  const geoms = new Map();
  const placed = [];
  const materials = {};
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  let lastReport = 0;
  api.StreamAllMeshes(modelID, (mesh, index, total) => {
    const el = elementFor(mesh.expressID);
    const pg = mesh.geometries;
    for (let i = 0; i < pg.size(); i++) {
      const g = pg.get(i);
      const gid = g.geometryExpressID;
      let geom = geoms.get(gid);
      if (!geom) {
        const geo = api.GetGeometry(modelID, gid);
        const v = api.GetVertexArray(geo.GetVertexData(), geo.GetVertexDataSize());
        const idx = api.GetIndexArray(geo.GetIndexData(), geo.GetIndexDataSize()).slice();
        geo.delete?.();
        const n = v.length / 6;
        const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3);
        for (let k = 0; k < n; k++) {
          pos[k * 3] = v[k * 6]; pos[k * 3 + 1] = v[k * 6 + 1]; pos[k * 3 + 2] = v[k * 6 + 2];
          nrm[k * 3] = v[k * 6 + 3]; nrm[k * 3 + 1] = v[k * 6 + 4]; nrm[k * 3 + 2] = v[k * 6 + 5];
        }
        const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
        for (let k = 0; k < pos.length; k += 3) for (let a = 0; a < 3; a++) { box[a] = Math.min(box[a], pos[k + a]); box[a + 3] = Math.max(box[a + 3], pos[k + a]); }
        geom = { pos, nrm, idx, box };
        geoms.set(gid, geom);
      }
      if (!geom.idx.length) continue;
      const m = mulM(ZUP, Array.from(g.flatTransformation));
      const c = g.color;
      const q = (x) => Math.round(Math.max(0, Math.min(1, x)) * 255);
      const matKey = `${q(c.x)},${q(c.y)},${q(c.z)},${q(c.w)}`;
      materials[matKey] ??= { color: [q(c.x) / 255, q(c.y) / 255, q(c.z) / 255], opacity: q(c.w) / 255 };
      placed.push(el, gid, matKey, m);
      const b = geom.box;
      for (let k = 0; k < 8; k++) {
        const x = k & 1 ? b[3] : b[0], y = k & 2 ? b[4] : b[1], z = k & 4 ? b[5] : b[2];
        const X = m[0] * x + m[4] * y + m[8] * z + m[12], Y = m[1] * x + m[5] * y + m[9] * z + m[13], Z = m[2] * x + m[6] * y + m[10] * z + m[14];
        if (X < lo[0]) lo[0] = X; if (Y < lo[1]) lo[1] = Y; if (Z < lo[2]) lo[2] = Z;
        if (X > hi[0]) hi[0] = X; if (Y > hi[1]) hi[1] = Y; if (Z > hi[2]) hi[2] = Z;
      }
    }
    const now = performance.now();
    if (now - lastReport > 150) { lastReport = now; report({ phase: 'geometry', done: index + 1, total }); }
  }, false);
  const tGeom = performance.now();
  // Second pass: merge (shifted to the model centre).
  report({ phase: 'merge' });
  const shift = Number.isFinite(lo[0]) ? lo.map((v, k) => Math.round((v + hi[k]) / 2)) : [0, 0, 0];
  const builder = new MergeBuilder({ shift, instanceMin: 24 });
  for (let i = 0; i < placed.length; i += 4) builder.addPlaced(placed[i], `g${placed[i + 1]}`, geoms.get(placed[i + 1]), placed[i + 2], placed[i + 3]);
  geoms.clear();
  placed.length = 0;
  // Spatial structure -> elements (with their storey) and the tree.
  report({ phase: 'structure' });
  const tree = buildTree(spatial);
  for (const el of elements) describe(el);
  // Materials and type objects of elements.
  for (const rel of ids(W.IFCRELASSOCIATESMATERIAL)) {
    const l = line(rel);
    if (!l) continue;
    const names = [...materialNames(val(l.RelatingMaterial))];
    if (!names.length) continue;
    for (const r of refs(l.RelatedObjects)) { const i = elementOf.get(r); if (i !== undefined) elements[i].materials = names; }
  }
  for (const rel of ids(W.IFCRELDEFINESBYTYPE)) {
    const l = line(rel);
    const typ = l && line(val(l.RelatingType));
    if (!typ) continue;
    const name = val(typ.Name);
    for (const r of refs(l.RelatedObjects)) { const i = elementOf.get(r); if (i !== undefined) elements[i].typeObject = name ? String(name) : typeName(typ.expressID); }
  }
  quantities();
  const geometry = builder.build(elements.length);
  // Header: the program that wrote the file.
  let application = '';
  try { const h = api.GetHeaderLine(modelID, W.FILE_NAME); application = (h?.arguments ?? []).slice(4, 6).map(val).filter(Boolean).join(' / '); } catch { /* no header */ }
  return { schema, units, elements, tree, geometry, materials, application, times: { open: Math.round(tGeom - t0), total: Math.round(performance.now() - t0) } };
}

/** Lengths (and areas/volumes) from quantity sets, for the element list. */
function quantities() {
  const t0 = performance.now();
  const seen = new Map();
  for (const rel of ids(W.IFCRELDEFINESBYPROPERTIES)) {
    if (performance.now() - t0 > 4000) break; // huge files: skip the rest
    const l = line(rel);
    const pid = val(l?.RelatingPropertyDefinition);
    if (pid == null) continue;
    let q = seen.get(pid);
    if (q === undefined) {
      q = null;
      try {
        if (api.GetLineType(modelID, pid) === W.IFCELEMENTQUANTITY) {
          const qs = line(pid);
          for (const r of refs(qs?.Quantities)) {
            const x = line(r);
            if (!x) continue;
            const name = String(val(x.Name) ?? '');
            if (x.type === W.IFCQUANTITYLENGTH && /^(Length|NetLength|GrossLength)$/i.test(name)) (q ??= {}).length ??= Number(val(x.LengthValue));
            else if (x.type === W.IFCQUANTITYVOLUME && /Volume/i.test(name)) (q ??= {}).volume ??= Number(val(x.VolumeValue));
          }
        }
      } catch { q = null; }
      seen.set(pid, q);
    }
    if (!q) continue;
    for (const r of refs(l.RelatedObjects)) {
      const i = elementOf.get(r);
      if (i === undefined) continue;
      if (q.length > 0 && elements[i].length === undefined) elements[i].length = q.length;
      if (q.volume > 0 && elements[i].volume === undefined) elements[i].volume = q.volume;
    }
  }
}

const SPATIAL = /^Ifc(Project|Site|Building|BuildingStorey|Space|Facility|FacilityPart|Bridge|Road|Railway|MarineFacility|Zone)/i;

/**
 * Tree: spatial elements nest; inside a storey (or any spatial element) the contained elements are
 * grouped by IFC type. Every node with an expressID is an element (selectable, properties).
 */
function buildTree(spatial) {
  const placedIds = new Set();
  const walk = (n, storey) => {
    const i = elementFor(n.expressID);
    placedIds.add(n.expressID);
    const type = typeName(n.expressID);
    const isStorey = /BuildingStorey/i.test(type);
    const st = isStorey ? i : storey;
    if (st !== undefined && st !== i) elements[i].storeyIndex = st;
    const node = { id: i, children: [] };
    const kids = n.children ?? [];
    const spatialKids = kids.filter((k) => SPATIAL.test(typeName(k.expressID)) && !/IfcSpace/i.test(typeName(k.expressID)));
    const others = kids.filter((k) => !spatialKids.includes(k));
    for (const k of spatialKids) node.children.push(walk(k, st));
    const groups = new Map();
    for (const k of others) {
      const t = typeName(k.expressID);
      if (!groups.has(t)) groups.set(t, []);
      groups.get(t).push(walk(k, st));
    }
    for (const [t, list] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) node.children.push({ name: t, group: t, children: list });
    return node;
  };
  const root = spatial ? walk(spatial, undefined) : { name: 'Model', children: [] };
  // Elements with geometry outside the spatial structure.
  const loose = elements.map((e, i) => i).filter((i) => !placedIds.has(elements[i].ifcId));
  if (loose.length) {
    const groups = new Map();
    for (const i of loose) {
      const t = typeName(elements[i].ifcId);
      if (!groups.has(t)) groups.set(t, []);
      groups.get(t).push({ id: i, children: [] });
    }
    root.children.push({ name: 'Not in the spatial structure', children: [...groups].map(([t, list]) => ({ name: t, group: t, children: list })) });
  }
  return root;
}

// ------------------------------------------------------------------ properties and search
function fmt(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return String(+v.toPrecision(10));
  if (v === 'T' || v === true) return 'True';
  if (v === 'F' || v === false) return 'False';
  return String(v);
}

function propertyRows(set) {
  const rows = [];
  for (const p of set.HasProperties ?? []) {
    if (!p) continue;
    const name = val(p.Name);
    if (p.NominalValue !== undefined) rows.push([name, fmt(val(p.NominalValue))]);
    else if (p.EnumerationValues) rows.push([name, (p.EnumerationValues ?? []).map(val).map(fmt).join(', ')]);
    else if (p.ListValues) rows.push([name, (p.ListValues ?? []).map(val).map(fmt).join(', ')]);
    else if (p.UpperBoundValue !== undefined || p.LowerBoundValue !== undefined) rows.push([name, `${fmt(val(p.LowerBoundValue))} – ${fmt(val(p.UpperBoundValue))}`]);
    else if (p.HasProperties) rows.push(...propertyRows(p).map(([k, v]) => [`${name}.${k}`, v]));
  }
  for (const q of set.Quantities ?? []) {
    if (!q) continue;
    const v = ['LengthValue', 'AreaValue', 'VolumeValue', 'CountValue', 'WeightValue', 'TimeValue'].map((k) => q[k]).find((x) => x !== undefined);
    rows.push([val(q.Name), fmt(val(v))]);
  }
  return rows;
}

async function props(id) {
  const groups = [];
  const l = line(id);
  if (l) {
    const rows = [];
    for (const [k, v] of Object.entries(l)) {
      if (['expressID', 'type', 'OwnerHistory', 'ObjectPlacement', 'Representation'].includes(k)) continue;
      const x = val(v);
      if (x === null || x === undefined || x === '' || typeof x === 'object') continue;
      if (typeof v === 'object' && v?.type === 5) continue; // reference to another line
      rows.push([k, fmt(x)]);
    }
    groups.push({ title: 'Attributes', rows });
  }
  try {
    const sets = await api.properties.getPropertySets(modelID, id, true, false);
    for (const s of sets) {
      const rows = propertyRows(s);
      if (rows.length) groups.push({ title: String(val(s.Name) ?? 'Properties'), rows });
    }
  } catch { /* no property sets */ }
  try {
    const types = await api.properties.getTypeProperties(modelID, id, true);
    for (const t of types) {
      for (const s of t.HasPropertySets ?? []) {
        const rows = s ? propertyRows(s) : [];
        if (rows.length) groups.push({ title: `${val(s.Name) ?? 'Type properties'} (type ${val(t.Name) ?? ''})`.trim(), rows });
      }
    }
  } catch { /* no type */ }
  return groups;
}

/** Element texts (attributes and property values), built on the first search. */
function buildSearchIndex() {
  const text = elements.map((e) => [e.type, e.ifcName, e.guid, e.objectType, e.predefinedType, e.tag, e.longName, e.description, e.typeObject, ...(e.materials ?? [])].filter(Boolean).join(' '));
  const cache = new Map();
  const t0 = performance.now();
  for (const rel of ids(W.IFCRELDEFINESBYPROPERTIES)) {
    if (performance.now() - t0 > 8000) break;
    const l = line(rel);
    const pid = val(l?.RelatingPropertyDefinition);
    if (pid == null) continue;
    let s = cache.get(pid);
    if (s === undefined) {
      try { const set = api.GetLine(modelID, pid, true); s = propertyRows(set).map(([k, v]) => `${k} ${v}`).join(' '); } catch { s = ''; }
      cache.set(pid, s);
    }
    if (!s) continue;
    for (const r of refs(l.RelatedObjects)) { const i = elementOf.get(r); if (i !== undefined) text[i] += ' ' + s; }
  }
  return text.map((s) => s.toLowerCase());
}

function search(query, limit = 2000) {
  searchIndex ??= buildSearchIndex();
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = [];
  for (let i = 0; i < searchIndex.length && hits.length < limit; i++) if (words.every((w) => searchIndex[i].includes(w))) hits.push(i);
  return hits;
}

self.onmessage = async (ev) => {
  const { cmd, req } = ev.data;
  try {
    if (cmd === 'load') {
      const res = await load(ev.data.buffer, (p) => self.postMessage({ type: 'progress', req, ...p }));
      self.postMessage({ type: 'done', req, ok: true, res }, transferables(res.geometry));
    } else if (cmd === 'props') {
      self.postMessage({ type: 'done', req, ok: true, res: await props(elements[ev.data.id]?.ifcId) });
    } else if (cmd === 'search') {
      self.postMessage({ type: 'done', req, ok: true, res: search(ev.data.query) });
    }
  } catch (err) {
    self.postMessage({ type: 'done', req, ok: false, error: String(err?.message || err) });
  }
};
