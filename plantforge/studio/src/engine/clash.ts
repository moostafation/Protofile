// Interference detection: convex parts + GJK minimum distance, sweep-and-prune broad phase.

import type { Connectivity } from "./connectivity";
import { pairKey } from "./connectivity";
import type { Comp } from "./model";
import { AABB, Shape, aabbOf, boxesOverlap, convexParts, support } from "./shapes";
import { V3, add, addScaled, dot, isClose, len, scale, sub } from "./vec";

export interface Clash {
  a: string;
  b: string;
  distance: number;
  point: V3;
  hard: boolean;
}

function solve(m: number[][], rhs: number[]): number[] | null {
  const n = rhs.length;
  const a = m.map((row, i) => [...row, rhs[i]]);
  const sc = Math.max(1, ...m.flat().map(Math.abs));
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[piv][col])) piv = r;
    if (Math.abs(a[piv][col]) < 1e-12 * sc) return null;
    [a[col], a[piv]] = [a[piv], a[col]];
    for (let r = col + 1; r < n; r++) {
      const f = a[r][col] / a[col][col];
      for (let c = col; c <= n; c++) a[r][c] -= f * a[col][c];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = a[r][n];
    for (let c = r + 1; c < n; c++) s -= a[r][c] * x[c];
    x[r] = s / a[r][r];
  }
  return x;
}

function closestOnSimplex(pts: V3[]): { v: V3; lam: number[]; idx: number[] } {
  let best: { d: number; v: V3; lam: number[]; idx: number[] } | null = null;
  const n = pts.length;
  for (let mask = 1; mask < 1 << n; mask++) {
    const idx: number[] = [];
    for (let i = 0; i < n; i++) if ((mask >> i) & 1) idx.push(i);
    const p0 = pts[idx[0]];
    let v = p0;
    let lam = [1];
    if (idx.length > 1) {
      const d = idx.slice(1).map((i) => sub(pts[i], p0));
      const g = d.map((di) => d.map((dj) => dot(di, dj)));
      const mu = solve(g, d.map((di) => -dot(di, p0)));
      if (!mu) continue;
      lam = [1 - mu.reduce((s, x) => s + x, 0), ...mu];
      if (Math.min(...lam) < -1e-12) continue;
      d.forEach((di, k) => (v = addScaled(v, di, mu[k])));
    }
    const dd = dot(v, v);
    if (!best || dd < best.d - 1e-18) best = { d: dd, v, lam, idx };
  }
  return best!;
}

/** Minimum distance between two convex shapes: [distance, point on a, point on b]. 0 when they intersect. */
export function gjk(sa: Shape, sb: Shape, maxIter = 64, tol = 1e-4): [number, V3, V3] {
  const da = support(sa, [1, 0, 0]);
  const db = support(sb, [-1, 0, 0]);
  let simplex: [V3, V3, V3][] = [[sub(da, db), da, db]];
  let v = sub(da, db);
  let lam = [1];
  for (let it = 0; it < maxIter; it++) {
    const vv = dot(v, v);
    if (vv < 1e-12) break;
    const pa = support(sa, scale(v, -1));
    const pb = support(sb, v);
    const w = sub(pa, pb);
    if (vv - dot(v, w) <= tol * Math.sqrt(vv)) break;
    if (simplex.some((s) => isClose(w, s[0], 1e-9))) break;
    simplex.push([w, pa, pb]);
    const r = closestOnSimplex(simplex.map((s) => s[0]));
    v = r.v;
    const picked = r.idx.map((i) => simplex[i]);
    const keep = r.lam.map((l, k) => [l, k] as const).filter(([l]) => l > 1e-12);
    simplex = keep.map(([, k]) => picked[k]);
    lam = keep.map(([l]) => l);
    if (simplex.length === 4) {
      v = [0, 0, 0];
      break;
    }
  }
  const total = lam.reduce((s, x) => s + x, 0) || 1;
  let pa: V3 = [0, 0, 0];
  let pb: V3 = [0, 0, 0];
  simplex.forEach(([, a, b], k) => {
    pa = addScaled(pa, a, lam[k] / total);
    pb = addScaled(pb, b, lam[k] / total);
  });
  const d = len(v);
  return [d < 1e-6 ? 0 : d, pa, pb];
}

interface Item {
  comp: Comp;
  group: string;
  parts: { s: Shape; box: AABB }[];
  box: AABB;
}

export interface ClashOptions {
  clearance?: number;
  /** extra rule: return true to skip a pair */
  skip?: (a: Comp, b: Comp) => boolean;
}

const groupOf = (c: Comp) => `${c.owner.type}:${c.owner.id}`;

export function prepare(comps: readonly Comp[]): Item[] {
  const items: Item[] = [];
  for (const comp of comps) {
    const parts = comp.shapes.flatMap(convexParts).map((s) => ({ s, box: aabbOf(s) }));
    if (!parts.length) continue;
    const box = parts.slice(1).reduce(
      (acc, p) => ({
        lo: [Math.min(acc.lo[0], p.box.lo[0]), Math.min(acc.lo[1], p.box.lo[1]), Math.min(acc.lo[2], p.box.lo[2])] as V3,
        hi: [Math.max(acc.hi[0], p.box.hi[0]), Math.max(acc.hi[1], p.box.hi[1]), Math.max(acc.hi[2], p.box.hi[2])] as V3,
      }),
      parts[0].box,
    );
    items.push({ comp, group: groupOf(comp), parts, box });
  }
  return items;
}

export function itemDistance(x: Item, y: Item, clearance: number): [number, V3, V3] | null {
  let best: [number, V3, V3] | null = null;
  for (const pa of x.parts) {
    for (const pb of y.parts) {
      if (!boxesOverlap(pa.box, pb.box, clearance)) continue;
      const r = gjk(pa.s, pb.s);
      if (!best || r[0] < best[0]) best = r;
      if (best[0] === 0) return best;
    }
  }
  return best;
}

export function findClashes(comps: readonly Comp[], conn: Connectivity, opts: ClashOptions = {}): Clash[] {
  const clearance = opts.clearance ?? 0;
  const near = conn.near(3);
  const items = prepare(comps).sort((a, b) => a.box.lo[0] - b.box.lo[0]);
  const out: Clash[] = [];
  for (let i = 0; i < items.length; i++) {
    const x = items[i];
    for (let j = i + 1; j < items.length; j++) {
      const y = items[j];
      if (y.box.lo[0] - clearance > x.box.hi[0]) break;
      if (x.group === y.group) continue;
      if (!boxesOverlap(x.box, y.box, clearance)) continue;
      if (near.has(pairKey(x.comp.uid, y.comp.uid))) continue;
      if (opts.skip?.(x.comp, y.comp)) continue;
      const r = itemDistance(x, y, clearance);
      if (r && r[0] <= clearance) out.push({ a: x.comp.uid, b: y.comp.uid, distance: r[0], point: scale(add(r[1], r[2]), 0.5), hard: r[0] === 0 });
    }
  }
  return out.sort((p, q) => Number(q.hard) - Number(p.hard) || p.distance - q.distance);
}
