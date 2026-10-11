// Pure document edits. Every function returns a new document (the store keeps the old one for undo).

import { autoRoute } from "./autoroute";
import { normalizeNps } from "./catalog";
import { Model, computeModel, linePath, resolveEnd } from "./compute";
import type { EndRef, EquipmentDoc, LineDoc, NozzleDoc, PlantDoc, StructureDoc, TemplateId } from "./doc";
import { TEMPLATES } from "./equipment";
import { InlineItem } from "./routing";
import { getSpec } from "./spec";
import { V3, add, dist, dot, isClose, neg, scale, sub } from "./vec";

export type ObjRef = { type: "equipment" | "line" | "structure"; id: string };

const clone = <T>(x: T): T => structuredClone(x);

function bumpSeq(doc: PlantDoc): [number, PlantDoc] {
  return [doc.seq, { ...doc, seq: doc.seq + 1 }];
}

export function nextTag(doc: PlantDoc, prefix: string): string {
  const used = new Set([...doc.equipment.map((e) => e.tag), ...doc.structures.map((s) => s.tag)]);
  for (let n = 101; ; n++) {
    const tag = `${prefix}-${n}`;
    if (!used.has(tag) && !used.has(`${tag}A`)) return tag;
  }
}

export function nextLineNumber(doc: PlantDoc, nps: string, spec: string, service = "P"): string {
  const used = new Set(doc.lines.map((l) => l.number));
  for (let n = 1001; ; n++) {
    const num = `${nps}"-${service}-${n}-${spec}`;
    if (![...used].some((u) => u.includes(`-${n}-`))) return num;
  }
}

export function addEquipment(doc: PlantDoc, template: TemplateId, origin: V3, rot = 0, tag?: string): [PlantDoc, string] {
  const t = TEMPLATES[template];
  const [seq, d] = bumpSeq(doc);
  const eq: EquipmentDoc = {
    id: `EQ${seq}`,
    tag: tag ?? nextTag(doc, t.prefix),
    template,
    description: t.description,
    origin,
    rot,
    params: { ...t.params },
    nozzles: clone(t.nozzles),
  };
  return [{ ...d, equipment: [...d.equipment, eq] }, eq.id];
}

export function updateEquipment(doc: PlantDoc, id: string, patch: Partial<EquipmentDoc>): PlantDoc {
  return { ...doc, equipment: doc.equipment.map((e) => (e.id === id ? { ...e, ...patch } : e)) };
}

export function updateNozzle(doc: PlantDoc, eqId: string, name: string, patch: Partial<NozzleDoc>): PlantDoc {
  return {
    ...doc,
    equipment: doc.equipment.map((e) => (e.id === eqId ? { ...e, nozzles: e.nozzles.map((n) => (n.name === name ? { ...n, ...patch } : n)) } : e)),
  };
}

export function addNozzle(doc: PlantDoc, eqId: string): PlantDoc {
  return {
    ...doc,
    equipment: doc.equipment.map((e) => {
      if (e.id !== eqId) return e;
      const names = new Set(e.nozzles.map((n) => n.name));
      let k = e.nozzles.length + 1;
      while (names.has(`N${k}`)) k++;
      const vertical = e.template === "vvessel" || e.template === "tank";
      const n: NozzleDoc = {
        name: `N${k}`,
        nps: "3",
        proj: 200,
        service: "",
        place: vertical ? { kind: "shell", elev: (e.params.skirt ?? 0) + 1000, orient: 90 } : { kind: "hshell", station: 1000, angle: 0 },
      };
      if (e.template === "pump") return e;
      return { ...e, nozzles: [...e.nozzles, n] };
    }),
  };
}

/**
 * Keep a line attached when one of its ends moves by `delta` (E3D-style stretch). The end moves; each
 * following point absorbs only the part of the move that its leg cannot take up by changing length,
 * so every leg keeps its direction. Works on the full path; `otherFixed` stops at the far end.
 */
export function stretch(full: V3[], fromStart: boolean, delta: V3, otherFixed: boolean): V3[] {
  const pts = fromStart ? [...full] : [...full].reverse();
  const out = [...pts];
  out[0] = add(pts[0], delta);
  let d = delta;
  for (let i = 1; i < pts.length; i++) {
    const leg = sub(pts[i], pts[i - 1]);
    const l = Math.hypot(...leg);
    if (l < 1e-6) break;
    const u = scale(leg, 1 / l);
    d = sub(d, scale(u, dot(d, u)));
    if (Math.hypot(...d) < 1e-6) break;
    if (i === pts.length - 1 && otherFixed) break; // cannot move: the route will report the broken leg
    out[i] = add(pts[i], d);
  }
  return fromStart ? out : out.reverse();
}

/** Re-attach lines whose connected ends moved (equipment moved, or the tee they branch from moved). */
export function followMovedEnds(doc: PlantDoc, before: Model): PlantDoc {
  let cur = doc;
  let prev = before;
  for (let pass = 0; pass < 3; pass++) {
    const after = computeModel(cur, { clash: false });
    let changed = false;
    const lines = cur.lines.map((line) => {
      const b = linePath(line, prev);
      const a = linePath(line, after);
      const ds = b.s && a.s ? sub(a.s.pos, b.s.pos) : null;
      const de = b.e && a.e ? sub(a.e.pos, b.e.pos) : null;
      const movedS = !!ds && Math.hypot(...ds) > 0.01;
      const movedE = !!de && Math.hypot(...de) > 0.01;
      if (!movedS && !movedE) return line;
      changed = true;
      let full = b.path;
      if (movedS && movedE && isClose(ds!, de!, 0.01)) full = full.map((p) => add(p, ds!));
      else {
        if (movedS) full = stretch(full, true, ds!, !!b.e && !movedE);
        if (movedE) full = stretch(full, false, de!, !!b.s);
      }
      return { ...line, points: full.slice(b.s ? 1 : 0, b.e ? full.length - 1 : full.length) };
    });
    cur = { ...cur, lines };
    if (!changed) break;
    prev = after;
  }
  return cur;
}

export function moveEquipment(doc: PlantDoc, id: string, origin: V3, rot?: number): PlantDoc {
  const before = computeModel(doc, { clash: false });
  const moved = updateEquipment(doc, id, rot === undefined ? { origin } : { origin, rot });
  return followMovedEnds(moved, before);
}

export function updateStructure(doc: PlantDoc, id: string, patch: Partial<StructureDoc>): PlantDoc {
  return { ...doc, structures: doc.structures.map((s) => (s.id === id ? { ...s, ...patch } : s)) };
}

export function addRack(doc: PlantDoc, origin: V3, axis: "x" | "y", length: number, width = 6000, levels = [5000, 7000]): [PlantDoc, string] {
  const [seq, d] = bumpSeq(doc);
  const st: StructureDoc = {
    id: `ST${seq}`,
    tag: nextTag(doc, "PR"),
    type: "rack",
    description: "",
    origin,
    axis,
    length: Math.max(1000, Math.round(length / 100) * 100),
    width,
    bay: 6000,
    levels,
  };
  return [{ ...d, structures: [...d.structures, st] }, st.id];
}

export function addLine(doc: PlantDoc, init: Partial<LineDoc> & { nps: string; spec?: string }): [PlantDoc, string] {
  const [seq, d] = bumpSeq(doc);
  const spec = init.spec ?? "A1A";
  const nps = normalizeNps(init.nps);
  const line: LineDoc = {
    id: `L${seq}`,
    number: init.number ?? nextLineNumber(doc, nps, spec),
    spec,
    nps,
    fluid: init.fluid ?? "Process",
    color: init.color ?? doc.lines.length % 8,
    start: init.start ?? { kind: "open" },
    end: init.end ?? { kind: "open" },
    points: init.points ?? [],
    inline: init.inline ?? [],
  };
  return [{ ...d, lines: [...d.lines, line] }, line.id];
}

export function updateLine(doc: PlantDoc, id: string, patch: Partial<LineDoc>): PlantDoc {
  return { ...doc, lines: doc.lines.map((l) => (l.id === id ? { ...l, ...patch } : l)) };
}

export function addInline(doc: PlantDoc, lineId: string, item: Omit<InlineItem, "id">): [PlantDoc, string] {
  const [seq, d] = bumpSeq(doc);
  const id = `I${seq}`;
  return [updateLine(d, lineId, { inline: [...d.lines.find((l) => l.id === lineId)!.inline, { ...item, id }] }), id];
}

export function removeInline(doc: PlantDoc, lineId: string, itemId: string): PlantDoc {
  let d = updateLine(doc, lineId, { inline: doc.lines.find((l) => l.id === lineId)!.inline.filter((i) => i.id !== itemId) });
  const model = computeModel(doc, { clash: false });
  // branches that started at a removed tee become open ends where the tee was
  d = {
    ...d,
    lines: d.lines.map((l) => {
      if (l.start.kind === "tee" && l.start.line === lineId && l.start.item === itemId) {
        const r = resolveEnd(l.start, model);
        return { ...l, start: { kind: "open" } as EndRef, points: r ? [r.pos, ...l.points] : l.points };
      }
      return l;
    }),
  };
  return d;
}

export function deleteObject(doc: PlantDoc, ref: ObjRef): PlantDoc {
  const model = computeModel(doc, { clash: false });
  const detach = (l: LineDoc): LineDoc => {
    let next = l;
    const hit = (r: EndRef) =>
      (ref.type === "equipment" && r.kind === "nozzle" && r.eq === ref.id) || (ref.type === "line" && r.kind === "tee" && r.line === ref.id);
    if (hit(l.start)) {
      const r = resolveEnd(l.start, model);
      next = { ...next, start: { kind: "flanged" }, points: r ? [r.pos, ...next.points] : next.points };
    }
    if (hit(l.end)) {
      const r = resolveEnd(l.end, model);
      next = { ...next, end: { kind: "flanged" }, points: r ? [...next.points, r.pos] : next.points };
    }
    return next;
  };
  return {
    ...doc,
    equipment: ref.type === "equipment" ? doc.equipment.filter((e) => e.id !== ref.id) : doc.equipment,
    structures: ref.type === "structure" ? doc.structures.filter((s) => s.id !== ref.id) : doc.structures,
    lines: doc.lines.filter((l) => !(ref.type === "line" && l.id === ref.id)).map(detach),
  };
}

export interface ConnectSpec {
  from: EndRef;
  to: EndRef;
  nps?: string;
  spec?: string;
  number?: string;
  fluid?: string;
}

/** Create a new line between two nozzle/tee ends using the auto-router. */
export function autoConnect(doc: PlantDoc, c: ConnectSpec): { doc: PlantDoc; lineId?: string; error?: string; info?: string } {
  const model = computeModel(doc, { clash: false });
  const s = resolveEnd(c.from, model);
  const e = resolveEnd(c.to, model);
  if (!s || !e) return { doc, error: "Pick two free nozzles (or a tee branch and a nozzle)." };
  const nps = normalizeNps(c.nps ?? s.nps);
  if (s.nps !== nps || e.nps !== nps) return { doc, error: `Sizes differ: ${s.label} is NPS ${s.nps}, ${e.label} is NPS ${e.nps}. Reducers come in a later release.` };
  const spec = getSpec(c.spec ?? "A1A");
  const exclude = new Set<string>();
  for (const comp of model.comps) {
    for (const p of comp.ports) if (isClose(p.pos, s.pos, 0.5) || isClose(p.pos, e.pos, 0.5)) exclude.add(comp.uid);
  }
  const res = autoRoute({ model, spec, nps, start: { pos: s.pos, dir: s.dir, kind: s.kind }, end: { pos: e.pos, dir: neg(e.dir), kind: e.kind }, exclude });
  if (!res) return { doc, error: `No valid route found between ${s.label} and ${e.label}.` };
  const [d, id] = addLine(doc, { nps, spec: spec.name, number: c.number, fluid: c.fluid, start: c.from, end: c.to, points: res.path.slice(1, -1) });
  const info = `${res.length > 0 ? Math.round(res.length) : 0} mm, ${res.bends} elbows${res.rackLength ? `, ${Math.round(res.rackLength / 1000)} m on rack` : ""}${res.clashes ? `, ${res.clashes} clash${res.clashes > 1 ? "es" : ""} left` : ", clash-free"}`;
  return { doc: d, lineId: id, info };
}

/** Re-route an existing line between its current ends, keeping inline items where they still fit. */
export function reroute(doc: PlantDoc, lineId: string): { doc: PlantDoc; error?: string; info?: string } {
  const line = doc.lines.find((l) => l.id === lineId);
  if (!line) return { doc, error: "Line not found." };
  const model = computeModel(doc, { clash: false });
  const res = model.lines.get(lineId)!;
  const s = resolveEnd(line.start, model);
  const e = resolveEnd(line.end, model);
  const path = res.path;
  const startPos = s?.pos ?? path[0];
  const endPos = e?.pos ?? path[path.length - 1];
  const spec = getSpec(line.spec);
  const exclude = new Set<string>();
  for (const comp of model.comps) for (const p of comp.ports) if (isClose(p.pos, startPos, 0.5) || isClose(p.pos, endPos, 0.5)) exclude.add(comp.uid);
  const r = autoRoute({
    model,
    spec,
    nps: line.nps,
    start: { pos: startPos, dir: s?.dir ?? null, kind: res.startKind },
    end: { pos: endPos, dir: e ? neg(e.dir) : null, kind: res.endKind },
    exclude,
    ownerId: lineId,
  });
  if (!r) return { doc, error: `No valid route found for ${line.number}.` };
  const points = r.path.slice(s ? 1 : 0, e ? -1 : undefined);
  // keep inline items on the first leg long enough, else drop them
  const legsLen = r.path.slice(1).map((p, i) => dist(p, r.path[i]));
  const inline = line.inline
    .map((it) => ({ ...it, leg: Math.min(it.leg, legsLen.length - 1) }))
    .filter((it) => it.station > 300 && it.station < legsLen[it.leg] - 300);
  return { doc: updateLine(doc, lineId, { points, inline }), info: `${line.number} re-routed: ${r.bends} elbows${r.clashes ? `, ${r.clashes} clash(es) left` : ", clash-free"}` };
}

