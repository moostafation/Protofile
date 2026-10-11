// doc -> model: build equipment and steel, route every line, add supports, then analyse.

import { catalog } from "./catalog";
import { Clash, findClashes } from "./clash";
import { Connectivity, analyse } from "./connectivity";
import type { EndRef, EquipmentDoc, LineDoc, PlantDoc, StructureDoc } from "./doc";
import { BuiltEquipment, buildEquipment } from "./equipment";
import type { Comp } from "./model";
import { MtoRow, materialTakeoff } from "./mto";
import { makeShoe } from "./parts";
import { EndKind, Leg, route } from "./routing";
import { getSpec } from "./spec";
import { RackInfo, SHOE_HEIGHT, buildRack, pipeElevationOn } from "./structure";
import { V3, addScaled, dot, fmtENU, neg, sub } from "./vec";

export interface LineResult {
  doc: LineDoc;
  comps: Comp[];
  warnings: string[];
  error?: string;
  path: V3[];
  legs: Leg[];
  startKind: EndKind;
  endKind: EndKind;
  startDir: V3 | null;
  endDir: V3 | null;
  pipeLength: number;
}

export interface TodoItem {
  level: "error" | "warning" | "info";
  text: string;
  uids: string[];
  owner?: { type: "line" | "equipment" | "structure"; id: string };
}

export interface Model {
  doc: PlantDoc;
  equipment: Map<string, BuiltEquipment & { doc: EquipmentDoc }>;
  structures: Map<string, { doc: StructureDoc; comp: Comp; rack: RackInfo }>;
  lines: Map<string, LineResult>;
  comps: Comp[];
  byUid: Map<string, Comp>;
  conn: Connectivity;
  clashes: Clash[] | null; // null = not computed yet
  todo: TodoItem[];
  mto: MtoRow[];
}

export interface Resolved {
  pos: V3;
  dir: V3;
  nps: string;
  kind: EndKind;
  label: string;
}

/** Position, direction and end type of a line end reference. */
export function resolveEnd(ref: EndRef, model: Pick<Model, "equipment" | "lines" | "doc">): Resolved | null {
  if (ref.kind === "nozzle") {
    const eq = model.equipment.get(ref.eq);
    const noz = eq?.nozzles.find((n) => n.props.name === ref.nozzle);
    if (!eq || !noz) return null;
    const p = noz.ports[0];
    return { pos: p.pos, dir: p.dir, nps: noz.nps, kind: "nozzle", label: noz.tag };
  }
  if (ref.kind === "tee") {
    const line = model.lines.get(ref.line);
    const tee = line?.comps.find((c) => c.kind === "TEE" && c.props.inlineId === ref.item);
    if (!line || !tee) return null;
    const br = tee.ports.find((p) => p.name === "BR")!;
    return { pos: br.pos, dir: br.dir, nps: tee.nps, kind: "buttweld", label: `${line.doc.number} ${tee.tag}` };
  }
  return null;
}

/** The full centre-line of a line: connected end points + free points. */
export function linePath(line: LineDoc, model: Pick<Model, "equipment" | "lines" | "doc">) {
  const s = resolveEnd(line.start, model);
  const e = resolveEnd(line.end, model);
  const path = [...(s ? [s.pos] : []), ...line.points, ...(e ? [e.pos] : [])];
  return { path, s, e };
}

function computeLine(line: LineDoc, model: Model): LineResult {
  const { path, s, e } = linePath(line, model);
  const startKind: EndKind = s ? s.kind : line.start.kind === "flanged" ? "flanged" : "open";
  const endKind: EndKind = e ? e.kind : line.end.kind === "flanged" ? "flanged" : "open";
  const base = { doc: line, path, startKind, endKind, startDir: s?.dir ?? null, endDir: e ? neg(e.dir) : null, pipeLength: 0 };
  const missing = (ref: EndRef, r: Resolved | null) => (ref.kind === "nozzle" || ref.kind === "tee") && !r;
  if (missing(line.start, s) || missing(line.end, e))
    return { ...base, comps: [], warnings: [], legs: [], error: `${line.number}: connected item no longer exists - reconnect or delete the line` };
  for (const r of [s, e]) {
    if (r && r.nps !== line.nps)
      return { ...base, comps: [], warnings: [], legs: [], error: `${line.number}: line is NPS ${line.nps} but ${r.label} is NPS ${r.nps} (reducers come in a later release)` };
  }
  if (path.length < 2) return { ...base, comps: [], warnings: [], legs: [], error: `${line.number}: needs at least two points` };
  let spec;
  try {
    spec = getSpec(line.spec);
  } catch (err) {
    return { ...base, comps: [], warnings: [], legs: [], error: `${line.number}: ${(err as Error).message}` };
  }
  const r = route({
    spec,
    owner: line.id,
    label: line.number,
    nps: line.nps,
    points: path,
    start: startKind,
    end: endKind,
    inline: line.inline,
    startDir: base.startDir,
    endDir: base.endDir,
    startRef: s?.label,
    endRef: e?.label,
  });
  const pipeLength = r.comps.filter((c) => c.kind === "PIPE").reduce((t, c) => t + c.props.length, 0);
  return { ...base, comps: r.comps, warnings: r.warnings, error: r.error, legs: r.legs, pipeLength };
}

/** Shoes where horizontal pipe crosses rack frames at a level it rests on. */
function addSupports(line: LineResult, racks: RackInfo[]) {
  let n = 0;
  const shoes: Comp[] = [];
  for (const c of line.comps) {
    if (c.kind !== "PIPE") continue;
    const [a, b] = [c.ports[0].pos, c.ports[1].pos];
    const d = sub(b, a);
    if (Math.abs(d[2]) > 1e-6) continue;
    const od = catalog.od(c.nps);
    for (const rk of racks) {
      const level = rk.levels.find((lv) => Math.abs(pipeElevationOn(lv, od) - a[2]) < 2);
      if (level === undefined) continue;
      const along = dot(d, rk.axis);
      if (Math.abs(Math.abs(along) - Math.hypot(d[0], d[1])) > 1e-6) continue; // must run along the rack
      const off = dot(sub(a, rk.start), rk.across);
      if (Math.abs(off) > rk.width / 2 - 200) continue;
      const u0 = dot(sub(a, rk.start), rk.axis);
      const u1 = dot(sub(b, rk.start), rk.axis);
      const [lo, hi] = [Math.min(u0, u1), Math.max(u0, u1)];
      for (const f of rk.frames) {
        if (f < lo + 150 || f > hi - 150) continue;
        const at = addScaled(a, rk.axis, f - u0);
        n += 1;
        shoes.push(
          makeShoe(c.nps, { tag: `S${n}`, owner: { type: "line", id: line.doc.id } }, at, rk.axis[0] ? [1, 0, 0] : [0, 1, 0], SHOE_HEIGHT, `PIPE SHOE ${SHOE_HEIGHT}H, CS, WELDED, ON ${rk.id}`),
        );
        shoes[shoes.length - 1].props.rack = rk.id;
      }
    }
  }
  line.comps.push(...shoes);
}

export function computeModel(doc: PlantDoc, opts: { clash?: boolean } = {}): Model {
  const model: Model = {
    doc,
    equipment: new Map(),
    structures: new Map(),
    lines: new Map(),
    comps: [],
    byUid: new Map(),
    conn: analyse([]),
    clashes: null,
    todo: [],
    mto: [],
  };
  for (const eq of doc.equipment) {
    try {
      model.equipment.set(eq.id, { ...buildEquipment(eq), doc: eq });
    } catch (err) {
      model.todo.push({ level: "error", text: `${eq.tag}: ${(err as Error).message}`, uids: [], owner: { type: "equipment", id: eq.id } });
    }
  }
  for (const st of doc.structures) {
    const comp = buildRack(st);
    model.structures.set(st.id, { doc: st, comp, rack: comp.props.rack });
  }
  const racks = [...model.structures.values()].map((s) => s.rack);

  // lines that branch from a tee must be routed after the line that owns the tee
  const pending = [...doc.lines];
  let guard = pending.length + 1;
  while (pending.length && guard-- > 0) {
    for (const line of [...pending]) {
      if (line.start.kind === "tee" && !model.lines.has(line.start.line) && pending.some((p) => p.id === (line.start as { line: string }).line)) continue;
      const res = computeLine(line, model);
      if (!res.error) addSupports(res, racks);
      model.lines.set(line.id, res);
      pending.splice(pending.indexOf(line), 1);
    }
  }
  for (const line of pending) model.lines.set(line.id, { ...computeLine(line, model), error: `${line.number}: circular branch reference` });

  for (const e of model.equipment.values()) model.comps.push(e.body, ...e.nozzles);
  for (const s of model.structures.values()) model.comps.push(s.comp);
  for (const l of model.lines.values()) model.comps.push(...l.comps);
  for (const c of model.comps) model.byUid.set(c.uid, c);

  model.conn = analyse(model.comps);
  for (const l of model.lines.values()) {
    if (l.error) model.todo.push({ level: "error", text: l.error, uids: [], owner: { type: "line", id: l.doc.id } });
    for (const w of l.warnings) model.todo.push({ level: "warning", text: w, uids: [], owner: { type: "line", id: l.doc.id } });
  }
  for (const p of model.conn.problems) model.todo.push({ level: "error", text: p.text, uids: p.uids });
  for (const o of model.conn.open) {
    if (o.comp.kind === "NOZZLE") continue; // free nozzles are normal
    const line = model.lines.get(o.comp.owner.id);
    model.todo.push({
      level: "info",
      text: `Open end ${line?.doc.number ?? ""} ${o.comp.tag} at ${fmtENU(o.port.pos)}`,
      uids: [o.comp.uid],
      owner: { type: "line", id: o.comp.owner.id },
    });
  }
  model.mto = materialTakeoff([...model.lines.values()].map((l) => ({ spec: l.doc.spec, comps: l.comps })));
  if (opts.clash !== false) model.clashes = runClash(model);
  return model;
}

export function runClash(model: Model, clearance = 0): Clash[] {
  return findClashes(model.comps, model.conn, {
    clearance,
    skip: (a, b) => (a.kind === "SUPPORT" && b.kind === "STEEL") || (b.kind === "SUPPORT" && a.kind === "STEEL"),
  });
}

export const freeNozzles = (model: Model) =>
  [...model.equipment.values()].flatMap((e) => e.nozzles).filter((n) => !model.conn.joints.some((j) => j.a.uid === n.uid || j.b.uid === n.uid));
