// Spec-driven pipe routing: polyline -> elbows, end assemblies, inline items and pipe.

import { CatalogError, catalog, normalizeNps } from "./catalog";
import { Comp } from "./model";
import { makeElbow, makeFlange, makeGasket, makePipe, makeTee, makeValve } from "./parts";
import { PipingSpec, SpecError, specApi } from "./spec";
import { EZ, EX, V3, addScaled, angleBetween, dist, dot, fmtENU, isClose, norm, sub } from "./vec";

export const TOL = 0.5;
const COLLINEAR = 1e-7;
const MIN_TURN = 1;
export const VALVE_TYPES = ["gate", "globe", "check"] as const;

export class RoutingError extends Error {}

export type EndKind = "open" | "buttweld" | "flanged" | "nozzle";

export interface InlineItem {
  id: string;
  type: "gate" | "globe" | "check" | "tee";
  leg: number; // index into the line's full point list (including connected end points)
  station: number; // distance from the leg start to the item centre, mm
  branch?: V3;
  stem?: V3;
}

export interface RouteInput {
  spec: PipingSpec;
  owner: string; // line id
  label: string; // line number, for messages
  nps: string;
  points: V3[];
  start: EndKind;
  end: EndKind;
  inline?: InlineItem[];
  startDir?: V3 | null;
  endDir?: V3 | null;
  startRef?: string;
  endRef?: string;
}

export interface Leg {
  start: V3;
  end: V3;
  dir: V3;
  length: number;
  /** original (doc) legs merged into this one: index and offset of its start along this leg */
  parts: { index: number; offset: number }[];
}

export interface RouteResult {
  comps: Comp[];
  warnings: string[];
  error?: string;
  legs: Leg[];
}

interface Slot {
  s0: number;
  s1: number;
  label: string;
  build?: () => Comp[];
  order: number;
}

class Tags {
  private counts: Record<string, number> = {};
  next(prefix: string): string {
    this.counts[prefix] = (this.counts[prefix] ?? 0) + 1;
    return `${prefix}${this.counts[prefix]}`;
  }
}

export function buildLegs(label: string, pts: readonly V3[]): Leg[] {
  if (pts.length < 2) throw new RoutingError(`${label}: a route needs at least two points`);
  const legs: Leg[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (dist(a, b) < TOL) throw new RoutingError(`${label}: leg ${i} has zero length at ${fmtENU(a)}`);
    const d = norm(sub(b, a));
    const last = legs[legs.length - 1];
    if (last) {
      const turn = angleBetween(last.dir, d);
      if (turn < COLLINEAR) {
        last.parts.push({ index: i, offset: last.length });
        last.end = b;
        last.length = dist(last.start, b);
        continue;
      }
      if (turn > Math.PI - COLLINEAR) throw new RoutingError(`${label}: route doubles back on itself at ${fmtENU(a)}`);
    }
    legs.push({ start: a, end: b, dir: d, length: dist(a, b), parts: [{ index: i, offset: 0 }] });
  }
  return legs;
}

/** Map a station on a merged leg back to the doc leg it falls on. */
export function toDocStation(legs: Leg[], legIndex: number, s: number): { leg: number; station: number } {
  const leg = legs[legIndex];
  let part = leg.parts[0];
  for (const p of leg.parts) if (p.offset <= s + 1e-6) part = p;
  return { leg: part.index, station: s - part.offset };
}

function locate(legs: Leg[], docLeg: number): { k: number; offset: number } | null {
  for (let k = 0; k < legs.length; k++) for (const p of legs[k].parts) if (p.index === docLeg) return { k, offset: p.offset };
  return null;
}

const at = (leg: Leg, s: number): V3 => addScaled(leg.start, leg.dir, s);

function selectElbow(label: string, nps: string, angle: number, where: V3): [string, number, number] {
  if (Math.abs(angle - 90) <= 0.01) return ["90 LR", 90, catalog.elbow90(nps)];
  if (Math.abs(angle - 45) <= 0.01) return ["45 LR", 45, catalog.elbow45(nps)];
  if (angle >= MIN_TURN && angle < 90) {
    const a = Math.round(angle * 100) / 100;
    return [`90 LR trimmed ${a}`, a, catalog.elbow90(nps) * Math.tan((a * Math.PI) / 360)];
  }
  if (angle < MIN_TURN) throw new RoutingError(`${label}: ${angle.toFixed(2)} deg turn at ${fmtENU(where)} is too small for an elbow`);
  throw new RoutingError(`${label}: ${angle.toFixed(1)} deg turn at ${fmtENU(where)} exceeds 90 deg - add an intermediate point`);
}

function checkDir(label: string, actual: V3, req: V3 | null | undefined, what: string, ref: string) {
  if (!req) return;
  if (dot(actual, norm(req)) < 1 - 1e-9) throw new RoutingError(`${label}: ${what} must leave ${ref} straight along the nozzle axis`);
}

export function stemFor(d: V3, stem?: V3): V3 {
  if (stem) {
    const s = norm(stem);
    if (Math.abs(dot(s, d)) > 1e-6) throw new RoutingError("valve stem must be perpendicular to the pipe");
    return s;
  }
  if (Math.abs(dot(d, EZ)) < 0.99) return norm(addScaled(EZ, d, -dot(d, EZ)));
  return norm(addScaled(EX, d, -dot(d, EX)));
}

export function route(input: RouteInput): RouteResult {
  try {
    return routeOrThrow(input);
  } catch (e) {
    if (e instanceof RoutingError || e instanceof SpecError || e instanceof CatalogError) {
      let legs: Leg[] = [];
      try {
        legs = buildLegs(input.label, input.points);
      } catch {
        /* geometry itself is broken */
      }
      return { comps: [], warnings: [], error: e.message.startsWith(input.label) ? e.message : `${input.label}: ${e.message}`, legs };
    }
    throw e;
  }
}

export function routeOrThrow(input: RouteInput): RouteResult {
  const { spec, owner, label } = input;
  const nps = normalizeNps(input.nps);
  specApi.pipe(spec, nps);
  const legs = buildLegs(label, input.points);
  checkDir(label, legs[0].dir, input.startDir, "the first leg", input.startRef || "the start");
  checkDir(label, legs[legs.length - 1].dir, input.endDir, "the last leg", input.endRef || "the end");

  const tags = new Tags();
  const base = (tag: string) => ({ tag, owner: { type: "line" as const, id: owner } });
  const flLen = specApi.flange(spec, nps).length;
  const g = spec.gasketThickness;
  const comps: Comp[] = [];
  const warnings: string[] = [];

  const bends = new Map<number, [string, number, number]>();
  for (let k = 1; k < legs.length; k++) {
    const angle = (angleBetween(legs[k - 1].dir, legs[k].dir) * 180) / Math.PI;
    bends.set(k, selectElbow(label, nps, angle, legs[k].start));
  }

  const slots: Slot[][] = legs.map(() => []);
  for (const [k, [variant, , tan]] of bends) {
    const lbl = `${variant} elbow at ${fmtENU(legs[k].start)}`;
    slots[k - 1].push({ s0: legs[k - 1].length - tan, s1: legs[k - 1].length, label: lbl, order: 2 });
    slots[k].push({ s0: 0, s1: tan, label: lbl, order: 0 });
  }

  const first = legs[0];
  const last = legs[legs.length - 1];
  const allowance: Record<EndKind, number> = { open: 0, buttweld: 0, flanged: flLen, nozzle: g + flLen };
  if (allowance[input.start]) {
    slots[0].push({
      s0: 0,
      s1: allowance[input.start],
      label: `${input.start} start`,
      order: 0,
      build: () =>
        input.start === "flanged"
          ? [makeFlange(spec, nps, base(tags.next("F")), at(first, flLen), at(first, 0))]
          : [
              makeGasket(spec, nps, base(tags.next("G")), at(first, 0), at(first, g)),
              makeFlange(spec, nps, base(tags.next("F")), at(first, g + flLen), at(first, g)),
            ],
    });
  }
  if (allowance[input.end]) {
    const L = last.length;
    slots[legs.length - 1].push({
      s0: L - allowance[input.end],
      s1: L,
      label: `${input.end} end`,
      order: 2,
      build: () =>
        input.end === "flanged"
          ? [makeFlange(spec, nps, base(tags.next("F")), at(last, L - flLen), at(last, L))]
          : [
              makeFlange(spec, nps, base(tags.next("F")), at(last, L - g - flLen), at(last, L - g)),
              makeGasket(spec, nps, base(tags.next("G")), at(last, L - g), at(last, L)),
            ],
    });
  }

  for (const item of input.inline ?? []) {
    const loc = locate(legs, item.leg);
    if (!loc) throw new RoutingError(`${label}: ${item.type} ${item.id} sits on leg ${item.leg}, which no longer exists`);
    const leg = legs[loc.k];
    const s = loc.offset + item.station;
    if (item.type === "tee") {
      if (!item.branch) throw new RoutingError(`${label}: tee needs a branch direction`);
      const br = norm(item.branch);
      if (Math.abs(dot(br, leg.dir)) > 1e-6) throw new RoutingError(`${label}: tee branch must be perpendicular to the run`);
      const c = catalog.tee(nps);
      slots[loc.k].push({
        s0: s - c,
        s1: s + c,
        label: `tee at ${fmtENU(at(leg, s))}`,
        order: 1,
        build: () => {
          const t = makeTee(spec, nps, base(tags.next("T")), at(leg, s), leg.dir, br);
          t.props.inlineId = item.id;
          return [t];
        },
      });
    } else if ((VALVE_TYPES as readonly string[]).includes(item.type)) {
      const { length } = specApi.valve(spec, item.type, nps);
      const stem = stemFor(leg.dir, item.stem);
      const total = 2 * flLen + 2 * g + length;
      const s0 = s - total / 2;
      slots[loc.k].push({
        s0,
        s1: s0 + total,
        label: `${item.type} valve at ${fmtENU(at(leg, s))}`,
        order: 1,
        build: () => {
          const a = s0 + flLen + g;
          const b = a + length;
          const v = makeValve(spec, nps, base(tags.next("V")), item.type, at(leg, a), at(leg, b), stem);
          v.props.inlineId = item.id;
          const out = [
            makeFlange(spec, nps, base(tags.next("F")), at(leg, s0), at(leg, s0 + flLen)),
            makeGasket(spec, nps, base(tags.next("G")), at(leg, s0 + flLen), at(leg, a)),
            v,
            makeGasket(spec, nps, base(tags.next("G")), at(leg, b), at(leg, b + g)),
            makeFlange(spec, nps, base(tags.next("F")), at(leg, s0 + total), at(leg, b + g)),
          ];
          for (const c of out) c.props.inlineId = item.id;
          return out;
        },
      });
    } else throw new RoutingError(`${label}: unknown inline item ${item.type}`);
  }

  legs.forEach((leg, i) => {
    const L = leg.length;
    const ordered = [...slots[i]].sort((a, b) => a.s0 - b.s0 || a.order - b.order);
    for (const sl of ordered) {
      if (sl.s0 < -TOL || sl.s1 > L + TOL)
        throw new RoutingError(`${label}: ${sl.label} does not fit on the ${Math.round(L)} mm leg ${fmtENU(leg.start)} -> ${fmtENU(leg.end)}`);
    }
    for (let j = 1; j < ordered.length; j++) {
      const a = ordered[j - 1];
      const b = ordered[j];
      if (b.s0 < a.s1 - TOL) throw new RoutingError(`${label}: ${a.label} and ${b.label} overlap by ${Math.round(a.s1 - b.s0)} mm`);
    }
    let cursor = 0;
    const fill = (s0: number, s1: number) => {
      const gap = s1 - s0;
      if (gap <= TOL) return;
      const p = makePipe(spec, nps, base(tags.next("P")), at(leg, s0), at(leg, s1), { leg: i, s0, s1 });
      comps.push(p);
      if (gap < spec.minPipeLength)
        warnings.push(`${label}: short pipe ${p.tag} = ${Math.round(gap)} mm (spec minimum ${spec.minPipeLength} mm)`);
    };
    for (const sl of ordered) {
      fill(cursor, sl.s0);
      if (sl.build) comps.push(...sl.build());
      cursor = sl.s1;
    }
    fill(cursor, L);
    if (i + 1 < legs.length) {
      const [variant, angle, tan] = bends.get(i + 1)!;
      comps.push(makeElbow(spec, nps, base(tags.next("E")), legs[i + 1].start, leg.dir, legs[i + 1].dir, angle, tan, variant));
    }
  });

  return { comps, warnings, legs };
}

/** Straight distance a fitting at a route corner needs on each side (for UI feedback). */
export function elbowTangent(nps: string, angleDeg: number): number {
  return selectElbow("", nps, angleDeg, [0, 0, 0])[2];
}

export const samePoint = (a: V3, b: V3) => isClose(a, b, TOL);
