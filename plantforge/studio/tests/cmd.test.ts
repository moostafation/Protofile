import { describe, expect, it } from "vitest";
import { Env } from "../src/cmd/commands";
import { tokenize } from "../src/cmd/lexer";
import { execute, newSession } from "../src/cmd/run";
import { computeModel } from "../src/engine/compute";
import { demoDoc } from "../src/engine/demo";
import type { PlantDoc } from "../src/engine/doc";
import { ApprovalError, LOCAL_USER, normalizeDoc, stamp } from "../src/engine/meta";

const base = normalizeDoc(demoDoc());

/** The command language against a plain document, as the app runs it (approvals enforced). */
function harness(doc: PlantDoc = base) {
  let d = doc;
  let m = computeModel(d, { clash: false });
  const out: string[] = [];
  const errors: string[] = [];
  const env: Env = {
    doc: () => d,
    model: () => m,
    user: () => LOCAL_USER,
    selection: () => [],
    apply: (next) => {
      try {
        d = stamp(d, next, LOCAL_USER);
      } catch (e) {
        if (e instanceof ApprovalError) {
          errors.push(e.message);
          return false;
        }
        throw e;
      }
      m = computeModel(d, { clash: false });
      return true;
    },
    select: () => {},
    out: (t, k) => (k === "error" ? errors : out).push(t),
  };
  const s = newSession();
  return {
    run: (t: string) => execute(t, env, s),
    get doc() {
      return d;
    },
    get model() {
      return m;
    },
    eq: (tag: string) => d.equipment.find((e) => e.tag === tag),
    out,
    errors,
    s,
  };
}

describe("command language: words", () => {
  it("reads sizes, lengths, coordinates, text and line numbers", () => {
    const t = tokenize(`add pump P-102 at 5000,3000 rot 90deg size 6" 2.5m 'Feed pump' 4"-P-1002-A1A nps>=6`);
    expect(t.map((x) => x.t)).toEqual(["word", "word", "word", "word", "coord", "word", "num", "word", "size", "num", "str", "word", "word", "op", "num"]);
    expect(t[4].nums).toEqual([5000, 3000]);
    expect(t[6].n).toBe(90);
    expect(t[8].v).toBe("6");
    expect(t[9].n).toBe(2500);
    expect(t[10].v).toBe("Feed pump");
    expect(t[11].v).toBe('4"-P-1002-A1A');
  });
});

describe("command language: modelling", () => {
  it("adds, rotates, copies and chains with it", () => {
    const h = harness();
    expect(h.run("add pump P-102 at 5000,-20000 rot 90")).toBe(true);
    expect(h.eq("P-102")!.origin).toEqual([5000, -20000, 0]);
    expect(h.eq("P-102")!.rot).toBe(90);
    h.run("add pump P-104 at 0,-30000 then rotate it 180");
    expect(h.eq("P-104")!.rot).toBe(180);
    const n = h.doc.equipment.length;
    h.run("add pump at 0,-40000 x3 spacing 2500 east");
    expect(h.doc.equipment.length).toBe(n + 3);
    h.run("copy V-101 east 15000 as V-102");
    expect(h.eq("V-102")!.origin).toEqual([21000, 10500, 0]);
    expect(h.errors).toEqual([]);
  });

  it("understands Arabic", () => {
    const h = harness();
    h.run("ضيف طلمبة P-103 عند 1000,-25000");
    expect(h.eq("P-103")!.origin).toEqual([1000, -25000, 0]);
    h.run("حرك P-103 شرق 500");
    expect(h.eq("P-103")!.origin).toEqual([1500, -25000, 0]);
    expect(h.errors).toEqual([]);
  });

  it("moves equipment and the connected pipes follow", () => {
    const h = harness();
    const before = h.eq("P-101A")!.origin;
    h.run("move P-101A east 500");
    expect(h.eq("P-101A")!.origin).toEqual([before[0] + 500, before[1], 0]);
    const suction = [...h.model.lines.values()].find((l) => l.doc.number.includes("P-1001"))!;
    expect(suction.error).toBeUndefined();
    h.run("again");
    expect(h.eq("P-101A")!.origin[0]).toBe(before[0] + 1000);
  });

  it("connects nozzles and draws pipes by steps", () => {
    const h = harness();
    h.run("add exchanger E-150 at 60000,10000 then add pump P-150 at 52000,12000 rot -90");
    expect(h.run("connect P-150.N2 to E-150.N1 as 'Test discharge'")).toBe(true);
    const line = h.doc.lines[h.doc.lines.length - 1];
    expect(line.fluid).toBe("Test discharge");
    expect(h.model.lines.get(line.id)!.error).toBeUndefined();
    expect(h.s.it[0].id).toBe(line.id);
    expect(h.run("route from E-150.N3 up 1500 east 2000 flanged")).toBe(true);
    const r = h.doc.lines[h.doc.lines.length - 1];
    expect(r.end.kind).toBe("flanged");
    expect(h.model.lines.get(r.id)!.error).toBeUndefined();
    expect(h.errors).toEqual([]);
  });

  it("puts valves and tees on lines and names them along the line", () => {
    const h = harness();
    const id = h.doc.lines.find((l) => l.number.includes("P-1004"))!.id;
    const n = h.doc.lines.find((l) => l.id === id)!.inline.length;
    expect(h.run("add gate valve on P-1004 mid")).toBe(true);
    expect(h.doc.lines.find((l) => l.id === id)!.inline.length).toBe(n + 1);
    h.out.length = 0;
    h.run("list valves on P-1004");
    expect(h.out.join("\n")).toContain("P-1004-A1A.V1");
    expect(h.run("delete P-1004.V1")).toBe(true);
    expect(h.doc.lines.find((l) => l.id === id)!.inline.length).toBe(n);
  });

  it("sets properties on sets of objects with where-filters", () => {
    const h = harness();
    h.run("set P-101A desc='Duty pump' rot=90");
    expect(h.eq("P-101A")!.description).toBe("Duty pump");
    expect(h.eq("P-101A")!.rot).toBe(90);
    h.run("set lines where nps>=6 color=blue");
    for (const l of h.doc.lines) if (Number(l.nps) >= 6) expect(l.color).toBe(2);
    h.out.length = 0;
    h.run("count lines where nps>=6");
    expect(h.out[0]).toMatch(/^\d+: \d+ lines?/);
    h.out.length = 0;
    h.run("list C-201 and lines where nps>=6");
    expect(h.out.join("\n")).toContain("C-201");
    expect(h.out.join("\n")).toContain('6"-P-2004-A1A');
    expect(h.out.join("\n")).not.toContain('4"-P-1002-A1A');
    h.run("set V-101 H=8000");
    expect(h.eq("V-101")!.params.H).toBe(8000);
  });

  it("keeps approved objects locked", () => {
    const h = harness();
    h.run("approve T-101");
    expect(h.doc.equipment.find((e) => e.tag === "T-101")!.meta!.status).toBe("Approved");
    expect(h.run("move T-101 east 100")).toBe(false);
    expect(h.errors.join(" ")).toMatch(/Approved/);
    h.run("reopen T-101");
    expect(h.run("move T-101 east 100")).toBe(true);
  });

  it("explains mistakes", () => {
    const h = harness();
    h.run("ad pump");
    expect(h.errors.pop()).toMatch(/Did you mean add/);
    h.run("move P-101Z east 100");
    expect(h.errors.pop()).toMatch(/Did you mean P-101[AB]/);
    h.run("connect P-101A.N2 to E-101.N1");
    expect(h.errors.pop()).toMatch(/already connected/);
  });

  it("runs macros with arguments", () => {
    const h = harness();
    const n = h.doc.equipment.length;
    h.run("macro pair add pump at $1 x2 spacing 3000 east");
    h.run("pair 0,-50000");
    expect(h.doc.equipment.length).toBe(n + 2);
    expect(h.doc.equipment[n].origin).toEqual([0, -50000, 0]);
  });

  it("answers questions: info, list, measure", () => {
    const h = harness();
    h.run("info V-101");
    expect(h.out.some((l) => l.includes("V-101") && l.includes("vessel"))).toBe(true);
    h.run("measure P-101A to P-101B");
    expect(h.out[h.out.length - 1]).toMatch(/direct 2500 mm/);
    h.run("list free nozzles");
    expect(h.errors).toEqual([]);
  });
});
