// Standard dimension tables, shared with the Python engine (plantforge/plantforge/data).

import pipeData from "../../../plantforge/data/pipe_b36_10.json";
import fitData from "../../../plantforge/data/fittings_b16_9.json";
import flangeData from "../../../plantforge/data/flanges_b16_5_cl150.json";
import valveData from "../../../plantforge/data/valves_b16_10_cl150.json";

export const INCH = 25.4;

export class CatalogError extends Error {}

/** "1-1/2" -> 1.5 */
export function npsValue(nps: string): number {
  const [whole, frac] = nps.includes("-") ? nps.split("-") : [nps, ""];
  const f = (s: string) => {
    if (!s) return 0;
    if (s.includes("/")) {
      const [a, b] = s.split("/").map(Number);
      return a / b;
    }
    return Number(s);
  };
  return f(whole) + f(frac);
}

/** Accepts 4, "4", '4"', 1.5, "1 1/2" and returns the catalog key ("4", "1-1/2"). */
export function normalizeNps(nps: string | number): string {
  let value: number;
  if (typeof nps === "number") value = nps;
  else {
    const s = String(nps).replace(/"|in/g, "").trim().replace(/\s+/, "-");
    value = npsValue(s);
  }
  if (!Number.isFinite(value) || value <= 0) throw new CatalogError(`not a valid NPS: ${nps}`);
  const eighths = Math.round(value * 8);
  const whole = Math.floor(eighths / 8);
  let rem = eighths % 8;
  if (rem === 0) return String(whole);
  let den = 8;
  while (rem % 2 === 0) {
    rem /= 2;
    den /= 2;
  }
  return whole === 0 ? `${rem}/${den}` : `${whole}-${rem}/${den}`;
}

export const fracToMm = (s: string): number => npsValue(s) * INCH;

export interface PipeData {
  nps: string;
  dn: number;
  od: number;
  wall: number;
  schedule: string;
  weightPerM: number;
}

export interface FlangeData {
  nps: string;
  rating: string;
  o: number;
  tf: number;
  y: number;
  rfHeight: number;
  rfDia: number;
  hubDia: number;
  bc: number;
  bolts: number;
  boltDia: string;
  /** Raised-face contact surface to weld end. */
  length: number;
  boltDiaMm: number;
}

type PipeRow = { dn: number; od: number; wall: Record<string, number> };
type FitRow = { elbow90_lr: number; elbow45_lr: number; tee: number };
type FlRow = { o: number; tf: number; y: number; rf_dia: number; hub_dia: number; bc: number; bolts: number; bolt_dia: string };

const PIPE = pipeData.sizes as Record<string, PipeRow>;
const FIT = fitData.sizes as Record<string, FitRow>;
const FLANGES: Record<string, { rf_height: number; sizes: Record<string, FlRow> }> = {
  [flangeData.rating]: flangeData as unknown as { rf_height: number; sizes: Record<string, FlRow> },
};
const VALVES: Record<string, Record<string, Record<string, number>>> = {
  [valveData.rating]: valveData.types as Record<string, Record<string, number>>,
};

function row<T>(table: Record<string, T>, nps: string, what: string): T {
  const key = normalizeNps(nps);
  const r = table[key];
  if (!r) throw new CatalogError(`${what}: no catalog data for NPS ${key}`);
  return r;
}

export const catalog = {
  sizes: Object.keys(PIPE).sort((a, b) => npsValue(a) - npsValue(b)),
  dn: (nps: string) => row(PIPE, nps, "pipe").dn,
  od: (nps: string) => row(PIPE, nps, "pipe").od,
  pipe(nps: string, schedule: string): PipeData {
    const r = row(PIPE, nps, "pipe");
    const wall = r.wall[schedule];
    if (wall === undefined) throw new CatalogError(`pipe NPS ${normalizeNps(nps)}: no schedule ${schedule}`);
    return { nps: normalizeNps(nps), dn: r.dn, od: r.od, wall, schedule, weightPerM: 0.0246615 * (r.od - wall) * wall };
  },
  elbow90: (nps: string) => row(FIT, nps, "90deg LR elbow").elbow90_lr,
  elbow45: (nps: string) => row(FIT, nps, "45deg LR elbow").elbow45_lr,
  tee: (nps: string) => row(FIT, nps, "equal tee").tee,
  flange(nps: string, rating: string): FlangeData {
    const t = FLANGES[rating];
    if (!t) throw new CatalogError(`no flange data for rating ${rating}`);
    const r = row(t.sizes, nps, `${rating} flange`);
    return {
      nps: normalizeNps(nps),
      rating,
      o: r.o,
      tf: r.tf,
      y: r.y,
      rfHeight: t.rf_height,
      rfDia: r.rf_dia,
      hubDia: r.hub_dia,
      bc: r.bc,
      bolts: r.bolts,
      boltDia: r.bolt_dia,
      length: r.y + t.rf_height,
      boltDiaMm: fracToMm(r.bolt_dia),
    };
  },
  valveLength(type: string, nps: string, rating: string): number {
    const t = VALVES[rating]?.[type];
    if (!t) throw new CatalogError(`no ${rating} data for valve type ${type}`);
    return row(t, nps, `${rating} ${type} valve`);
  },
  valveSizes(type: string, rating: string): string[] {
    return Object.keys(VALVES[rating]?.[type] ?? {});
  },
};

export type Catalog = typeof catalog;
