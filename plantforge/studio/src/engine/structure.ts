// Pipe rack generator: frames of two columns with beams at every level, longitudinal struts at the column lines.

import type { StructureDoc } from "./doc";
import { Comp } from "./model";
import { plinth } from "./deco";
import { Basis, Shape, cyl, obox } from "./shapes";
import { V3, add, cross, dist, lerp, norm, sub } from "./vec";

export const COLUMN = 300; // HEA 300-ish, as a box
export const BEAM = 300; // beam depth
export const SHOE_HEIGHT = 100;

export interface RackInfo {
  id: string;
  axis: V3; // along the rack
  across: V3;
  start: V3;
  length: number;
  width: number;
  levels: number[];
  frames: number[]; // stations along the axis
}

export function rackInfo(s: StructureDoc): RackInfo {
  const axis: V3 = s.axis === "x" ? [1, 0, 0] : [0, 1, 0];
  const across: V3 = s.axis === "x" ? [0, 1, 0] : [1, 0, 0];
  const frames: number[] = [];
  const n = Math.max(1, Math.round(s.length / s.bay));
  for (let i = 0; i <= n; i++) frames.push((s.length * i) / n);
  return { id: s.id, axis, across, start: s.origin, length: s.length, width: s.width, levels: [...s.levels].sort((a, b) => a - b), frames };
}

/** A point given in rack coordinates (u along, v across, z up). */
const at = (info: RackInfo, u: number, v: number, z: number): V3 => add(info.start, [info.axis[0] * u + info.across[0] * v, info.axis[1] * u + info.across[1] * v, z]);

/**
 * An I-section member between two centre-line points: `web` is the direction of the section depth.
 * For clash it is the enclosing box; the viewer draws the I profile.
 */
function iMember(a: V3, b: V3, web: V3, depth: number, flange: number): Shape {
  const along = norm(sub(b, a));
  const ax: Basis = [norm(cross(web, along)), web, along];
  return { ...obox(lerp(a, b, 0.5), ax, [flange, depth, dist(a, b)]), m: "ibeam" };
}

export function buildRack(s: StructureDoc): Comp {
  const info = rackInfo(s);
  const top = Math.max(...info.levels);
  const w = info.width / 2;
  const c = COLUMN / 2;
  const shapes: Shape[] = [];
  const deco: Shape[] = [];
  const Z: V3 = [0, 0, 1];
  for (const u of info.frames) {
    // columns: web in the frame plane; transverse beams at every level
    for (const v of [-w, w]) shapes.push(iMember(at(info, u, v, 0), at(info, u, v, top), info.across, COLUMN, COLUMN));
    for (const lv of info.levels) shapes.push(iMember(at(info, u, -w + c, lv - BEAM / 2), at(info, u, w - c, lv - BEAM / 2), Z, BEAM, BEAM * 0.8));
    for (const v of [-w, w]) {
      deco.push({ ...obox(at(info, u, v, 215), [info.axis, info.across, Z], [480, 480, 30]), m: "steel" });
      const g = at(info, u, v, 0);
      deco.push(plinth([g[0] - 400, g[1] - 400, 0], [g[0] + 400, g[1] + 400, 0], 200, 700));
    }
    // knee braces under the lowest beam
    const low = info.levels[0] - BEAM;
    for (const s of [-1, 1]) deco.push({ ...cyl(at(info, u, s * (w - c), low - 900), at(info, u, s * (w - c - 900), low), 45), m: "steel" });
  }
  for (let i = 0; i + 1 < info.frames.length; i++) {
    const u0 = info.frames[i] + c;
    const u1 = info.frames[i + 1] - c;
    for (const v of [-w, w]) {
      for (const lv of info.levels) shapes.push(iMember(at(info, u0, v, lv - BEAM / 2 - 150), at(info, u1, v, lv - BEAM / 2 - 150), Z, BEAM * 0.7, BEAM * 0.7 * 0.6));
    }
  }
  // vertical bracing in the end bays and every fourth bay
  for (let i = 0; i + 1 < info.frames.length; i++) {
    if (!(i === 0 || i === info.frames.length - 2 || i % 4 === 2)) continue;
    const u0 = info.frames[i];
    const u1 = info.frames[i + 1];
    for (const v of [-w, w]) {
      const lo = 250;
      const hi = info.levels[0] - BEAM - 150;
      deco.push({ ...cyl(at(info, u0 + c, v, lo), at(info, u1 - c, v, hi), 55), m: "steel" });
      deco.push({ ...cyl(at(info, u1 - c, v, lo), at(info, u0 + c, v, hi), 55), m: "steel" });
    }
  }
  return {
    uid: `${s.id}/STEEL`,
    tag: s.tag,
    kind: "STEEL",
    nps: "",
    ports: [],
    shapes,
    deco,
    desc: s.description || `Pipe rack ${info.frames.length} frames, ${info.width} wide, levels ${info.levels.map((l) => `EL +${l}`).join(", ")}`,
    skey: "",
    props: { rack: info },
    owner: { type: "structure", id: s.id },
  };
}

/** Pipe centre-line elevation for a pipe of outside diameter od resting on shoes at a rack level. */
export const pipeElevationOn = (level: number, od: number) => level + SHOE_HEIGHT + od / 2;
