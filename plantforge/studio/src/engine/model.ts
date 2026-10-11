// Computed model types: everything placed in the plant is a Comp with ports and shapes.

import type { Shape } from "./shapes";
import type { V3 } from "./vec";

export type EndType = "BW" | "FL";

export type Kind =
  | "PIPE"
  | "ELBOW"
  | "TEE"
  | "FLANGE"
  | "GASKET"
  | "VALVE"
  | "SUPPORT"
  | "NOZZLE"
  | "EQUIPMENT"
  | "STEEL";

export type OwnerType = "equipment" | "line" | "structure";

export interface Port {
  name: string;
  pos: V3;
  dir: V3; // unit vector pointing OUT of the component
  end: EndType;
  nps: string;
}

export interface Comp {
  uid: string; // "<owner id>/<tag>"
  tag: string;
  kind: Kind;
  nps: string;
  ports: Port[];
  shapes: Shape[];
  desc: string;
  skey: string;
  props: Record<string, any>;
  owner: { type: OwnerType; id: string };
}

export const port = (name: string, pos: V3, dir: V3, end: EndType, nps: string): Port => ({ name, pos, dir, end, nps });
