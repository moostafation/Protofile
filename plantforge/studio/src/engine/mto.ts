// Material take-off from the computed model.

import { npsValue } from "./catalog";
import type { Comp } from "./model";

export interface MtoRow {
  kind: string;
  spec: string;
  nps: string;
  description: string;
  qty: number;
  unit: "m" | "EA" | "SET";
  weight?: number;
}

const ORDER = ["PIPE", "ELBOW", "TEE", "FLANGE", "GASKET", "VALVE", "BOLTING", "SUPPORT"];

export function materialTakeoff(lines: { spec: string; comps: Comp[] }[]): MtoRow[] {
  const rows = new Map<string, MtoRow>();
  const add = (kind: string, spec: string, nps: string, description: string, qty: number, unit: MtoRow["unit"], weight?: number) => {
    const k = [kind, spec, nps, description, unit].join("|");
    const r = rows.get(k);
    if (r) {
      r.qty += qty;
      if (weight !== undefined) r.weight = (r.weight ?? 0) + weight;
    } else rows.set(k, { kind, spec, nps, description, qty, unit, weight });
  };
  for (const line of lines) {
    for (const c of line.comps) {
      if (c.kind === "PIPE") add("PIPE", line.spec, c.nps, c.desc, c.props.length / 1000, "m", c.props.weight);
      else if (["ELBOW", "TEE", "FLANGE", "GASKET", "VALVE", "SUPPORT"].includes(c.kind)) {
        add(c.kind, line.spec, c.nps, c.desc, 1, "EA");
        if (c.kind === "GASKET") add("BOLTING", line.spec, c.nps, `STUD BOLT SET ${c.props.bolts} x ${c.props.boltDia}" DIA W/ 2 NUTS, LENGTH PER ASME B16.5`, 1, "SET");
      }
    }
  }
  return [...rows.values()].sort(
    (a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || npsValue(a.nps) - npsValue(b.nps) || a.description.localeCompare(b.description),
  );
}

export function mtoCsv(rows: MtoRow[], welds: number, inchDia: number): string {
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const out = ["Item,Spec,NPS,Description,Qty,Unit,Weight (kg)"];
  rows.forEach((r, i) =>
    out.push([i + 1, r.spec, q(r.nps), q(r.description), r.unit === "m" ? r.qty.toFixed(2) : r.qty, r.unit, r.weight?.toFixed(1) ?? ""].join(",")),
  );
  out.push("", `,,,Butt welds,${welds},EA,`, `,,,Butt welds (inch-dia),${inchDia},in-dia,`);
  return out.join("\n") + "\n";
}
