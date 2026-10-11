// Graphic primitives ("symbol outputs"). The viewer, clash checker and exporters all read the same list.

import { EPS, V3, add, addScaled, anyPerp, cross, dot, len, norm, rotate, scale, sub } from "./vec";

export type Basis = readonly [V3, V3, V3];

export type Shape =
  | { t: "cyl"; a: V3; b: V3; r: number }
  | { t: "fru"; a: V3; b: V3; ra: number; rb: number }
  | { t: "box"; c: V3; ax: Basis; h: V3 } // oriented box: centre, unit axes, half extents
  | { t: "sph"; c: V3; r: number }
  | { t: "ell"; c: V3; ax: Basis; r: V3 } // ellipsoid: centre, unit axes, radii
  | { t: "tor"; c: V3; s: V3; n: V3; ang: number; r: number } // swept circle along an arc
  | { t: "cap"; a: V3; b: V3; r: number }; // capsule (used by the auto-router)

export interface AABB {
  lo: V3;
  hi: V3;
}

export const WORLD: Basis = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

export const cyl = (a: V3, b: V3, r: number): Shape => ({ t: "cyl", a, b, r });
export const fru = (a: V3, b: V3, ra: number, rb: number): Shape => ({ t: "fru", a, b, ra, rb });
export const sph = (c: V3, r: number): Shape => ({ t: "sph", c, r });
export const ell = (c: V3, ax: Basis, r: V3): Shape => ({ t: "ell", c, ax, r });
export const cap = (a: V3, b: V3, r: number): Shape => ({ t: "cap", a, b, r });

/** Axis-aligned box from two corners. */
export function boxMinMax(lo: V3, hi: V3): Shape {
  return { t: "box", c: scale(add(lo, hi), 0.5), ax: WORLD, h: scale(sub(hi, lo), 0.5) };
}

/** Oriented box from centre, axes and full sizes. */
export function obox(c: V3, ax: Basis, size: V3): Shape {
  return { t: "box", c, ax, h: scale(size, 0.5) };
}

/** Basis rotated about Z by deg. */
export function basisZ(deg: number): Basis {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [
    [c, s, 0],
    [-s, c, 0],
    [0, 0, 1],
  ];
}

/** A basis whose third axis is u. */
export function basisAlong(u: V3): Basis {
  const x = anyPerp(u);
  return [x, cross(u, x), u];
}

export const torEnd = (s: Extract<Shape, { t: "tor" }>): V3 => add(s.c, rotate(sub(s.s, s.c), s.n, s.ang));
export const torRadius = (s: Extract<Shape, { t: "tor" }>): number => len(sub(s.s, s.c));

export function torCenterline(s: Extract<Shape, { t: "tor" }>, segments = 16): V3[] {
  const r0 = sub(s.s, s.c);
  const out: V3[] = [];
  for (let i = 0; i <= segments; i++) out.push(add(s.c, rotate(r0, s.n, (s.ang * i) / segments)));
  return out;
}

function discExtent(axis: V3, r: number): V3 {
  return [
    r * Math.sqrt(Math.max(0, 1 - axis[0] * axis[0])),
    r * Math.sqrt(Math.max(0, 1 - axis[1] * axis[1])),
    r * Math.sqrt(Math.max(0, 1 - axis[2] * axis[2])),
  ];
}

function discSupport(c: V3, axis: V3, r: number, d: V3): V3 {
  const perp = addScaled(d, axis, -dot(d, axis));
  const n = len(perp);
  return n < EPS ? c : addScaled(c, perp, r / n);
}

const unionBox = (a: AABB, b: AABB): AABB => ({
  lo: [Math.min(a.lo[0], b.lo[0]), Math.min(a.lo[1], b.lo[1]), Math.min(a.lo[2], b.lo[2])],
  hi: [Math.max(a.hi[0], b.hi[0]), Math.max(a.hi[1], b.hi[1]), Math.max(a.hi[2], b.hi[2])],
});

export function aabbOf(s: Shape): AABB {
  switch (s.t) {
    case "cyl":
    case "cap": {
      const e = s.t === "cap" ? ([s.r, s.r, s.r] as V3) : discExtent(norm(sub(s.b, s.a)), s.r);
      return {
        lo: [Math.min(s.a[0], s.b[0]) - e[0], Math.min(s.a[1], s.b[1]) - e[1], Math.min(s.a[2], s.b[2]) - e[2]],
        hi: [Math.max(s.a[0], s.b[0]) + e[0], Math.max(s.a[1], s.b[1]) + e[1], Math.max(s.a[2], s.b[2]) + e[2]],
      };
    }
    case "fru": {
      const u = norm(sub(s.b, s.a));
      const ea = discExtent(u, s.ra);
      const eb = discExtent(u, s.rb);
      return unionBox({ lo: sub(s.a, ea), hi: add(s.a, ea) }, { lo: sub(s.b, eb), hi: add(s.b, eb) });
    }
    case "sph":
      return { lo: sub(s.c, [s.r, s.r, s.r]), hi: add(s.c, [s.r, s.r, s.r]) };
    case "box":
    case "ell": {
      const ext = s.t === "box" ? s.h : s.r;
      const e: number[] = [0, 0, 0];
      for (let k = 0; k < 3; k++) {
        e[k] =
          s.t === "box"
            ? Math.abs(s.ax[0][k]) * ext[0] + Math.abs(s.ax[1][k]) * ext[1] + Math.abs(s.ax[2][k]) * ext[2]
            : Math.sqrt((s.ax[0][k] * ext[0]) ** 2 + (s.ax[1][k] * ext[1]) ** 2 + (s.ax[2][k] * ext[2]) ** 2);
      }
      return { lo: sub(s.c, e as unknown as V3), hi: add(s.c, e as unknown as V3) };
    }
    case "tor": {
      const parts = convexParts(s);
      return parts.map(aabbOf).reduce(unionBox);
    }
  }
}

export function shapesAABB(shapes: readonly Shape[]): AABB | null {
  if (!shapes.length) return null;
  return shapes.map(aabbOf).reduce(unionBox);
}

export const boxesOverlap = (a: AABB, b: AABB, m = 0): boolean =>
  a.lo[0] - m <= b.hi[0] &&
  b.lo[0] - m <= a.hi[0] &&
  a.lo[1] - m <= b.hi[1] &&
  b.lo[1] - m <= a.hi[1] &&
  a.lo[2] - m <= b.hi[2] &&
  b.lo[2] - m <= a.hi[2];

/** Support point of a convex shape in direction d (for GJK). */
export function support(s: Shape, d: V3): V3 {
  switch (s.t) {
    case "cyl": {
      const u = norm(sub(s.b, s.a));
      return discSupport(dot(d, u) > 0 ? s.b : s.a, u, s.r, d);
    }
    case "fru": {
      const u = norm(sub(s.b, s.a));
      const pa = discSupport(s.a, u, s.ra, d);
      const pb = discSupport(s.b, u, s.rb, d);
      return dot(pa, d) >= dot(pb, d) ? pa : pb;
    }
    case "box": {
      let p = s.c;
      for (let k = 0; k < 3; k++) p = addScaled(p, s.ax[k], dot(d, s.ax[k]) > 0 ? s.h[k] : -s.h[k]);
      return p;
    }
    case "sph": {
      const n = len(d);
      return n < EPS ? s.c : addScaled(s.c, d, s.r / n);
    }
    case "cap": {
      const end = dot(d, sub(s.b, s.a)) > 0 ? s.b : s.a;
      const n = len(d);
      return n < EPS ? end : addScaled(end, d, s.r / n);
    }
    case "ell": {
      const l = [dot(d, s.ax[0]) * s.r[0], dot(d, s.ax[1]) * s.r[1], dot(d, s.ax[2]) * s.r[2]];
      const n = Math.hypot(l[0], l[1], l[2]);
      if (n < EPS) return s.c;
      let p = s.c;
      for (let k = 0; k < 3; k++) p = addScaled(p, s.ax[k], (l[k] * s.r[k]) / n);
      return p;
    }
    case "tor":
      throw new Error("torus is not convex: use convexParts()");
  }
}

/** Convex decomposition: a torus becomes chord cylinders that enclose it; everything else is itself. */
export function convexParts(s: Shape): Shape[] {
  if (s.t !== "tor") return [s];
  const full = s.ang >= 2 * Math.PI - 1e-9;
  const segments = Math.max(2, Math.ceil(s.ang / (Math.PI / 8)));
  const pts = torCenterline(s, segments);
  const half = s.ang / segments / 2;
  const R = torRadius(s);
  const r = s.r + R * (1 - Math.cos(half));
  const ext = r * Math.tan(half);
  const out: Shape[] = [];
  for (let i = 0; i < segments; i++) {
    let a = pts[i];
    let b = pts[i + 1];
    const u = norm(sub(b, a));
    if (i > 0 || full) a = addScaled(a, u, -ext);
    if (i < segments - 1 || full) b = addScaled(b, u, ext);
    out.push(cyl(a, b, r));
  }
  return out;
}

/** Move every point of a shape by a rigid transform (rotate about Z, then translate). */
export function transformShape(s: Shape, rotDeg: number, offset: V3): Shape {
  const rad = (rotDeg * Math.PI) / 180;
  const c = Math.cos(rad);
  const sn = Math.sin(rad);
  const D = (p: V3): V3 => [p[0] * c - p[1] * sn, p[0] * sn + p[1] * c, p[2]];
  const P = (p: V3): V3 => add(D(p), offset);
  switch (s.t) {
    case "cyl":
    case "cap":
    case "fru":
      return { ...s, a: P(s.a), b: P(s.b) };
    case "sph":
      return { ...s, c: P(s.c) };
    case "box":
    case "ell":
      return { ...s, c: P(s.c), ax: [D(s.ax[0]), D(s.ax[1]), D(s.ax[2])] as Basis } as Shape;
    case "tor":
      return { ...s, c: P(s.c), s: P(s.s), n: D(s.n) };
  }
}
