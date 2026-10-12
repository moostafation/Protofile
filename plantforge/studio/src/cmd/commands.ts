// PlantForge command language: the commands. Each one is a verb followed by readable words:
//   add pump P-102 at 5000,3000 rot 90        connect P-101A.N2 to E-101.N1
//   move P-101A east 500                       route from V-101.N2 down 1500 to P-101A.N1
//   set lines where spec=A1A fluid='Process'   approve pumps
// Commands work on an Env (the application, or a test double) and never touch the UI directly.

import { autoRoute } from "../engine/autoroute";
import { normalizeNps } from "../engine/catalog";
import type { Clash } from "../engine/clash";
import {
  addEquipment,
  addInline,
  addLine,
  addRack,
  autoConnect,
  deleteObject,
  followMovedEnds,
  moveEquipment,
  removeInline,
  reroute,
  updateEquipment,
  updateLine,
  updateNozzle,
  updateStructure,
} from "../engine/commands";
import { Model, computeModel, resolveEnd } from "../engine/compute";
import type { ApprovalStatus, EndRef, NozzleDoc, NozzlePlace, PlantDoc, TemplateId } from "../engine/doc";
import { TEMPLATES } from "../engine/equipment";
import { ApprovalError, User, setMeta } from "../engine/meta";
import { route, toDocStation } from "../engine/routing";
import { shapesAABB } from "../engine/shapes";
import { SPECS, getSpec } from "../engine/spec";
import { V3, add, addScaled, cross, dist, fmtENU, isClose, neg, norm as unit, scale, sub } from "../engine/vec";
import { REPORTS } from "../db/schema";
import { CmdError, Token, norm } from "./lexer";
import { Reader } from "./reader";
import { COLOR_NAMES, DIRS, Kind, VERBS, VIEWS, kw, lookup } from "./vocab";
import { EndTarget, Ref, TYPE_NAMES, World, ordered, paramKeyOf } from "./world";

// ------------------------------------------------------------------ environment
export interface QueryTable {
  columns: string[];
  rows: unknown[][];
}

/** What commands can do to the application. Only the first group is required. */
export interface Env {
  doc(): PlantDoc;
  model(): Model;
  user(): User;
  selection(): Ref[];
  /** Commit an edit as one undoable transaction; false when it was refused (approved objects). */
  apply(doc: PlantDoc, label: string): boolean;
  select(refs: Ref[], frame: boolean): void;
  out(text: string, kind?: "out" | "error" | "ok"): void;
  newLine?(): { nps: string; spec: string; fluid: string };
  view?(name: string): void;
  fit?(refs: Ref[] | null): void;
  visibility?(mode: "hide" | "show" | "isolate" | "all", ids: string[]): void;
  colorBy?(mode: "line" | "status"): void;
  labels?(on: boolean | null): void;
  section?(refs: Ref[] | null): void;
  clash?(clearance: number | null): Clash[];
  undo?(n: number): void;
  redo?(n: number): void;
  iso?(lineId: string): void;
  exportFile?(kind: string, ref: Ref | null): void;
  save?(): void;
  sql?(q: string): QueryTable;
  routing?(): boolean;
  routeStep?(dir: V3, mm: number): void;
  routeTo?(end: EndTarget): void;
  routeFinish?(flanged: boolean): void;
  startRoute?(from: EndTarget | null): void;
  history?(): string[];
  clear?(): void;
}

/** Thrown when the application refused the edit and already said why. */
export class Stop extends Error {}

export interface Ctx {
  env: Env;
  w: World;
  it(refs: Ref[]): void;
  say(text: string, kind?: "out" | "error" | "ok"): void;
  table(head: string[], rows: unknown[][], max?: number): void;
  commit(doc: PlantDoc, label: string): void;
  macros: Record<string, string>;
}

export interface Command {
  verb: string;
  group: "Create" | "Edit" | "Piping" | "Find & view" | "Check & data" | "Output" | "Session";
  syntax: string;
  more?: string[];
  summary: string;
  ar: string;
  examples: string[];
  run(r: Reader, x: Ctx): void;
}

export const COMMANDS: Command[] = [];
const def = (c: Command) => COMMANDS.push(c);

// ------------------------------------------------------------------ helpers
const names = (refs: Ref[], max = 6) => refs.slice(0, max).map((r) => r.name).join(", ") + (refs.length > max ? ` and ${refs.length - max} more` : "");
const COLUMN = { D: 1800, H: 18000, skirt: 3000 };
const TEMPLATE_OF: Partial<Record<Kind, TemplateId>> = { pump: "pump", vvessel: "vvessel", column: "vvessel", hdrum: "hdrum", exchanger: "exchanger", tank: "tank" };

function value(t: Token): string | number | number[] {
  if (t.t === "num") return t.n!;
  if (t.t === "coord") return t.nums!;
  return t.v;
}

function asNum(t: Token, what: string): number {
  if (t.t !== "num") throw new CmdError(`${what} needs a number, not "${t.v}"`);
  return t.n!;
}

const STATUS_WORDS: Record<string, ApprovalStatus> = {
  working: "Working",
  wip: "Working",
  review: "In Review",
  "in-review": "In Review",
  inreview: "In Review",
  approved: "Approved",
  approve: "Approved",
  rejected: "Rejected",
  reject: "Rejected",
  شغال: "Working",
  مراجعه: "In Review",
  معتمد: "Approved",
  مرفوض: "Rejected",
};

/** The next words are not a tag when they are a keyword, a step, a copy count or key=value. */
function maybeTag(r: Reader): string | null {
  const t = r.peek();
  if (!t || t.t !== "word") return null;
  if (r.peekKw() || lookup(DIRS, t.v) || /^[x×]\d+$/i.test(t.v) || r.peek(1)?.v === "=") return null;
  r.i++;
  return t.v.toUpperCase();
}

function placeAuto(w: World): V3 {
  const xs = w.doc.equipment.map((e) => e.origin[0]);
  return [xs.length ? Math.max(...xs) + 5000 : 0, 0, 0];
}

function lineError(doc: PlantDoc, lineId: string): string | undefined {
  return computeModel(doc, { clash: false }).lines.get(lineId)?.error;
}

// ================================================================== CREATE
def({
  verb: "add",
  group: "Create",
  syntax: "add <pump|vessel|column|drum|exchanger|tank> [TAG] [at <where>] [rot <deg>] [D=… H=…] [x<copies> [spacing <mm> <dir>]]",
  more: [
    "add rack [TAG] at <where> [along x|y] [length 30m] [width 6m] [levels 5000,7000]",
    'add nozzle <size> on <equipment> [facing north|<deg>] [elev <mm>] [top] [station <mm>] [as \'service\']',
    "add <gate|globe|check> valve on <line> [at <mm from start> | mid | near start | near end]",
    "add tee on <line> [at <mm>] [branch <dir>]",
    "add system 'Steam'",
  ],
  summary: "Create equipment, racks, nozzles, valves, tees and systems",
  ar: "ضيف: معدة أو راك أو نوزل أو بلف أو تي أو سيستم",
  examples: ["add pump P-102 at 5000,3000 rot 90", "add column C-301 at 45000,-8000 H=24000", "add pump at V-101 south 6000 x2 spacing 2500 east", "add gate valve on P-1002 near start", 'add nozzle 3" on V-101 facing east elev 4000 as \'Drain\'', "ضيف طلمبة عند 5000,3000"],
  run(r, x) {
    const kind = r.takeKind();
    if (!kind) throw new CmdError("Add what? pump, vessel, column, drum, exchanger, tank, rack, nozzle, gate/globe/check valve, tee or system");
    const tpl = TEMPLATE_OF[kind];
    if (tpl) return addEquipmentCmd(r, x, kind, tpl);
    if (kind === "rack") return addRackCmd(r, x);
    if (kind === "nozzle") return addNozzleCmd(r, x);
    if (kind === "system") return addSystemCmd(r, x);
    if (kind === "line") throw new CmdError("Lines are made with route or connect: connect P-101A.N2 to E-101.N1");
    return addInlineCmd(r, x, kind);
  },
});

function addEquipmentCmd(r: Reader, x: Ctx, kind: Kind, template: TemplateId) {
  const t = TEMPLATES[template];
  const tag = maybeTag(r);
  if (tag && x.w.byName(tag)) throw new CmdError(`${tag} already exists`);
  let origin: V3 | null = null;
  let rot = 0;
  let times = 1;
  let spacing: V3 | null = null;
  let desc: string | null = null;
  const params: Record<string, number> = kind === "column" ? { ...COLUMN } : {};
  while (!r.done) {
    if (r.takeKw("at")) {
      origin = r.position();
      continue;
    }
    if (r.takeKw("rot")) {
      rot = r.angle();
      continue;
    }
    const n = r.takeTimes();
    if (n) {
      times = n;
      continue;
    }
    if (r.takeKw("spacing")) {
      const mm = r.num("a spacing in mm");
      const d = r.isWord() ? lookup(DIRS, r.peek()!.v) : undefined;
      if (d) r.i++;
      spacing = scale(d ?? [1, 0, 0], mm);
      continue;
    }
    if (r.takeKw("as")) {
      desc = r.text("a description");
      continue;
    }
    const k = r.peek()!;
    if (k.t === "word" && r.peek(1)?.v === "=") {
      r.i += 2;
      const key = paramKeyOf(template, k.v);
      if (!key) throw new CmdError(`A ${TYPE_NAMES[template] ?? template} has no ${k.v}. Its sizes: ${Object.keys(t.params).join(", ")}`);
      params[key] = r.num(`a value for ${k.v}`);
      continue;
    }
    throw new CmdError(`I didn't understand "${k.v}". Try: add ${kind} [TAG] at 5000,3000 rot 90`);
  }
  const base = origin ?? placeAuto(x.w);
  let doc = x.w.doc;
  const made: Ref[] = [];
  for (let i = 0; i < times; i++) {
    const o = add(base, scale(spacing ?? [3000, 0, 0], i));
    const [d, id] = addEquipment(doc, template, o, rot, i === 0 && tag ? tag : undefined);
    doc = updateEquipment(d, id, { params: { ...t.params, ...params }, description: desc ?? (kind === "column" ? "Column" : t.description) });
    made.push(x.w.ref("equipment", doc.equipment.find((e) => e.id === id)!));
  }
  x.commit(doc, times > 1 ? `Add ${names(made)}` : `Add ${made[0].name}`);
  x.it(made);
  x.say(`Added ${names(made)} at ${fmtENU(base)}${times > 1 ? ` (${times} copies)` : ""}`, "ok");
}

function addRackCmd(r: Reader, x: Ctx) {
  const tag = maybeTag(r);
  let origin: V3 | null = null;
  let axis: "x" | "y" = "x";
  let length = 30000;
  let width = 6000;
  let levels = [5000, 7000];
  let bay = 6000;
  while (!r.done) {
    if (r.takeKw("at")) origin = r.position();
    else if (r.takeKw("along")) {
      const t = r.next();
      const d = t.t === "word" ? lookup(DIRS, t.v) : undefined;
      axis = norm(t.v) === "y" || (d && d[1] !== 0) ? "y" : "x";
    } else if (r.takeKw("length")) length = r.num("a length");
    else if (r.takeKw("width")) width = r.num("a width");
    else if (r.takeKw("levels")) {
      const t = r.next();
      levels = t.t === "coord" ? t.nums! : [asNum(t, "levels")];
    } else if (r.peek()?.t === "word" && norm(r.peek()!.v) === "bay") {
      r.i++;
      bay = r.num("a bay length");
    } else throw new CmdError(`I didn't understand "${r.peek()!.v}". Try: add rack at 0,0 along x length 30m levels 5000,7000`);
  }
  let [doc, id] = addRack(x.w.doc, origin ?? [0, 0, 0], axis, length, width, levels);
  doc = updateStructure(doc, id, { bay, ...(tag ? { tag } : {}) });
  const s = doc.structures.find((q) => q.id === id)!;
  x.commit(doc, `Add ${s.tag}`);
  x.it([x.w.ref("structure", s)]);
  x.say(`Added ${s.tag}: ${s.length / 1000} m along ${axis === "x" ? "E-W" : "N-S"}, levels ${s.levels.join(", ")}`, "ok");
}

function addNozzleCmd(r: Reader, x: Ctx) {
  let size: string | null = r.maybeSize();
  let eqRef: Ref | null = null;
  let facing: number | null = null;
  let vertical: "top" | "bottom" | null = null;
  let elev: number | null = null;
  let station: number | null = null;
  let service = "";
  let proj = 200;
  while (!r.done) {
    if (r.takeKw("on")) eqRef = r.ref("equipment");
    else if (r.takeKw("facing")) {
      const v = r.takeKw("top", "bottom");
      if (v) vertical = v as "top" | "bottom";
      else facing = r.angle();
    } else if (r.takeKw("top", "bottom")) vertical = r.toks[r.i - 1] && kw(r.toks[r.i - 1].v) === "bottom" ? "bottom" : "top";
    else if (r.takeKw("elev")) elev = r.num("an elevation");
    else if (r.takeKw("station")) station = r.num("a station");
    else if (r.takeKw("as")) service = r.text("a service");
    else if (r.peek()?.t === "word" && /^proj(ection)?$/i.test(r.peek()!.v)) {
      r.i++;
      r.takeOp("=");
      proj = r.num("a projection");
    } else if (!size && (size = r.maybeSize())) continue;
    else throw new CmdError(`I didn't understand "${r.peek()!.v}". Try: add nozzle 3" on V-101 facing east elev 4000`);
  }
  if (!eqRef || eqRef.type !== "equipment") throw new CmdError('Which equipment? add nozzle 3" on V-101');
  const eq = x.w.eq(eqRef.id)!;
  if (eq.template === "pump") throw new CmdError("Pumps have fixed suction and discharge nozzles");
  let place: NozzlePlace;
  if (eq.template === "vvessel" || eq.template === "tank") {
    place = vertical === "top" ? { kind: "top", dx: 0, dy: 0 } : { kind: "shell", elev: elev ?? (eq.params.skirt ?? 0) + 1000, orient: facing ?? 90 };
  } else {
    const angle = vertical === "bottom" ? 180 : vertical === "top" ? 0 : facing === 0 ? 90 : facing === 180 ? 270 : facing === null ? 0 : -1;
    if (angle < 0) throw new CmdError("On a horizontal drum or exchanger a nozzle faces top, bottom, north or south");
    place = { kind: "hshell", station: station ?? 1000, angle };
  }
  const used = new Set(eq.nozzles.map((n) => n.name));
  let k = eq.nozzles.length + 1;
  while (used.has(`N${k}`)) k++;
  const noz: NozzleDoc = { name: `N${k}`, nps: normalizeNps(size ?? "3"), proj, service, place };
  const doc = updateEquipment(x.w.doc, eq.id, { nozzles: [...eq.nozzles, noz] });
  try {
    computeModel(doc, { clash: false });
  } catch (e) {
    throw new CmdError(`That nozzle does not fit: ${(e as Error).message}`);
  }
  x.commit(doc, `Add nozzle ${eq.tag}.${noz.name}`);
  x.it([eqRef]);
  x.say(`Added ${eq.tag}.${noz.name}, ${noz.nps}" ${service || "nozzle"}`, "ok");
}

function addSystemCmd(r: Reader, x: Ctx) {
  const name = r.text("a system name");
  let parent = (x.w.doc.hierarchy ?? []).find((h) => h.kind === "unit")?.id ?? null;
  if (r.takeKw("in")) {
    const u = r.text("a unit");
    parent = (x.w.doc.hierarchy ?? []).find((h) => norm(h.name) === norm(u))?.id ?? parent;
  }
  r.end_();
  const hierarchy = [...(x.w.doc.hierarchy ?? []), { id: `sys-${Date.now().toString(36)}`, parent, kind: "system" as const, name }];
  x.commit({ ...x.w.doc, hierarchy }, `Add system ${name}`);
  x.say(`Added system ${name}. Put objects in it with: set <objects> system='${name}'`, "ok");
}

function addInlineCmd(r: Reader, x: Ctx, kind: Kind) {
  let type: "gate" | "globe" | "check" | "tee";
  if (kind === "valve") {
    const k = r.peekKind();
    type = k === "gate" || k === "globe" || k === "check" ? (r.i++, k) : "gate";
  } else type = kind as typeof type;
  if (type !== "tee" && r.peekKind() === "valve") r.i++;
  r.takeKw("on");
  const lineRef = r.ref("line");
  if (lineRef.type !== "line") throw new CmdError(`${lineRef.name} is not a line`);
  let at: number | null = null;
  let where: "mid" | "start" | "end" | null = null;
  let branch: V3 | null = null;
  while (!r.done) {
    if (r.takeKw("at")) at = r.num("a distance from the start of the line");
    else if (r.takeKw("mid")) where = "mid";
    else if (r.takeKw("near")) {
      const k = r.takeKw("start", "end");
      if (!k) throw new CmdError("near start or near end");
      where = k as "start" | "end";
    } else if (r.takeKw("start", "end")) where = kw(r.toks[r.i - 1].v) as "start" | "end";
    else if (r.takeKw("branch")) {
      const t = r.next();
      const d = t.t === "word" ? lookup(DIRS, t.v) : undefined;
      if (!d) throw new CmdError("branch east, west, north, south, up or down");
      branch = d;
    } else throw new CmdError(`I didn't understand "${r.peek()!.v}". Try: add ${type}${type === "tee" ? "" : " valve"} on ${lineRef.name} near start`);
  }
  const res = x.w.model.lines.get(lineRef.id);
  if (!res || res.error || !res.legs.length) throw new CmdError(`${lineRef.name} has to route cleanly first`);
  const legs = res.legs;
  let k = 0;
  let s = 0;
  if (at !== null) {
    let rem = at;
    while (k < legs.length - 1 && rem > legs[k].length) rem -= legs[k++].length;
    s = Math.min(rem, legs[k].length);
  } else if (where === "start") s = Math.min(legs[0].length / 2, 900);
  else if (where === "end") {
    k = legs.length - 1;
    s = legs[k].length - Math.min(legs[k].length / 2, 900);
  } else {
    k = legs.reduce((b, g, i) => (g.length > legs[b].length ? i : b), 0);
    s = legs[k].length / 2;
  }
  const { leg, station } = toDocStation(legs, k, s);
  const dir = legs[k].dir;
  const br = type === "tee" ? (branch ?? (Math.abs(dir[2]) > 0.5 ? ([1, 0, 0] as V3) : unit(cross([0, 0, 1], dir)))) : undefined;
  if (br && Math.abs(br[0] * dir[0] + br[1] * dir[1] + br[2] * dir[2]) > 0.01) throw new CmdError("A tee branch must be at right angles to the pipe");
  const [doc, itemId] = addInline(x.w.doc, lineRef.id, { type, leg, station, ...(br ? { branch: br } : {}) });
  const err = lineError(doc, lineRef.id);
  if (err) throw new CmdError(`A ${type} does not fit there (${err.replace(/^.*?: /, "")}). Try another place: at <mm>, mid, near start, near end`);
  const line = doc.lines.find((l) => l.id === lineRef.id)!;
  const list = ordered(line).filter((i) => (type === "tee" ? i.type === "tee" : i.type !== "tee"));
  const label = `${line.number}.${type === "tee" ? "T" : "V"}${list.findIndex((i) => i.id === itemId) + 1}`;
  x.commit(doc, `Add ${type} on ${line.number}`);
  x.it([lineRef]);
  x.say(`Added ${type === "tee" ? "tee" : `${type} valve`} ${label}${type === "tee" ? `. Route its branch with: connect ${label} to <nozzle>` : ""}`, "ok");
}

// ================================================================== PIPING
def({
  verb: "connect",
  group: "Piping",
  syntax: "connect <nozzle|tee> to <nozzle|tee> [size 6\"] [spec A1A] [as 'service'] [number <line no>]",
  summary: "Auto-route a new line between two nozzles (clash-free, prefers the rack)",
  ar: "وصّل نوزلين بخط جديد (الراوتر بيختار المسار)",
  examples: ["connect P-101A.N2 to E-101.N1", "connect 4\"-P-1002.T1 to P-101B.N2 as 'Discharge B'", "وصل P-201A.N2 مع C-201.N4"],
  run(r, x) {
    const a = r.end();
    r.takeKw("to");
    const b = r.end();
    let nps: string | undefined;
    let spec: string | undefined;
    let fluid: string | undefined;
    let number: string | undefined;
    while (!r.done) {
      const sz = r.maybeSize();
      if (sz) nps = sz;
      else if (r.takeKw("spec")) spec = r.text("a spec").toUpperCase();
      else if (r.takeKw("as")) fluid = r.text("a service");
      else if (r.takeKw("number")) number = r.text("a line number");
      else throw new CmdError(`I didn't understand "${r.peek()!.v}"`);
    }
    for (const e of [a, b]) if (!e.free) throw new CmdError(`${e.label} is already connected`);
    if (spec && !SPECS[spec]) throw new CmdError(`No spec ${spec}. Specs: ${Object.keys(SPECS).join(", ")}`);
    const res = autoConnect(x.w.doc, { from: a.ref, to: b.ref, nps, spec, fluid: fluid ?? x.env.newLine?.().fluid, number });
    if (res.error || !res.lineId) throw new CmdError(res.error ?? "No route found");
    const line = res.doc.lines.find((l) => l.id === res.lineId)!;
    x.commit(res.doc, `Connect ${a.label} to ${b.label}`);
    x.it([x.w.ref("line", line)]);
    x.say(`${line.number}: ${res.info}`, "ok");
  },
});

def({
  verb: "route",
  group: "Piping",
  syntax: "route [from] <nozzle | at <where>> [<dir> <mm>]… [to <nozzle> | flanged] [size 6\"] [spec A1A] [as 'service']",
  more: ["route                   start drawing with the mouse", "route from P-101A.N2    start drawing from a nozzle, then type steps: east 2000, up 1500, to E-101.N1, finish"],
  summary: "Draw a pipe by steps; 'to' finishes at a nozzle with the auto-router",
  ar: "ارسم ماسورة بخطوات: شرق 2000 فوق 1500 لحد نوزل",
  examples: ["route from V-101.N2 down 1500 east 3000 to P-101A.N2", "route at 0,-5000,4000 size 4\" east 6m north 3m flanged", "ارسم من P-201A.N2 فوق 2000 شرق 3000"],
  run(r, x) {
    if (r.done) {
      x.env.startRoute?.(null);
      return x.say("Drawing: click a nozzle or a point, or type steps like east 2000, then finish");
    }
    r.takeKw("from");
    const m = x.w.model;
    let start: { ref: EndRef; pos: V3; dir: V3 | null; kind: "open" | "nozzle" | "buttweld" | "flanged"; nps: string | null; label: string };
    const se = r.peekEnd();
    if (se) {
      r.i++;
      if (!se.free) throw new CmdError(`${se.label} is already connected`);
      const res = resolveEnd(se.ref, m)!;
      start = { ref: se.ref, pos: res.pos, dir: res.dir, kind: res.kind as typeof start.kind, nps: res.nps, label: se.label };
    } else {
      r.takeKw("at");
      const p = r.position();
      start = { ref: { kind: "open" }, pos: p, dir: null, kind: "open", nps: null, label: fmtENU(p) };
    }
    const steps: { dir: V3; mm: number }[] = [];
    let to: EndTarget | null = null;
    let endKind: "open" | "flanged" = "open";
    let size: string | null = null;
    let spec = x.env.newLine?.().spec ?? "A1A";
    let fluid: string | undefined;
    let number: string | undefined;
    while (!r.done) {
      const st = r.step();
      if (st) {
        steps.push(st);
        continue;
      }
      if (r.takeKw("to")) to = r.end();
      else if (r.takeKw("flanged")) endKind = "flanged";
      else if (r.takeKw("spec")) spec = r.text("a spec").toUpperCase();
      else if (r.takeKw("as")) fluid = r.text("a service");
      else if (r.takeKw("number")) number = r.text("a line number");
      else if (!(size = r.maybeSize() ?? size)) throw new CmdError(`I didn't understand "${r.peek()!.v}". Steps look like east 2000, up 1.5m, n500`);
    }
    if (!steps.length && !to) {
      if (se && x.env.startRoute) {
        x.env.startRoute(se);
        return x.say(`Drawing from ${se.label}: type steps like east 2000, then "to <nozzle>" or "finish"`);
      }
      throw new CmdError("Give steps (east 2000 up 1500) or a target (to E-101.N1)");
    }
    const nps = size ?? start.nps ?? x.env.newLine?.().nps ?? "4";
    if (start.nps && start.nps !== nps) throw new CmdError(`${start.label} is ${start.nps}", the pipe is ${nps}" (reducers come later)`);
    if (!SPECS[spec]) throw new CmdError(`No spec ${spec}`);
    const full: V3[] = [start.pos];
    for (const s of steps) full.push(addScaled(full[full.length - 1], s.dir, s.mm));
    let endDir: V3 | null = null;
    let endRefKind: "open" | "flanged" | "nozzle" | "buttweld" = endKind;
    if (to) {
      if (!to.free) throw new CmdError(`${to.label} is already connected`);
      const tgt = resolveEnd(to.ref, m)!;
      if (tgt.nps !== nps) throw new CmdError(`${to.label} is ${tgt.nps}", the pipe is ${nps}"`);
      const last = full[full.length - 1];
      const prev = full[full.length - 2];
      const exclude = new Set(m.comps.filter((c) => c.ports.some((p) => isClose(p.pos, tgt.pos, 0.5) || isClose(p.pos, full[0], 0.5))).map((c) => c.uid));
      const ar = autoRoute({
        model: m,
        spec: getSpec(spec),
        nps,
        start: { pos: last, dir: full.length === 1 ? start.dir : null, kind: full.length === 1 ? start.kind : "open", avoid: prev ? unit(sub(last, prev)) : null },
        end: { pos: tgt.pos, dir: neg(tgt.dir), kind: tgt.kind },
        exclude,
      });
      if (!ar) throw new CmdError(`No clash-free way to ${to.label} from the last step`);
      full.push(...ar.path.slice(1));
      endDir = neg(tgt.dir);
      endRefKind = tgt.kind as typeof endRefKind;
    }
    const check = route({ spec: getSpec(spec), owner: "cmd", label: "New pipe", nps, points: full, start: start.kind, end: endRefKind, startDir: start.dir, endDir });
    if (check.error) throw new CmdError(check.error.replace(/^New pipe: /, ""));
    const hasStart = start.ref.kind === "nozzle" || start.ref.kind === "tee";
    const points = full.slice(hasStart ? 1 : 0, to ? -1 : undefined);
    const [doc, id] = addLine(x.w.doc, { nps, spec, fluid: fluid ?? x.env.newLine?.().fluid, number, start: start.ref, end: to ? to.ref : { kind: endKind }, points });
    const line = doc.lines.find((l) => l.id === id)!;
    x.commit(doc, `Route ${line.number}`);
    x.it([x.w.ref("line", line)]);
    const elbows = check.comps.filter((c) => c.kind === "ELBOW").length;
    x.say(`${line.number}: ${steps.length} steps${to ? ` then auto-routed to ${to.label}` : ""}, ${elbows} elbows`, "ok");
  },
});

def({
  verb: "reroute",
  group: "Piping",
  syntax: "reroute <lines | equipment | all>",
  summary: "Route lines again with the auto-router (equipment: every line on it)",
  ar: "اعادة المسار لخطوط (أو كل خطوط معدة)",
  examples: ["reroute P-1002", "reroute P-101A", "reroute lines where errors=yes"],
  run(r, x) {
    const refs = r.refs("lines");
    r.end_();
    const lineIds = new Set<string>();
    for (const ref of refs) {
      if (ref.type === "line") lineIds.add(ref.id);
      if (ref.type === "equipment")
        for (const l of x.w.doc.lines) if ((l.start.kind === "nozzle" && l.start.eq === ref.id) || (l.end.kind === "nozzle" && l.end.eq === ref.id)) lineIds.add(l.id);
    }
    if (!lineIds.size) throw new CmdError("No lines to re-route");
    let doc = x.w.doc;
    const done: string[] = [];
    const failed: string[] = [];
    for (const id of lineIds) {
      const res = reroute(doc, id);
      const n = doc.lines.find((l) => l.id === id)!.number;
      if (res.error) failed.push(n);
      else {
        doc = res.doc;
        done.push(n);
      }
    }
    if (done.length) x.commit(doc, `Re-route ${done.length > 1 ? `${done.length} lines` : done[0]}`);
    x.say(`Re-routed ${done.length} line${done.length === 1 ? "" : "s"}${failed.length ? `; no route for ${failed.join(", ")}` : ""}`, failed.length ? "error" : "ok");
  },
});

def({
  verb: "finish",
  group: "Piping",
  syntax: "finish | flanged",
  summary: "While drawing a pipe: end it open (finish) or with a flange (flanged)",
  ar: "خلّص الماسورة اللي بترسمها",
  examples: ["finish", "flanged"],
  run(_r, x) {
    if (!x.env.routing?.()) throw new CmdError("Nothing is being drawn. Start with: route from P-101A.N2");
    x.env.routeFinish?.(false);
  },
});
def({
  verb: "flanged",
  group: "Piping",
  syntax: "flanged",
  summary: "While drawing a pipe: end it with a flange",
  ar: "خلّص الماسورة بفلانشة",
  examples: ["flanged"],
  run(_r, x) {
    if (!x.env.routing?.()) throw new CmdError("Nothing is being drawn. Start with: route from P-101A.N2");
    x.env.routeFinish?.(true);
  },
});

// ================================================================== EDIT
def({
  verb: "move",
  group: "Edit",
  syntax: "move <objects> <dir> <mm>… | move <objects> to <where>",
  summary: "Move equipment or racks; connected pipes stretch with them",
  ar: "حرّك معدات أو راكات، والمواسير بتتمط معاها",
  examples: ["move P-101A east 500", "move pumps north 1m", "move P-102 to V-101 south 5000", "حرك P-101A شرق 500"],
  run(r, x) {
    const refs = r.refs();
    let off = r.offsets();
    if (!off) {
      if (!r.takeKw("to")) throw new CmdError("Move where? move P-101A east 500, or move P-101A to 4000,6000");
      off = sub(r.position(), x.w.position(refs[0]));
    }
    r.end_();
    let doc = x.w.doc;
    for (const ref of refs) {
      if (ref.type === "equipment") {
        const e = doc.equipment.find((q) => q.id === ref.id)!;
        doc = moveEquipment(doc, ref.id, add(e.origin, off));
      } else if (ref.type === "structure") {
        const s = doc.structures.find((q) => q.id === ref.id)!;
        doc = updateStructure(doc, ref.id, { origin: add(s.origin, off) });
      } else {
        const l = doc.lines.find((q) => q.id === ref.id)!;
        const fixed = (e: EndRef) => e.kind === "nozzle" || e.kind === "tee";
        if (fixed(l.start) || fixed(l.end)) throw new CmdError(`${l.number} is connected; move what it is connected to, or reroute it`);
        doc = updateLine(doc, l.id, { points: l.points.map((p) => add(p, off!)) });
      }
    }
    x.commit(doc, `Move ${names(refs)}`);
    x.it(refs);
    x.say(`Moved ${names(refs)} by ${fmtENU(off).replace(/EL /, "U ")}`, "ok");
  },
});

def({
  verb: "rotate",
  group: "Edit",
  syntax: "rotate <objects> [by] [<deg>]",
  summary: "Turn equipment about its origin (default 90°); racks swap E-W / N-S",
  ar: "لِف معدة بزاوية (90 لو ماحددتش)",
  examples: ["rotate P-102", "rotate P-102 by 180", "لف P-102 90"],
  run(r, x) {
    const refs = r.refs();
    r.takeKw("by");
    const ang = r.done ? 90 : r.angle();
    r.end_();
    let doc = x.w.doc;
    for (const ref of refs) {
      if (ref.type === "equipment") {
        const e = doc.equipment.find((q) => q.id === ref.id)!;
        doc = moveEquipment(doc, ref.id, e.origin, (((e.rot + ang) % 360) + 360) % 360);
      } else if (ref.type === "structure") {
        const s = doc.structures.find((q) => q.id === ref.id)!;
        if (Math.round(ang) % 180 === 90) doc = updateStructure(doc, ref.id, { axis: s.axis === "x" ? "y" : "x" });
      } else throw new CmdError(`${ref.name} is a line; rotate the equipment it connects to`);
    }
    x.commit(doc, `Rotate ${names(refs)}`);
    x.it(refs);
    x.say(`Rotated ${names(refs)} by ${ang}°`, "ok");
  },
});

def({
  verb: "copy",
  group: "Edit",
  syntax: "copy <equipment|racks> [<dir> <mm>… | to <where>] [x<copies>] [as TAG]",
  summary: "Copy equipment or racks; xN makes a row of copies",
  ar: "انسخ معدات (x3 تعمل 3 نسخ ورا بعض)",
  examples: ["copy P-101A east 3000", "copy P-201A east 2500 x3", "copy V-101 to 20000,15000 as V-102", "انسخ P-101A شرق 3000"],
  run(r, x) {
    const refs = r.refs();
    let off: V3 | null = null;
    let target: V3 | null = null;
    let times = 1;
    let tag: string | null = null;
    while (!r.done) {
      const o = r.offsets();
      if (o) off = o;
      else if (r.takeKw("to")) target = r.position();
      else if (r.takeKw("as")) tag = r.text("a tag").toUpperCase();
      else {
        const n = r.takeTimes();
        if (!n) throw new CmdError(`I didn't understand "${r.peek()!.v}"`);
        times = n;
      }
    }
    if (target) off = sub(target, x.w.position(refs[0]));
    off = off ?? [3000, 0, 0];
    if (tag && (refs.length > 1 || times > 1)) throw new CmdError("'as TAG' names a single copy");
    if (tag && x.w.byName(tag)) throw new CmdError(`${tag} already exists`);
    let doc = x.w.doc;
    const made: Ref[] = [];
    for (const ref of refs) {
      for (let i = 1; i <= times; i++) {
        const d = scale(off, i);
        if (ref.type === "equipment") {
          const e = x.w.eq(ref.id)!;
          const [d1, id] = addEquipment(doc, e.template, add(e.origin, d), e.rot, tag ?? undefined);
          doc = updateEquipment(d1, id, { params: { ...e.params }, nozzles: structuredClone(e.nozzles), description: e.description });
          made.push(x.w.ref("equipment", doc.equipment.find((q) => q.id === id)!));
        } else if (ref.type === "structure") {
          const s = x.w.rack(ref.id)!;
          const [d1, id] = addRack(doc, add(s.origin, d), s.axis, s.length, s.width, s.levels);
          doc = updateStructure(d1, id, { bay: s.bay, description: s.description, ...(tag ? { tag } : {}) });
          made.push(x.w.ref("structure", doc.structures.find((q) => q.id === id)!));
        } else throw new CmdError(`${ref.name} is a line: draw a new one with route or connect`);
      }
    }
    x.commit(doc, `Copy ${names(refs)}`);
    x.it(made);
    x.say(`Copied to ${names(made, 8)}`, "ok");
  },
});

def({
  verb: "set",
  group: "Edit",
  syntax: "set <objects | nozzle> <property>=<value> …",
  more: [
    "equipment: tag, desc, rot, e, n, el, and its sizes (D, H, skirt, L, cl, shaftZ, motorL …)",
    "lines: number, spec, nps, fluid, color (yellow, green, blue, orange, teal, purple, pink, lime)",
    "racks: tag, length, width, bay, levels, along · nozzles: nps, service, proj, elev, facing, station",
    "every object: status (working, review, approved, rejected), group, system",
  ],
  summary: "Change properties of one object or a whole set at once",
  ar: "غيّر خصائص: rot=90 أو nps=6 أو status=approved … لعنصر أو لمجموعة",
  examples: ["set P-101A rot=90 desc='Feed pump A'", "set V-101 H=8000 D=2600", "set lines where fluid=Process spec=A1A", "set V-101.N1 nps=6 elev=7500", "set pumps system='Feed pumps'", "خلي P-101A rot=180"],
  run(r, x) {
    const nozzle = r.peekEnd();
    if (nozzle && nozzle.ref.kind === "nozzle") {
      r.i++;
      return setNozzle(r, x, nozzle);
    }
    const refs = r.refs();
    const pairs = r.pairs();
    const before = x.w.model;
    let doc = x.w.doc;
    const meta: { status?: ApprovalStatus; group?: string; system?: string } = {};
    const moved = new Set<string>();
    for (const [key, vals] of pairs) {
      const k = norm(key);
      const t = vals[0];
      if (k === "status") {
        const st = STATUS_WORDS[norm(t.v)];
        if (!st) throw new CmdError("status is working, review, approved or rejected");
        meta.status = st;
        continue;
      }
      if (k === "group") {
        meta.group = t.v;
        continue;
      }
      if (k === "system") {
        const sys = (doc.hierarchy ?? []).find((h) => h.kind === "system" && norm(h.name) === norm(t.v));
        if (!sys) throw new CmdError(`No system "${t.v}". Systems: ${(doc.hierarchy ?? []).filter((h) => h.kind === "system").map((h) => h.name).join(", ")} (add one with: add system '${t.v}')`);
        meta.system = sys.id;
        continue;
      }
      for (const ref of refs) {
        if (ref.type === "equipment") {
          const e = doc.equipment.find((q) => q.id === ref.id)!;
          if (k === "tag" || k === "name") {
            if (x.w.byName(t.v) && t.v.toUpperCase() !== e.tag.toUpperCase()) throw new CmdError(`${t.v} already exists`);
            doc = updateEquipment(doc, e.id, { tag: t.v.toUpperCase() });
          } else if (k === "desc" || k === "description") doc = updateEquipment(doc, e.id, { description: t.v });
          else if (k === "rot" || k === "rotation") {
            doc = updateEquipment(doc, e.id, { rot: asNum(t, "rot") });
            moved.add(e.id);
          } else if (["e", "east", "n", "north", "el", "elevation", "u"].includes(k)) {
            const o = [...e.origin] as [number, number, number];
            o[k.startsWith("e") && k !== "el" && k !== "elevation" ? 0 : k.startsWith("n") ? 1 : 2] = asNum(t, key);
            doc = updateEquipment(doc, e.id, { origin: o });
            moved.add(e.id);
          } else {
            const p = paramKeyOf(e.template, key);
            if (!p) throw new CmdError(`${e.tag} has no property ${key}. Try: tag, desc, rot, e, n, el, ${Object.keys(TEMPLATES[e.template].params).join(", ")}`);
            doc = updateEquipment(doc, e.id, { params: { ...TEMPLATES[e.template].params, ...e.params, [p]: asNum(t, key) } });
            moved.add(e.id);
          }
        } else if (ref.type === "line") {
          const l = doc.lines.find((q) => q.id === ref.id)!;
          if (k === "number" || k === "name" || k === "tag") doc = updateLine(doc, l.id, { number: t.v });
          else if (k === "spec") {
            if (!SPECS[t.v.toUpperCase()]) throw new CmdError(`No spec ${t.v}`);
            doc = updateLine(doc, l.id, { spec: t.v.toUpperCase() });
          } else if (k === "nps" || k === "size") doc = updateLine(doc, l.id, { nps: normalizeNps(String(value(t))) });
          else if (k === "fluid" || k === "service") doc = updateLine(doc, l.id, { fluid: t.v });
          else if (k === "color" || k === "colour") {
            const c = t.t === "num" ? t.n! : COLOR_NAMES[norm(t.v)];
            if (c === undefined) throw new CmdError(`Colours: ${Object.keys(COLOR_NAMES).filter((n) => /^[a-z]/.test(n)).join(", ")}`);
            doc = updateLine(doc, l.id, { color: c });
          } else throw new CmdError(`${l.number} has no property ${key}. Try: number, spec, nps, fluid, color, status, system`);
        } else {
          const s = doc.structures.find((q) => q.id === ref.id)!;
          if (k === "tag" || k === "name") doc = updateStructure(doc, s.id, { tag: t.v.toUpperCase() });
          else if (k === "length" || k === "width" || k === "bay") doc = updateStructure(doc, s.id, { [k]: asNum(t, key) });
          else if (k === "levels") doc = updateStructure(doc, s.id, { levels: t.t === "coord" ? t.nums! : [asNum(t, key)] });
          else if (k === "along" || k === "axis") doc = updateStructure(doc, s.id, { axis: /^(y|n|north|s|south)$/i.test(t.v) ? "y" : "x" });
          else if (k === "e" || k === "n") {
            const o = [...s.origin] as [number, number, number];
            o[k === "e" ? 0 : 1] = asNum(t, key);
            doc = updateStructure(doc, s.id, { origin: o });
          } else throw new CmdError(`${s.tag} has no property ${key}. Try: tag, length, width, bay, levels, along, e, n`);
        }
      }
    }
    if (moved.size) doc = followMovedEnds(doc, before);
    if (Object.keys(meta).length) doc = withMeta(doc, refs, meta, x.env.user());
    x.commit(doc, `Set ${pairs.map(([k]) => k).join(", ")} on ${names(refs, 3)}`);
    x.it(refs);
    const broken = [...x.env.model().lines.values()].filter((l) => l.error).map((l) => l.doc.number);
    x.say(`Changed ${names(refs)}${broken.length ? ` · now not routing: ${broken.join(", ")} (try reroute)` : ""}`, broken.length ? "error" : "ok");
  },
});

function withMeta(doc: PlantDoc, refs: Ref[], patch: { status?: ApprovalStatus; group?: string; system?: string }, user: User): PlantDoc {
  try {
    return setMeta(doc, refs.map((r) => r.id), patch, user);
  } catch (e) {
    if (e instanceof ApprovalError) throw new CmdError(e.message);
    throw e;
  }
}

function setNozzle(r: Reader, x: Ctx, n: EndTarget) {
  if (n.ref.kind !== "nozzle") return;
  const eq = x.w.eq(n.ref.eq)!;
  const noz = eq.nozzles.find((q) => q.name === (n.ref as { nozzle: string }).nozzle)!;
  const patch: Partial<NozzleDoc> = {};
  let place = { ...noz.place } as NozzlePlace;
  for (const [key, vals] of r.pairs()) {
    const k = norm(key);
    const t = vals[0];
    if (k === "nps" || k === "size") patch.nps = normalizeNps(String(value(t)));
    else if (k === "service" || k === "desc") patch.service = t.v;
    else if (k === "proj" || k === "projection") patch.proj = asNum(t, key);
    else if (k === "elev" && place.kind === "shell") place = { ...place, elev: asNum(t, key) };
    else if ((k === "facing" || k === "orient") && place.kind === "shell") {
      const d = lookup(DIRS, t.v);
      place = { ...place, orient: d ? ((Math.round((Math.atan2(d[0], d[1]) * 180) / Math.PI) % 360) + 360) % 360 : asNum(t, key) };
    } else if (k === "station" && place.kind === "hshell") place = { ...place, station: asNum(t, key) };
    else throw new CmdError(`${n.label}: properties are nps, service, proj${noz.place.kind === "shell" ? ", elev, facing" : noz.place.kind === "hshell" ? ", station" : ""}`);
  }
  if (place !== noz.place) patch.place = place;
  const doc = followMovedEnds(updateNozzle(x.w.doc, eq.id, noz.name, patch), x.w.model);
  try {
    computeModel(doc, { clash: false });
  } catch (e) {
    throw new CmdError((e as Error).message);
  }
  x.commit(doc, `Set ${n.label}`);
  x.it([n.owner]);
  x.say(`Changed ${n.label}`, "ok");
}

def({
  verb: "rename",
  group: "Edit",
  syntax: "rename <object> [to] <new name>",
  summary: "Give equipment, a rack or a line a new tag / number",
  ar: "غيّر اسم عنصر",
  examples: ["rename P-102 to P-103", "rename P-1002 4\"-P-1102-A1A"],
  run(r, x) {
    const ref = r.ref();
    r.takeKw("to");
    const name = r.text("the new name");
    r.end_();
    if (x.w.byName(name)) throw new CmdError(`${name} already exists`);
    const doc =
      ref.type === "equipment" ? updateEquipment(x.w.doc, ref.id, { tag: name.toUpperCase() }) : ref.type === "line" ? updateLine(x.w.doc, ref.id, { number: name }) : updateStructure(x.w.doc, ref.id, { tag: name.toUpperCase() });
    x.commit(doc, `Rename ${ref.name} to ${name}`);
    x.say(`${ref.name} is now ${ref.type === "line" ? name : name.toUpperCase()}`, "ok");
  },
});

def({
  verb: "delete",
  group: "Edit",
  syntax: "delete <objects> | delete <line>.V1 | delete <line>.T1",
  summary: "Delete objects, or one valve / tee of a line (connected pipes become open ends)",
  ar: "امسح عناصر، أو بلف/تي من خط",
  examples: ["delete P-102", "delete P-1002.V2", "delete lines where errors=yes", "امسح P-102"],
  run(r, x) {
    const item = r.peekItem();
    if (item) {
      r.i++;
      r.end_();
      x.commit(removeInline(x.w.doc, item.line.id, item.item), `Delete ${item.label}`);
      return x.say(`Deleted ${item.label}`, "ok");
    }
    const refs = r.refs();
    r.end_();
    let doc = x.w.doc;
    for (const ref of refs) doc = deleteObject(doc, { type: ref.type, id: ref.id });
    x.commit(doc, `Delete ${names(refs, 3)}`);
    x.it([]);
    x.say(`Deleted ${names(refs)}`, "ok");
  },
});

// ================================================================== FIND & VIEW
def({
  verb: "find",
  group: "Find & view",
  syntax: "find <objects>",
  summary: "Select objects and zoom to them (also: just type a name)",
  ar: "دوّر على عناصر واختارها وقرّب عليها",
  examples: ["find P-101A", "find pumps", "find lines where nps>=6", "find *-CW-*", "دور C-201"],
  run(r, x) {
    let refs: Ref[];
    try {
      refs = r.refs();
    } catch (e) {
      const t = r.peek();
      const loose = t?.t === "word" && !t.v.includes("*") ? x.w.wildcard(`*${t.v}*`) : [];
      if (!loose.length) throw e;
      r.i++;
      refs = loose;
    }
    r.end_();
    if (!refs.length) return x.say("Nothing matches");
    x.env.select(refs, true);
    x.it(refs);
    x.say(`Found ${refs.length}: ${names(refs, 10)}`);
  },
});

def({
  verb: "select",
  group: "Find & view",
  syntax: "select <objects> | select none",
  summary: "Select objects without moving the view",
  ar: "اختار عناصر",
  examples: ["select pumps", "select none"],
  run(r, x) {
    if (r.takeKw("none")) return x.env.select([], false);
    const refs = r.refs();
    r.end_();
    x.env.select(refs, false);
    x.it(refs);
    x.say(`Selected ${refs.length}: ${names(refs, 10)}`);
  },
});

def({
  verb: "zoom",
  group: "Find & view",
  syntax: "zoom [<objects> | all]",
  summary: "Frame objects in the view (no selection change)",
  ar: "قرّب على عناصر أو على المصنع كله",
  examples: ["zoom", "zoom C-201", "zoom racks"],
  run(r, x) {
    if (r.done || r.takeKw("all")) return x.env.fit?.(null);
    const refs = r.refs();
    r.end_();
    x.env.fit?.(refs);
  },
});

def({
  verb: "view",
  group: "Find & view",
  syntax: "view <iso | iso ne | iso nw | iso se | plan | north | south | east | west>",
  summary: "Standard views",
  ar: "منظر: ايزو، مسقط، شمال، جنوب …",
  examples: ["view iso", "view iso ne", "view plan", "منظر مسقط"],
  run(r, x) {
    const words = [];
    while (!r.done) words.push(r.text("a view"));
    const key = words.join("-") || "iso";
    const v = lookup(VIEWS, key) ?? lookup(VIEWS, words[words.length - 1] ?? "");
    if (!v) throw new CmdError("Views: iso, iso ne, iso nw, iso se, plan, north, south, east, west");
    x.env.view?.(v);
  },
});

const visibility = (mode: "hide" | "show" | "isolate"): Command["run"] =>
  (r, x) => {
    if (mode === "show" && (r.done || r.takeKw("all"))) {
      x.env.visibility?.("all", []);
      return x.say("Showing everything");
    }
    const refs = r.refs();
    r.end_();
    x.env.visibility?.(mode, refs.map((q) => q.id));
    if (mode === "isolate") x.env.fit?.(refs);
    x.say(`${mode === "hide" ? "Hidden" : mode === "show" ? "Showing" : "Showing only"} ${names(refs)}`);
  };
def({ verb: "show", group: "Find & view", syntax: "show <objects> | show all", summary: "Show hidden objects", ar: "اظهر عناصر مخفية", examples: ["show all", "show racks"], run: visibility("show") });
def({ verb: "hide", group: "Find & view", syntax: "hide <objects>", summary: "Hide objects from the view", ar: "اخفي عناصر", examples: ["hide racks", "hide T-101", "hide lines where spec=A1A"], run: visibility("hide") });
def({ verb: "isolate", group: "Find & view", syntax: "isolate <objects>", summary: "Show only these objects (show all brings everything back)", ar: "اعرض العناصر دي بس", examples: ["isolate C-201 and D-201", "isolate lines where nps>=6"], run: visibility("isolate") });

def({
  verb: "color",
  group: "Find & view",
  syntax: "color by <status | line>",
  summary: "Colour the model by approval status or by line",
  ar: "لوّن حسب حالة الاعتماد أو حسب الخط",
  examples: ["color by status", "color by line", "لون حسب status"],
  run(r, x) {
    r.takeKw("by");
    if (r.peek() && norm(r.peek()!.v) === "حسب") r.i++;
    const w = r.done ? "line" : norm(r.text("status or line"));
    x.env.colorBy?.(w.startsWith("stat") || w === "حاله" ? "status" : "line");
  },
});

def({
  verb: "labels",
  group: "Find & view",
  syntax: "labels [on | off]",
  summary: "Name labels in the view",
  ar: "اسامي العناصر في المنظر",
  examples: ["labels on", "labels off"],
  run(r, x) {
    const t = r.peek();
    const on = !t ? null : norm(t.v) === "on" || kw(t.v) === "yes" ? true : kw(t.v) === "off" ? false : null;
    if (t) r.i++;
    x.env.labels?.(on);
  },
});

def({
  verb: "section",
  group: "Find & view",
  syntax: "section <objects> | section off",
  summary: "Section box around objects",
  ar: "اقطع المنظر حوالين عناصر",
  examples: ["section C-201", "section off"],
  run(r, x) {
    if (r.takeKw("off", "none")) return x.env.section?.(null);
    const refs = r.refs();
    r.end_();
    x.env.section?.(refs);
  },
});

// ================================================================== CHECK & DATA
def({
  verb: "info",
  group: "Check & data",
  syntax: "info <object | nozzle>",
  summary: "Everything about one object",
  ar: "كل بيانات عنصر",
  examples: ["info P-101A", "info P-1002", "info V-101.N2", "معلومات C-201"],
  run(r, x) {
    const e = r.peekEnd();
    if (e) {
      r.i++;
      const res = resolveEnd(e.ref, x.w.model);
      x.say(`${e.label}  ${e.nps}"  ${e.free ? "free" : "connected"}${res ? `  at ${fmtENU(res.pos)} facing ${dirWord(res.dir)}` : ""}`);
      if (e.ref.kind === "nozzle") {
        const noz = x.w.eq(e.ref.eq)!.nozzles.find((n) => n.name === (e.ref as { nozzle: string }).nozzle)!;
        x.say(`  service ${noz.service || "-"} · projection ${noz.proj} mm`);
      }
      return;
    }
    const refs = r.refs();
    r.end_();
    for (const ref of refs.slice(0, 5)) info(x, ref);
  },
});

function dirWord(d: V3): string {
  const [best] = [["east", [1, 0, 0]], ["west", [-1, 0, 0]], ["north", [0, 1, 0]], ["south", [0, -1, 0]], ["up", [0, 0, 1]], ["down", [0, 0, -1]]].sort(
    (a, b) => (b[1] as number[]).reduce((s, v, i) => s + v * d[i], 0) - (a[1] as number[]).reduce((s, v, i) => s + v * d[i], 0),
  );
  return best[0] as string;
}

function info(x: Ctx, ref: Ref) {
  const w = x.w;
  const meta = (ref.type === "equipment" ? w.eq(ref.id) : ref.type === "line" ? w.line(ref.id) : w.rack(ref.id))?.meta;
  const status = `${meta?.status ?? "Working"} · rev ${meta?.rev ?? 1} · ${meta?.group ?? "-"} · system ${w.systemName(meta?.system)}`;
  if (ref.type === "equipment") {
    const e = w.eq(ref.id)!;
    const p = { ...TEMPLATES[e.template].params, ...e.params };
    x.say(`${e.tag}  ${TYPE_NAMES[e.template]}  "${e.description}"`);
    x.say(`  at ${fmtENU(e.origin)} · rotation ${e.rot}° · ${Object.entries(p).map(([k, v]) => `${k}=${v}`).join(" ")}`);
    x.say(`  nozzles ${e.nozzles.map((n) => `${n.name} ${n.nps}"${n.service ? ` ${n.service}` : ""}${w.ends().find((q) => q.label === `${e.tag}.${n.name}`)?.free ? " (free)" : ""}`).join(" · ")}`);
    x.say(`  ${status}`);
  } else if (ref.type === "line") {
    const l = w.line(ref.id)!;
    const res = w.model.lines.get(ref.id);
    const count = (k: string) => res?.comps.filter((c) => c.kind === k).length ?? 0;
    x.say(`${l.number}  ${l.nps}" ${l.spec}  "${l.fluid}"`);
    x.say(`  from ${w.endLabel(l.start)} to ${w.endLabel(l.end)} · pipe ${((res?.pipeLength ?? 0) / 1000).toFixed(2)} m · ${count("ELBOW")} elbows · ${count("VALVE")} valves · ${count("TEE")} tees · ${count("SUPPORT")} shoes`);
    if (res?.error) x.say(`  not routing: ${res.error}`, "error");
    x.say(`  ${status}`);
  } else {
    const s = w.rack(ref.id)!;
    x.say(`${s.tag}  rack ${s.length / 1000} m × ${s.width / 1000} m along ${s.axis === "x" ? "E-W" : "N-S"} · levels ${s.levels.join(", ")} · bay ${s.bay}`);
    x.say(`  from ${fmtENU(s.origin)} · ${status}`);
  }
}

def({
  verb: "list",
  group: "Check & data",
  syntax: "list <objects> [where …] | list valves [on <line>] | list nozzles [on <equipment>] | list free nozzles | list systems | list reports",
  summary: "A table in the command window",
  ar: "جدول بالعناصر",
  examples: ["list pumps", "list lines where nps>=6", "list free nozzles", "list valves on P-1002", "list systems", "قائمة خطوط"],
  run(r, x) {
    const w = x.w;
    if (r.takeKw("free")) {
      if (r.peekKind() === "nozzle") r.i++;
      const ends = w.ends().filter((e) => e.free);
      return x.table(["NOZZLE / BRANCH", "NPS", "OWNER"], ends.map((e) => [e.label, `${e.nps}"`, e.owner.name]), 60);
    }
    const kind = r.peekKind();
    if (kind === "nozzle") {
      r.i++;
      let ends = w.ends().filter((e) => e.ref.kind === "nozzle");
      if (r.takeKw("on")) {
        const owner = r.ref("equipment");
        ends = ends.filter((e) => e.owner.id === owner.id);
      }
      return x.table(["NOZZLE", "NPS", "STATE"], ends.map((e) => [e.label, `${e.nps}"`, e.free ? "free" : "connected"]), 80);
    }
    if (kind === "valve" || kind === "gate" || kind === "globe" || kind === "check" || kind === "tee") {
      r.i++;
      if (kind !== "valve" && kind !== "tee" && r.peekKind() === "valve") r.i++;
      let lines = w.doc.lines;
      if (r.takeKw("on")) {
        const lr = r.ref("line");
        lines = lines.filter((l) => l.id === lr.id);
      }
      const rows: unknown[][] = [];
      for (const l of lines) {
        let v = 0;
        let t = 0;
        for (const i of ordered(l)) {
          const name = i.type === "tee" ? `${l.number}.T${++t}` : `${l.number}.V${++v}`;
          if (kind === "tee" ? i.type === "tee" : kind === "valve" ? i.type !== "tee" : i.type === kind) rows.push([name, i.type, `${l.nps}"`]);
        }
      }
      return x.table(["ITEM", "TYPE", "NPS"], rows, 80);
    }
    if (kind === "system") {
      r.i++;
      const sys = (w.doc.hierarchy ?? []).filter((h) => h.kind === "system");
      return x.table(["SYSTEM", "OBJECTS"], sys.map((s) => [s.name, w.all().filter((q) => w.attr(q, "system") === s.name).length]));
    }
    if (r.peek() && /^reports?$/i.test(r.peek()!.v)) {
      r.i++;
      return x.table(["REPORT"], REPORTS.map((q) => [q.name]));
    }
    const refs = r.refs();
    r.end_();
    tableOf(x, refs);
  },
});

function tableOf(x: Ctx, refs: Ref[]) {
  const w = x.w;
  const types = new Set(refs.map((q) => q.type));
  if (types.size === 1 && types.has("line"))
    return x.table(
      ["LINE", "NPS", "SPEC", "FROM", "TO", "PIPE m", "ELB", "VLV", "STATUS"],
      refs.map((q) => [q.name, `${w.line(q.id)!.nps}"`, w.attr(q, "spec"), w.attr(q, "from"), w.attr(q, "to"), w.attr(q, "length"), w.attr(q, "elbows"), w.attr(q, "valves"), w.attr(q, "status")]),
      80,
    );
  if (types.size === 1 && types.has("equipment"))
    return x.table(
      ["TAG", "TYPE", "E", "N", "EL", "ROT", "STATUS"],
      refs.map((q) => [q.name, w.kindName(q), w.attr(q, "e"), w.attr(q, "n"), w.attr(q, "el"), w.attr(q, "rot"), w.attr(q, "status")]),
      80,
    );
  return x.table(["NAME", "TYPE", "STATUS", "SYSTEM"], refs.map((q) => [q.name, w.kindName(q), w.attr(q, "status"), w.attr(q, "system")]), 80);
}

def({
  verb: "count",
  group: "Check & data",
  syntax: "count <objects> [where …] | count valves | count free nozzles",
  summary: "How many",
  ar: "عدد العناصر",
  examples: ["count lines where nps>=6", "count valves", "count free nozzles", "كام خطوط"],
  run(r, x) {
    const w = x.w;
    if (r.takeKw("free")) {
      if (r.peekKind() === "nozzle") r.i++;
      return x.say(`${w.ends().filter((e) => e.free).length} free nozzles / branches`);
    }
    const k = r.peekKind();
    if (k === "valve" || k === "tee") {
      r.i++;
      const n = w.doc.lines.reduce((s, l) => s + l.inline.filter((i) => (k === "tee" ? i.type === "tee" : i.type !== "tee")).length, 0);
      return x.say(`${n} ${k === "tee" ? "tees" : "valves"}`);
    }
    if (k === "nozzle") {
      r.i++;
      return x.say(`${w.ends().filter((e) => e.ref.kind === "nozzle").length} nozzles`);
    }
    const refs = r.refs();
    r.end_();
    const by = new Map<string, number>();
    for (const q of refs) by.set(w.kindName(q), (by.get(w.kindName(q)) ?? 0) + 1);
    x.say(`${refs.length}${by.size > 1 || refs.length ? `: ${[...by].map(([k2, n]) => `${n} ${k2}${n > 1 ? "s" : ""}`).join(", ")}` : ""}`);
  },
});

def({
  verb: "measure",
  group: "Check & data",
  syntax: "measure <object | nozzle | E,N,EL> to <object | nozzle | E,N,EL>",
  summary: "Distance between two things, and the clear gap between objects",
  ar: "قيس المسافة بين حاجتين (والخلوص بينهم)",
  examples: ["measure P-101A to P-101B", "measure V-101.N2 to P-101A.N1", "قيس C-201 الى T-101"],
  run(r, x) {
    const a = point(r, x);
    r.takeKw("to");
    const b = point(r, x);
    r.end_();
    const d = sub(b.p, a.p);
    let text = `ΔE ${Math.round(d[0])} ΔN ${Math.round(d[1])} ΔU ${Math.round(d[2])} · direct ${Math.round(dist(a.p, b.p))} mm · in plan ${Math.round(Math.hypot(d[0], d[1]))} mm`;
    if (a.ref && b.ref) {
      const box = (q: Ref) => shapesAABB(x.w.model.comps.filter((c) => c.owner.id === q.id).flatMap((c) => c.shapes));
      const ba = box(a.ref);
      const bb = box(b.ref);
      if (ba && bb) {
        const g = [0, 1, 2].map((k) => Math.max(0, ba.lo[k] - bb.hi[k], bb.lo[k] - ba.hi[k]));
        text += ` · clear gap ${Math.round(Math.hypot(g[0], g[1], g[2]))} mm`;
      }
    }
    x.say(text);
  },
});

function point(r: Reader, x: Ctx): { p: V3; ref: Ref | null } {
  const e = r.peekEnd();
  if (e) {
    r.i++;
    return { p: resolveEnd(e.ref, x.w.model)?.pos ?? x.w.position(e.owner), ref: null };
  }
  const t = r.peek();
  if (t?.t === "coord") return { p: r.position(), ref: null };
  const ref = r.ref();
  return { p: x.w.position(ref), ref };
}

def({
  verb: "check",
  group: "Check & data",
  syntax: "check",
  summary: "Health of the model: clashes, routing errors, open ends, free nozzles, approvals",
  ar: "افحص الموديل كله",
  examples: ["check", "افحص"],
  run(r, x) {
    r.end_();
    const m = x.w.model;
    const clashes = (x.env.clash?.(null) ?? m.clashes ?? []).filter((c) => c.hard);
    const errors = m.todo.filter((t) => t.level === "error");
    const warnings = m.todo.filter((t) => t.level !== "error");
    const free = x.w.ends().filter((e) => e.free).length;
    const notApproved = x.w.all().filter((q) => x.w.attr(q, "status") !== "Approved").length;
    x.say(`${clashes.length} hard clashes · ${errors.length} errors · ${warnings.length} warnings · ${free} free nozzles · ${notApproved} of ${x.w.all().length} objects not approved`, clashes.length || errors.length ? "error" : "ok");
    for (const t of [...errors, ...warnings].slice(0, 6)) x.say(`  ${t.level === "error" ? "✗" : "!"} ${t.text}`);
  },
});

def({
  verb: "clash",
  group: "Check & data",
  syntax: "clash [<clearance mm>]",
  summary: "Run the clash check (optionally with a clearance) and list the clashes",
  ar: "شغّل فحص التصادم",
  examples: ["clash", "clash 50"],
  run(r, x) {
    const cl = r.done ? null : r.num("a clearance in mm");
    r.end_();
    const list = x.env.clash?.(cl) ?? x.w.model.clashes ?? [];
    const owner = (uid: string) => x.w.model.byUid.get(uid)?.owner.id ?? "";
    const nameOf = (uid: string) => x.w.all().find((q) => q.id === owner(uid))?.name ?? uid;
    const hard = list.filter((c) => c.hard);
    x.say(`${hard.length} hard clashes${cl ? `, ${list.length - hard.length} within ${cl} mm` : ""}`, hard.length ? "error" : "ok");
    for (const c of list.slice(0, 8)) x.say(`  ${c.hard ? "HARD" : "near"}  ${nameOf(c.a)} × ${nameOf(c.b)} at ${fmtENU(c.point)}`);
  },
});

const status = (st: ApprovalStatus, verb: string): Command["run"] =>
  (r, x) => {
    const refs = r.refs();
    r.end_();
    x.commit(withMeta(x.w.doc, refs, { status: st }, x.env.user()), `${verb} ${names(refs, 3)}`);
    x.it(refs);
    x.say(`${st}: ${names(refs)}`, "ok");
  };
def({ verb: "approve", group: "Check & data", syntax: "approve <objects>", summary: "Set status Approved (locks them; editors only)", ar: "اعتمد عناصر (بتتقفل)", examples: ["approve P-101A", "approve lines where errors=no"], run: status("Approved", "Approve") });
def({ verb: "submit", group: "Check & data", syntax: "submit <objects>", summary: "Send for review (status In Review)", ar: "قدّم للمراجعة", examples: ["submit pumps"], run: status("In Review", "Submit") });
def({ verb: "reject", group: "Check & data", syntax: "reject <objects>", summary: "Set status Rejected (editors only)", ar: "ارفض", examples: ["reject P-1002"], run: status("Rejected", "Reject") });
def({ verb: "reopen", group: "Check & data", syntax: "reopen <objects>", summary: "Back to Working (unlocks approved objects; editors only)", ar: "افتح للتعديل تاني", examples: ["reopen T-101"], run: status("Working", "Reopen") });

def({
  verb: "sql",
  group: "Check & data",
  syntax: "sql <SELECT …>",
  summary: "Read-only SQL on the plant database",
  ar: "استعلام SQL على قاعدة البيانات",
  examples: ["sql SELECT tag, template FROM equipment", "sql SELECT nps, COUNT(*) FROM line GROUP BY nps"],
  run(r, x) {
    const q = r.restRaw();
    if (!q) throw new CmdError("sql SELECT …");
    if (!x.env.sql) throw new CmdError("The database is not open");
    const res = x.env.sql(q);
    x.table(res.columns, res.rows, 25);
  },
});

def({
  verb: "report",
  group: "Check & data",
  syntax: "report <name>",
  summary: "Run a saved report (list reports shows them)",
  ar: "شغّل تقرير جاهز",
  examples: ["report line list", "report valve list", "report free nozzles"],
  run(r, x) {
    const name = norm(r.restRaw());
    if (!name) return x.table(["REPORT"], REPORTS.map((q) => [q.name]));
    const rep = REPORTS.find((q) => norm(q.name) === name) ?? REPORTS.find((q) => norm(q.name).startsWith(name)) ?? REPORTS.find((q) => norm(q.name).includes(name));
    if (!rep) throw new CmdError(`No report "${name}". Reports: ${REPORTS.map((q) => q.name).join(", ")}`);
    if (!x.env.sql) throw new CmdError("The database is not open");
    const res = x.env.sql(rep.sql);
    x.say(rep.name);
    x.table(res.columns, res.rows, 25);
  },
});

// ================================================================== OUTPUT
def({
  verb: "iso",
  group: "Output",
  syntax: "iso <line>",
  summary: "Open the isometric of a line",
  ar: "افتح الأيزومتريك لخط",
  examples: ["iso P-1002"],
  run(r, x) {
    const ref = r.ref("line");
    r.end_();
    if (ref.type !== "line") throw new CmdError(`${ref.name} is not a line`);
    x.env.iso?.(ref.id);
  },
});

def({
  verb: "export",
  group: "Output",
  syntax: "export <zip [line] | mto | json | ifc | png | database | reports>",
  summary: "Download files: package zip (PCF, DXF, SVG, MTO), MTO csv, model, IFC input, screenshot, database",
  ar: "صدّر ملفات",
  examples: ["export zip", "export zip P-1002", "export mto", "export database"],
  run(r, x) {
    const k = norm(r.text("what to export"));
    const map: Record<string, string> = { zip: "zip", package: "zip", pcf: "zip", dxf: "zip", mto: "csv", csv: "csv", json: "json", model: "json", ifc: "toml", toml: "toml", png: "png", image: "png", screenshot: "png", database: "sqlite", db: "sqlite", sqlite: "sqlite", backup: "sqlite", reports: "reports" };
    const kind = map[k];
    if (!kind) throw new CmdError("export zip, mto, json, ifc, png, database or reports");
    const ref = r.done ? null : r.ref("line");
    x.env.exportFile?.(kind, ref);
  },
});

def({
  verb: "save",
  group: "Output",
  syntax: "save",
  summary: "Save (to your account, or to the shared plant automatically)",
  ar: "احفظ",
  examples: ["save"],
  run(_r, x) {
    x.env.save?.();
  },
});

// ================================================================== SESSION
def({
  verb: "undo",
  group: "Session",
  syntax: "undo [<n>] · redo [<n>]",
  summary: "Undo / redo the last n transactions",
  ar: "تراجع",
  examples: ["undo", "undo 3", "redo"],
  run(r, x) {
    x.env.undo?.(r.done ? 1 : r.int("how many"));
  },
});
def({ verb: "redo", group: "Session", syntax: "redo [<n>]", summary: "Redo", ar: "رجّع اللي اتلغى", examples: ["redo"], run: (r, x) => x.env.redo?.(r.done ? 1 : r.int("how many")) });
def({ verb: "again", group: "Session", syntax: "again", summary: "Run the last command again", ar: "كرر آخر أمر", examples: ["again"], run: () => {} });
def({
  verb: "macro",
  group: "Session",
  syntax: "macro <name> <commands; …>  ($1 $2 … are the words after the name when it runs)",
  more: ["macro <name>        show it", "macro delete <name>", "macros              list them", "<name> [words]      run it (or: run <name>)"],
  summary: "Save a sequence of commands under a new name",
  ar: "احفظ مجموعة أوامر باسم وشغلها بعدين",
  examples: ["macro pumpset add pump at $1 x2 spacing 2500 east; add pump at $1 north 4000", "pumpset 50000,0"],
  run: () => {},
});
def({ verb: "macros", group: "Session", syntax: "macros", summary: "List saved macros", ar: "الماكروز المحفوظة", examples: ["macros"], run: (_r, x) => x.table(["MACRO", "COMMANDS"], Object.entries(x.macros).map(([k, v]) => [k, v])) });
def({ verb: "run", group: "Session", syntax: "run <macro> [words]", summary: "Run a macro", ar: "شغّل ماكرو", examples: ["run pumpset 50000,0"], run: () => {} });
def({
  verb: "history",
  group: "Session",
  syntax: "history",
  summary: "Commands typed in this session",
  ar: "الأوامر اللي اتكتبت",
  examples: ["history"],
  run(_r, x) {
    for (const h of (x.env.history?.() ?? []).slice(-20)) x.say(`  ${h}`);
  },
});
def({ verb: "clear", group: "Session", syntax: "clear", summary: "Clear the command window", ar: "نضّف شاشة الأوامر", examples: ["clear"], run: (_r, x) => x.env.clear?.() });
def({
  verb: "help",
  group: "Session",
  syntax: "help [<command>]",
  summary: "Commands, or one command in detail",
  ar: "المساعدة",
  examples: ["help", "help add", "help connect"],
  run(r, x) {
    if (!r.done) {
      const v = lookup(VERBS, r.text("a command"));
      const c = COMMANDS.find((q) => q.verb === v);
      if (!c) throw new CmdError("No such command. Type help for the list");
      x.say(`${c.syntax}`);
      for (const m of c.more ?? []) x.say(`  ${m}`);
      x.say(`  ${c.summary} · ${c.ar}`);
      x.say(`  e.g.  ${c.examples.join("   ·   ")}`);
      return;
    }
    const groups = [...new Set(COMMANDS.map((c) => c.group))];
    for (const g of groups) x.say(`${g}: ${COMMANDS.filter((c) => c.group === g && c.verb !== "flanged").map((c) => c.verb).join(" · ")}`);
    x.say("Objects: P-101A · nozzles P-101A.N2 · tees 4\"-P-1002.T1 · valves P-1002.V1 · it · selection · pumps · lines where nps>=6 · P-10*");
    x.say("Places: 5000,3000[,EL] · e5000 n3000 · V-101 east 4000 · steps east 500 / up 1.5m / s200 · chain with ; or then");
    x.say("Arabic works too: ضيف طلمبة عند 5000,3000 · حرك P-101A شرق 500 · وصل P-101A.N2 مع E-101.N1 · help <command> for details");
  },
});
