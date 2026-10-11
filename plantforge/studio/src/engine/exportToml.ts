// Export the model as a PlantForge project TOML for the Python engine (`plantforge build` -> IFC, PCF, DXF).
// The Python format knows boxes and cylinders, so other equipment primitives are written as their bounds.

import type { Model } from "./compute";
import { Shape, aabbOf } from "./shapes";
import { V3, dist } from "./vec";

const num = (n: number) => (Math.round(n * 10) / 10).toString();
const vec = (v: V3) => `[${v.map(num).join(", ")}]`;
const str = (s: string) => (s.includes('"') ? `'${s}'` : `"${s}"`);

function shapeToml(s: Shape): string[] {
  if (s.t === "cyl") return ["  [[equipment.shapes]]", '  type = "cylinder"', `  a = ${vec(s.a)}`, `  b = ${vec(s.b)}`, `  diameter = ${num(s.r * 2)}`];
  if (s.t === "fru")
    return ["  [[equipment.shapes]]", '  type = "cylinder"', `  a = ${vec(s.a)}`, `  b = ${vec(s.b)}`, `  diameter = ${num(Math.max(s.ra, s.rb) * 2)}`];
  const b = aabbOf(s);
  return ["  [[equipment.shapes]]", '  type = "box"', `  min = ${vec(b.lo)}`, `  max = ${vec(b.hi)}`];
}

export function exportToml(model: Model): string {
  const p = model.doc.project;
  const out: string[] = [
    "# Exported from PlantForge Studio. Build with:  plantforge build this-file.toml -o out",
    "",
    "[project]",
    `name = ${str(p.name)}`,
    `plant = ${str(p.plant)}`,
    `area = ${str(p.area)}`,
    `unit = ${str(p.unit)}`,
  ];
  for (const e of model.equipment.values()) {
    out.push("", "[[equipment]]", `tag = ${str(e.doc.tag)}`, `kind = ${str(e.doc.template === "pump" ? "pump" : e.doc.template === "exchanger" ? "exchanger" : e.doc.template === "tank" ? "tank" : "vessel")}`, `description = ${str(e.doc.description)}`);
    for (const s of e.body.shapes) out.push("", ...shapeToml(s));
    for (const n of e.nozzles) {
      const pt = n.ports[0];
      out.push("", "  [[equipment.nozzles]]", `  name = ${str(n.props.name)}`, `  nps = ${str(n.nps)}`, `  position = ${vec(pt.pos)}`, `  direction = ${vec(pt.dir)}`, `  projection = ${num(n.props.proj)}`);
    }
  }
  for (const s of model.structures.values()) {
    out.push("", "[[equipment]]", `tag = ${str(s.doc.tag)}`, 'kind = "structure"', `description = ${str(s.comp.desc)}`);
    for (const sh of s.comp.shapes) out.push("", ...shapeToml(sh));
  }
  const teeId = (lineId: string, item: string) => `T_${lineId}_${item}`;
  const ref = (r: Model["doc"]["lines"][number]["start"]) => {
    if (r.kind === "nozzle") return `${model.equipment.get(r.eq)?.doc.tag}/${r.nozzle}`;
    if (r.kind === "tee") return `tee:${teeId(r.line, r.item)}`;
    return "";
  };
  for (const l of model.lines.values()) {
    if (l.error) continue;
    const d = l.doc;
    out.push("", "[[lines]]", `number = ${str(d.number)}`, `spec = ${str(d.spec)}`, `nps = ${str(d.nps)}`, `fluid = ${str(d.fluid)}`);
    const from = ref(d.start);
    const to = ref(d.end);
    if (from) out.push(`from = ${str(from)}`);
    else out.push(`start = "${d.start.kind === "flanged" ? "flanged" : "open"}"`);
    if (to) out.push(`to = ${str(to)}`);
    else out.push(`end = "${d.end.kind === "flanged" ? "flanged" : "open"}"`);
    out.push(`points = [${d.points.map(vec).join(", ")}]`);
    for (const it of d.inline) {
      out.push("  [[lines.inline]]", `  type = ${str(it.type)}`, `  leg = ${it.leg}`, `  station = ${num(it.station)}`);
      if (it.type === "tee") out.push(`  id = ${str(teeId(d.id, it.id))}`, `  branch = ${vec(it.branch!)}`);
      if (it.stem) out.push(`  stem = ${vec(it.stem)}`);
    }
  }
  return out.join("\n") + "\n";
}

export const pathLength = (pts: V3[]) => pts.slice(1).reduce((t, q, i) => t + dist(pts[i], q), 0);
