// Pipe rack generator: frames of two columns with beams at every level, longitudinal struts at the column lines.

import type { StructureDoc } from "./doc";
import { Comp } from "./model";
import { Shape, boxMinMax } from "./shapes";
import { V3, add } from "./vec";

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

/** Box between two points given in rack coordinates (u along, v across, z up). */
function member(info: RackInfo, u0: number, u1: number, v0: number, v1: number, z0: number, z1: number): Shape {
  const p = (u: number, v: number, z: number): V3 =>
    add(info.start, [info.axis[0] * u + info.across[0] * v, info.axis[1] * u + info.across[1] * v, z]);
  const a = p(u0, v0, z0);
  const b = p(u1, v1, z1);
  return boxMinMax([Math.min(a[0], b[0]), Math.min(a[1], b[1]), a[2]], [Math.max(a[0], b[0]), Math.max(a[1], b[1]), b[2]]);
}

export function buildRack(s: StructureDoc): Comp {
  const info = rackInfo(s);
  const top = Math.max(...info.levels);
  const w = info.width / 2;
  const c = COLUMN / 2;
  const shapes: Shape[] = [];
  for (const u of info.frames) {
    for (const v of [-w, w]) shapes.push(member(info, u - c, u + c, v - c, v + c, 0, top));
    for (const lv of info.levels) shapes.push(member(info, u - c * 0.8, u + c * 0.8, -w + c, w - c, lv - BEAM, lv));
  }
  for (let i = 0; i + 1 < info.frames.length; i++) {
    for (const v of [-w, w]) {
      for (const lv of info.levels) shapes.push(member(info, info.frames[i] + c, info.frames[i + 1] - c, v - c * 0.7, v + c * 0.7, lv - BEAM - 150, lv - 150));
    }
  }
  return {
    uid: `${s.id}/STEEL`,
    tag: s.tag,
    kind: "STEEL",
    nps: "",
    ports: [],
    shapes,
    desc: s.description || `Pipe rack ${info.frames.length} frames, ${info.width} wide, levels ${info.levels.map((l) => `EL +${l}`).join(", ")}`,
    skey: "",
    props: { rack: info },
    owner: { type: "structure", id: s.id },
  };
}

/** Pipe centre-line elevation for a pipe of outside diameter od resting on shoes at a rack level. */
export const pipeElevationOn = (level: number, od: number) => level + SHOE_HEIGHT + od / 2;
