// Clash-aware orthogonal auto-router.
//
// Candidate paths are generated between the two ends (straight stubs out of the nozzles, then
// orthogonal corners, optionally up to a rack lane), validated by the real spec router (every elbow
// and flange must fit), and scored: length + bends + clashes, with a bonus for running on a rack and
// penalties for long horizontal runs off the rack and for runs at head height.

import { catalog } from "./catalog";
import { itemDistance, prepare } from "./clash";
import type { Model } from "./compute";
import type { Comp } from "./model";
import { EndKind, buildLegs, route } from "./routing";
import { cap } from "./shapes";
import { PipingSpec, specApi } from "./spec";
import { RackInfo, pipeElevationOn } from "./structure";
import { V3, addScaled, dist, dot, isAxis, len, norm, sub } from "./vec";

export interface RouteEnd {
  pos: V3;
  /** start: forced leaving direction; end: forced arrival direction (direction of the last leg). null = free. */
  dir: V3 | null;
  kind: EndKind;
  /** at a free start: the direction we must not go back along */
  avoid?: V3 | null;
}

export interface AutoRouteRequest {
  model: Model;
  spec: PipingSpec;
  nps: string;
  start: RouteEnd;
  end: RouteEnd;
  exclude?: Set<string>; // uids to ignore as obstacles
  ownerId?: string; // the line being routed (its own components are ignored)
  clearance?: number;
}

export interface AutoRouteResult {
  path: V3[];
  score: number;
  length: number;
  bends: number;
  clashes: number;
  rackLength: number;
  evaluated: number;
}

const BEND_COST = 450;
const CLASH_COST = 25000;
const RACK_BONUS = 0.35;
const HEADROOM_COST = 0.6;
const OFF_RACK_COST = 0.8; // long horizontal runs belong on a rack
const OFF_RACK_FREE = 4000; // mm of horizontal run allowed off the rack per leg

const uniq = (xs: number[]) => [...new Set(xs.map((x) => Math.round(x)))];

function simplify(path: V3[]): V3[] | null {
  const pts: V3[] = [];
  for (const p of path) if (!pts.length || dist(pts[pts.length - 1], p) > 1) pts.push(p);
  if (pts.length < 2) return null;
  const out: V3[] = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = norm(sub(pts[i], out[out.length - 1]));
    const b = norm(sub(pts[i + 1], pts[i]));
    const d = dot(a, b);
    if (d < -0.999) return null; // doubles back
    if (d > 0.999999) continue; // collinear
    out.push(pts[i]);
  }
  out.push(pts[pts.length - 1]);
  for (let i = 1; i < out.length; i++) if (!isAxis(norm(sub(out[i], out[i - 1])))) return null;
  return out;
}

function corners(a: V3, b: V3, order: number[]): V3[] {
  const out: V3[] = [];
  let p: V3 = a;
  for (const k of order) {
    if (Math.abs(b[k] - p[k]) < 1) continue;
    const q = [...p] as [number, number, number];
    q[k] = b[k];
    p = q;
    out.push(p);
  }
  return out;
}

const ORDERS = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
];

export function autoRoute(req: AutoRouteRequest): AutoRouteResult | null {
  const { model, spec, nps, start, end } = req;
  const od = catalog.od(nps);
  const A = catalog.elbow90(nps);
  const fl = specApi.flange(spec, nps).length;
  const allowance: Record<EndKind, number> = { open: 0, buttweld: 0, flanged: fl, nozzle: fl + spec.gasketThickness };
  // shortest stub: the flange welds straight onto the first elbow (no pipe between)
  const minS = allowance[start.kind] + A;
  const minE = allowance[end.kind] + A;
  const minPipe = spec.minPipeLength;
  const racks: RackInfo[] = [...model.structures.values()].map((s) => s.rack);
  const rackZ = racks.flatMap((r) => r.levels.map((lv) => pipeElevationOn(lv, od)));

  // ---- obstacles -------------------------------------------------------------
  const exclude = req.exclude ?? new Set<string>();
  const obstacles = prepare(
    model.comps.filter((c: Comp) => !exclude.has(c.uid) && !(req.ownerId && c.owner.type === "line" && c.owner.id === req.ownerId)),
  );
  const clearance = req.clearance ?? 30;

  // ---- stub lengths -------------------------------------------------------------
  const stubs = (p: V3, d: V3 | null, min: number, other: V3, sign: 1 | -1): V3[] => {
    if (!d) return [p];
    const vals = [min, min + minPipe + 300, min + 1000];
    const along = dot(sub(other, p), d) * sign;
    if (along >= min + minPipe || Math.abs(along - min) < 1) vals.push(along);
    if (Math.abs(d[2]) > 0.5) for (const z of rackZ) vals.push((z - p[2]) * d[2] * sign);
    const ok = (v: number) => Math.abs(v - min) < 1 || v >= min + minPipe;
    return [...new Set(vals.filter(ok).map((v) => Math.round(v * 100) / 100))].map((v) => addScaled(p, d, v * sign));
  };
  const S = start.pos;
  const T = end.pos;
  const startStubs = stubs(S, start.dir, minS, T, 1);
  const endStubs = stubs(T, end.dir, minE, S, -1);

  // ---- candidate corner sets ---------------------------------------------------
  const candidates: V3[][] = [];
  for (const s1 of startStubs) {
    for (const t1 of endStubs) {
      for (const o of ORDERS) candidates.push([S, s1, ...corners(s1, t1, o), t1, T]);
      const zs = uniq([...rackZ, Math.max(s1[2], t1[2]) + 600]);
      for (const z of zs) {
        const up: V3 = [s1[0], s1[1], z];
        const down: V3 = [t1[0], t1[1], z];
        for (const o of [[0, 1], [1, 0]]) candidates.push([S, s1, up, ...corners(up, down, o), down, t1, T]);
      }
      for (const rk of racks) {
        const ax = rk.axis[0] ? 0 : 1;
        const ac = 1 - ax;
        for (const lv of rk.levels) {
          const z = pipeElevationOn(lv, od);
          for (let v = -rk.width / 2 + 600; v <= rk.width / 2 - 600 + 1; v += 600) {
            const lane = rk.start[ac] + v;
            const p1 = [...s1] as [number, number, number];
            p1[2] = z;
            const p2 = [...p1] as [number, number, number];
            p2[ac] = lane;
            const p3 = [...p2] as [number, number, number];
            p3[ax] = t1[ax];
            const p4 = [...p3] as [number, number, number];
            p4[ac] = t1[ac];
            candidates.push([S, s1, p1, p2, p3, p4, [t1[0], t1[1], z], t1, T]);
            candidates.push([S, s1, [p2[0], p2[1], s1[2]], p2, p3, p4, [t1[0], t1[1], z], t1, T]);
          }
        }
      }
    }
  }

  // ---- validate and score ---------------------------------------------------------
  type Scored = { path: V3[]; lower: number };
  const seen = new Set<string>();
  const valid: Scored[] = [];
  for (const c of candidates) {
    const path = simplify(c);
    if (!path) continue;
    const k = path.map((p) => p.map(Math.round).join(",")).join(";");
    if (seen.has(k)) continue;
    seen.add(k);
    const d0 = norm(sub(path[1], path[0]));
    if (start.dir && dot(d0, start.dir) < 0.999) continue;
    if (!start.dir && start.avoid && dot(d0, start.avoid) < -0.999) continue;
    if (end.dir && dot(norm(sub(path[path.length - 1], path[path.length - 2])), end.dir) < 0.999) continue;
    let length = 0;
    for (let i = 1; i < path.length; i++) length += dist(path[i - 1], path[i]);
    valid.push({ path, lower: length + BEND_COST * (path.length - 2) - RACK_BONUS * length });
  }
  valid.sort((a, b) => a.lower - b.lower);

  let best: AutoRouteResult | null = null;
  let evaluated = 0;
  for (const cand of valid) {
    if (best && cand.lower >= best.score) break;
    const r = route({ spec, owner: "auto", label: "auto-route", nps, points: cand.path, start: start.kind, end: end.kind, startDir: start.dir, endDir: end.dir });
    if (r.error) continue;
    evaluated += 1;
    const res = score(cand.path, od, racks, obstacles, clearance, allowance[start.kind], allowance[end.kind]);
    if (!best || res.score < best.score) best = { ...res, path: cand.path, evaluated };
    if (evaluated > 400) break;
  }
  if (best) best.evaluated = evaluated;
  return best;
}

function onRack(a: V3, b: V3, od: number, racks: RackInfo[]): number {
  if (Math.abs(a[2] - b[2]) > 1e-6) return 0;
  const d = sub(b, a);
  for (const rk of racks) {
    if (!rk.levels.some((lv) => Math.abs(pipeElevationOn(lv, od) - a[2]) < 2)) continue;
    if (Math.abs(Math.abs(dot(d, rk.axis)) - len(d)) > 1e-6) continue;
    if (Math.abs(dot(sub(a, rk.start), rk.across)) > rk.width / 2) continue;
    const u0 = dot(sub(a, rk.start), rk.axis);
    const u1 = dot(sub(b, rk.start), rk.axis);
    const lo = Math.max(0, Math.min(u0, u1));
    const hi = Math.min(rk.length, Math.max(u0, u1));
    if (hi > lo) return hi - lo;
  }
  return 0;
}

function score(path: V3[], od: number, racks: RackInfo[], obstacles: ReturnType<typeof prepare>, clearance: number, trimS: number, trimE: number) {
  let length = 0;
  let rackLength = 0;
  let headroom = 0;
  let offRack = 0;
  const segs: ReturnType<typeof prepare>[number][] = [];
  for (let i = 1; i < path.length; i++) {
    let a = path[i - 1];
    let b = path[i];
    const l = dist(a, b);
    length += l;
    const rk = onRack(a, b, od, racks);
    rackLength += rk;
    const horizontal = Math.abs(a[2] - b[2]) < 1e-6;
    if (horizontal && a[2] > 500 && a[2] < 2400 && l > 1500 && i > 1 && i < path.length - 1) headroom += l;
    if (horizontal && racks.length) offRack += Math.max(0, l - rk - OFF_RACK_FREE);
    const u = norm(sub(b, a));
    if (i === 1) a = addScaled(a, u, Math.min(trimS + 5, l / 2));
    if (i === path.length - 1) b = addScaled(b, u, -Math.min(trimE + 5, l / 2));
    const shape = cap(a, b, od / 2 + clearance / 2);
    segs.push({ comp: null as unknown as Comp, group: "auto", parts: [{ s: shape, box: boxOf(a, b, od / 2 + clearance / 2) }], box: boxOf(a, b, od / 2 + clearance / 2) });
  }
  const hit = new Set<string>();
  for (const s of segs) {
    for (const o of obstacles) {
      if (hit.has(o.comp.uid)) continue;
      if (!boxOverlap(s.box, o.box)) continue;
      const r = itemDistance(s, o, clearance / 2);
      if (r && r[0] <= clearance / 2) hit.add(o.comp.uid);
    }
  }
  const bends = path.length - 2;
  return {
    length,
    bends,
    clashes: hit.size,
    rackLength,
    score: length + BEND_COST * bends + CLASH_COST * hit.size - RACK_BONUS * rackLength + HEADROOM_COST * headroom + OFF_RACK_COST * offRack,
  };
}

const boxOf = (a: V3, b: V3, r: number) => ({
  lo: [Math.min(a[0], b[0]) - r, Math.min(a[1], b[1]) - r, Math.min(a[2], b[2]) - r] as V3,
  hi: [Math.max(a[0], b[0]) + r, Math.max(a[1], b[1]) + r, Math.max(a[2], b[2]) + r] as V3,
});

const boxOverlap = (a: { lo: V3; hi: V3 }, b: { lo: V3; hi: V3 }) =>
  a.lo[0] <= b.hi[0] && b.lo[0] <= a.hi[0] && a.lo[1] <= b.hi[1] && b.lo[1] <= a.hi[1] && a.lo[2] <= b.hi[2] && b.lo[2] <= a.hi[2];

/** Legs of a candidate path, for previews. */
export const pathLegs = (path: V3[]) => buildLegs("preview", path);


