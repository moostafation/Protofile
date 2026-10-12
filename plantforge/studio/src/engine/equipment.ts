// Parametric equipment templates. Each builds shapes and nozzles in a local frame (X along the main axis),
// which is then rotated about Z by `rot` and moved to `origin`.

import { catalog } from "./catalog";
import type { EquipmentDoc, NozzleDoc, NozzlePlace, TemplateId } from "./doc";
import { Comp, port } from "./model";
import { boltRing, ladder, octFoundation, plinth, ringPlatform, spiralStair } from "./deco";
import { flangeBolts } from "./parts";
import { Basis, Shape, WORLD, boxMinMax, cyl, ell, finish, fru, transformShape } from "./shapes";
import { V3, add, addScaled, rotZ, scale } from "./vec";

export interface ParamSpec {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
}

export interface Template {
  id: TemplateId;
  name: string;
  prefix: string; // tag prefix
  description: string;
  ifc: string;
  params: Record<string, number>;
  paramSpecs: ParamSpec[];
  nozzles: NozzleDoc[];
  build(p: Record<string, number>): Shape[];
  /** Detail for the 3D view only: foundations, ladders, platforms, bolting. */
  deco?(p: Record<string, number>): Shape[];
  /** Local nozzle face position, outward direction and the radius of the surface it sits on. */
  nozzle(p: Record<string, number>, place: NozzlePlace, proj: number): { pos: V3; dir: V3; base: V3 };
}

const Z: V3 = [0, 0, 1];
const AX_X: Basis = [
  [0, 1, 0],
  [0, 0, 1],
  [1, 0, 0],
];
const rad = (d: number) => (d * Math.PI) / 180;
const nz = (name: string, nps: string, proj: number, service: string, place: NozzlePlace): NozzleDoc => ({ name, nps, proj, service, place });

function pumpLayout(p: Record<string, number>) {
  const cx = 450;
  const cw = p.casingW;
  const brgEnd = cx + cw / 2 + 520;
  const cplEnd = brgEnd + 260;
  const motEnd = cplEnd + p.motorL;
  return { cx, cw, brgEnd, cplEnd, motEnd };
}

function vesselShell(place: NozzlePlace, proj: number, R: number, topZ: number) {
  if (place.kind === "shell") {
    const d: V3 = [Math.sin(rad(place.orient)), Math.cos(rad(place.orient)), 0];
    return { pos: add(scale(d, R + proj), [0, 0, place.elev]), dir: d, base: add(scale(d, R * 0.9), [0, 0, place.elev]) };
  }
  if (place.kind === "top") {
    const r = Math.min(Math.hypot(place.dx, place.dy), R * 0.85);
    const zHead = topZ + (R / 2) * Math.sqrt(Math.max(0, 1 - (r / R) ** 2));
    return { pos: [place.dx, place.dy, zHead + proj] as V3, dir: Z, base: [place.dx, place.dy, zHead - 50] as V3 };
  }
  throw new Error(`nozzle placement ${place.kind} is not available on this equipment`);
}

function horizontalShell(p: Record<string, number>, place: NozzlePlace, proj: number, front: number, radiusAt: (x: number) => number, ends: [number, number]) {
  if (place.kind === "hshell") {
    const x = front + place.station;
    const R = radiusAt(x);
    const d: V3 = [0, Math.sin(rad(place.angle)), Math.cos(rad(place.angle))];
    const c: V3 = [x, 0, p.cl];
    return { pos: addScaled(c, d, R + proj), dir: d, base: addScaled(c, d, R * 0.9) };
  }
  if (place.kind === "end") {
    const s = place.side === "left" ? -1 : 1;
    const xEnd = place.side === "left" ? ends[0] : ends[1];
    return { pos: [xEnd + s * proj, place.dy, p.cl + place.dz] as V3, dir: [s, 0, 0] as V3, base: [xEnd - s * 100, place.dy, p.cl + place.dz] as V3 };
  }
  throw new Error(`nozzle placement ${place.kind} is not available on this equipment`);
}

export const TEMPLATES: Record<TemplateId, Template> = {
  pump: {
    id: "pump",
    name: "Centrifugal pump",
    prefix: "P",
    description: "Centrifugal pump, end suction, top discharge",
    ifc: "IfcPump",
    params: { length: 2750, width: 800, baseH: 300, shaftZ: 850, casingD: 900, casingW: 460, motorD: 560, motorL: 1150 },
    paramSpecs: [
      { key: "shaftZ", label: "Shaft centre height", min: 500, max: 2000, step: 50 },
      { key: "casingD", label: "Casing diameter", min: 300, max: 2000, step: 50 },
      { key: "motorL", label: "Motor length", min: 400, max: 3000, step: 50 },
      { key: "length", label: "Baseplate length", min: 1000, max: 6000, step: 50 },
    ],
    nozzles: [nz("N1", "6", 250, "Suction", { kind: "fixed", key: "suction" }), nz("N2", "4", 200, "Discharge", { kind: "fixed", key: "discharge" })],
    build(p) {
      const { cx, cw, brgEnd, cplEnd, motEnd } = pumpLayout(p);
      const z = p.shaftZ;
      const R = p.casingD / 2;
      return [
        ...finish("base", boxMinMax([0, -p.width / 2, 0], [p.length, p.width / 2, p.baseH])),
        ...finish(
          "casing",
          boxMinMax([cx - 220, -260, p.baseH], [cx + 220, 260, z - R + 60]),
          cyl([cx - cw / 2, 0, z], [cx + cw / 2, 0, z], R),
          ell([cx, 0, z], AX_X, [R * 0.92, R * 0.92, cw * 0.62]),
          cyl([cx + cw / 2, 0, z], [brgEnd, 0, z], 170),
          boxMinMax([cx + cw / 2 + 60, -180, p.baseH], [brgEnd - 40, 180, z - 120]),
        ),
        ...finish("guard", boxMinMax([brgEnd, -170, z - 170], [cplEnd, 170, z + 170])),
        ...finish(
          "motor",
          cyl([cplEnd, 0, z], [motEnd, 0, z], p.motorD / 2),
          ell([motEnd, 0, z], AX_X, [p.motorD * 0.47, p.motorD * 0.47, 160]),
          boxMinMax([cplEnd + 80, -p.motorD * 0.42, p.baseH], [motEnd - 80, p.motorD * 0.42, z - p.motorD * 0.3]),
          boxMinMax([cplEnd + p.motorL * 0.35, -140, z + p.motorD / 2 - 20], [cplEnd + p.motorL * 0.6, 140, z + p.motorD / 2 + 170]),
        ),
      ];
    },
    deco(p) {
      const { cx, cw, cplEnd, motEnd } = pumpLayout(p);
      const z = p.shaftZ;
      const out: Shape[] = [plinth([-150, -p.width / 2 - 150, 0], [p.length + 150, p.width / 2 + 150, 0], 0, 300)];
      // motor cooling fins and fan cowl
      for (let x = cplEnd + 140; x < motEnd - 120; x += 95) out.push({ ...cyl([x, 0, z], [x + 22, 0, z], p.motorD / 2 + 22), m: "motor" });
      out.push({ ...cyl([motEnd - 40, 0, z], [motEnd + 140, 0, z], p.motorD / 2 + 8), m: "motor" });
      // volute tongue and casing bolting
      out.push(...boltRing([cx + cw / 2, 0, z], [1, 0, 0], p.casingD * 0.92, 12, 20, -30, 30, 30));
      // drain and vent bosses
      out.push({ ...cyl([cx, 0, z - p.casingD / 2], [cx, 0, z - p.casingD / 2 - 60], 30), m: "casing" });
      return out;
    },
    nozzle(p, place, proj) {
      const { cx, cw } = pumpLayout(p);
      if (place.kind !== "fixed") throw new Error("pump nozzles are fixed: suction and discharge");
      if (place.key === "suction") return { pos: [cx - cw / 2 - proj, 0, p.shaftZ], dir: [-1, 0, 0], base: [cx - cw / 2 + 40, 0, p.shaftZ] };
      return { pos: [cx, 0, p.shaftZ + p.casingD / 2 + proj], dir: Z, base: [cx, 0, p.shaftZ + p.casingD * 0.35] };
    },
  },
  vvessel: {
    id: "vvessel",
    name: "Vertical vessel",
    prefix: "V",
    description: "Vertical vessel, 2:1 ellipsoidal heads, skirt",
    ifc: "IfcTank",
    params: { D: 2000, H: 6000, skirt: 1500 },
    paramSpecs: [
      { key: "D", label: "Inside diameter", min: 500, max: 8000, step: 100 },
      { key: "H", label: "Height T/T", min: 1000, max: 60000, step: 100 },
      { key: "skirt", label: "Skirt height", min: 300, max: 8000, step: 100 },
    ],
    nozzles: [
      nz("N1", "4", 250, "Inlet", { kind: "shell", elev: 5500, orient: 270 }),
      nz("N2", "6", 250, "Outlet", { kind: "shell", elev: 2000, orient: 180 }),
      nz("N3", "3", 200, "Vapour outlet", { kind: "top", dx: 0, dy: 0 }),
    ],
    build(p) {
      const R = p.D / 2;
      const tl = p.skirt;
      const tt = p.skirt + p.H;
      return [
        ...finish("steel", cyl([0, 0, 0], [0, 0, 30], R + 160)),
        ...finish("skirt", cyl([0, 0, 0], [0, 0, tl], R)),
        ...finish("shell", cyl([0, 0, tl], [0, 0, tt], R), ell([0, 0, tt], WORLD, [R, R, R / 2]), cyl([0, 0, tl - 20], [0, 0, tl + 20], R + 25), cyl([0, 0, tt - 20], [0, 0, tt + 20], R + 25)),
      ];
    },
    deco(p) {
      const R = p.D / 2;
      const tt = p.skirt + p.H;
      const out: Shape[] = [octFoundation([0, 0, 0], R + 700, 0, 450)];
      // skirt access opening frame and anchor chairs
      for (let a = 0; a < 360; a += 45) {
        const d: V3 = [Math.sin(rad(a + 22.5)), Math.cos(rad(a + 22.5)), 0];
        out.push({ ...cyl(addScaled([0, 0, 30], d, R + 90), addScaled([0, 0, 260], d, R + 90), 45), m: "steel" });
      }
      // ladder on the east side to platforms every 6 m and at the top, clear of the process nozzles (N, S, W)
      const ladDir: V3 = [Math.sin(rad(100)), Math.cos(rad(100)), 0];
      out.push(...ladder(addScaled([0, 0, 0], ladDir, R + 260), tt - 250, ladDir));
      for (let lv = p.skirt + 4500; lv < tt - 3000; lv += 6000) out.push(...ringPlatform([0, 0, 0], lv, R + 60, 900, 45, 160));
      out.push(...ringPlatform([0, 0, 0], tt - 250, R + 60, 900, 45, 160));
      // davit on the top head
      out.push({ ...cyl([0, R * 0.55, tt + R * 0.35], [0, R * 0.55, tt + R * 0.35 + 1600], 40), m: "rail" });
      out.push({ ...cyl([0, R * 0.55, tt + R * 0.35 + 1600], [0, R * 0.55 - 900, tt + R * 0.35 + 1600], 35), m: "rail" });
      return out;
    },
    nozzle(p, place, proj) {
      return vesselShell(place, proj, p.D / 2, p.skirt + p.H);
    },
  },
  hdrum: {
    id: "hdrum",
    name: "Horizontal drum",
    prefix: "D",
    description: "Horizontal drum on saddles, 2:1 heads",
    ifc: "IfcTank",
    params: { D: 1800, L: 5000, cl: 2200 },
    paramSpecs: [
      { key: "D", label: "Inside diameter", min: 500, max: 5000, step: 100 },
      { key: "L", label: "Length T/T", min: 1000, max: 30000, step: 100 },
      { key: "cl", label: "Centre line elevation", min: 800, max: 15000, step: 50 },
    ],
    nozzles: [
      nz("N1", "4", 250, "Inlet", { kind: "hshell", station: 800, angle: 0 }),
      nz("N2", "6", 250, "Outlet", { kind: "hshell", station: 4200, angle: 180 }),
    ],
    build(p) {
      const R = p.D / 2;
      const h = p.L / 2;
      const out: Shape[] = finish("shell", cyl([-h, 0, p.cl], [h, 0, p.cl], R), ell([-h, 0, p.cl], WORLD, [R / 2, R, R]), ell([h, 0, p.cl], WORLD, [R / 2, R, R]));
      for (const x of [-0.3 * p.L, 0.3 * p.L]) {
        out.push(...finish("saddle", boxMinMax([x - 130, -R * 0.8, 0], [x + 130, R * 0.8, p.cl - R * 0.75]), boxMinMax([x - 12, -R * 0.75, p.cl - R * 0.75], [x + 12, R * 0.75, p.cl - R * 0.45])));
      }
      return out;
    },
    deco(p) {
      const R = p.D / 2;
      return [-0.3 * p.L, 0.3 * p.L].map((x) => plinth([x - 400, -R * 0.8 - 250, 0], [x + 400, R * 0.8 + 250, 0], 0, 400));
    },
    nozzle(p, place, proj) {
      const R = p.D / 2;
      return horizontalShell(p, place, proj, -p.L / 2, () => R, [-p.L / 2 - R / 2, p.L / 2 + R / 2]);
    },
  },
  exchanger: {
    id: "exchanger",
    name: "Shell & tube exchanger",
    prefix: "E",
    description: "Shell and tube heat exchanger, BEM type",
    ifc: "IfcHeatExchanger",
    params: { shellD: 700, shellL: 4500, chanD: 760, chanL: 700, cl: 1500 },
    paramSpecs: [
      { key: "shellD", label: "Shell diameter", min: 200, max: 3000, step: 50 },
      { key: "shellL", label: "Shell length", min: 1000, max: 12000, step: 100 },
      { key: "cl", label: "Centre line elevation", min: 600, max: 10000, step: 50 },
    ],
    nozzles: [
      nz("N1", "4", 200, "Tube inlet", { kind: "hshell", station: 350, angle: 0 }),
      nz("N2", "4", 200, "Tube outlet", { kind: "hshell", station: 350, angle: 180 }),
      nz("N3", "6", 200, "Shell inlet", { kind: "hshell", station: 4500, angle: 0 }),
      nz("N4", "6", 200, "Shell outlet", { kind: "hshell", station: 1900, angle: 180 }),
    ],
    build(p) {
      const rs = p.shellD / 2;
      const rc = p.chanD / 2;
      const out: Shape[] = [
        ...finish("channel", cyl([-p.chanL - 70, 0, p.cl], [-p.chanL, 0, p.cl], rc + 90), cyl([-p.chanL, 0, p.cl], [0, 0, p.cl], rc), cyl([-70, 0, p.cl], [70, 0, p.cl], rc + 90)),
        ...finish("shell", cyl([0, 0, p.cl], [p.shellL, 0, p.cl], rs), ell([p.shellL, 0, p.cl], WORLD, [rs / 2, rs, rs])),
      ];
      for (const x of [0.15 * p.shellL, 0.85 * p.shellL]) out.push(...finish("saddle", boxMinMax([x - 110, -rs * 0.85, 0], [x + 110, rs * 0.85, p.cl - rs * 0.6])));
      return out;
    },
    deco(p) {
      const rs = p.shellD / 2;
      const rc = p.chanD / 2;
      const out: Shape[] = [];
      for (const x of [0.15 * p.shellL, 0.85 * p.shellL]) out.push(plinth([x - 350, -rs * 0.85 - 200, 0], [x + 350, rs * 0.85 + 200, 0], 0, 400));
      // girth flange and channel cover bolting
      out.push(...boltRing([-70, 0, p.cl], [1, 0, 0], (rc + 45) * 2, 28, 22, -40, 180, -10));
      out.push(...boltRing([-p.chanL, 0, p.cl], [-1, 0, 0], (rc + 45) * 2, 28, 22, -40, 110, -10));
      // lifting lugs
      for (const x of [0.3 * p.shellL, 0.7 * p.shellL]) out.push({ ...boxMinMax([x - 60, -15, p.cl + rs - 20], [x + 60, 15, p.cl + rs + 110]), m: "shell" });
      return out;
    },
    nozzle(p, place, proj) {
      return horizontalShell(p, place, proj, -p.chanL, (x) => (x < 0 ? p.chanD / 2 : p.shellD / 2), [-p.chanL - 70, p.shellL + p.shellD / 4]);
    },
  },
  tank: {
    id: "tank",
    name: "Storage tank",
    prefix: "T",
    description: "Atmospheric storage tank, cone roof (API 650)",
    ifc: "IfcTank",
    params: { D: 8000, H: 9000 },
    paramSpecs: [
      { key: "D", label: "Diameter", min: 2000, max: 80000, step: 500 },
      { key: "H", label: "Shell height", min: 2000, max: 25000, step: 100 },
    ],
    nozzles: [nz("N1", "6", 300, "Outlet", { kind: "shell", elev: 600, orient: 270 }), nz("N2", "4", 300, "Inlet", { kind: "shell", elev: 7800, orient: 300 })],
    build(p) {
      const R = p.D / 2;
      return [...finish("steel", cyl([0, 0, 0], [0, 0, 12], R + 60)), ...finish("tankshell", cyl([0, 0, 0], [0, 0, p.H], R)), ...finish("roof", fru([0, 0, p.H], [0, 0, p.H + R / 6], R + 40, 350))];
    },
    deco(p) {
      const R = p.D / 2;
      const out: Shape[] = [{ ...cyl([0, 0, -500], [0, 0, 0], R + 450), m: "concrete" }];
      // shell courses (plate seams) and top angle
      for (let z = 2400; z < p.H; z += 2400) out.push({ t: "tor", c: [0, 0, z], s: [R + 4, 0, z], n: [0, 0, 1], ang: Math.PI * 2, r: 9, m: "seam" });
      out.push({ t: "tor", c: [0, 0, p.H], s: [R + 30, 0, p.H], n: [0, 0, 1], ang: Math.PI * 2, r: 40, m: "steel" });
      // roof handrail, spiral stair and roof manway
      const roofZ = (r: number) => p.H + (R / 6) * (1 - (r - 350) / (R + 40 - 350));
      for (const h of [550, 1100]) out.push({ t: "tor", c: [0, 0, roofZ(R - 200) + h], s: [R - 200, 0, roofZ(R - 200) + h], n: [0, 0, 1], ang: Math.PI * 1.5, r: h > 600 ? 24 : 16, m: "rail" });
      for (let a = 0; a < 270; a += 18) {
        const d: V3 = [Math.cos(rad(a)), Math.sin(rad(a)), 0];
        out.push({ ...cyl(addScaled([0, 0, roofZ(R - 200)], d, R - 200), addScaled([0, 0, roofZ(R - 200) + 1100], d, R - 200), 22), m: "rail" });
      }
      out.push(...spiralStair([0, 0, 0], R, p.H, 95, 125));
      out.push({ ...cyl([R * 0.45, R * 0.2, roofZ(R * 0.5) - 50], [R * 0.45, R * 0.2, roofZ(R * 0.5) + 250], 330), m: "roof" });
      return out;
    },
    nozzle(p, place, proj) {
      return vesselShell(place, proj, p.D / 2, p.H);
    },
  },
};

export const TEMPLATE_LIST = Object.values(TEMPLATES);

export interface BuiltEquipment {
  body: Comp;
  nozzles: Comp[];
}

/** World position and direction of a nozzle face. */
export function nozzleFrame(eq: EquipmentDoc, n: NozzleDoc): { pos: V3; dir: V3; base: V3 } {
  const t = TEMPLATES[eq.template];
  const p = { ...t.params, ...eq.params };
  const l = t.nozzle(p, n.place, n.proj);
  return { pos: add(rotZ(l.pos, eq.rot), eq.origin), dir: rotZ(l.dir, eq.rot), base: add(rotZ(l.base, eq.rot), eq.origin) };
}

export function buildEquipment(eq: EquipmentDoc): BuiltEquipment {
  const t = TEMPLATES[eq.template];
  const p = { ...t.params, ...eq.params };
  const owner = { type: "equipment" as const, id: eq.id };
  const body: Comp = {
    uid: `${eq.id}/BODY`,
    tag: eq.tag,
    kind: "EQUIPMENT",
    nps: "",
    ports: [],
    shapes: t.build(p).map((s) => transformShape(s, eq.rot, eq.origin)),
    deco: (t.deco?.(p) ?? []).map((s) => transformShape(s, eq.rot, eq.origin)),
    desc: eq.description || t.description,
    skey: "",
    props: { template: eq.template, ifc: t.ifc },
    owner,
  };
  const nozzles = eq.nozzles.map((n): Comp => {
    const { pos, dir, base } = nozzleFrame(eq, n);
    const fl = catalog.flange(n.nps, "CL150");
    const od = catalog.od(n.nps);
    const neckEnd = addScaled(pos, dir, -(fl.tf + fl.rfHeight));
    return {
      uid: `${eq.id}/${n.name}`,
      tag: `${eq.tag}/${n.name}`,
      kind: "NOZZLE",
      nps: n.nps,
      ports: [port("FACE", pos, dir, "FL", n.nps)],
      shapes: [{ ...cyl(base, neckEnd, od / 2), m: "nozzle" }, { ...cyl(neckEnd, pos, fl.o / 2), m: "nozzle" }],
      deco: flangeBolts(fl, neckEnd, dir),
      desc: `NOZZLE ${n.name} ${n.service ? n.service.toUpperCase() + " " : ""}NPS ${n.nps} CL150 RF`,
      skey: "",
      props: { service: n.service, proj: n.proj, equipment: eq.id, name: n.name },
      owner,
    };
  });
  return { body, nozzles };
}

/** Footprint box of an equipment template (for placement previews). */
export function templateShapes(id: TemplateId, origin: V3, rot: number): Shape[] {
  const t = TEMPLATES[id];
  return t.build(t.params).map((s) => transformShape(s, rot, origin));
}

