// In-app design assistant: Claude (via the artifact `sample` capability) operating the model through page tools.

import { useStore } from "../app/store";
import { addEquipment, addInline, addNozzle, addRack, autoConnect, deleteObject, moveEquipment, nextTag, reroute, updateEquipment, updateNozzle } from "../engine/commands";
import { computeModel } from "../engine/compute";
import type { EndRef, NozzleDoc, PlantDoc, TemplateId } from "../engine/doc";
import { TEMPLATES } from "../engine/equipment";
import { toDocStation } from "../engine/routing";
import { dirName, fmtENU } from "../engine/vec";

const S = () => useStore.getState();
const r0 = (n: number) => Math.round(n);

export function findByName(name: string): { type: "equipment" | "line" | "structure"; id: string; label: string } | null {
  const n = name.trim().toUpperCase();
  const d = S().doc;
  const eq = d.equipment.find((e) => e.tag.toUpperCase() === n);
  if (eq) return { type: "equipment", id: eq.id, label: eq.tag };
  const st = d.structures.find((s) => s.tag.toUpperCase() === n);
  if (st) return { type: "structure", id: st.id, label: st.tag };
  const ln = d.lines.find((l) => l.number.toUpperCase() === n) ?? d.lines.find((l) => l.number.toUpperCase().includes(n));
  if (ln) return { type: "line", id: ln.id, label: ln.number };
  return null;
}

export function nozzleRefByName(ref: string): EndRef | null {
  const [tag, noz] = ref.split("/");
  const eq = S().doc.equipment.find((e) => e.tag.toUpperCase() === (tag ?? "").trim().toUpperCase());
  const n = eq?.nozzles.find((x) => x.name.toUpperCase() === (noz ?? "").trim().toUpperCase());
  return eq && n ? { kind: "nozzle", eq: eq.id, nozzle: n.name } : null;
}

export function modelSummary() {
  const m = S().model;
  const connected = new Set(m.conn.joints.flatMap((j) => [j.a.uid, j.b.uid]));
  return {
    project: m.doc.project.name,
    units: "mm; X=East, Y=North, Z=Elevation; grade at EL 0",
    equipment: [...m.equipment.values()].map((e) => ({
      tag: e.doc.tag,
      template: e.doc.template,
      description: e.doc.description,
      origin: e.doc.origin.map(r0),
      rotation: e.doc.rot,
      nozzles: e.nozzles.map((n) => ({
        name: n.props.name,
        nps: n.nps,
        service: n.props.service,
        face: n.ports[0].pos.map(r0),
        points: dirName(n.ports[0].dir),
        connected: connected.has(n.uid),
      })),
    })),
    racks: [...m.structures.values()].map((s) => ({
      tag: s.doc.tag,
      start: s.doc.origin.map(r0),
      along: s.doc.axis === "x" ? "east" : "north",
      length: s.doc.length,
      width: s.doc.width,
      levels_top_of_steel: s.doc.levels,
    })),
    lines: [...m.lines.values()].map((l) => ({
      number: l.doc.number,
      nps: l.doc.nps,
      fluid: l.doc.fluid,
      from: ref(l.doc.start),
      to: ref(l.doc.end),
      status: l.error ? `ERROR: ${l.error}` : "ok",
      valves: l.comps.filter((c) => c.kind === "VALVE").map((c) => c.props.valveType),
    })),
    hard_clashes: (m.clashes ?? []).filter((c) => c.hard).length,
  };
}

function ref(r: EndRef): string {
  const d = S().doc;
  if (r.kind === "nozzle") return `${d.equipment.find((e) => e.id === r.eq)?.tag}/${r.nozzle}`;
  if (r.kind === "tee") return `tee on ${d.lines.find((l) => l.id === r.line)?.number}`;
  return r.kind === "flanged" ? "flanged battery-limit end" : "open end";
}

const TEMPLATE_HELP = Object.values(TEMPLATES)
  .map((t) => `- ${t.id}: ${t.name}; params ${JSON.stringify(t.params)}; default nozzles ${t.nozzles.map((n) => `${n.name} ${n.nps}" ${n.service}`).join(", ")}`)
  .join("\n");

export const INSTRUCTIONS = `You are the design assistant inside PlantForge Studio, a 3D plant and piping design program (like SP3D / E3D).
You change the model ONLY by calling the tools. Coordinates are millimetres: X = East, Y = North, Z = elevation, grade = 0.
Rules a good piping designer follows:
- Call get_model first to see what exists (tags, free nozzles, racks), unless the request is trivial.
- Keep clear of existing equipment: leave at least 1500 mm between equipment footprints and 3000 mm from rack columns.
- Pumps in parallel sit side by side 2500 mm apart, suction facing the vessel they draw from.
- Connect nozzles with connect_nozzles: it auto-routes with clash avoidance and prefers the pipe rack. Sizes must match (no reducers yet).
- Put check + gate valves on pump discharges (check first, ~700 mm from the nozzle; gate ~1450 mm), a gate valve on pump suctions near the pump.
- After changes, run clash_check and fix problems (move equipment, reroute_line) before you finish.
Equipment templates (rotation is degrees about Z; a pump's suction faces local -X, i.e. West at rotation 0, North at -90):
${TEMPLATE_HELP}
Finish with a short summary of what you changed, in the same language the user wrote in (Arabic or English).`;

type Tool = {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  execute(input: Record<string, unknown>): unknown;
};

const str = (x: unknown) => String(x ?? "").trim();
const num = (x: unknown, d?: number) => (x === undefined || x === null || x === "" ? d : Number(x));

export function assistantTools(onAction: (text: string) => void): Tool[] {
  const apply = (doc: PlantDoc, label: string) => {
    S().apply(doc, `Assistant: ${label}`);
    onAction(label);
  };
  return [
    {
      name: "get_model",
      description: "Returns the current plant model: equipment with nozzles (face position, direction, size, connected or free), racks, lines and clash count.",
      execute: () => modelSummary(),
    },
    {
      name: "add_equipment",
      description: "Places parametric equipment at grade. Returns its tag and nozzles. template: pump | vvessel | hdrum | exchanger | tank.",
      inputSchema: {
        type: "object",
        properties: {
          template: { type: "string", enum: Object.keys(TEMPLATES) },
          tag: { type: "string", description: "optional, e.g. P-102B" },
          east: { type: "number" },
          north: { type: "number" },
          rotation: { type: "number", description: "degrees about Z: 0, 90, 180, -90" },
          description: { type: "string" },
          params: { type: "object", description: "optional size parameters, see template list" },
        },
        required: ["template", "east", "north"],
      },
      execute: (i) => {
        const t = str(i.template) as TemplateId;
        if (!TEMPLATES[t]) throw new Error(`unknown template ${t}`);
        let [doc, id] = addEquipment(S().doc, t, [num(i.east, 0)!, num(i.north, 0)!, 0], num(i.rotation, 0)!, str(i.tag) || undefined);
        if (i.params || i.description) {
          const eq = doc.equipment.find((e) => e.id === id)!;
          doc = updateEquipment(doc, id, { params: { ...eq.params, ...((i.params as Record<string, number>) ?? {}) }, description: str(i.description) || eq.description });
        }
        const tag = doc.equipment.find((e) => e.id === id)!.tag;
        apply(doc, `add ${tag}`);
        const e = S().model.equipment.get(id)!;
        return { tag, nozzles: e.nozzles.map((n) => ({ name: n.props.name, nps: n.nps, service: n.props.service, face: n.ports[0].pos.map(r0), points: dirName(n.ports[0].dir) })) };
      },
    },
    {
      name: "move_equipment",
      description: "Moves (and optionally rotates) equipment; connected pipes stretch to follow. Returns lines that could not follow.",
      inputSchema: {
        type: "object",
        properties: { tag: { type: "string" }, east: { type: "number" }, north: { type: "number" }, elevation: { type: "number" }, rotation: { type: "number" } },
        required: ["tag"],
      },
      execute: (i) => {
        const f = findByName(str(i.tag));
        if (!f || f.type !== "equipment") throw new Error(`no equipment ${i.tag}`);
        const eq = S().doc.equipment.find((e) => e.id === f.id)!;
        const o = eq.origin;
        const doc = moveEquipment(S().doc, f.id, [num(i.east, o[0])!, num(i.north, o[1])!, num(i.elevation, o[2])!], num(i.rotation, eq.rot));
        apply(doc, `move ${eq.tag}`);
        return { broken_lines: [...S().model.lines.values()].filter((l) => l.error).map((l) => l.doc.number) };
      },
    },
    {
      name: "add_nozzle",
      description: "Adds a shell nozzle to a vessel, drum, exchanger or tank. For vertical shells give elevation and orientation (degrees from North, clockwise); for horizontal shells give station (mm from the front) and angle (0 top, 90 north side, 180 bottom).",
      inputSchema: {
        type: "object",
        properties: {
          tag: { type: "string" },
          nps: { type: "string" },
          service: { type: "string" },
          elevation: { type: "number" },
          orientation: { type: "number" },
          station: { type: "number" },
          angle: { type: "number" },
        },
        required: ["tag", "nps"],
      },
      execute: (i) => {
        const f = findByName(str(i.tag));
        if (!f || f.type !== "equipment") throw new Error(`no equipment ${i.tag}`);
        let doc = addNozzle(S().doc, f.id);
        const eq = doc.equipment.find((e) => e.id === f.id)!;
        const n = eq.nozzles[eq.nozzles.length - 1];
        if (!n) throw new Error("this equipment has fixed nozzles");
        const place: NozzleDoc["place"] =
          n.place.kind === "shell"
            ? { kind: "shell", elev: num(i.elevation, n.place.elev)!, orient: num(i.orientation, n.place.orient)! }
            : n.place.kind === "hshell"
              ? { kind: "hshell", station: num(i.station, n.place.station)!, angle: num(i.angle, n.place.angle)! }
              : n.place;
        doc = updateNozzle(doc, f.id, n.name, { nps: str(i.nps), service: str(i.service), place });
        apply(doc, `add nozzle ${eq.tag}/${n.name}`);
        const built = S().model.equipment.get(f.id)!.nozzles.find((x) => x.props.name === n.name)!;
        return { nozzle: `${eq.tag}/${n.name}`, face: built.ports[0].pos.map(r0), points: dirName(built.ports[0].dir) };
      },
    },
    {
      name: "connect_nozzles",
      description: "Creates a new line between two free nozzles (format TAG/NOZZLE, e.g. V-101/N2) with the clash-avoiding auto-router. Returns the line number and route summary.",
      inputSchema: {
        type: "object",
        properties: { from: { type: "string" }, to: { type: "string" }, line_number: { type: "string" }, fluid: { type: "string" } },
        required: ["from", "to"],
      },
      execute: (i) => {
        const a = nozzleRefByName(str(i.from));
        const b = nozzleRefByName(str(i.to));
        if (!a || !b) throw new Error("use TAG/NOZZLE for both ends, e.g. P-101A/N2");
        const res = autoConnect(S().doc, { from: a, to: b, number: str(i.line_number) || undefined, fluid: str(i.fluid) || undefined, spec: S().newLine.spec });
        if (res.error || !res.lineId) throw new Error(res.error ?? "no route");
        const line = res.doc.lines.find((l) => l.id === res.lineId)!;
        apply(res.doc, `connect ${str(i.from)} to ${str(i.to)} as ${line.number}`);
        return { line: line.number, route: res.info };
      },
    },
    {
      name: "add_valve",
      description: "Inserts a flanged valve on a line, measured from the line's start or end along its first or last straight leg. type: gate | globe | check.",
      inputSchema: {
        type: "object",
        properties: {
          line: { type: "string" },
          type: { type: "string", enum: ["gate", "globe", "check"] },
          near: { type: "string", enum: ["start", "end"] },
          distance_mm: { type: "number" },
        },
        required: ["line", "type"],
      },
      execute: (i) => {
        const f = findByName(str(i.line));
        if (!f || f.type !== "line") throw new Error(`no line ${i.line}`);
        const res = S().model.lines.get(f.id)!;
        if (res.error) throw new Error(res.error);
        const atEnd = str(i.near) === "end";
        const k = atEnd ? res.legs.length - 1 : 0;
        const dmm = num(i.distance_mm, 900)!;
        const s = atEnd ? res.legs[k].length - dmm : dmm;
        const { leg, station } = toDocStation(res.legs, k, s);
        const [doc] = addInline(S().doc, f.id, { type: str(i.type) as "gate", leg, station });
        const check = computeModel(doc, { clash: false }).lines.get(f.id)!;
        if (check.error) throw new Error(`valve does not fit there (${check.error}); try another distance or the other end`);
        apply(doc, `${i.type} valve on ${f.label}`);
        return { ok: true };
      },
    },
    {
      name: "add_pipe_rack",
      description: "Adds a pipe rack: start point of its centre line at grade, direction east or north, length, width (default 6000) and beam top levels (default [5000, 7000]).",
      inputSchema: {
        type: "object",
        properties: {
          east: { type: "number" },
          north: { type: "number" },
          along: { type: "string", enum: ["east", "north"] },
          length: { type: "number" },
          width: { type: "number" },
          levels: { type: "array", items: { type: "number" } },
        },
        required: ["east", "north", "along", "length"],
      },
      execute: (i) => {
        const [doc, id] = addRack(S().doc, [num(i.east, 0)!, num(i.north, 0)!, 0], str(i.along) === "north" ? "y" : "x", num(i.length, 12000)!, num(i.width, 6000), (i.levels as number[]) ?? [5000, 7000]);
        apply(doc, "add pipe rack");
        return { tag: doc.structures.find((s) => s.id === id)!.tag };
      },
    },
    {
      name: "reroute_line",
      description: "Re-routes an existing line between its ends with the auto-router (use after moving equipment or to fix clashes).",
      inputSchema: { type: "object", properties: { line: { type: "string" } }, required: ["line"] },
      execute: (i) => {
        const f = findByName(str(i.line));
        if (!f || f.type !== "line") throw new Error(`no line ${i.line}`);
        const r = reroute(S().doc, f.id);
        if (r.error) throw new Error(r.error);
        apply(r.doc, `re-route ${f.label}`);
        return { result: r.info };
      },
    },
    {
      name: "delete_item",
      description: "Deletes equipment (by tag), a rack (by tag) or a line (by line number). Lines attached to deleted equipment keep a flanged open end.",
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      execute: (i) => {
        const f = findByName(str(i.name));
        if (!f) throw new Error(`nothing called ${i.name}`);
        apply(deleteObject(S().doc, f), `delete ${f.label}`);
        return { deleted: f.label };
      },
    },
    {
      name: "clash_check",
      description: "Runs interference checking and returns hard clashes and routing errors.",
      execute: () => {
        const m = S().model;
        const name = (uid: string) => {
          const c = m.byUid.get(uid);
          if (!c) return uid;
          return c.owner.type === "line" ? `${m.lines.get(c.owner.id)?.doc.number} ${c.tag}` : c.tag;
        };
        return {
          clashes: (m.clashes ?? []).filter((c) => c.hard).slice(0, 20).map((c) => ({ a: name(c.a), b: name(c.b), at: fmtENU(c.point) })),
          errors: m.todo.filter((t) => t.level === "error").map((t) => t.text),
        };
      },
    },
  ];
}

export const suggestTag = (prefix: string) => nextTag(S().doc, prefix);
