import { afterEach, describe, expect, it } from "vitest";
import { catalog, getCatalogData, setCatalogData, standardCatalogData } from "../src/engine/catalog";
import { addEquipment, moveEquipment } from "../src/engine/commands";
import { computeModel } from "../src/engine/compute";
import { demoDoc } from "../src/engine/demo";
import { ApprovalError, LOCAL_USER, normalizeDoc, setMeta, stamp } from "../src/engine/meta";
import { setSpecs, standardSpecs } from "../src/engine/spec";
import { PlantDB, parseCsv } from "../src/db/PlantDB";
import { REPORTS } from "../src/db/schema";

const demo = normalizeDoc(demoDoc());

afterEach(() => {
  setCatalogData(standardCatalogData());
  setSpecs(standardSpecs());
});

describe("plant database", () => {
  it("stores and reads back the model, catalog and specs", async () => {
    const db = await PlantDB.create(demo);
    const back = db.readDoc();
    expect(back.equipment.map((e) => e.tag)).toEqual(demo.equipment.map((e) => e.tag));
    expect(back.lines.map((l) => l.number)).toEqual(demo.lines.map((l) => l.number));
    expect(JSON.stringify(back.lines[2])).toEqual(JSON.stringify(demo.lines[2]));
    expect(back.hierarchy?.length).toBeGreaterThan(3);
    expect(db.readCatalog()).toEqual(standardCatalogData());
    const specs = db.readSpecs();
    expect(specs.A1A.pipeRules).toEqual(standardSpecs().A1A.pipeRules);
    expect(specs.A1A.valves).toEqual(standardSpecs().A1A.valves);
  });

  it("refreshes report tables and runs every saved report", async () => {
    const db = await PlantDB.create(demo);
    db.refreshDerived(computeModel(demo));
    for (const r of REPORTS) expect(() => db.query(r.sql), r.name).not.toThrow();
    const lines = db.query("SELECT line_number, route_status FROM v_line_list");
    expect(lines.rows.length).toBe(demo.lines.length);
    expect(lines.rows.every((r) => r[1] === "OK")).toBe(true);
    const free = db.query("SELECT nozzle FROM v_nozzle_schedule WHERE connected_line = 'free'");
    expect(free.rows.map((r) => r[0])).toEqual(["T-101/N1"]);
    const welds = db.query("SELECT SUM(welds) FROM v_weld_summary").rows[0][0];
    expect(welds).toBe(computeModel(demo).conn.welds.length);
  });

  it("keeps a transaction log of who changed what", async () => {
    const db = await PlantDB.create(demo);
    const pump = demo.equipment.find((e) => e.tag === "P-101A")!;
    const next = stamp(demo, moveEquipment(demo, pump.id, [pump.origin[0], pump.origin[1] + 200, 0]), { id: "u_mostafa", name: "Mostafa", canApprove: true });
    const touched = db.saveDoc(next, { action: "Move P-101A", user: "u_mostafa" });
    expect(touched.map((t) => t.name)).toContain("P-101A");
    const t = db.txns(1)[0];
    expect(t.action).toBe("Move P-101A");
    expect(t.user).toBe("u_mostafa");
    expect(db.query("SELECT rev, modified_by FROM object WHERE name = 'P-101A'").rows[0]).toEqual([2, "u_mostafa"]);
    // ids are stored; names come from the local person table
    db.setPeople([["u_mostafa", "Mostafa"]]);
    db.refreshDerived(computeModel(next));
    const audit = REPORTS.find((r) => r.name === "Audit trail")!;
    expect(db.query(audit.sql).rows[0][2]).toBe("Mostafa");
  });

  it("routes with catalog edits made in the database", async () => {
    const db = await PlantDB.create(demo);
    const before = catalog.elbow90("4");
    db.updateCell("cat_fitting", { nps: "4" }, "elbow90_lr", 300);
    setCatalogData(db.readCatalog());
    expect(catalog.elbow90("4")).toBe(300);
    const m = computeModel(demo, { clash: false });
    const elbow = [...m.lines.values()].flatMap((l) => l.comps).find((c) => c.kind === "ELBOW" && c.nps === "4" && c.props.angle === 90)!;
    expect(elbow.props.centerToEnd).toBe(300);
    expect(before).toBe(152);
  });

  it("bulkloads CSV like SP3D's Excel bulkload", async () => {
    const db = await PlantDB.create(demo);
    const csv = 'rating,type,nps,face_to_face\nCL150,gate,5,250\n"CL150","ball","4",229\n';
    expect(db.importCsv("cat_valve", csv, "merge")).toBe(2);
    expect(db.readCatalog().valves.CL150.ball["4"]).toBe(229);
    expect(() => db.importCsv("cat_valve", "rating,colour\nCL150,red\n", "merge")).toThrow(/Unknown column/);
    expect(parseCsv('a,"b,c",d\n1,"x ""y""",3')).toEqual([["a", "b,c", "d"], ["1", 'x "y"', "3"]]);
  });

  it("backs up to a SQLite file and restores it", async () => {
    const db = await PlantDB.create(demo);
    db.refreshDerived(computeModel(demo));
    const bytes = db.export();
    expect(new TextDecoder().decode(bytes.slice(0, 15))).toBe("SQLite format 3");
    const copy = await PlantDB.open(bytes);
    expect(copy.readDoc().lines.length).toBe(demo.lines.length);
    expect(copy.query("SELECT COUNT(*) FROM component").rows[0][0]).toBeGreaterThan(100);
    expect(copy.saveDoc(copy.readDoc(), { action: "noop", user: "x" })).toEqual([]);
  });

  it("refuses writes in the SQL console", async () => {
    const db = await PlantDB.create(demo);
    expect(() => db.query("DELETE FROM object")).toThrow(/read-only/);
    expect(() => db.query("SELECT 1; DROP TABLE object")).toThrow(/one statement/);
    expect(db.query("SELECT COUNT(*) AS n FROM object").rows[0][0]).toBe(demo.equipment.length + demo.lines.length + demo.structures.length);
  });

  it("restores from portable state (catalog customisations included)", async () => {
    const db = await PlantDB.create(demo);
    db.updateCell("cat_pipe", { nps: "6" }, "od", 168.0);
    const state = db.exportState();
    const db2 = await PlantDB.fromState(state);
    expect(db2.readCatalog().pipe["6"].od).toBe(168.0);
    expect(db2.txns().length).toBeGreaterThan(0);
  });
});

describe("approval workflow", () => {
  it("locks approved objects and records revisions", () => {
    const tank = demo.equipment.find((e) => e.tag === "T-101")!;
    const approved = setMeta(demo, [tank.id], { status: "Approved" }, LOCAL_USER);
    expect(approved.equipment.find((e) => e.id === tank.id)!.meta!.status).toBe("Approved");
    const moved = moveEquipment(approved, tank.id, [0, 0, 0]);
    expect(() => stamp(approved, moved, LOCAL_USER)).toThrow(ApprovalError);
    const reviewer = { id: "u2", name: "Reviewer", canApprove: false };
    expect(() => setMeta(demo, [tank.id], { status: "Approved" }, reviewer)).toThrow(/editors/);
    const [withPump] = addEquipment(demo, "pump", [0, 0, 0]);
    const stamped = stamp(demo, withPump, reviewer);
    const pump = stamped.equipment[stamped.equipment.length - 1];
    expect(pump.meta!.createdBy).toBe("u2");
    expect(pump.meta!.status).toBe("Working");
  });

  it("does not touch the catalog of other tests", () => {
    expect(getCatalogData().fittings["4"].elbow90_lr).toBe(152);
  });
});
