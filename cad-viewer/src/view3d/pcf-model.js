// Builds the 3D model of a PCF: pipes as cylinders with the bore as diameter, elbows and bends
// as tubes swept through the centre point, tees/olets/crosses as run + branch, reducers as cones,
// flanges as hub + disc, valves as a bow-tie body with a handwheel or lever, gaskets as discs,
// welds as rings, supports as shoes or clamps. Pure JavaScript (no three.js), so it is tested in node.
import { parsePcf, pcfBom, componentSize, componentLength, sizeLabel } from '../formats/pcf.js';
import { MergeBuilder } from './merge.js';
import { Mesh, frustum, sweep, torus, sphere, box, sub, add, mul, dot, cross, len, dist, norm, basis } from './prims.js';

export const PCF_COLORS = {
  Pipe: [0.62, 0.67, 0.74],
  Fittings: [0.36, 0.72, 0.60],
  Reducer: [0.96, 0.60, 0.22],
  Flanges: [0.88, 0.74, 0.36],
  Gaskets: [0.18, 0.18, 0.20],
  Bolts: [0.45, 0.45, 0.45],
  Valves: [0.88, 0.27, 0.27],
  Handwheel: [0.98, 0.82, 0.22],
  Instruments: [0.74, 0.40, 0.90],
  Specials: [0.44, 0.52, 0.95],
  Supports: [0.16, 0.74, 0.90],
  Welds: [0.28, 0.28, 0.30],
  Other: [0.70, 0.70, 0.70],
};

const P = (p) => [p.x, p.y, p.z];
const SPINDLE = { UP: [0, 0, 1], DOWN: [0, 0, -1], NORTH: [0, 1, 0], SOUTH: [0, -1, 0], EAST: [1, 0, 0], WEST: [-1, 0, 0] };
const FACE_NEIGHBOURS = /^(GASKET|FLANGE|VALVE|INSTRUMENT|FILTER|END-CONNECTION-EQUIPMENT|FLANGE-BLIND)/;

/** Points of a tube through an elbow/bend: circular arc when the legs are equal, else a smooth curve. */
export function elbowPath(a, cp, b) {
  const l1 = dist(a, cp), l2 = dist(b, cp);
  if (l1 < 1e-9 || l2 < 1e-9) return [a, b];
  const d1 = norm(sub(cp, a)), d2 = norm(sub(b, cp));
  const theta = Math.acos(Math.max(-1, Math.min(1, dot(d1, d2))));
  if (theta < 1e-3) return [a, b];
  const n = Math.max(4, Math.ceil(theta / (Math.PI / 24)));
  const out = [];
  if (Math.abs(l1 - l2) <= 0.02 * Math.max(l1, l2) && theta < Math.PI - 1e-3) {
    const R = l1 / Math.tan(theta / 2);
    let inward = norm(cross(norm(cross(d1, d2)), d1));
    if (dot(inward, sub(b, a)) < 0) inward = mul(inward, -1);
    const O = add(a, mul(inward, R));
    const ao = sub(a, O);
    for (let i = 0; i <= n; i++) {
      const phi = (theta * i) / n;
      out.push(add(O, add(mul(ao, Math.cos(phi)), mul(d1, R * Math.sin(phi)))));
    }
    out[n] = b;
    return out;
  }
  for (let i = 0; i <= n; i++) {
    const t = i / n, s = 1 - t;
    out.push(add(add(mul(a, s * s), mul(cp, 2 * s * t)), mul(b, t * t)));
  }
  return out;
}

const key = (p) => `${Math.round(p[0] * 100)},${Math.round(p[1] * 100)},${Math.round(p[2] * 100)}`;

/**
 * Reads a PCF and builds its model.
 * @param {ArrayBuffer|string} input
 * @param {string} fileName
 */
export function buildPcfModel(input, fileName = 'piping.pcf') {
  const pcf = parsePcf(input);
  const u = pcf.units;
  const boreToCoord = u.boreMm / u.coordMm;
  const mm = 1 / u.coordMm; // one millimetre in coordinate units

  // Model extents (for the shift) and which components meet at each end point.
  const all = [];
  const ends = new Map();
  for (const c of pcf.components) {
    const pts = [...c.endPoints, c.centre, ...c.branches, c.coords].filter(Boolean);
    for (const p of pts) all.push(P(p));
    c.endPoints.forEach((p, i) => {
      const k = key(P(p));
      if (!ends.has(k)) ends.set(k, []);
      ends.get(k).push({ c, i });
    });
  }
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of all) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
  const shift = lo.map((v, k) => Math.round((v + hi[k]) / 2));
  const span = Math.max(1, ...hi.map((v, k) => v - lo[k]));
  const bores = pcf.components.map((c) => c.bore).filter((b) => b > 0).sort((a, b) => a - b);
  const defaultBore = bores.length ? bores[bores.length >> 1] : (span / 200) / boreToCoord;

  const neighbours = (p, self) => (ends.get(key(p)) ?? []).filter((e) => e.c !== self);
  /** Direction of the piping through point p (for welds, supports, caps). */
  const axisAt = (p, self) => {
    for (const { c, i } of neighbours(p, self)) {
      if (c.type === 'WELD' || c.endPoints.length < 2) continue;
      const other = c.centre && /ELBOW|BEND|TEE|CROSS|VALVE-ANGLE/.test(c.type) ? P(c.centre) : P(c.endPoints[1 - i] ?? c.endPoints[0]);
      const d = sub(other, P(c.endPoints[i]));
      if (len(d) > 1e-9) return norm(d);
    }
    for (const c of pcf.components) {
      if (c === self || c.endPoints.length < 2 || !/^PIPE/.test(c.type)) continue;
      const a = P(c.endPoints[0]), b = P(c.endPoints[1]);
      const ab = sub(b, a), L = len(ab);
      if (L < 1e-9) continue;
      const t = dot(sub(p, a), ab) / (L * L);
      if (t >= -1e-6 && t <= 1 + 1e-6 && dist(add(a, mul(ab, t)), p) < Math.max(L * 1e-4, 0.5 * mm)) return norm(ab);
    }
    return null;
  };

  const builder = new MergeBuilder({ shift });
  const materials = {};
  for (const [k, color] of Object.entries(PCF_COLORS)) materials[k] = { color, opacity: 1 };
  const elements = [];
  const tree = { name: fileName, children: [] };
  let triangles = 0;

  for (const pl of pcf.pipelines) {
    const node = { name: pl.ref, type: 'Pipeline', children: [] };
    tree.children.push(node);
    for (const c of pl.components) {
      const id = elements.length;
      const r = ((c.bore ?? defaultBore) * boreToCoord) / 2;
      const size = componentSize(c, u);
      const name = `${c.type}${c.skey ? ' ' + c.skey : ''}${size ? ' ' + size : ''}${c.tag ? ' – ' + c.tag : ''}`;
      const colorKey = /^REDUCER/.test(c.type) ? 'Reducer' : PCF_COLORS[c.category] ? c.category : 'Other';
      elements.push({
        name, type: c.type, category: c.physical ? c.category : 'Annotation', pipeline: c.pipeline, color: PCF_COLORS[colorKey],
        props: componentProps(c, pl, u, size), text: searchText(c, name),
      });
      node.children.push({ name, id });
      const parts = {};
      const mesh = (k) => (parts[k] ??= new Mesh());
      try {
        drawComponent(c, r, mesh(colorKey), mesh, { neighbours, axisAt, mm, boreToCoord });
      } catch (err) {
        // A malformed component (e.g. missing points) is listed but not drawn.
        elements[id].warning = String(err?.message || err);
      }
      for (const [k, m] of Object.entries(parts)) {
        if (m.empty) continue;
        builder.addMesh(id, k, m.pos, m.nrm, m.idx);
        triangles += m.idx.length / 3;
      }
    }
  }
  const geometry = builder.build(elements.length);
  const bom = pcfBom(pcf);
  const lu = bom.lengthUnit;
  return {
    format: 'PCF', formatLabel: 'PCF (Piping Component File)', fileName,
    units: { label: u.coordLabel, perMeter: 1000 / u.coordMm },
    upAxis: 'z',
    elements, tree, geometry, materials,
    groupKeys: ['pipeline', 'category', 'type'],
    pcf, bom: { kind: 'pcf', ...bom },
    info: [
      ['Format', 'PCF (ISOGEN Piping Component File)'],
      ['Units', `co-ordinates ${u.coordLabel}, bore ${u.bore.toLowerCase()}${u.weight ? ', weight ' + u.weight.toLowerCase() : ''}`],
      ['Pipelines', pcf.pipelines.map((p) => p.ref).join(', ')],
      ['Components', String(pcf.components.filter((c) => c.physical).length)],
      ['Pipe length', `${bom.totalPipe} ${lu}`],
      ['Triangles', String(triangles)],
      ...(pcf.header['ISOGEN-FILES'] ? [['ISOGEN files', pcf.header['ISOGEN-FILES']]] : []),
    ],
    summary: () => pcfSummary(pcf, bom, fileName),
  };
}

function drawComponent(c, r, m, mesh, env) {
  const { neighbours, axisAt, mm } = env;
  const T = c.type;
  const ep = c.endPoints.map(P);
  const [a, b] = ep;
  const seg = 16;
  const flangeR = (rr) => rr * 1.6 + 25 * mm;
  const endR = (p) => (p?.bore > 0 ? (p.bore * env.boreToCoord) / 2 : r);
  const r0 = endR(c.endPoints[0]), r1 = endR(c.endPoints[1]);
  if (!c.physical) return;
  if (/^PIPE/.test(T)) { if (a && b) frustum(m, a, b, r0, r1, seg); return; }
  if (/^(ELBOW|BEND)/.test(T)) {
    if (!a || !b) return;
    const path = c.centre ? elbowPath(a, P(c.centre), b) : [a, b];
    sweep(m, path, r * 1.03, seg);
    return;
  }
  if (/^REDUCER/.test(T)) { if (a && b) frustum(m, a, b, r0 * 1.03, r1 * 1.03, seg); return; }
  if (/^(TEE|CROSS|Y-PIECE|LATERAL)/.test(T)) {
    if (a && b) frustum(m, a, b, r0 * 1.05, r1 * 1.05, seg);
    const from = c.centre ? P(c.centre) : a && b ? mul(add(a, b), 0.5) : null;
    if (from) for (const br of c.branches) frustum(m, from, P(br), endR(br) * 1.05, endR(br) * 1.05, seg);
    return;
  }
  if (/OLET/.test(T)) {
    const from = c.centre ? P(c.centre) : a;
    for (const br of c.branches) { const rb = endR(br); frustum(m, from, P(br), rb * 1.4, rb * 1.08, seg); }
    if (!c.branches.length && a && b) frustum(m, a, b, r * 1.2, r * 1.05, seg);
    return;
  }
  if (T === 'FLANGE-BLIND') {
    if (a && b && dist(a, b) > 1e-9) frustum(m, a, b, flangeR(r), flangeR(r), seg);
    else if (a) { const d = axisAt(a, c) ?? [1, 0, 0]; frustum(m, a, add(a, mul(d, r * 0.3)), flangeR(r), flangeR(r), seg); }
    return;
  }
  if (/^FLANGE/.test(T) || /^LAP-JOINT/.test(T)) {
    if (!a || !b) return;
    const L = dist(a, b);
    if (L < 1e-9) return;
    // The face is the end that meets a gasket, valve or other flanged item (else the second end).
    const faceAtA = neighbours(a, c).some((e) => FACE_NEIGHBOURS.test(e.c.type)) && !neighbours(b, c).some((e) => FACE_NEIGHBOURS.test(e.c.type));
    const [w, f] = faceAtA ? [b, a] : [a, b];
    const d = norm(sub(f, w));
    const hubEnd = add(w, mul(d, L * 0.55));
    frustum(m, w, hubEnd, Math.min(r0, r1) * 1.06, r * 1.45, seg);
    frustum(m, hubEnd, f, flangeR(r), flangeR(r), seg);
    return;
  }
  if (/^GASKET/.test(T)) {
    if (!a) return;
    let d = b && dist(a, b) > 1e-9 ? norm(sub(b, a)) : axisAt(a, c) ?? [1, 0, 0];
    const t = Math.max(b ? dist(a, b) : 0, r * 0.06);
    const mid = b ? mul(add(a, b), 0.5) : a;
    frustum(m, sub(mid, mul(d, t / 2)), add(mid, mul(d, t / 2)), r * 1.4, r * 1.4, seg);
    return;
  }
  if (/^WELD/.test(T)) {
    const p = a ?? (c.coords ? P(c.coords) : null);
    if (!p) return;
    const d = b && dist(p, b) > 1e-9 ? norm(sub(b, p)) : axisAt(p, c) ?? [1, 0, 0];
    torus(m, p, d, r * 1.04, Math.max(r * 0.07, 1 * mm), 20, 6);
    return;
  }
  if (/^SUPPORT/.test(T)) {
    const p = c.coords ? P(c.coords) : a;
    if (!p) return;
    const d = axisAt(p, c) ?? [1, 0, 0];
    if (Math.abs(d[2]) > 0.7) {
      // Vertical pipe: clamp with two lugs.
      torus(m, p, d, r * 1.12, r * 0.12, 20, 6);
      const [s] = basis(d);
      for (const k of [1, -1]) box(m, add(p, mul(s, k * r * 1.45)), [r * 0.35, r * 0.12, r * 0.25], s, cross(d, s), d);
    } else {
      // Horizontal pipe: shoe under the pipe and a base plate.
      const along = norm([d[0], d[1], 0]);
      const across = [-along[1], along[0], 0];
      const h = r * 0.9;
      box(m, add(p, [0, 0, -(r + h / 2)]), [r * 0.9, r * 0.45, h / 2], along, across, [0, 0, 1]);
      box(m, add(p, [0, 0, -(r + h + r * 0.06)]), [r * 1.1, r * 0.9, r * 0.06], along, across, [0, 0, 1]);
    }
    return;
  }
  if (/^CAP/.test(T)) {
    if (!a) return;
    let d = b && dist(a, b) > 1e-9 ? norm(sub(b, a)) : axisAt(a, c);
    if (!d) d = [1, 0, 0];
    else if (!(b && dist(a, b) > 1e-9)) d = mul(d, -1); // away from the pipe
    const L = b ? dist(a, b) : r;
    const neck = add(a, mul(d, Math.max(0, L - r * 0.6)));
    frustum(m, a, neck, r * 1.04, r * 1.04, seg, false);
    sphere(m, neck, r * 1.04, seg, d);
    return;
  }
  if (/^(VALVE|INSTRUMENT)/.test(T)) { drawValve(c, r, m, mesh, env, a, b); return; }
  if (/^FILTER/.test(T)) {
    if (!a || !b) return;
    const d = norm(sub(b, a)), L = dist(a, b);
    if (flanged(c, a, b, neighbours)) for (const [p, q] of [[a, add(a, mul(d, L * 0.08))], [sub(b, mul(d, L * 0.08)), b]]) frustum(m, p, q, flangeR(r), flangeR(r), seg);
    if (c.branches.length && c.centre) {
      frustum(m, a, b, r * 1.2, r * 1.2, seg);
      const cp = P(c.centre);
      for (const br of c.branches) { frustum(m, cp, P(br), r * 0.95, r * 0.95, seg); sphere(m, P(br), r * 0.95, seg, norm(sub(P(br), cp))); }
    } else {
      frustum(m, add(a, mul(d, L * 0.2)), sub(b, mul(d, L * 0.2)), r * 1.8, r * 1.8, seg);
      frustum(m, a, b, r * 1.05, r * 1.05, seg);
    }
    return;
  }
  // Couplings, unions, misc components and anything else with two ends: a slightly larger body.
  if (a && b && dist(a, b) > 1e-9) {
    frustum(m, a, b, r * 1.25, r * 1.25, seg);
    if (c.centre) for (const br of c.branches) frustum(m, P(c.centre), P(br), endR(br) * 1.1, endR(br) * 1.1, seg);
  } else if (c.coords || a) sphere(m, c.coords ? P(c.coords) : a, r * 1.3, 12);
}

function flanged(c, a, b, neighbours) {
  return /FL$/.test(c.skey) || [a, b].some((p) => p && neighbours(p, c).some((e) => /^GASKET/.test(e.c.type)));
}

function drawValve(c, r, m, mesh, env, a, b) {
  const { neighbours, mm } = env;
  const seg = 16;
  const flangeR = r * 1.6 + 25 * mm;
  const angle = /ANGLE/.test(c.type) && c.centre;
  if (!a) return;
  const cp = angle ? P(c.centre) : b ? mul(add(a, b), 0.5) : a;
  const bEnd = b ?? a;
  const L = angle ? dist(a, cp) + dist(cp, bEnd) : dist(a, bEnd);
  const d = angle ? norm(sub(cp, a)) : L > 1e-9 ? norm(sub(bEnd, a)) : [1, 0, 0];
  if (flanged(c, a, b, neighbours)) {
    const ends = angle ? [[a, d], [bEnd, norm(sub(cp, bEnd))]] : [[a, d], [bEnd, mul(d, -1)]];
    for (const [p, dir] of ends) frustum(m, p, add(p, mul(dir, Math.max(L * 0.06, r * 0.15))), flangeR, flangeR, seg);
  }
  const instrument = /^INSTRUMENT/.test(c.type);
  if (instrument && !angle) {
    frustum(m, a, bEnd, r * 1.3, r * 1.3, seg);
  } else {
    frustum(m, a, cp, r * 1.3, r * 0.45, seg);
    frustum(m, cp, bEnd, r * 0.45, r * 1.3, seg);
    sphere(m, cp, r * 0.75, seg);
  }
  for (const br of c.branches) frustum(m, cp, P(br), r * 1.2, r * 0.45, seg);
  // Stem direction: SPINDLE-DIRECTION, else up (or sideways on vertical lines); angle valves: along the inlet.
  const spindle = String(c.attrs.find(([k]) => k === 'SPINDLE-DIRECTION')?.[1] ?? '').toUpperCase().trim();
  let s = SPINDLE[spindle] ?? (angle ? d : Math.abs(d[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1]);
  s = sub(s, mul(d, angle ? 0 : dot(s, d)));
  s = len(s) < 1e-6 ? basis(d)[0] : norm(s);
  const sk = c.skey.toUpperCase();
  if (/^(CK|VC|VK|NR)/.test(sk)) return; // check valves have no operator
  const H = Math.max(L * 0.85, r * 3);
  const top = add(cp, mul(s, H));
  const wheel = mesh('Handwheel');
  if (instrument) {
    frustum(m, cp, add(cp, mul(s, r * 1.8)), r * 0.18, r * 0.18, 10);
    const head = add(cp, mul(s, r * 1.8 + r * 0.5));
    const [u] = basis(s);
    box(wheel, head, [r * 0.6, r * 0.6, r * 0.5], u, cross(s, u), s);
    return;
  }
  frustum(m, cp, top, r * 0.13, r * 0.13, 10);
  if (/^(VB|VP|VY|VF|BV|BF)/.test(sk)) {
    // Quarter-turn valve: a lever along the pipe.
    const side = cross(s, d);
    box(wheel, add(top, mul(d, r * 1.4)), [r * 1.6, r * 0.12, r * 0.06], d, side, s);
    return;
  }
  const R = Math.max(r * 1.1, L * 0.32);
  torus(wheel, top, s, R, Math.max(R * 0.07, 1 * mm), 28, 8);
  const [u, v] = basis(s);
  for (const dir of [u, v]) frustum(wheel, add(top, mul(dir, -R)), add(top, mul(dir, R)), R * 0.04, R * 0.04, 6);
}

function fmtPoint(p, units) {
  const f = (v) => String(+v.toFixed(3));
  return `${f(p.x)}, ${f(p.y)}, ${f(p.z)}${p.bore > 0 ? `  (${sizeLabel(p.bore, units)})` : ''}`;
}

const SHOWN = new Set(['END-POINT', 'CENTRE-POINT', 'CENTER-POINT', 'CO-ORDS', 'SKEY', 'ITEM-CODE', 'ITEM-DESCRIPTION']);

function componentProps(c, pl, units, size) {
  const comp = [['Type', c.type], ['Category', c.physical ? c.category : 'Annotation / connection']];
  if (c.skey) comp.push(['SKEY', c.skey]);
  if (c.itemCode) comp.push(['Item code', c.itemCode]);
  if (c.description) comp.push(['Description', c.description]);
  if (size) comp.push(['Size', size]);
  const L = componentLength(c);
  if (L > 0) comp.push([/^PIPE/.test(c.type) ? 'Length' : 'Length (end to end)', `${+L.toFixed(1)} ${units.coordLabel}`]);
  if (c.tag) comp.push(['Tag', c.tag]);
  comp.push(['Pipeline', c.pipeline], ['File line', String(c.line)]);
  const geo = [];
  c.endPoints.forEach((p, i) => geo.push([`End point ${i + 1}`, fmtPoint(p, units)]));
  if (c.centre) geo.push(['Centre point', fmtPoint(c.centre, units)]);
  c.branches.forEach((p, i) => geo.push([`Branch ${i + 1} point`, fmtPoint(p, units)]));
  if (c.coords) geo.push(['Co-ords', fmtPoint(c.coords, units)]);
  const attrs = c.attrs.filter(([k]) => !SHOWN.has(k) && !/^BRANCH\d-POINT$/.test(k));
  const groups = [{ title: 'Component', rows: comp }, { title: `Geometry (${units.coordLabel})`, rows: geo }];
  if (attrs.length) groups.push({ title: 'Attributes', rows: attrs.map(([k, v]) => [k, v]) });
  if (pl.attrs.length) groups.push({ title: `Pipeline ${pl.ref}`, rows: pl.attrs.map(([k, v]) => [k, v]) });
  return groups;
}

function searchText(c, name) {
  return [name, c.type, c.skey, c.itemCode, c.description, c.tag, c.pipeline, ...c.attrs.filter(([k]) => !/POINT|CO-ORDS/.test(k)).map(([k, v]) => `${k} ${v}`)].join(' ').toLowerCase();
}

/** Text summary for the AI assistant. */
export function pcfSummary(pcf, bom, fileName) {
  const out = [`PCF piping isometric file "${fileName}" (ISOGEN Piping Component File). Units: co-ordinates ${pcf.units.coordLabel}, bore ${pcf.units.bore}.`];
  out.push(`Pipelines (${pcf.pipelines.length}):`);
  for (const pl of pcf.pipelines) {
    const counts = new Map();
    for (const c of pl.components) if (c.physical) counts.set(c.type, (counts.get(c.type) ?? 0) + 1);
    out.push(`- ${pl.ref}: ${[...counts].map(([t, n]) => `${n} ${t}`).join(', ')}${pl.attrs.length ? `; attributes: ${pl.attrs.map(([k, v]) => `${k} ${v}`).join('; ')}` : ''}`);
  }
  out.push('', `Bill of materials (all pipelines; pipe in ${bom.lengthUnit}):`, 'Category | Item code | Description | Size | Qty | Unit');
  for (const r of bom.rows) out.push(`${r.category} | ${r.itemCode || '-'} | ${r.description} | ${r.size} | ${r.qty} | ${r.unit}`);
  out.push('', `Pipe length per size: ${bom.pipeLengths.map((p) => `${p.size}: ${p.length} ${p.unit}`).join('; ')}. Total ${bom.totalPipe} ${bom.lengthUnit}.`);
  return out.join('\n');
}
