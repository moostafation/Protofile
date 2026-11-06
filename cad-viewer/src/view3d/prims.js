// Simple solid primitives as triangle lists (pure JavaScript, for the PCF piping builder): tubes
// with different end radii (pipes, reducers, cones), swept tubes along a path (elbows, bends),
// tori (weld rings, handwheels), spheres, boxes and discs. Each function appends to a Mesh.

export class Mesh {
  constructor() { this.pos = []; this.nrm = []; this.idx = []; }
  get empty() { return !this.idx.length; }
  vertex(p, n) { this.pos.push(p[0], p[1], p[2]); this.nrm.push(n[0], n[1], n[2]); return this.pos.length / 3 - 1; }
  tri(a, b, c) { this.idx.push(a, b, c); }
}

export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a) => Math.hypot(a[0], a[1], a[2]);
export const dist = (a, b) => len(sub(a, b));
export const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** Two unit vectors perpendicular to `d` (and to each other). */
export function basis(d) {
  const a = Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const u = norm(cross(d, a));
  return [u, cross(d, u)];
}

/** Ring of `seg` points around `c` in the plane of u, v. */
function ring(c, u, v, r, seg) {
  const out = [];
  for (let i = 0; i < seg; i++) {
    const t = (i / seg) * Math.PI * 2;
    const dir = add(mul(u, Math.cos(t)), mul(v, Math.sin(t)));
    out.push({ p: add(c, mul(dir, r)), n: dir });
  }
  return out;
}

function disc(m, c, n, u, v, r, seg) {
  if (r <= 0) return;
  const center = m.vertex(c, n);
  const pts = ring(c, u, v, r, seg).map((q) => m.vertex(q.p, n));
  for (let i = 0; i < seg; i++) {
    const a = pts[i], b = pts[(i + 1) % seg];
    if (dot(cross(u, v), n) > 0) m.tri(center, a, b); else m.tri(center, b, a);
  }
}

/** Cylinder or cone frustum from p0 (radius r0) to p1 (radius r1), closed with end discs. */
export function frustum(m, p0, p1, r0, r1, seg = 16, caps = true) {
  const axis = sub(p1, p0);
  const L = len(axis);
  if (L < 1e-9 || (r0 <= 0 && r1 <= 0)) return;
  const d = mul(axis, 1 / L);
  const [u, v] = basis(d);
  // Side normals lean along the axis for cones.
  const slope = (r0 - r1) / L;
  const a = ring(p0, u, v, r0, seg), b = ring(p1, u, v, r1, seg);
  const ia = a.map((q) => m.vertex(q.p, norm(add(q.n, mul(d, slope)))));
  const ib = b.map((q) => m.vertex(q.p, norm(add(q.n, mul(d, slope)))));
  for (let i = 0; i < seg; i++) {
    const j = (i + 1) % seg;
    m.tri(ia[i], ia[j], ib[j]);
    m.tri(ia[i], ib[j], ib[i]);
  }
  if (caps) {
    disc(m, p0, mul(d, -1), u, v, r0, seg);
    disc(m, p1, d, u, v, r1, seg);
  }
}

/** Tube of radius r along a path of points (parallel transport frames), with end discs. */
export function sweep(m, path, r, seg = 16, caps = true) {
  if (path.length < 2) return;
  let d = norm(sub(path[1], path[0]));
  let [u, v] = basis(d);
  const rings = [];
  for (let i = 0; i < path.length; i++) {
    const next = i < path.length - 1 ? norm(sub(path[i + 1], path[i])) : d;
    const tangent = i === 0 ? next : i === path.length - 1 ? d : norm(add(d, next));
    // Transport the frame: remove the tangent component and re-orthogonalise.
    u = norm(sub(u, mul(tangent, dot(u, tangent))));
    v = cross(tangent, u);
    rings.push(ring(path[i], u, v, r, seg).map((q) => m.vertex(q.p, q.n)));
    d = next;
  }
  for (let k = 0; k < rings.length - 1; k++) {
    const a = rings[k], b = rings[k + 1];
    for (let i = 0; i < seg; i++) {
      const j = (i + 1) % seg;
      m.tri(a[i], a[j], b[j]);
      m.tri(a[i], b[j], b[i]);
    }
  }
  if (caps) {
    const d0 = norm(sub(path[0], path[1]));
    const [u0, v0] = basis(d0);
    disc(m, path[0], d0, u0, v0, r, seg);
    const d1 = norm(sub(path.at(-1), path.at(-2)));
    const [u1, v1] = basis(d1);
    disc(m, path.at(-1), d1, u1, v1, r, seg);
  }
}

/** Torus around `axis` through `c`: ring radius R, tube radius r. */
export function torus(m, c, axis, R, r, seg = 24, tube = 8) {
  const d = norm(axis);
  const [u, v] = basis(d);
  const grid = [];
  for (let i = 0; i < seg; i++) {
    const t = (i / seg) * Math.PI * 2;
    const out = add(mul(u, Math.cos(t)), mul(v, Math.sin(t)));
    const center = add(c, mul(out, R));
    const row = [];
    for (let k = 0; k < tube; k++) {
      const s = (k / tube) * Math.PI * 2;
      const n = add(mul(out, Math.cos(s)), mul(d, Math.sin(s)));
      row.push(m.vertex(add(center, mul(n, r)), n));
    }
    grid.push(row);
  }
  for (let i = 0; i < seg; i++) {
    const a = grid[i], b = grid[(i + 1) % seg];
    for (let k = 0; k < tube; k++) {
      const l = (k + 1) % tube;
      m.tri(a[k], b[k], b[l]);
      m.tri(a[k], b[l], a[l]);
    }
  }
}

/** UV sphere (or the half towards `dir` when given: a dome for caps). */
export function sphere(m, c, r, seg = 16, dir = null) {
  const rows = Math.max(4, seg >> 1);
  const d = dir ? norm(dir) : [0, 0, 1];
  const [u, v] = basis(d);
  const start = dir ? Math.PI / 2 : 0;
  const grid = [];
  for (let i = 0; i <= rows; i++) {
    const phi = start + ((Math.PI - start) * i) / rows; // from the pole
    const row = [];
    for (let k = 0; k < seg; k++) {
      const t = (k / seg) * Math.PI * 2;
      const n = add(mul(d, Math.cos(Math.PI - phi)), mul(add(mul(u, Math.cos(t)), mul(v, Math.sin(t))), Math.sin(phi)));
      row.push(m.vertex(add(c, mul(n, r)), n));
    }
    grid.push(row);
  }
  for (let i = 0; i < rows; i++) {
    for (let k = 0; k < seg; k++) {
      const l = (k + 1) % seg;
      m.tri(grid[i][k], grid[i + 1][l], grid[i + 1][k]);
      m.tri(grid[i][k], grid[i][l], grid[i + 1][l]);
    }
  }
}

/** Box centred at c with half sizes h along axes x, y, z (unit vectors). */
export function box(m, c, h, x = [1, 0, 0], y = [0, 1, 0], z = [0, 0, 1]) {
  const axes = [x, y, z];
  for (let k = 0; k < 3; k++) {
    for (const s of [1, -1]) {
      const n = mul(axes[k], s), a = axes[(k + 1) % 3];
      const b = cross(n, a); // a × b = n: counter-clockwise seen from outside
      const ha = h[(k + 1) % 3], hb = h[(k + 2) % 3];
      const center = add(c, mul(n, h[k]));
      const p = (sa, sb) => m.vertex(add(center, add(mul(a, sa * ha), mul(b, sb * hb))), n);
      const i0 = p(-1, -1), i1 = p(1, -1), i2 = p(1, 1), i3 = p(-1, 1);
      m.tri(i0, i1, i2);
      m.tri(i0, i2, i3);
    }
  }
}
