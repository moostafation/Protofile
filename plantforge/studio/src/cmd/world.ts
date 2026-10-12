// PlantForge command language: what names refer to. A snapshot of the plant that resolves tags, line numbers,
// nozzle and tee references (P-101A.N2, 4"-P-1002.T1), sets (pumps, lines, it, selection) and attributes.

import { npsValue } from "../engine/catalog";
import type { Model } from "../engine/compute";
import type { EndRef, EquipmentDoc, LineDoc, PlantDoc, StructureDoc } from "../engine/doc";
import { TEMPLATES } from "../engine/equipment";
import type { V3 } from "../engine/vec";
import { norm } from "./lexer";

export type ObjType = "equipment" | "line" | "structure";
export interface Ref {
  type: ObjType;
  id: string;
  name: string;
}

/** A line end that can be connected to: an equipment nozzle or a tee branch. */
export interface EndTarget {
  ref: EndRef & ({ kind: "nozzle" } | { kind: "tee" });
  label: string;
  nps: string;
  free: boolean;
  owner: Ref;
}

/** An inline item of a line: P-1002.V1 (first valve), P-1002.T1 (first tee). */
export interface ItemTarget {
  line: LineDoc;
  item: string;
  label: string;
}

/** Inline items in the order they sit along the line (leg, then station): V1 is the first valve met from the start. */
export const ordered = (l: LineDoc) => [...l.inline].sort((a, b) => a.leg - b.leg || a.station - b.station);

export const TYPE_NAMES: Record<string, string> = { pump: "pump", vvessel: "vessel", hdrum: "drum", exchanger: "exchanger", tank: "tank" };

export class World {
  constructor(
    readonly doc: PlantDoc,
    readonly model: Model,
    readonly it: Ref[] = [],
    readonly selection: Ref[] = [],
  ) {}

  ref(type: ObjType, o: EquipmentDoc | LineDoc | StructureDoc): Ref {
    return { type, id: o.id, name: "tag" in o ? o.tag : (o as LineDoc).number };
  }

  equipment = (): Ref[] => this.doc.equipment.map((e) => this.ref("equipment", e));
  lines = (): Ref[] => this.doc.lines.map((l) => this.ref("line", l));
  racks = (): Ref[] => this.doc.structures.map((s) => this.ref("structure", s));
  all = (): Ref[] => [...this.equipment(), ...this.lines(), ...this.racks()];

  eq = (id: string) => this.doc.equipment.find((e) => e.id === id);
  line = (id: string) => this.doc.lines.find((l) => l.id === id);
  rack = (id: string) => this.doc.structures.find((s) => s.id === id);

  /** Exact tag or line number; a line also by a unique part of its number (P-1002). */
  byName(word: string): Ref | null {
    const n = word.trim().toUpperCase();
    if (!n) return null;
    const eq = this.doc.equipment.find((e) => e.tag.toUpperCase() === n);
    if (eq) return this.ref("equipment", eq);
    const st = this.doc.structures.find((s) => s.tag.toUpperCase() === n);
    if (st) return this.ref("structure", st);
    const exact = this.doc.lines.find((l) => l.number.toUpperCase() === n);
    if (exact) return this.ref("line", exact);
    const part = this.doc.lines.filter((l) => l.number.toUpperCase().includes(n));
    if (part.length === 1 && n.length >= 3) return this.ref("line", part[0]);
    return null;
  }

  /** Names matching a pattern with * (P-10*, *-CW-*). */
  wildcard(pattern: string): Ref[] {
    const re = new RegExp(`^${pattern.toUpperCase().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
    return this.all().filter((r) => re.test(r.name.toUpperCase()));
  }

  private connected(): Set<string> {
    const s = new Set<string>();
    const add = (r: EndRef) => {
      if (r.kind === "nozzle") s.add(`n:${r.eq}:${r.nozzle}`);
      if (r.kind === "tee") s.add(`t:${r.line}:${r.item}`);
    };
    for (const l of this.doc.lines) {
      add(l.start);
      add(l.end);
    }
    return s;
  }

  /** TAG.N1 (or TAG/N1), it.N1, LINE.T1 (first tee branch). */
  end(word: string): EndTarget | null {
    const m = /^(.+?)[./]([A-Za-z]+\d*)$/.exec(word.trim());
    if (!m) return null;
    const owner = norm(m[1]) === "it" || ["ده", "دي", "هو", "this"].includes(norm(m[1])) ? (this.it[0] ?? null) : this.byName(m[1]);
    if (!owner) return null;
    const used = this.connected();
    if (owner.type === "equipment") {
      const eq = this.eq(owner.id)!;
      const noz = eq.nozzles.find((n) => n.name.toUpperCase() === m[2].toUpperCase());
      if (!noz) return null;
      return { ref: { kind: "nozzle", eq: eq.id, nozzle: noz.name }, label: `${eq.tag}.${noz.name}`, nps: noz.nps, free: !used.has(`n:${eq.id}:${noz.name}`), owner };
    }
    if (owner.type === "line") {
      const t = /^T(\d+)$/i.exec(m[2]);
      if (!t) return null;
      const line = this.line(owner.id)!;
      const tee = ordered(line).filter((i) => i.type === "tee")[Number(t[1]) - 1];
      if (!tee) return null;
      return { ref: { kind: "tee", line: line.id, item: tee.id }, label: `${line.number}.T${t[1]}`, nps: line.nps, free: !used.has(`t:${line.id}:${tee.id}`), owner };
    }
    return null;
  }

  /** P-1002.V2 (second valve), P-1002.T1 (first tee). */
  item(word: string): ItemTarget | null {
    const m = /^(.+?)[./]([VT])(\d+)$/i.exec(word.trim());
    if (!m) return null;
    const owner = this.byName(m[1]);
    if (owner?.type !== "line") return null;
    const line = this.line(owner.id)!;
    const list = ordered(line).filter((i) => (m[2].toUpperCase() === "T" ? i.type === "tee" : i.type !== "tee"));
    const it = list[Number(m[3]) - 1];
    return it ? { line, item: it.id, label: `${line.number}.${m[2].toUpperCase()}${m[3]}` } : null;
  }

  /** Every nozzle and tee branch (for completion and "list nozzles"). */
  ends(): EndTarget[] {
    const used = this.connected();
    const out: EndTarget[] = [];
    for (const e of this.doc.equipment)
      for (const n of e.nozzles) out.push({ ref: { kind: "nozzle", eq: e.id, nozzle: n.name }, label: `${e.tag}.${n.name}`, nps: n.nps, free: !used.has(`n:${e.id}:${n.name}`), owner: this.ref("equipment", e) });
    for (const l of this.doc.lines) {
      let k = 0;
      for (const i of ordered(l))
        if (i.type === "tee") {
          k += 1;
          out.push({ ref: { kind: "tee", line: l.id, item: i.id }, label: `${l.number}.T${k}`, nps: l.nps, free: !used.has(`t:${l.id}:${i.id}`), owner: this.ref("line", l) });
        }
    }
    return out;
  }

  names(): string[] {
    return this.all().map((r) => r.name);
  }

  /** Where an object is: equipment and rack origins, a line's first point. */
  position(r: Ref): V3 {
    if (r.type === "equipment") return this.eq(r.id)!.origin;
    if (r.type === "structure") return this.rack(r.id)!.origin;
    const res = this.model.lines.get(r.id);
    return res?.path[0] ?? [0, 0, 0];
  }

  kindName(r: Ref): string {
    if (r.type === "line") return "line";
    if (r.type === "structure") return "rack";
    return TYPE_NAMES[this.eq(r.id)!.template] ?? "equipment";
  }

  systemName(id: string | undefined): string {
    return (this.doc.hierarchy ?? []).find((h) => h.id === id)?.name ?? id ?? "";
  }

  /** Attribute values for where-filters, list and info. */
  attr(r: Ref, key: string): string | number | undefined {
    const k = norm(key);
    const meta = (r.type === "equipment" ? this.eq(r.id) : r.type === "line" ? this.line(r.id) : this.rack(r.id))?.meta;
    switch (k) {
      case "type":
      case "kind":
        return this.kindName(r);
      case "name":
      case "tag":
        return r.name;
      case "status":
        return meta?.status ?? "Working";
      case "group":
        return meta?.group ?? "";
      case "system":
        return this.systemName(meta?.system);
      case "rev":
        return meta?.rev ?? 1;
    }
    if (r.type === "equipment") {
      const e = this.eq(r.id)!;
      if (k === "e" || k === "east") return e.origin[0];
      if (k === "n" || k === "north") return e.origin[1];
      if (k === "el" || k === "elevation") return e.origin[2];
      if (k === "rot" || k === "rotation") return e.rot;
      if (k === "template") return e.template;
      if (k === "desc" || k === "description") return e.description;
      if (k === "nozzles") return e.nozzles.length;
      const p = paramKey(e, key);
      if (p) return { ...TEMPLATES[e.template].params, ...e.params }[p];
      return undefined;
    }
    if (r.type === "line") {
      const l = this.line(r.id)!;
      const res = this.model.lines.get(r.id);
      if (k === "nps" || k === "size") return npsValue(l.nps);
      if (k === "spec") return l.spec;
      if (k === "fluid" || k === "service") return l.fluid;
      if (k === "number") return l.number;
      if (k === "length") return res ? Math.round(res.pipeLength / 10) / 100 : 0;
      if (k === "elbows") return res?.comps.filter((c) => c.kind === "ELBOW").length ?? 0;
      if (k === "valves") return res?.comps.filter((c) => c.kind === "VALVE").length ?? 0;
      if (k === "error" || k === "errors") return res?.error ? "yes" : "no";
      if (k === "from") return this.endLabel(l.start);
      if (k === "to") return this.endLabel(l.end);
      return undefined;
    }
    const s = this.rack(r.id)!;
    if (k === "length") return s.length;
    if (k === "width") return s.width;
    if (k === "levels") return s.levels.join(",");
    if (k === "bay") return s.bay;
    return undefined;
  }

  endLabel(e: EndRef): string {
    if (e.kind === "nozzle") {
      const eq = this.eq(e.eq);
      return eq ? `${eq.tag}.${e.nozzle}` : "?";
    }
    if (e.kind === "tee") {
      const l = this.line(e.line);
      const k = l ? ordered(l).filter((i) => i.type === "tee").findIndex((i) => i.id === e.item) + 1 : 0;
      return l ? `${l.number}.T${k}` : "?";
    }
    return e.kind;
  }
}

const PARAM_ALIASES: Record<string, string[]> = { D: ["diameter", "dia", "قطر"], H: ["height", "ارتفاع"], L: ["length", "طول"], skirt: ["skirt"], cl: ["centreline", "centerline", "cl"] };

/** Template parameter key for a word (case-insensitive, with a few aliases). */
export function paramKey(e: EquipmentDoc, word: string): string | null {
  return paramKeyOf(e.template, word);
}

export function paramKeyOf(template: EquipmentDoc["template"], word: string): string | null {
  const keys = Object.keys(TEMPLATES[template].params);
  const w = norm(word);
  const direct = keys.find((k) => k.toLowerCase() === w);
  if (direct) return direct;
  for (const [k, al] of Object.entries(PARAM_ALIASES)) if (keys.includes(k) && al.map(norm).includes(w)) return k;
  return null;
}
