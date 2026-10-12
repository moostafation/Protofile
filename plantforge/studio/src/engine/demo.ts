// Demo unit: feed drum, two pumps in parallel, exchanger, tank and a two-level pipe rack.
// Equipment and steel are placed by hand; every line is routed by the auto-router.

import { autoRoute } from "./autoroute";
import { catalog } from "./catalog";
import { addEquipment, addInline, addLine, addRack, autoConnect, updateEquipment } from "./commands";
import { computeModel, resolveEnd } from "./compute";
import { EndRef, PlantDoc, emptyDoc } from "./doc";
import { TEMPLATES } from "./equipment";
import { toDocStation } from "./routing";
import { getSpec } from "./spec";
import { pipeElevationOn } from "./structure";
import { V3, isClose, neg } from "./vec";

const nozzle = (eq: string, n: string): EndRef => ({ kind: "nozzle", eq, nozzle: n });

interface FreeOpts {
  point: V3;
  dir: V3;
  ref: EndRef;
  pointIsStart: boolean;
  nps: string;
  number: string;
  fluid: string;
  color: number;
}

/** Route a line between a free (battery-limit) point and a nozzle. */
function connectFree(doc: PlantDoc, o: FreeOpts): PlantDoc {
  const model = computeModel(doc, { clash: false });
  const r = resolveEnd(o.ref, model)!;
  const exclude = new Set(model.comps.filter((c) => c.ports.some((p) => isClose(p.pos, r.pos, 0.5))).map((c) => c.uid));
  const free = { pos: o.point, dir: o.dir, kind: "flanged" as const };
  const fixed = o.pointIsStart ? { pos: r.pos, dir: neg(r.dir), kind: r.kind } : { pos: r.pos, dir: r.dir, kind: r.kind };
  const res = autoRoute({ model, spec: getSpec("A1A"), nps: o.nps, start: o.pointIsStart ? free : fixed, end: o.pointIsStart ? fixed : free, exclude });
  if (!res) throw new Error(`demo: cannot route ${o.number}`);
  const [d] = addLine(doc, {
    nps: o.nps,
    number: o.number,
    fluid: o.fluid,
    color: o.color,
    start: o.pointIsStart ? { kind: "flanged" } : o.ref,
    end: o.pointIsStart ? o.ref : { kind: "flanged" },
    points: o.pointIsStart ? res.path.slice(0, -1) : res.path.slice(1),
  });
  return d;
}

function connect(doc: PlantDoc, from: EndRef, to: EndRef, number: string, fluid: string, color: number): [PlantDoc, string] {
  const r = autoConnect(doc, { from, to, number, fluid });
  if (r.error || !r.lineId) throw new Error(`demo: ${number}: ${r.error}`);
  return [{ ...r.doc, lines: r.doc.lines.map((l) => (l.id === r.lineId ? { ...l, color } : l)) }, r.lineId];
}

/** Inline item on the first leg of a line, `station` mm from its start. */
function onFirstLeg(doc: PlantDoc, lineId: string, type: "gate" | "check" | "globe" | "tee", station: number, branch?: V3): [PlantDoc, string] {
  const res = computeModel(doc, { clash: false }).lines.get(lineId)!;
  const { leg, station: st } = toDocStation(res.legs, 0, station);
  return addInline(doc, lineId, { type, leg, station: st, branch });
}

/** Inline item on the last leg of a line, `fromEnd` mm from its end. */
function onLastLeg(doc: PlantDoc, lineId: string, type: "gate" | "check" | "globe", fromEnd: number): PlantDoc {
  const res = computeModel(doc, { clash: false }).lines.get(lineId)!;
  const k = res.legs.length - 1;
  const { leg, station } = toDocStation(res.legs, k, res.legs[k].length - fromEnd);
  return addInline(doc, lineId, { type, leg, station })[0];
}

export function demoDoc(): PlantDoc {
  let d: PlantDoc = { ...emptyDoc(), project: { name: "Feed & Stripper Unit", plant: "PlantForge Demo Refinery", area: "A-100", unit: "U-110 Feed / Stripper" } };
  let drum: string, pa: string, pb: string, ex: string, tk: string, col: string, rd: string, ra: string, rb: string;
  let header: string, tee: string, l: string, reflux: string;
  [d] = addRack(d, [0, 0, 0], "x", 36000, 6000, [5000, 7000]);

  // ---- feed section (north of the rack)
  [d, drum] = addEquipment(d, "vvessel", [6000, 10500, 0], 0, "V-101");
  d = updateEquipment(d, drum, {
    description: "Feed surge drum",
    params: { ...TEMPLATES.vvessel.params, D: 2400, H: 7000, skirt: 2000 },
    nozzles: [
      { name: "N1", nps: "4", proj: 250, service: "Inlet", place: { kind: "shell", elev: 7800, orient: 180 } },
      { name: "N2", nps: "6", proj: 250, service: "Outlet to P-101A", place: { kind: "shell", elev: 2600, orient: 180 } },
      { name: "N3", nps: "3", proj: 250, service: "Vapour outlet", place: { kind: "top", dx: 0, dy: 0 } },
      { name: "N4", nps: "6", proj: 250, service: "Outlet to P-101B", place: { kind: "shell", elev: 2600, orient: 270 } },
    ],
  });
  [d, pa] = addEquipment(d, "pump", [5000, 6300, 0], -90, "P-101A");
  [d, pb] = addEquipment(d, "pump", [2500, 6300, 0], -90, "P-101B");
  d = updateEquipment(d, pa, { description: "Feed pump (duty)" });
  d = updateEquipment(d, pb, { description: "Feed pump (standby)" });

  // ---- stripper section (south of the rack) and reflux (north)
  [d, ex] = addEquipment(d, "exchanger", [15000, -7000, 0], 0, "E-101");
  d = updateEquipment(d, ex, { description: "Feed / bottoms exchanger" });
  [d, col] = addEquipment(d, "vvessel", [26000, -8500, 0], 0, "C-201");
  d = updateEquipment(d, col, {
    description: "Stripper column",
    params: { ...TEMPLATES.vvessel.params, D: 1800, H: 18000, skirt: 3000 },
    nozzles: [
      { name: "N1", nps: "4", proj: 300, service: "Feed", place: { kind: "shell", elev: 12500, orient: 0 } },
      { name: "N2", nps: "6", proj: 300, service: "Bottoms", place: { kind: "shell", elev: 3500, orient: 270 } },
      { name: "N3", nps: "6", proj: 300, service: "Overhead vapour", place: { kind: "top", dx: 0, dy: 0 } },
      { name: "N4", nps: "4", proj: 300, service: "Reflux", place: { kind: "shell", elev: 19500, orient: 0 } },
    ],
  });
  [d, rd] = addEquipment(d, "hdrum", [30500, 10200, 0], 0, "D-201");
  d = updateEquipment(d, rd, {
    description: "Reflux drum",
    params: { ...TEMPLATES.hdrum.params, D: 1600, L: 5000, cl: 2400 },
    nozzles: [
      { name: "N1", nps: "6", proj: 250, service: "Inlet", place: { kind: "hshell", station: 2500, angle: 0 } },
      { name: "N2", nps: "6", proj: 250, service: "Outlet to P-201A", place: { kind: "hshell", station: 1700, angle: 180 } },
      { name: "N3", nps: "6", proj: 250, service: "Outlet to P-201B", place: { kind: "hshell", station: 3300, angle: 180 } },
    ],
  });
  [d, ra] = addEquipment(d, "pump", [29700, 6300, 0], -90, "P-201A");
  [d, rb] = addEquipment(d, "pump", [31300, 6300, 0], -90, "P-201B");
  d = updateEquipment(d, ra, { description: "Reflux pump (duty)" });
  d = updateEquipment(d, rb, { description: "Reflux pump (standby)" });
  [d, tk] = addEquipment(d, "tank", [42000, -12500, 0], 0, "T-101");
  d = updateEquipment(d, tk, {
    description: "Product storage tank",
    nozzles: [
      { name: "N1", nps: "6", proj: 300, service: "Outlet", place: { kind: "shell", elev: 600, orient: 270 } },
      { name: "N2", nps: "6", proj: 300, service: "Inlet", place: { kind: "shell", elev: 7800, orient: 270 } },
    ],
  });

  // ---- feed pumps
  [d] = connect(d, nozzle(drum, "N2"), nozzle(pa, "N1"), '6"-P-1001-A1A', "Pump suction A", 1);
  [d] = connect(d, nozzle(drum, "N4"), nozzle(pb, "N1"), '6"-P-1005-A1A', "Pump suction B", 1);
  [d, header] = connect(d, nozzle(pa, "N2"), nozzle(ex, "N1"), '4"-P-1002-A1A', "Pump discharge", 2);
  [d] = onFirstLeg(d, header, "check", 700);
  [d] = onFirstLeg(d, header, "gate", 1450);
  [d, tee] = onFirstLeg(d, header, "tee", 2900, [-1, 0, 0]);
  [d, l] = connect(d, { kind: "tee", line: header, item: tee }, nozzle(pb, "N2"), '4"-P-1003-A1A', "Pump discharge B", 2);
  d = onLastLeg(d, l, "check", 700);
  d = onLastLeg(d, l, "gate", 1450);

  // ---- stripper: feed, overhead, reflux, bottoms, product
  [d] = connect(d, nozzle(ex, "N2"), nozzle(col, "N1"), '4"-P-1006-A1A', "Preheated feed", 0);
  [d] = connect(d, nozzle(col, "N3"), nozzle(rd, "N1"), '6"-P-2001-A1A', "Overhead vapour", 5);
  [d] = connect(d, nozzle(rd, "N2"), nozzle(ra, "N1"), '6"-P-2002-A1A', "Reflux pump suction A", 4);
  [d] = connect(d, nozzle(rd, "N3"), nozzle(rb, "N1"), '6"-P-2005-A1A', "Reflux pump suction B", 4);
  [d, reflux] = connect(d, nozzle(ra, "N2"), nozzle(col, "N4"), '4"-P-2003-A1A', "Reflux", 4);
  [d] = onFirstLeg(d, reflux, "check", 700);
  [d] = onFirstLeg(d, reflux, "gate", 1450);
  [d, tee] = onFirstLeg(d, reflux, "tee", 2900, [1, 0, 0]);
  [d, l] = connect(d, { kind: "tee", line: reflux, item: tee }, nozzle(rb, "N2"), '4"-P-2006-A1A', "Reflux pump B discharge", 4);
  d = onLastLeg(d, l, "check", 700);
  d = onLastLeg(d, l, "gate", 1450);
  [d] = connect(d, nozzle(col, "N2"), nozzle(ex, "N3"), '6"-P-2004-A1A', "Stripper bottoms", 7);
  [d] = connect(d, nozzle(ex, "N4"), nozzle(tk, "N2"), '6"-P-1004-A1A', "Product to storage", 3);

  // battery-limit lines enter the rack from the west, each in its own lane, at its size's shoe elevation
  const east: V3 = [1, 0, 0];
  const west: V3 = [-1, 0, 0];
  const z = (level: number, nps: string) => pipeElevationOn(level, catalog.od(nps));
  d = connectFree(d, { point: [-1500, 1200, z(7000, "4")], dir: east, ref: nozzle(drum, "N1"), pointIsStart: true, nps: "4", number: '4"-P-1000-A1A', fluid: "Feed from battery limit", color: 0 });
  d = connectFree(d, { point: [-1500, 2400, z(7000, "3")], dir: west, ref: nozzle(drum, "N3"), pointIsStart: false, nps: "3", number: '3"-VG-3001-A1A', fluid: "Vapour to flare header", color: 6 });
  d = connectFree(d, { point: [-1500, -1800, z(5000, "6")], dir: west, ref: nozzle(tk, "N1"), pointIsStart: false, nps: "6", number: '6"-P-1007-A1A', fluid: "Product export", color: 3 });
  return d;
}
