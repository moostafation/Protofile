// Object metadata (status, permission group, system, revision, who/when) and the approval guard.
// Every edit passes through stamp(): changed objects get a new revision; approved objects are locked.

import type { ApprovalStatus, EquipmentDoc, HierNode, LineDoc, ObjMeta, PlantDoc, StructureDoc } from "./doc";

export type ModelObject = EquipmentDoc | LineDoc | StructureDoc;
export type ObjType = "equipment" | "line" | "structure";

export const STATUSES: ApprovalStatus[] = ["Working", "In Review", "Approved", "Rejected"];
export const DEFAULT_GROUPS = ["Piping", "Mechanical", "Structural", "Admin"];

export class ApprovalError extends Error {}

export interface User {
  /** Stored in the database (created_by, modified_by, txn.user); names are resolved for display. */
  id: string;
  name: string;
  canApprove: boolean;
}

export const LOCAL_USER: User = { id: "local", name: "Local user", canApprove: true };

const SYS = { equipment: "sys-equipment", line: "sys-piping", structure: "sys-steel" } as const;
const GROUP: Record<ObjType, string> = { equipment: "Mechanical", line: "Piping", structure: "Structural" };

export function defaultHierarchy(doc: PlantDoc): HierNode[] {
  return [
    { id: "area", parent: null, kind: "area", name: doc.project.area || "Area 100" },
    { id: "unit", parent: "area", kind: "unit", name: doc.project.unit || "Unit 100" },
    { id: SYS.equipment, parent: "unit", kind: "system", name: "Equipment" },
    { id: SYS.line, parent: "unit", kind: "system", name: "Process piping" },
    { id: "sys-utility", parent: "unit", kind: "system", name: "Utility piping" },
    { id: SYS.structure, parent: "unit", kind: "system", name: "Steel" },
  ];
}

export function typeOf(doc: PlantDoc, id: string): ObjType | null {
  if (doc.equipment.some((e) => e.id === id)) return "equipment";
  if (doc.lines.some((l) => l.id === id)) return "line";
  if (doc.structures.some((s) => s.id === id)) return "structure";
  return null;
}

export function objects(doc: PlantDoc): { type: ObjType; obj: ModelObject }[] {
  return [
    ...doc.equipment.map((obj) => ({ type: "equipment" as const, obj })),
    ...doc.lines.map((obj) => ({ type: "line" as const, obj })),
    ...doc.structures.map((obj) => ({ type: "structure" as const, obj })),
  ];
}

export const objName = (o: ModelObject) => ("tag" in o ? o.tag : (o as LineDoc).number);

function freshMeta(type: ObjType, user: User, now: number, obj?: ModelObject): ObjMeta {
  const utility = type === "line" && /-(CW|ST|N|IA|PW)-/.test((obj as LineDoc | undefined)?.number ?? "");
  return {
    status: "Working",
    group: GROUP[type],
    system: utility ? "sys-utility" : SYS[type],
    rev: 1,
    createdBy: user.id,
    createdAt: now,
    modifiedBy: user.id,
    modifiedAt: now,
  };
}

/** Bring an older document up to date: hierarchy, groups and metadata on every object. */
export function normalizeDoc(doc: PlantDoc, user: User = LOCAL_USER, now = Date.now()): PlantDoc {
  const hierarchy = doc.hierarchy?.length ? doc.hierarchy : defaultHierarchy(doc);
  const groups = doc.groups?.length ? doc.groups : [...DEFAULT_GROUPS];
  const fix = <T extends ModelObject>(type: ObjType) => (o: T): T => (o.meta ? o : { ...o, meta: freshMeta(type, user, now, o) });
  return {
    ...doc,
    hierarchy,
    groups,
    equipment: doc.equipment.map(fix("equipment")),
    lines: doc.lines.map(fix("line")),
    structures: doc.structures.map(fix("structure")),
  };
}

const content = (o: ModelObject) => JSON.stringify({ ...o, meta: undefined });

/**
 * Stamp an edit: new objects get metadata, changed objects get rev+1 and who/when.
 * Throws ApprovalError when the edit changes an Approved object.
 */
export function stamp(prev: PlantDoc, next: PlantDoc, user: User, now = Date.now()): PlantDoc {
  const before = new Map(objects(prev).map(({ obj }) => [obj.id, obj]));
  const locked: string[] = [];
  const touch = <T extends ModelObject>(type: ObjType) => (o: T): T => {
    const old = before.get(o.id);
    if (!old) return { ...o, meta: o.meta ? { ...o.meta, createdBy: user.id, createdAt: now, modifiedBy: user.id, modifiedAt: now } : freshMeta(type, user, now, o) };
    if (content(old) === content(o)) return o.meta === old.meta ? o : { ...o };
    if (old.meta?.status === "Approved") locked.push(objName(old));
    const meta = o.meta ?? old.meta ?? freshMeta(type, user, now, o);
    return { ...o, meta: { ...meta, rev: (old.meta?.rev ?? 0) + 1, modifiedBy: user.id, modifiedAt: now } };
  };
  const out = normalizeDoc({
    ...next,
    equipment: next.equipment.map(touch("equipment")),
    lines: next.lines.map(touch("line")),
    structures: next.structures.map(touch("structure")),
  });
  // deleting an approved object is an edit too
  for (const { obj } of objects(prev)) {
    if (obj.meta?.status === "Approved" && typeOf(next, obj.id) === null) locked.push(objName(obj));
  }
  if (locked.length) throw new ApprovalError(`${locked.join(", ")} ${locked.length > 1 ? "are" : "is"} Approved. Set the status back to Working before changing ${locked.length > 1 ? "them" : "it"}.`);
  return out;
}

/** Change status / permission group / system of objects (a metadata-only transaction). */
export function setMeta(doc: PlantDoc, ids: string[], patch: Partial<Pick<ObjMeta, "status" | "group" | "system">>, user: User, now = Date.now()): PlantDoc {
  if (!user.canApprove) {
    const deciding = patch.status === "Approved" || patch.status === "Rejected";
    const reopening = objects(doc).some(({ obj }) => ids.includes(obj.id) && obj.meta?.status === "Approved");
    if (deciding || reopening) throw new ApprovalError("Only editors of this plant database can approve, reject or re-open approved objects.");
  }
  const set = <T extends ModelObject>(o: T): T =>
    ids.includes(o.id) && o.meta ? { ...o, meta: { ...o.meta, ...patch, rev: o.meta.rev + 1, modifiedBy: user.id, modifiedAt: now } } : o;
  return { ...doc, equipment: doc.equipment.map(set), lines: doc.lines.map(set), structures: doc.structures.map(set) };
}

/** Objects that changed between two documents (added, modified or removed), by id. */
export function changedIds(prev: PlantDoc, next: PlantDoc): { upserts: string[]; deletes: string[] } {
  const a = new Map(objects(prev).map(({ obj }) => [obj.id, JSON.stringify(obj)]));
  const b = new Map(objects(next).map(({ obj }) => [obj.id, JSON.stringify(obj)]));
  const upserts = [...b].filter(([id, j]) => a.get(id) !== j).map(([id]) => id);
  const deletes = [...a.keys()].filter((id) => !b.has(id));
  return { upserts, deletes };
}

/** Unique ids across users (shared databases): sequence plus a short random suffix. */
export const uniqueSuffix = () => Math.random().toString(36).slice(2, 6);
