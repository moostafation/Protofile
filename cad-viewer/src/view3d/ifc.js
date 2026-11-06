// IFC models: parsing runs in ifc-worker.js; this side turns the result into the viewer's model
// (names, tree, properties, element list) and keeps the worker for property sets and search.
import { workerClient } from './worker-client.js';

const fmtN = (v, d = 3) => String(+Number(v).toFixed(d));

function progressText(p) {
  if (p.phase === 'geometry' && p.total) return `Reading IFC geometry… ${Math.round((100 * p.done) / p.total)}% (${p.done.toLocaleString('en-US')} of ${p.total.toLocaleString('en-US')} elements)`;
  if (p.phase === 'merge') return 'Preparing the 3D view…';
  return 'Reading the IFC structure…';
}

export async function loadIfc(buffer, fileName, ctx = {}) {
  const worker = new Worker(new URL('./ifc-worker.js', import.meta.url), { type: 'module' });
  const client = workerClient(worker, ctx.signal);
  let res;
  try {
    res = await client.call('load', { buffer }, [buffer], (p) => ctx.onProgress?.(progressText(p)));
  } catch (err) {
    client.dispose();
    throw err;
  }
  client.detach();
  return ifcModel(res, fileName, client);
}

/** Name shown for an IFC element: Name, else long name / object type, else its type. */
function nameOf(e) {
  return e.ifcName || e.longName || e.objectType || e.type || `#${e.ifcId}`;
}

export function ifcModel(res, fileName, client = null) {
  const { units } = res;
  const elements = res.elements.map((e, i) => ({ ...e, index: i, name: nameOf(e) }));
  for (const e of elements) {
    e.storey = e.storeyIndex !== undefined ? elements[e.storeyIndex].name : '';
    const rows = [['IFC type', e.type], ['Name', e.ifcName ?? ''], ['GlobalId', e.guid ?? ''], ['Express id', `#${e.ifcId}`]];
    if (e.predefinedType) rows.push(['Predefined type', e.predefinedType]);
    if (e.objectType) rows.push(['Object type', e.objectType]);
    if (e.typeObject) rows.push(['Type', e.typeObject]);
    if (e.tag) rows.push(['Tag', e.tag]);
    if (e.longName) rows.push(['Long name', e.longName]);
    if (e.description) rows.push(['Description', e.description]);
    if (e.materials?.length) rows.push(['Material', e.materials.join(', ')]);
    if (e.storey) rows.push(['Storey', e.storey]);
    if (Number.isFinite(e.elevation)) rows.push(['Elevation', `${fmtN(e.elevation)} ${units.label}`]);
    if (e.length > 0) rows.push(['Length (quantity)', `${fmtN(e.length)} ${units.label}`]);
    if (e.volume > 0) rows.push(['Volume (quantity)', `${fmtN(e.volume)} ${units.label}³`]);
    e.props = [{ title: 'Element', rows: rows.filter(([, v]) => v !== '') }];
    e.text = [e.name, e.type, e.guid, e.objectType, e.predefinedType, e.tag, e.typeObject, e.storey, ...(e.materials ?? [])].filter(Boolean).join(' ').toLowerCase();
  }
  const label = (n) => {
    if (n.id !== undefined) {
      const e = elements[n.id];
      const out = { name: e.name, type: e.type, id: n.id };
      if (n.children?.length) out.children = n.children.map(label);
      return out;
    }
    return { name: n.name, type: n.group ? 'group' : undefined, children: (n.children ?? []).map(label) };
  };
  const tree = label(res.tree);
  tree.open = true;
  const hasGeom = (i) => res.geometry.boxes[i * 6] <= res.geometry.boxes[i * 6 + 3];
  const withGeometry = elements.filter((e, i) => hasGeom(i));
  const storeys = elements.filter((e) => /BuildingStorey/i.test(e.type));
  const counts = countBy(withGeometry, (e) => e.type);
  return {
    format: 'IFC', formatLabel: `IFC (${res.schema})`, fileName,
    units, upAxis: 'z', elements, tree, geometry: res.geometry, materials: res.materials,
    groupKeys: ['type', 'storey', 'typeObject'],
    initialHidden: elements.map((e, i) => (/^Ifc(Space|OpeningElement)$/i.test(e.type) ? i : -1)).filter((i) => i >= 0),
    bom: { kind: 'list', rows: elementList(withGeometry, units) },
    info: [
      ['Format', `IFC ${res.schema}`],
      ...(res.application ? [['Application', res.application]] : []),
      ['Units', units.label],
      ['Elements', `${withGeometry.length.toLocaleString('en-US')} with geometry, ${elements.length.toLocaleString('en-US')} in all`],
      ['Storeys', storeys.map((s) => s.name).join(', ') || '-'],
      ['Element types', String(counts.size)],
      ['Read in', `${(res.times.total / 1000).toFixed(1)} s`],
    ],
    async loadProps(id) {
      if (!client) return [];
      return client.call('props', { id });
    },
    async searchDeep(query) {
      if (!client) return null;
      return client.call('search', { query });
    },
    dispose() { client?.dispose(); },
    summary: () => ifcSummary(res, elements, withGeometry, storeys, fileName, units),
  };
}

function countBy(list, key) {
  const m = new Map();
  for (const x of list) { const k = key(x); if (k) m.set(k, (m.get(k) ?? 0) + 1); }
  return new Map([...m].sort((a, b) => b[1] - a[1]));
}

/** Element list: count (and total length/volume when quantities exist) per IFC type and type name. */
function elementList(list, units) {
  const rows = new Map();
  for (const e of list) {
    const name = e.typeObject || e.objectType || e.ifcName || '';
    const k = `${e.type}|${name}`;
    let r = rows.get(k);
    if (!r) rows.set(k, r = { category: e.type, itemCode: '', description: name, size: '', qty: 0, unit: 'pcs', length: 0, lengthUnit: units.label, ids: [] });
    r.qty++;
    r.ids.push(e);
    if (e.length > 0) r.length += e.length;
  }
  return [...rows.values()].sort((a, b) => a.category.localeCompare(b.category) || a.description.localeCompare(b.description)).map((r) => ({ ...r, length: r.length ? +r.length.toFixed(3) : 0, ids: undefined }));
}

function ifcSummary(res, elements, withGeometry, storeys, fileName, units) {
  const out = [`IFC model "${fileName}", schema ${res.schema}${res.application ? `, written by ${res.application}` : ''}. Length unit: ${units.label}.`];
  out.push(`${withGeometry.length} elements with geometry (${elements.length} including spatial structure).`);
  out.push('', 'Storeys (elements contained):');
  for (const s of storeys) {
    const i = s.index;
    const n = elements.filter((e) => e.storeyIndex === i).length;
    out.push(`- [#${i}] ${s.name}${Number.isFinite(s.elevation) ? ` (elevation ${fmtN(s.elevation)} ${units.label})` : ''}: ${n} elements`);
  }
  out.push('', 'Element counts by IFC type:');
  for (const [t, n] of countBy(withGeometry, (e) => e.type)) out.push(`- ${t}: ${n}`);
  const mats = countBy(withGeometry.flatMap((e) => e.materials ?? []), (m) => m);
  if (mats.size) out.push('', `Materials (elements using them): ${[...mats].slice(0, 60).map(([m, n]) => `${m} (${n})`).join('; ')}`);
  const types = countBy(withGeometry, (e) => (e.typeObject ? `${e.type}: ${e.typeObject}` : ''));
  if (types.size) out.push('', 'Element types (count):', ...[...types].slice(0, 80).map(([t, n]) => `- ${t}: ${n}`));
  const lengths = new Map();
  for (const e of withGeometry) if (e.length > 0) lengths.set(e.type, (lengths.get(e.type) ?? 0) + e.length);
  if (lengths.size) out.push('', `Total lengths from quantity sets (${units.label}): ${[...lengths].map(([t, L]) => `${t} ${fmtN(L, 1)}`).join('; ')}`);
  out.push('', 'Elements ([#id] type: name, storey) — first 400:');
  for (const e of withGeometry.slice(0, 400)) out.push(`[#${e.index}] ${e.type}: ${e.name}${e.storey ? ` (${e.storey})` : ''}`);
  if (withGeometry.length > 400) out.push(`… ${withGeometry.length - 400} more (use find_in_drawing).`);
  return out.join('\n');
}
