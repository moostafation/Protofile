// Merges the triangles of many model elements into a few large buffers, one or more per material
// ("chunks"), so a model with thousands of elements renders in a handful of draw calls. Each chunk
// keeps which index range belongs to which element (picking, highlighting, hiding) and small
// "cells" of at most CELL_TRIS triangles with their bounding boxes, which make ray picking fast.
// Geometry that a format places many times (IFC mapped items, glTF instancing) becomes instanced
// groups instead. Pure JavaScript (no three.js): it runs in workers and in node tests.
//
// Coordinates are stored relative to `shift` (the model's centre) in float32, so models placed far
// from the origin (site coordinates in millimetres) keep their precision.

const CELL_TRIS = 1024;
const MAX_CHUNK_VERTS = 1 << 21;

/** Growable typed array. */
class Grow {
  constructor(Type, n = 1024) { this.Type = Type; this.a = new Type(n); this.n = 0; }
  reserve(k) {
    if (this.n + k <= this.a.length) return;
    let cap = this.a.length * 2;
    while (cap < this.n + k) cap *= 2;
    const b = new this.Type(cap);
    b.set(this.a.subarray(0, this.n));
    this.a = b;
  }
  done() { return this.a.slice(0, this.n); }
}

/** Per-vertex normals of an indexed triangle list (area weighted). */
export function computeNormals(pos, idx) {
  const n = new Float32Array(pos.length);
  const tri = idx ? idx.length : pos.length / 3;
  for (let t = 0; t < tri; t += 3) {
    const a = idx ? idx[t] : t, b = idx ? idx[t + 1] : t + 1, c = idx ? idx[t + 2] : t + 2;
    const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
    const ux = pos[b * 3] - ax, uy = pos[b * 3 + 1] - ay, uz = pos[b * 3 + 2] - az;
    const vx = pos[c * 3] - ax, vy = pos[c * 3 + 1] - ay, vz = pos[c * 3 + 2] - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const v of [a, b, c]) { n[v * 3] += nx; n[v * 3 + 1] += ny; n[v * 3 + 2] += nz; }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
    n[i] /= l; n[i + 1] /= l; n[i + 2] /= l;
  }
  return n;
}

class Chunk {
  constructor(key, attrs) {
    this.key = key;
    this.attrs = attrs; // { colors, uvs }
    this.pos = new Grow(Float32Array, 4096);
    this.nrm = new Grow(Float32Array, 4096);
    this.col = attrs.colors ? new Grow(Float32Array, 4096) : null;
    this.uv = attrs.uvs ? new Grow(Float32Array, 2048) : null;
    this.idx = new Grow(Uint32Array, 4096);
    this.ranges = new Grow(Int32Array, 256); // elementId, start, count (index units)
  }
  get verts() { return this.pos.n / 3; }
}

export class MergeBuilder {
  /**
   * @param {{ shift?: number[], instanceMin?: number }} opts shift: subtracted from every coordinate;
   *   instanceMin: geometry placed at least this often becomes an instanced group.
   */
  constructor(opts = {}) {
    this.shift = opts.shift ?? [0, 0, 0];
    this.instanceMin = opts.instanceMin ?? 24;
    this.chunks = new Map(); // key -> Chunk (current one for that key)
    this.allChunks = [];
    this.boxes = new Grow(Float64Array, 6 * 256);
    this.elementCount = 0;
    this.placements = new Map(); // geomKey|matKey -> { geom, matKey, list: [elementId, matrix] }
    this.triangles = 0;
  }

  ensureElement(id) {
    if (id < this.elementCount) return;
    const add = id + 1 - this.elementCount;
    this.boxes.reserve(add * 6);
    for (let i = 0; i < add; i++) this.boxes.a.set([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], this.boxes.n + i * 6);
    this.boxes.n += add * 6;
    this.elementCount = id + 1;
  }

  growBox(id, x, y, z) {
    const b = this.boxes.a, o = id * 6;
    if (x < b[o]) b[o] = x; if (y < b[o + 1]) b[o + 1] = y; if (z < b[o + 2]) b[o + 2] = z;
    if (x > b[o + 3]) b[o + 3] = x; if (y > b[o + 4]) b[o + 4] = y; if (z > b[o + 5]) b[o + 5] = z;
  }

  chunkFor(key, attrs, verts) {
    let c = this.chunks.get(key);
    if (!c || c.verts + verts > MAX_CHUNK_VERTS) {
      c = new Chunk(key, attrs);
      this.chunks.set(key, c);
      this.allChunks.push(c);
    }
    return c;
  }

  /**
   * Adds triangles of an element.
   * @param {number} id element id
   * @param {string} matKey material key (chunks never mix materials)
   * @param {ArrayLike<number>} pos x,y,z per vertex in model coordinates (before the shift)
   * @param {ArrayLike<number>|null} nrm normals (computed when missing)
   * @param {ArrayLike<number>|null} idx triangle indices (sequential triangles when missing)
   * @param {{ matrix?: ArrayLike<number>, colors?: ArrayLike<number>, uvs?: ArrayLike<number> }} [extra]
   *   matrix: column-major 4x4 applied to positions and normals; colors: r,g,b per vertex (0-1); uvs.
   */
  addMesh(id, matKey, pos, nrm, idx, extra = {}) {
    const nv = Math.floor(pos.length / 3);
    if (!nv) return;
    const index = idx ?? Array.from({ length: nv - (nv % 3) }, (_, i) => i);
    if (!index.length) return;
    if (!nrm) nrm = computeNormals(pos, index);
    this.ensureElement(id);
    const attrs = { colors: !!extra.colors, uvs: !!extra.uvs };
    const key = `${matKey}${attrs.colors ? '|c' : ''}${attrs.uvs ? '|t' : ''}`;
    const c = this.chunkFor(key, attrs, nv);
    const base = c.verts;
    const m = extra.matrix;
    const [sx, sy, sz] = this.shift;
    c.pos.reserve(nv * 3); c.nrm.reserve(nv * 3);
    const P = c.pos.a, N = c.nrm.a;
    let o = c.pos.n;
    for (let i = 0; i < nv; i++, o += 3) {
      let x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      let nx = nrm[i * 3], ny = nrm[i * 3 + 1], nz = nrm[i * 3 + 2];
      if (m) {
        const X = m[0] * x + m[4] * y + m[8] * z + m[12];
        const Y = m[1] * x + m[5] * y + m[9] * z + m[13];
        const Z = m[2] * x + m[6] * y + m[10] * z + m[14];
        x = X; y = Y; z = Z;
        const NX = m[0] * nx + m[4] * ny + m[8] * nz, NY = m[1] * nx + m[5] * ny + m[9] * nz, NZ = m[2] * nx + m[6] * ny + m[10] * nz;
        const l = Math.hypot(NX, NY, NZ) || 1;
        nx = NX / l; ny = NY / l; nz = NZ / l;
      }
      this.growBox(id, x - sx, y - sy, z - sz);
      P[o] = x - sx; P[o + 1] = y - sy; P[o + 2] = z - sz;
      N[o] = nx; N[o + 1] = ny; N[o + 2] = nz;
    }
    c.pos.n += nv * 3; c.nrm.n += nv * 3;
    if (c.col) { c.col.reserve(nv * 3); c.col.a.set(extra.colors.length === nv * 3 ? extra.colors : Array.from({ length: nv * 3 }, (_, i) => extra.colors[i] ?? 1), c.col.n); c.col.n += nv * 3; }
    if (c.uv) { c.uv.reserve(nv * 2); c.uv.a.set(extra.uvs.length === nv * 2 ? extra.uvs : new Float32Array(nv * 2), c.uv.n); c.uv.n += nv * 2; }
    const start = c.idx.n;
    const ni = index.length - (index.length % 3);
    c.idx.reserve(ni);
    const I = c.idx.a;
    for (let i = 0; i < ni; i++) I[start + i] = base + index[i];
    c.idx.n += ni;
    this.triangles += ni / 3;
    // Extend the element's last range when it continues it.
    const R = c.ranges;
    if (R.n >= 3 && R.a[R.n - 3] === id && R.a[R.n - 2] + R.a[R.n - 1] === start) R.a[R.n - 1] += ni;
    else { R.reserve(3); R.a[R.n] = id; R.a[R.n + 1] = start; R.a[R.n + 2] = ni; R.n += 3; }
  }

  /**
   * Places shared geometry (`geom` = { pos, nrm, idx } in its own coordinates) for an element with
   * a column-major matrix. Placed often enough, it is drawn instanced; otherwise merged like addMesh.
   */
  addPlaced(id, geomKey, geom, matKey, matrix) {
    const key = `${geomKey}|${matKey}`;
    let p = this.placements.get(key);
    if (!p) this.placements.set(key, p = { geom, matKey, list: [] });
    this.ensureElement(id);
    p.list.push(id, Array.from(matrix));
  }

  /** Finishes the model (`elementCount`: all elements, also those without geometry). Typed arrays only (transferable). */
  build(elementCount = 0) {
    if (elementCount > 0) this.ensureElement(elementCount - 1);
    const instanced = [];
    for (const p of this.placements.values()) {
      const n = p.list.length / 2;
      const g = p.geom;
      if (!g.nrm) g.nrm = computeNormals(g.pos, g.idx);
      if (n < this.instanceMin) {
        for (let i = 0; i < p.list.length; i += 2) this.addMesh(p.list[i], p.matKey, g.pos, g.nrm, g.idx, { matrix: p.list[i + 1] });
        continue;
      }
      instanced.push(this.instancedGroup(p));
    }
    this.placements.clear();
    const chunks = this.allChunks.map((c) => finishChunk(c));
    return { shift: this.shift, chunks, instanced, boxes: this.boxes.done(), elementCount: this.elementCount, triangles: this.triangles };
  }

  instancedGroup(p) {
    const g = p.geom;
    const n = p.list.length / 2;
    const pos = Float32Array.from(g.pos), nrm = Float32Array.from(g.nrm);
    const idx = g.idx ? Uint32Array.from(g.idx) : Uint32Array.from({ length: pos.length / 3 }, (_, i) => i);
    const matrices = new Float32Array(16 * n), ids = new Int32Array(n), boxes = new Float32Array(6 * n);
    // Local bounding box, then each instance's world box from its 8 corners.
    const lb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.length; i += 3) {
      for (let k = 0; k < 3; k++) { lb[k] = Math.min(lb[k], pos[i + k]); lb[k + 3] = Math.max(lb[k + 3], pos[i + k]); }
    }
    const [sx, sy, sz] = this.shift;
    for (let i = 0; i < n; i++) {
      const id = p.list[i * 2], m = p.list[i * 2 + 1].slice();
      m[12] -= sx; m[13] -= sy; m[14] -= sz;
      matrices.set(m, i * 16);
      ids[i] = id;
      const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      for (let c = 0; c < 8; c++) {
        const x = c & 1 ? lb[3] : lb[0], y = c & 2 ? lb[4] : lb[1], z = c & 4 ? lb[5] : lb[2];
        const X = m[0] * x + m[4] * y + m[8] * z + m[12], Y = m[1] * x + m[5] * y + m[9] * z + m[13], Z = m[2] * x + m[6] * y + m[10] * z + m[14];
        b[0] = Math.min(b[0], X); b[1] = Math.min(b[1], Y); b[2] = Math.min(b[2], Z);
        b[3] = Math.max(b[3], X); b[4] = Math.max(b[4], Y); b[5] = Math.max(b[5], Z);
      }
      boxes.set(b, i * 6);
      this.growBox(id, b[0], b[1], b[2]);
      this.growBox(id, b[3], b[4], b[5]);
      this.triangles += idx.length / 3;
    }
    const local = finishChunk({ key: p.matKey, pos: { done: () => pos }, nrm: { done: () => nrm }, col: null, uv: null, idx: { done: () => idx }, ranges: { done: () => Int32Array.of(-1, 0, idx.length) } });
    return { key: p.matKey, positions: pos, normals: nrm, index: idx, cells: local.cells, cellRefs: local.cellRefs, matrices, ids, boxes };
  }
}

/** Typed arrays of a chunk plus its picking cells. */
function finishChunk(c) {
  const positions = c.pos.done(), index = c.idx.done(), ranges = c.ranges.done();
  const cells = [], refs = [];
  for (let r = 0; r < ranges.length; r += 3) {
    const id = ranges[r], start = ranges[r + 1], count = ranges[r + 2];
    for (let s = start; s < start + count; s += CELL_TRIS * 3) {
      const e = Math.min(start + count, s + CELL_TRIS * 3);
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      for (let i = s; i < e; i++) {
        const v = index[i] * 3;
        const x = positions[v], y = positions[v + 1], z = positions[v + 2];
        if (x < x0) x0 = x; if (y < y0) y0 = y; if (z < z0) z0 = z;
        if (x > x1) x1 = x; if (y > y1) y1 = y; if (z > z1) z1 = z;
      }
      cells.push(x0, y0, z0, x1, y1, z1);
      refs.push(s, e - s, id);
    }
  }
  return {
    key: c.key,
    positions, normals: c.nrm.done(), colors: c.col ? c.col.done() : null, uvs: c.uv ? c.uv.done() : null, index, ranges,
    cells: Float32Array.from(cells), cellRefs: Int32Array.from(refs),
  };
}

/** Typed arrays of a build result, for postMessage transfer lists. */
export function transferables(res) {
  const out = [res.boxes.buffer];
  for (const c of res.chunks) for (const k of ['positions', 'normals', 'colors', 'uvs', 'index', 'ranges', 'cells', 'cellRefs']) if (c[k]) out.push(c[k].buffer);
  for (const g of res.instanced) for (const k of ['positions', 'normals', 'index', 'cells', 'cellRefs', 'matrices', 'ids', 'boxes']) out.push(g[k].buffer);
  return out;
}

/** Union of element boxes (in shifted coordinates); null when empty. */
export function unionBox(boxes, ids) {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  const list = ids ?? Array.from({ length: boxes.length / 6 }, (_, i) => i);
  for (const id of list) {
    const o = id * 6;
    if (!(boxes[o] <= boxes[o + 3])) continue;
    for (let k = 0; k < 3; k++) { b[k] = Math.min(b[k], boxes[o + k]); b[k + 3] = Math.max(b[k + 3], boxes[o + k + 3]); }
  }
  return Number.isFinite(b[0]) ? b : null;
}
