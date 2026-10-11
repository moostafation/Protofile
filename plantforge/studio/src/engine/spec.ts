// Piping specifications (pipe classes), read from the same TOML files as the Python engine.

import { parse } from "smol-toml";
import a1a from "../../../plantforge/specs/A1A.toml?raw";
import { CatalogError, FlangeData, PipeData, catalog, normalizeNps, npsValue } from "./catalog";

export class SpecError extends Error {}

export interface PartRule {
  description: string;
  skey: string;
}

export interface PipeRule {
  lo: number;
  hi: number;
  schedule: string;
  description: string;
}

export interface PipingSpec {
  name: string;
  description: string;
  rating: string;
  material: string;
  minPipeLength: number;
  gasketThickness: number;
  pipeRules: PipeRule[];
  parts: Record<string, PartRule>;
  valves: Record<string, PartRule>;
}

type Raw = Record<string, any>;

export function specFromToml(text: string): PipingSpec {
  const d = parse(text) as Raw;
  try {
    const parts: Record<string, PartRule> = {};
    for (const k of ["elbow90", "elbow45", "tee", "flange", "gasket", "bolting"]) {
      if (d[k]) parts[k] = { description: d[k].description, skey: d[k].skey ?? "" };
    }
    const valves: Record<string, PartRule> = {};
    for (const [k, v] of Object.entries((d.valve ?? {}) as Raw)) valves[k] = { description: v.description, skey: v.skey ?? "" };
    return {
      name: d.name,
      description: d.description ?? "",
      rating: d.rating,
      material: d.material ?? "",
      minPipeLength: Number(d.min_pipe_length ?? 50),
      gasketThickness: Number(d.gasket_thickness ?? 3),
      pipeRules: (d.pipe as Raw[]).map((r) => ({
        lo: npsValue(normalizeNps(r.from)),
        hi: npsValue(normalizeNps(r.to)),
        schedule: String(r.schedule),
        description: r.description,
      })),
      parts,
      valves,
    };
  } catch (e) {
    throw new SpecError(`invalid spec: ${(e as Error).message}`);
  }
}

export const standardSpecs = (): Record<string, PipingSpec> => ({ A1A: specFromToml(a1a) });

/** Specs in use. Replaced as a whole when a plant database with its own specs is opened. */
export const SPECS: Record<string, PipingSpec> = standardSpecs();

export function setSpecs(specs: Record<string, PipingSpec>) {
  for (const k of Object.keys(SPECS)) delete SPECS[k];
  Object.assign(SPECS, specs);
}

export function getSpec(name: string): PipingSpec {
  const s = SPECS[name];
  if (!s) throw new SpecError(`unknown spec ${name}`);
  return s;
}

function rule(spec: PipingSpec, nps: string): PipeRule {
  const v = npsValue(normalizeNps(nps));
  const r = spec.pipeRules.find((x) => x.lo <= v && v <= x.hi);
  if (!r) throw new SpecError(`spec ${spec.name}: NPS ${normalizeNps(nps)} is not allowed`);
  return r;
}

export const specApi = {
  schedule: (spec: PipingSpec, nps: string) => rule(spec, nps).schedule,
  pipe(spec: PipingSpec, nps: string): { data: PipeData; description: string } {
    const r = rule(spec, nps);
    return { data: catalog.pipe(nps, r.schedule), description: `${r.description}, SCH ${r.schedule}` };
  },
  part(spec: PipingSpec, key: string): PartRule {
    const p = spec.parts[key];
    if (!p) throw new SpecError(`spec ${spec.name}: no ${key} defined`);
    return p;
  },
  bw(spec: PipingSpec, key: string, nps: string): string {
    return `${specApi.part(spec, key).description}, SCH ${rule(spec, nps).schedule}`;
  },
  flange(spec: PipingSpec, nps: string): FlangeData {
    return catalog.flange(nps, spec.rating);
  },
  valve(spec: PipingSpec, type: string, nps: string): { length: number; rule: PartRule } {
    const r = spec.valves[type];
    if (!r) throw new SpecError(`spec ${spec.name}: valve type ${type} not allowed (allowed: ${Object.keys(spec.valves).join(", ")})`);
    try {
      return { length: catalog.valveLength(type, nps, spec.rating), rule: r };
    } catch (e) {
      if (e instanceof CatalogError) throw new SpecError(e.message);
      throw e;
    }
  },
  sizes(spec: PipingSpec): string[] {
    return catalog.sizes.filter((s) => spec.pipeRules.some((r) => r.lo <= npsValue(s) && npsValue(s) <= r.hi));
  },
};
