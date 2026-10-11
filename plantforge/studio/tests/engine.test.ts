import { describe, expect, it } from "vitest";
import { autoRoute } from "../src/engine/autoroute";
import { normalizeNps, npsValue, catalog } from "../src/engine/catalog";
import { gjk } from "../src/engine/clash";
import { addEquipment, addInline, addLine, addRack, autoConnect, deleteObject, moveEquipment, removeInline, reroute, stretch } from "../src/engine/commands";
import { computeModel, linePath } from "../src/engine/compute";
import { demoDoc } from "../src/engine/demo";
import { emptyDoc } from "../src/engine/doc";
import { toDxf, toSvg } from "../src/engine/drawing";
import { exportToml } from "../src/engine/exportToml";
import { lineIsometric } from "../src/engine/iso";
import { linePcf } from "../src/engine/pcf";
import { route } from "../src/engine/routing";
import { boxMinMax, convexParts, cyl, sph } from "../src/engine/shapes";
import { getSpec } from "../src/engine/spec";
import { V3, dist, isClose } from "../src/engine/vec";

const spec = getSpec("A1A");
const base = { spec, owner: "L", label: "L", nps: "4", start: "open" as const, end: "open" as const };

describe("catalog & spec (shared with the Python engine)", () => {
  it("normalises sizes", () => {
    expect(normalizeNps(1.5)).toBe("1-1/2");
    expect(normalizeNps('4"')).toBe("4");
    expect(npsValue("3/4")).toBe(0.75);
  });
  it("reads ASME tables", () => {
    expect(catalog.pipe("4", "STD").weightPerM).toBeCloseTo(16.07, 1);
    expect(catalog.elbow90("6")).toBe(229);
    expect(catalog.flange("4", "CL150").length).toBeCloseTo(76.6);
  });
  it("selects schedules from the spec TOML", () => {
    expect(spec.pipeRules.find((r) => r.lo <= 1 && 1 <= r.hi)?.schedule).toBe("80");
    expect(Object.keys(spec.valves).sort()).toEqual(["check", "gate", "globe"]);
  });
});

describe("routing", () => {
  it("places elbows and fills pipe like the Python engine", () => {
    const r = route({ ...base, points: [[0, 0, 0], [2000, 0, 0], [2000, 1500, 0]] });
    expect(r.error).toBeUndefined();
    expect(r.comps.map((c) => c.kind)).toEqual(["PIPE", "ELBOW", "PIPE"]);
    expect(r.comps[0].props.length).toBeCloseTo(1848);
    expect(isClose(r.comps[1].ports[1].pos, [2000, 152, 0])).toBe(true);
  });
  it("builds a flanged valve assembly centred on its station", () => {
    const r = route({ ...base, points: [[0, 0, 0], [2000, 0, 0]], inline: [{ id: "v", type: "gate", leg: 0, station: 1000 }] });
    expect(r.comps.map((c) => c.kind)).toEqual(["PIPE", "FLANGE", "GASKET", "VALVE", "GASKET", "FLANGE", "PIPE"]);
    const v = r.comps.find((c) => c.kind === "VALVE")!;
    expect(isClose(v.props.center, [1000, 0, 0], 1e-6)).toBe(true);
  });
  it("reports errors instead of throwing", () => {
    expect(route({ ...base, points: [[0, 0, 0], [1000, 0, 0], [1000, 200, 0], [2000, 200, 0]] }).error).toMatch(/overlap/);
    expect(route({ ...base, points: [[0, 0, 0], [1000, 0, 0], [0, 500, 0]] }).error).toMatch(/exceeds 90/);
    expect(route({ ...base, nps: "30", points: [[0, 0, 0], [1000, 0, 0]] }).error).toMatch(/NPS 30/);
  });
});

describe("clash geometry", () => {
  it("measures distances with GJK", () => {
    expect(gjk(sph([0, 0, 0], 5), sph([10, 10, 10], 5))[0]).toBeCloseTo(Math.sqrt(300) - 10, 2);
    expect(gjk(cyl([0, 0, 0], [100, 0, 0], 10), cyl([50, -50, 40], [50, 50, 40], 15))[0]).toBeCloseTo(15, 2);
    expect(gjk(boxMinMax([0, 0, 0], [10, 10, 10]), sph([5, 5, 5], 1))[0]).toBe(0);
  });
  it("encloses elbows with chord cylinders", () => {
    const tor = { t: "tor" as const, c: [0, 0, 0] as V3, s: [100, 0, 0] as V3, n: [0, 0, 1] as V3, ang: Math.PI / 2, r: 10 };
    const probe = sph([Math.cos(Math.PI / 4) * 109.9, Math.sin(Math.PI / 4) * 109.9, 0], 0.01);
    expect(Math.min(...convexParts(tor).map((p) => gjk(p, probe)[0]))).toBe(0);
  });
});

describe("plant model", () => {
  const doc = demoDoc();
  const model = computeModel(doc);

  it("routes the whole demo automatically, clash-free, with rack shoes", () => {
    expect([...model.lines.values()].filter((l) => l.error)).toEqual([]);
    expect(model.clashes!.filter((c) => c.hard)).toEqual([]);
    expect(model.conn.problems).toEqual([]);
    expect(model.comps.filter((c) => c.kind === "SUPPORT").length).toBeGreaterThanOrEqual(10);
  });

  it("detects a clash when a line is pushed through another", () => {
    const header = doc.lines.find((l) => l.number.includes("P-1002"))!;
    const res = model.lines.get(header.id)!;
    const i = res.path.findIndex((p, k) => k > 0 && Math.abs(p[2] - res.path[k - 1][2]) < 1 && Math.abs(p[1] - res.path[k - 1][1]) < 1 && dist(p, res.path[k - 1]) > 5000);
    const [a, b] = [res.path[i - 1], res.path[i]];
    const x = (a[0] + b[0]) / 2;
    const z = a[2];
    let [d, id] = addLine(doc, { nps: "6", points: [[x, a[1] - 4000, z], [x, a[1] + 4000, z]], start: { kind: "open" }, end: { kind: "open" } });
    const m2 = computeModel(d);
    expect(m2.clashes!.some((c) => c.hard && (c.a.startsWith(id) || c.b.startsWith(id)))).toBe(true);
    d = deleteObject(d, { type: "line", id });
    expect(computeModel(d).clashes!.filter((c) => c.hard)).toEqual([]);
  });

  it("stretches connected lines when equipment moves (E3D-style)", () => {
    const pump = doc.equipment.find((e) => e.tag === "P-101A")!;
    const moved = moveEquipment(doc, pump.id, [pump.origin[0], pump.origin[1] + 300, 0]);
    const m2 = computeModel(moved);
    const suction = [...m2.lines.values()].find((l) => l.doc.number.includes("P-1001"))!;
    expect(suction.error).toBeUndefined();
    const discharge = [...m2.lines.values()].find((l) => l.doc.number.includes("P-1002"))!;
    expect(discharge.error).toBeUndefined();
  });

  it("re-routes a line", () => {
    const line = doc.lines.find((l) => l.number.includes("P-1004"))!;
    const r = reroute(doc, line.id);
    expect(r.error).toBeUndefined();
    expect(computeModel(r.doc).lines.get(line.id)!.error).toBeUndefined();
  });

  it("detaches lines when equipment is deleted and branches when a tee is removed", () => {
    const tank = doc.equipment.find((e) => e.tag === "T-101")!;
    const d = deleteObject(doc, { type: "equipment", id: tank.id });
    const m2 = computeModel(d, { clash: false });
    const l = [...m2.lines.values()].find((x) => x.doc.number.includes("P-1004"))!;
    expect(l.doc.end.kind).toBe("flanged");
    expect(l.error).toBeUndefined();
    const header = doc.lines.find((x) => x.number.includes("P-1002"))!;
    const tee = header.inline.find((i) => i.type === "tee")!;
    const d2 = removeInline(doc, header.id, tee.id);
    const branch = computeModel(d2, { clash: false }).lines.get(doc.lines.find((x) => x.number.includes("P-1003"))!.id)!;
    expect(branch.doc.start.kind).toBe("open");
    expect(branch.error).toBeUndefined();
  });

  it("produces PCF, isometric SVG/DXF and a Python TOML", () => {
    const l = [...model.lines.values()][2];
    const pcf = linePcf(model, l);
    expect(pcf).toMatch(/^ISOGEN-FILES/);
    expect(pcf).toContain("BRANCH1-POINT");
    const iso = lineIsometric(model, l.doc.id, "2026-01-01");
    expect(toSvg(iso, true)).toContain("<svg");
    const dxf = toDxf(iso);
    expect(dxf).toContain("ENTITIES");
    expect(dxf.trim().endsWith("EOF")).toBe(true);
    const toml = exportToml(model);
    expect(toml).toContain("[[lines]]");
    expect(toml).toContain("from = \"V-101/N2\"");
  });
});

describe("auto-router", () => {
  it("connects two pumps' nozzles through open space without clashes", () => {
    let d = emptyDoc();
    let a: string, b: string;
    [d, a] = addEquipment(d, "vvessel", [0, 0, 0], 0, "V-1");
    [d, b] = addEquipment(d, "pump", [-1500, -5000, 0], -90, "P-1");
    const r = autoConnect(d, { from: { kind: "nozzle", eq: a, nozzle: "N2" }, to: { kind: "nozzle", eq: b, nozzle: "N1" } });
    expect(r.error).toBeUndefined();
    const m = computeModel(r.doc);
    expect([...m.lines.values()][0].error).toBeUndefined();
    expect(m.clashes!.filter((c) => c.hard)).toEqual([]);
  });

  it("prefers the rack for long runs", () => {
    let d = emptyDoc();
    let a: string, b: string;
    [d] = addRack(d, [0, 0, 0], "x", 30000);
    [d, a] = addEquipment(d, "pump", [2000, 6500, 0], -90, "P-1");
    [d, b] = addEquipment(d, "exchanger", [25000, -7500, 0], 0, "E-1");
    const m = computeModel(d, { clash: false });
    const s = m.equipment.get(a)!.nozzles.find((n) => n.props.name === "N2")!.ports[0];
    const e = m.equipment.get(b)!.nozzles.find((n) => n.props.name === "N1")!.ports[0];
    const res = autoRoute({ model: m, spec, nps: "4", start: { pos: s.pos, dir: s.dir, kind: "nozzle" }, end: { pos: e.pos, dir: [-e.dir[0], -e.dir[1], -e.dir[2]], kind: "nozzle" } })!;
    expect(res).not.toBeNull();
    expect(res.rackLength).toBeGreaterThan(15000);
    expect(res.clashes).toBe(0);
  });

  it("keeps legs orthogonal when stretching", () => {
    const full: V3[] = [[0, 0, 0], [0, 0, 1000], [3000, 0, 1000], [3000, 2000, 1000]];
    const out = stretch(full, true, [200, 100, 0], true);
    expect(out[0]).toEqual([200, 100, 0]);
    expect(out[1]).toEqual([200, 100, 1000]);
    expect(out[2]).toEqual([3000, 100, 1000]);
    expect(out[3]).toEqual([3000, 2000, 1000]);
  });

  it("inline insertion via the command API survives re-compute", () => {
    const d0 = demoDoc();
    const l = d0.lines.find((x) => x.number.includes("P-1004"))!;
    const res = computeModel(d0, { clash: false }).lines.get(l.id)!;
    const long = res.legs.reduce((best, g, k) => (g.length > res.legs[best].length ? k : best), 0);
    const [d1] = addInline(d0, l.id, { type: "globe", leg: res.legs[long].parts[0].index, station: res.legs[long].length / 2 });
    const r2 = computeModel(d1, { clash: false }).lines.get(l.id)!;
    expect(r2.error).toBeUndefined();
    expect(r2.comps.some((c) => c.kind === "VALVE" && c.props.valveType === "globe")).toBe(true);
    expect(linePath(l, computeModel(d1, { clash: false })).path.length).toBe(res.path.length);
  });
});
