// Reads STEP, IGES and BREP off the main thread with occt-import-js (OpenCascade compiled to
// WebAssembly, LGPL-2.1) and merges the triangulated parts by colour. The assembly structure
// (product names) becomes the model tree; every mesh is one element.
import occtimportjs from 'occt-import-js';
import wasmUrl from 'occt-import-js/dist/occt-import-js.wasm?url';
import { MergeBuilder, transferables } from './merge.js';

let occt = null;
const DEFAULT = [0.72, 0.75, 0.8];

/** Triangles `first..last` (inclusive, triangle numbers) of a mesh as a compact sub-mesh. */
function subMesh(pos, nrm, idx, tris) {
  const map = new Map();
  const P = [], N = [], I = [];
  for (const t of tris) {
    for (let k = 0; k < 3; k++) {
      const v = idx[t * 3 + k];
      let m = map.get(v);
      if (m === undefined) {
        m = P.length / 3;
        map.set(v, m);
        P.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
        if (nrm) N.push(nrm[v * 3], nrm[v * 3 + 1], nrm[v * 3 + 2]);
      }
      I.push(m);
    }
  }
  return { pos: P, nrm: nrm ? N : null, idx: I };
}

function read(format, bytes) {
  const params = { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', linearDeflection: 0.001, angularDeflection: 0.5 };
  if (format === 'iges') return occt.ReadIgesFile(bytes, params);
  if (format === 'brep') return occt.ReadBrepFile(bytes, params);
  return occt.ReadStepFile(bytes, params);
}

async function load(format, buffer) {
  occt ??= await occtimportjs({ locateFile: (p) => (p.endsWith('.wasm') ? wasmUrl : p) });
  const t0 = performance.now();
  const r = read(format, new Uint8Array(buffer));
  if (!r?.success || !r.meshes) throw new Error(`This ${format.toUpperCase()} file could not be read (it may be damaged, empty or not a ${format.toUpperCase()} file).`);
  if (!r.meshes.length) throw new Error(`No solids or surfaces were found in this ${format.toUpperCase()} file.`);
  const tRead = performance.now();
  // Shift: centre of all vertices.
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const m of r.meshes) {
    const p = m.attributes.position.array;
    for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) { if (p[i + k] < lo[k]) lo[k] = p[i + k]; if (p[i + k] > hi[k]) hi[k] = p[i + k]; }
  }
  const shift = lo.map((v, k) => (Number.isFinite(v) ? Math.round((v + hi[k]) / 2) : 0));
  const builder = new MergeBuilder({ shift });
  const materials = {};
  const keyOf = (c) => {
    const rgb = (c ?? DEFAULT).map((x) => Math.round(Math.max(0, Math.min(1, x)) * 255));
    const k = rgb.join(',');
    materials[k] ??= { color: rgb.map((x) => x / 255), opacity: 1 };
    return k;
  };
  const elements = [];
  const meshElement = new Map();
  const node = (n, path) => {
    const out = { name: n.name || 'Part', children: [] };
    for (const mi of n.meshes ?? []) {
      const m = r.meshes[mi];
      const id = elements.length;
      const name = m.name || n.name || `Part ${id + 1}`;
      const pos = m.attributes.position.array, nrm = m.attributes.normal?.array ?? null, idx = m.index.array;
      const ntri = idx.length / 3;
      elements.push({ name, type: 'Part', color: m.color ?? DEFAULT, assembly: path.join(' / '), triangles: ntri, faces: m.brep_faces?.length ?? 0 });
      meshElement.set(mi, id);
      out.children.push({ name, id });
      // Faces with their own colour are split off; the rest uses the part colour.
      const byColor = new Map();
      const faces = m.brep_faces ?? [];
      let covered = 0;
      for (const f of faces) {
        if (!f.color) continue;
        const k = keyOf(f.color);
        if (!byColor.has(k)) byColor.set(k, []);
        const list = byColor.get(k);
        for (let t = f.first; t <= f.last; t++) list.push(t);
        covered += f.last - f.first + 1;
      }
      if (!byColor.size) builder.addMesh(id, keyOf(m.color), pos, nrm, idx);
      else {
        const base = keyOf(m.color);
        if (covered < ntri) {
          const colored = new Uint8Array(ntri);
          for (const list of byColor.values()) for (const t of list) colored[t] = 1;
          const rest = [];
          for (let t = 0; t < ntri; t++) if (!colored[t]) rest.push(t);
          if (!byColor.has(base)) byColor.set(base, []);
          byColor.get(base).push(...rest);
        }
        for (const [k, tris] of byColor) {
          const s = subMesh(pos, nrm, idx, tris);
          builder.addMesh(id, k, s.pos, s.nrm, s.idx);
        }
      }
    }
    for (const c of n.children ?? []) out.children.push(node(c, [...path, c.name || 'Assembly']));
    return out;
  };
  const tree = node(r.root ?? { name: 'Model', meshes: r.meshes.map((_, i) => i) }, []);
  const geometry = builder.build(elements.length);
  return { elements, tree, geometry, materials, times: { read: Math.round(tRead - t0), total: Math.round(performance.now() - t0) } };
}

self.onmessage = async (ev) => {
  const { cmd, req } = ev.data;
  try {
    if (cmd === 'load') {
      const res = await load(ev.data.format, ev.data.buffer);
      self.postMessage({ type: 'done', req, ok: true, res }, transferables(res.geometry));
    }
  } catch (err) {
    self.postMessage({ type: 'done', req, ok: false, error: String(err?.message || err) });
  }
};
