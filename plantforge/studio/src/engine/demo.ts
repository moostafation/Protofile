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
  let d: PlantDoc = { ...emptyDoc(), project: { name: "Feed Section Demo", plant: "PlantForge Demo Refinery", area: "A-100", unit: "U-110 Feed" } };
  let drum: string, pa: string, pb: string, ex: string, tk: string, header: string, tee: string, l: string;
  [d] = addRack(d, [0, 0, 0], "x", 30000, 6000, [5000, 7000]);

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
  [d, ex] = addEquipment(d, "exchanger", [22000, -7500, 0], 0, "E-101");
  d = updateEquipment(d, ex, { description: "Feed / effluent exchanger" });
  [d, tk] = addEquipment(d, "tank", [31000, -15500, 0], 0, "T-101");
  d = updateEquipment(d, tk, {
    description: "Intermediate storage tank",
    nozzles: [
      { name: "N1", nps: "6", proj: 300, service: "Outlet", place: { kind: "shell", elev: 600, orient: 270 } },
      { name: "N2", nps: "4", proj: 300, service: "Inlet", place: { kind: "shell", elev: 7800, orient: 270 } },
    ],
  });

  [d] = connect(d, nozzle(drum, "N2"), nozzle(pa, "N1"), '6"-P-1001-A1A', "Pump suction A", 1);
  [d] = connect(d, nozzle(drum, "N4"), nozzle(pb, "N1"), '6"-P-1005-A1A', "Pump suction B", 1);
  [d, header] = connect(d, nozzle(pa, "N2"), nozzle(ex, "N1"), '4"-P-1002-A1A', "Pump discharge", 0);
  [d] = onFirstLeg(d, header, "check", 700);
  [d] = onFirstLeg(d, header, "gate", 1450);
  [d, tee] = onFirstLeg(d, header, "tee", 2900, [-1, 0, 0]);
  [d, l] = connect(d, { kind: "tee", line: header, item: tee }, nozzle(pb, "N2"), '4"-P-1003-A1A', "Pump discharge B", 0);
  d = onLastLeg(d, l, "check", 700);
  d = onLastLeg(d, l, "gate", 1450);
  [d] = connect(d, nozzle(ex, "N2"), nozzle(tk, "N2"), '4"-P-1004-A1A', "Exchanger outlet", 2);

  // battery-limit lines enter the rack from the west, each in its own lane, at its size's shoe elevation
  const east: V3 = [1, 0, 0];
  const west: V3 = [-1, 0, 0];
  const z = (level: number, nps: string) => pipeElevationOn(level, catalog.od(nps));
  d = connectFree(d, { point: [-1500, -1800, z(5000, "6")], dir: east, ref: nozzle(ex, "N3"), pointIsStart: true, nps: "6", number: '6"-CW-2001-A1A', fluid: "Cooling water supply", color: 3 });
  d = connectFree(d, { point: [-1500, -600, z(5000, "6")], dir: west, ref: nozzle(ex, "N4"), pointIsStart: false, nps: "6", number: '6"-CW-2002-A1A', fluid: "Cooling water return", color: 4 });
  d = connectFree(d, { point: [-1500, 1200, z(7000, "4")], dir: east, ref: nozzle(drum, "N1"), pointIsStart: true, nps: "4", number: '4"-P-1000-A1A', fluid: "Feed from battery limit", color: 5 });
  d = connectFree(d, { point: [-1500, 2400, z(7000, "3")], dir: west, ref: nozzle(drum, "N3"), pointIsStart: false, nps: "3", number: '3"-VG-3001-A1A', fluid: "Vapour to flare header", color: 6 });
  return d;
}
