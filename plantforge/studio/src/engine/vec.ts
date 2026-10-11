// Small immutable 3D vector helpers. Plant axes: X = East, Y = North, Z = Elevation (mm).

export type V3 = readonly [number, number, number];

export const ORIGIN: V3 = [0, 0, 0];
export const EX: V3 = [1, 0, 0];
export const EY: V3 = [0, 1, 0];
export const EZ: V3 = [0, 0, 1];
export const EPS = 1e-9;

export const v3 = (x: number, y: number, z: number): V3 => [x, y, z];
export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
export const addScaled = (a: V3, b: V3, k: number): V3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
export const neg = (a: V3): V3 => [-a[0], -a[1], -a[2]];
export const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const len = (a: V3): number => Math.sqrt(dot(a, a));
export const dist = (a: V3, b: V3): number => len(sub(a, b));
export const lerp = (a: V3, b: V3, t: number): V3 => addScaled(a, sub(b, a), t);
export const mid = (a: V3, b: V3): V3 => lerp(a, b, 0.5);

export function norm(a: V3): V3 {
  const n = len(a);
  if (n < EPS) throw new Error("cannot normalise a zero-length vector");
  return [a[0] / n, a[1] / n, a[2] / n];
}

export const isClose = (a: V3, b: V3, tol = 1e-6): boolean => dist(a, b) <= tol;

export function anyPerp(u: V3): V3 {
  const ref = Math.abs(u[2]) < 0.9 ? EZ : EX;
  return norm(cross(u, ref));
}

/** Rodrigues rotation of v about unit axis by angle (radians, right-hand). */
export function rotate(v: V3, axis: V3, angle: number): V3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const k = dot(axis, v) * (1 - c);
  const x = cross(axis, v);
  return [v[0] * c + x[0] * s + axis[0] * k, v[1] * c + x[1] * s + axis[1] * k, v[2] * c + x[2] * s + axis[2] * k];
}

export function angleBetween(u: V3, v: V3): number {
  const c = Math.max(-1, Math.min(1, dot(norm(u), norm(v))));
  return Math.acos(c);
}

/** Rotate about the vertical axis by deg (counter-clockwise seen from above). */
export function rotZ(v: V3, deg: number): V3 {
  if (!deg) return v;
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [v[0] * c - v[1] * s, v[0] * s + v[1] * c, v[2]];
}

export const round = (a: V3, nd = 3): V3 => {
  const f = 10 ** nd;
  return [Math.round(a[0] * f) / f + 0, Math.round(a[1] * f) / f + 0, Math.round(a[2] * f) / f + 0];
};

const sgn = (n: number) => (n < 0 ? "-" : "+");

/** Plant coordinate as designers write it: "E 1200 N 300 EL +3500" (W/S for negatives). */
export function fmtENU(p: V3): string {
  const e = Math.round(p[0]);
  const n = Math.round(p[1]);
  const z = Math.round(p[2]);
  return `${e < 0 ? "W" : "E"} ${Math.abs(e)} ${n < 0 ? "S" : "N"} ${Math.abs(n)} EL ${sgn(z)}${Math.abs(z)}`;
}

const AXIS_NAMES: [V3, string][] = [
  [EX, "E"],
  [neg(EX), "W"],
  [EY, "N"],
  [neg(EY), "S"],
  [EZ, "U"],
  [neg(EZ), "D"],
];

/** "E", "W", "N", "S", "U", "D" for an axis direction, or a compact vector for anything else. */
export function dirName(d: V3): string {
  for (const [a, n] of AXIS_NAMES) if (dot(a, d) > 1 - 1e-9) return n;
  return `(${d.map((c) => c.toFixed(2)).join(", ")})`;
}

export function dirFromName(name: string): V3 | null {
  const m = AXIS_NAMES.find(([, n]) => n === name.toUpperCase());
  return m ? m[0] : null;
}

/** Snap a direction to the nearest world axis. */
export function nearestAxis(d: V3): V3 {
  let best: V3 = EX;
  let bd = -Infinity;
  for (const [a] of AXIS_NAMES) {
    const k = dot(a, d);
    if (k > bd) {
      bd = k;
      best = a;
    }
  }
  return best;
}

export const isAxis = (d: V3): boolean => AXIS_NAMES.some(([a]) => dot(a, d) > 1 - 1e-9);
