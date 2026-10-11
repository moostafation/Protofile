// The editable plant document. Everything the user changes lives here; the model is computed from it.

import type { InlineItem } from "./routing";
import type { V3 } from "./vec";

export type TemplateId = "pump" | "vvessel" | "hdrum" | "exchanger" | "tank";

export type NozzlePlace =
  | { kind: "shell"; elev: number; orient: number } // vertical shell: elevation, plan angle from North, clockwise
  | { kind: "top"; dx: number; dy: number } // vertical vessel / tank top head
  | { kind: "hshell"; station: number; angle: number } // horizontal shell: station from the front, angle (0 top, 90 local north, 180 bottom, 270 south)
  | { kind: "end"; side: "left" | "right"; dy: number; dz: number }
  | { kind: "fixed"; key: "suction" | "discharge" }; // pump nozzles

export interface NozzleDoc {
  name: string;
  nps: string;
  proj: number;
  service: string;
  place: NozzlePlace;
}

/** SP3D-style object metadata kept with every model object in the database. */
export type ApprovalStatus = "Working" | "In Review" | "Approved" | "Rejected";

export interface ObjMeta {
  status: ApprovalStatus;
  group: string; // permission group
  system: string; // hierarchy node id
  rev: number;
  createdBy: string;
  createdAt: number;
  modifiedBy: string;
  modifiedAt: number;
}

export interface HierNode {
  id: string;
  parent: string | null;
  kind: "area" | "unit" | "system";
  name: string;
}

export interface EquipmentDoc {
  id: string;
  meta?: ObjMeta;
  tag: string;
  template: TemplateId;
  description: string;
  origin: V3;
  rot: number; // degrees about Z
  params: Record<string, number>;
  nozzles: NozzleDoc[];
}

export interface StructureDoc {
  id: string;
  meta?: ObjMeta;
  tag: string;
  type: "rack";
  description: string;
  origin: V3; // start of the rack centre line at grade
  axis: "x" | "y";
  length: number;
  width: number;
  bay: number;
  levels: number[]; // top of steel elevations
}

export type EndRef =
  | { kind: "nozzle"; eq: string; nozzle: string }
  | { kind: "tee"; line: string; item: string }
  | { kind: "open" }
  | { kind: "flanged" };

export interface LineDoc {
  id: string;
  meta?: ObjMeta;
  number: string;
  spec: string;
  nps: string;
  fluid: string;
  color: number; // palette index
  start: EndRef;
  end: EndRef;
  points: V3[]; // free points; connected end points are added from the nozzle / tee
  inline: InlineItem[];
}

export interface PlantDoc {
  version: 1;
  project: { name: string; plant: string; area: string; unit: string };
  equipment: EquipmentDoc[];
  structures: StructureDoc[];
  lines: LineDoc[];
  seq: number;
  /** System hierarchy (Area > Unit > System), as in the SP3D workspace explorer. */
  hierarchy?: HierNode[];
  /** Permission groups objects can belong to. */
  groups?: string[];
}

export const emptyDoc = (): PlantDoc => ({
  version: 1,
  project: { name: "Untitled plant", plant: "", area: "A-100", unit: "U-100" },
  equipment: [],
  structures: [],
  lines: [],
  seq: 1,
});

let ID_SUFFIX = "";
/** In a shared plant every session adds its own suffix, so ids made at the same time never collide. */
export function setIdSuffix(suffix: string) {
  ID_SUFFIX = suffix;
}

export function nextId(doc: PlantDoc, prefix: string): [string, PlantDoc] {
  return [`${prefix}${doc.seq}${ID_SUFFIX}`, { ...doc, seq: doc.seq + 1 }];
}
