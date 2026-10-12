// Detail geometry for the 3D view: bolting, ladders, platforms, handrails, stairs and foundations.
// These shapes make the model read like a real plant; they are not part of clash checks or exports.

import { Shape, cyl, finish, obox } from "./shapes";
import { V3, add, addScaled, anyPerp, cross, norm, scale, sub } from "./vec";

const Z: V3 = [0, 0, 1];

/** Studs and nuts on a bolt circle. `u` points from the flange back towards its face; offsets are along u. */
export function boltRing(centre: V3, u: V3, bc: number, count: number, boltDia: number, studFrom: number, studTo: number, nutAt: number): Shape[] {
  const x = anyPerp(u);
  const y = cross(u, x);
  const out: Shape[] = [];
  const d = Math.max(boltDia, 12);
  for (let i = 0; i < count; i++) {
    const a = ((i + 0.5) / count) * Math.PI * 2; // bolt holes straddle the centre lines
    const p = add(centre, add(scale(x, (Math.cos(a) * bc) / 2), scale(y, (Math.sin(a) * bc) / 2)));
    out.push({ ...cyl(addScaled(p, u, studFrom), addScaled(p, u, studTo), d / 2), m: "bolt" });
    out.push({ ...cyl(addScaled(p, u, nutAt - d * 0.9), addScaled(p, u, nutAt), d * 0.95), m: "nut" });
  }
  return out;
}

/** Caged-free fixed ladder: two stringers and rungs, `out` points away from the wall. */
export function ladder(foot: V3, height: number, out: V3, width = 450): Shape[] {
  const side = norm(cross(Z, out));
  const shapes: Shape[] = [];
  for (const s of [-1, 1]) {
    const b = addScaled(foot, side, (s * width) / 2);
    shapes.push(cyl(b, addScaled(b, Z, height + 1000), 22));
  }
  for (let h = 300; h < height; h += 300) {
    const c = addScaled(foot, Z, h);
    shapes.push(cyl(addScaled(c, side, -width / 2), addScaled(c, side, width / 2), 11));
  }
  // safety cage hoops above 2.5 m
  for (let h = 2500; h < height + 900; h += 900) {
    const c = addScaled(addScaled(foot, Z, h), out, 380);
    shapes.push({ t: "tor", c, s: addScaled(c, side, 380), n: Z, ang: Math.PI * 2, r: 12 });
  }
  return finish("rail", ...shapes);
}

/** Circular platform around a vertical shell: grating segments, toe plate, handrail with posts. */
export function ringPlatform(axis: V3, level: number, rIn: number, width: number, from = 0, to = 360): Shape[] {
  const shapes: Shape[] = [];
  const n = Math.max(6, Math.round(((to - from) / 360) * 24));
  const rOut = rIn + width;
  const rMid = rIn + width / 2;
  const pt = (r: number, deg: number, z: number): V3 => {
    const a = (deg * Math.PI) / 180;
    return [axis[0] + Math.sin(a) * r, axis[1] + Math.cos(a) * r, z];
  };
  for (let i = 0; i < n; i++) {
    const a0 = from + ((to - from) * i) / n;
    const a1 = from + ((to - from) * (i + 1)) / n;
    const am = (a0 + a1) / 2;
    const radial = norm(sub(pt(1, am, 0), pt(0, am, 0)));
    const tang = norm(cross(Z, radial));
    const chord = 2 * rOut * Math.sin((((a1 - a0) / 2) * Math.PI) / 180) + 10;
    shapes.push({ ...obox(pt(rMid, am, level - 20), [tang, radial, Z], [chord, width, 40]), m: "grating" });
    shapes.push({ ...obox(pt(rOut - 5, am, level + 50), [tang, radial, Z], [chord, 8, 100]), m: "rail" });
  }
  const railR = rOut - 30;
  for (const h of [550, 1100]) {
    const c: V3 = [axis[0], axis[1], level + h];
    const ang = ((to - from) * Math.PI) / 180;
    const a0 = (from * Math.PI) / 180;
    shapes.push({ t: "tor", c, s: [axis[0] + Math.sin(a0) * railR, axis[1] + Math.cos(a0) * railR, level + h], n: [0, 0, -1], ang, r: h > 600 ? 24 : 16, m: "rail" });
  }
  const posts = Math.max(3, Math.round(((to - from) / 360) * 14));
  for (let i = 0; i <= posts; i++) {
    const a = from + ((to - from) * i) / posts;
    if (to - from >= 360 && i === posts) break;
    shapes.push({ ...cyl(pt(railR, a, level), pt(railR, a, level + 1100), 22), m: "rail" });
  }
  return shapes;
}

/** Spiral stair up the outside of a tank shell, with stringer, treads and outer handrail. */
export function spiralStair(axis: V3, rShell: number, height: number, startDeg: number, sweepDeg: number): Shape[] {
  const shapes: Shape[] = [];
  const rise = 200;
  const steps = Math.floor(height / rise);
  const rIn = rShell + 80;
  const w = 800;
  const at = (r: number, deg: number, z: number): V3 => {
    const a = (deg * Math.PI) / 180;
    return [axis[0] + Math.sin(a) * r, axis[1] + Math.cos(a) * r, z];
  };
  let prevOuter: V3 | null = null;
  let prevRail: V3 | null = null;
  for (let i = 1; i <= steps; i++) {
    const deg = startDeg + (sweepDeg * i) / steps;
    const z = i * rise;
    const radial = norm(sub(at(1, deg, 0), at(0, deg, 0)));
    const tang = norm(cross(Z, radial));
    shapes.push({ ...obox(at(rIn + w / 2, deg, z - 15), [tang, radial, Z], [260, w, 30]), m: "grating" });
    const outer = at(rIn + w, deg, z - 120);
    const rail = at(rIn + w - 20, deg, z + 950);
    if (prevOuter) shapes.push({ ...cyl(prevOuter, outer, 45), m: "steel" });
    if (prevRail) shapes.push({ ...cyl(prevRail, rail, 22), m: "rail" });
    if (i % 5 === 0) shapes.push({ ...cyl(at(rIn + w - 20, deg, z), rail, 20), m: "rail" });
    prevOuter = outer;
    prevRail = rail;
  }
  return shapes;
}

/** Concrete block under a footprint (top at `top`, going `depth` down). */
export function plinth(lo: V3, hi: V3, top = 0, depth = 250): Shape {
  const c: V3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, top - depth / 2];
  return { ...obox(c, [[1, 0, 0], [0, 1, 0], Z], [hi[0] - lo[0], hi[1] - lo[1], depth]), m: "concrete" };
}

/** Octagonal concrete foundation under a round footprint. */
export function octFoundation(centre: V3, radius: number, top = 0, depth = 400): Shape {
  return { ...cyl([centre[0], centre[1], top - depth], [centre[0], centre[1], top], radius), m: "concrete8" };
}
