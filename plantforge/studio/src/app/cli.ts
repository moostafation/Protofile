// Command line (E3D-flavoured). Routing commands go to the active route tool first.

import { findByName, nozzleRefByName } from "../assistant/assistant";
import { addEquipment, autoConnect, deleteObject, moveEquipment, reroute } from "../engine/commands";
import type { TemplateId } from "../engine/doc";
import { normalizeNps } from "../engine/catalog";
import { fmtENU } from "../engine/vec";
import { useStore } from "./store";

const S = () => useStore.getState();

const TEMPLATE_WORDS: Record<string, TemplateId> = {
  PUMP: "pump",
  VESSEL: "vvessel",
  VVESSEL: "vvessel",
  COLUMN: "vvessel",
  DRUM: "hdrum",
  HDRUM: "hdrum",
  EXCHANGER: "exchanger",
  HX: "exchanger",
  TANK: "tank",
};

export const HELP = [
  "E 2000 · N 1500 · U 1000 · W/S/D …   add a leg while routing (mm)",
  "TO V-101/N1                          finish the route at a nozzle (auto-route)",
  "FINISH · FLANGED                     end the route open / with a flange",
  "ROUTE [P-101A/N2]                    start routing (optionally from a nozzle)",
  "CONNECT P-101A/N2 E-101/N1           auto-route a new line between two nozzles",
  "NEW PUMP|VESSEL|DRUM|EXCHANGER|TANK [TAG] AT E 5000 N 3000",
  "MOVE P-101A E 500 · MOVE P-101A TO E 4000 N 6000",
  "ROTATE P-101A 90 · DELETE P-101B · REROUTE 4\"-P-1002",
  "NPS 6 · SPEC A1A · EL 3500 (working elevation for new routes)",
  "CLASH [clearance mm] · ISO <line> · GOTO <tag> · UNDO · REDO · HELP",
];

export interface CliHooks {
  routeCommand(text: string): boolean;
  startRoute(fromNozzle?: string): void;
  goto(uids: string[]): void;
  setWorkingZ(z: number): void;
}

function coords(tokens: string[]): { e?: number; n?: number; z?: number } {
  const out: { e?: number; n?: number; z?: number } = {};
  for (let i = 0; i < tokens.length - 1; i++) {
    const k = tokens[i].toUpperCase();
    const v = Number(tokens[i + 1]);
    if (Number.isNaN(v)) continue;
    if (k === "E") out.e = v;
    if (k === "W") out.e = -v;
    if (k === "N") out.n = v;
    if (k === "S") out.n = -v;
    if (k === "EL" || k === "U") out.z = v;
    if (k === "D") out.z = -v;
  }
  return out;
}

export function runCommand(raw: string, hooks: CliHooks): void {
  const text = raw.trim();
  if (!text) return;
  const st = S();
  st.logLine(text, "in");
  const say = (t: string) => st.logLine(t);
  const fail = (t: string) => st.logLine(t, "error");
  if (hooks.routeCommand(text)) return;
  const tokens = text.split(/\s+/);
  const cmd = tokens[0].toUpperCase();
  try {
    switch (cmd) {
      case "HELP":
      case "?":
        HELP.forEach(say);
        return;
      case "UNDO":
        return st.undo();
      case "REDO":
        return st.redo();
      case "ROUTE":
        return hooks.startRoute(tokens[1]);
      case "NPS": {
        const nps = normalizeNps(tokens[1]);
        st.set({ newLine: { ...st.newLine, nps } });
        return say(`New lines: NPS ${nps}`);
      }
      case "SPEC":
        st.set({ newLine: { ...st.newLine, spec: tokens[1].toUpperCase() } });
        return say(`New lines: spec ${tokens[1].toUpperCase()}`);
      case "EL": {
        const z = Number(tokens[1]);
        if (Number.isNaN(z)) return fail("EL needs a number, e.g. EL 3500");
        hooks.setWorkingZ(z);
        return say(`Working elevation EL ${z >= 0 ? "+" : ""}${z}`);
      }
      case "CONNECT": {
        const a = nozzleRefByName(tokens[1] ?? "");
        const b = nozzleRefByName(tokens[2] ?? "");
        if (!a || !b) return fail("CONNECT needs two nozzles: CONNECT P-101A/N2 E-101/N1");
        const res = autoConnect(st.doc, { from: a, to: b, spec: st.newLine.spec, fluid: st.newLine.fluid });
        if (res.error || !res.lineId) return fail(res.error ?? "no route");
        const number = res.doc.lines.find((l) => l.id === res.lineId)!.number;
        st.apply(res.doc, `Auto-route ${number}`);
        return say(`${number}: ${res.info}`);
      }
      case "NEW": {
        const t = TEMPLATE_WORDS[(tokens[1] ?? "").toUpperCase()];
        if (!t) return fail("NEW PUMP | VESSEL | DRUM | EXCHANGER | TANK");
        const tag = tokens[2] && tokens[2].toUpperCase() !== "AT" ? tokens[2].toUpperCase() : undefined;
        const c = coords(tokens);
        const [doc, id] = addEquipment(st.doc, t, [c.e ?? 0, c.n ?? 0, 0], 0, tag);
        const eq = doc.equipment.find((e) => e.id === id)!;
        st.apply(doc, `Add ${eq.tag}`);
        st.select([`${id}/BODY`], { type: "equipment", id });
        hooks.goto([`${id}/BODY`]);
        return say(`Placed ${eq.tag} at ${fmtENU(eq.origin)}`);
      }
      case "MOVE":
      case "ROTATE": {
        const f = findByName(tokens[1] ?? "");
        if (!f || f.type !== "equipment") return fail(`No equipment ${tokens[1] ?? ""}`);
        const eq = st.doc.equipment.find((e) => e.id === f.id)!;
        let origin = eq.origin;
        let rot = eq.rot;
        if (cmd === "ROTATE") rot = (eq.rot + Number(tokens[2] ?? 90)) % 360;
        else if ((tokens[2] ?? "").toUpperCase() === "TO") {
          const c = coords(tokens.slice(3));
          origin = [c.e ?? origin[0], c.n ?? origin[1], c.z ?? origin[2]];
        } else {
          const c = coords(tokens.slice(2));
          origin = [origin[0] + (c.e ?? 0), origin[1] + (c.n ?? 0), origin[2] + (c.z ?? 0)];
        }
        st.apply(moveEquipment(st.doc, f.id, origin, rot), `${cmd === "MOVE" ? "Move" : "Rotate"} ${eq.tag}`);
        const broken = [...S().model.lines.values()].filter((l) => l.error).map((l) => l.doc.number);
        return say(`${eq.tag} at ${fmtENU(origin)}, rotation ${rot}°${broken.length ? ` · could not follow: ${broken.join(", ")} (try REROUTE)` : ""}`);
      }
      case "DELETE": {
        const f = findByName(tokens.slice(1).join(" "));
        if (!f) return fail(`Nothing called ${tokens.slice(1).join(" ")}`);
        st.apply(deleteObject(st.doc, f), `Delete ${f.label}`);
        return say(`Deleted ${f.label}`);
      }
      case "REROUTE": {
        const f = findByName(tokens.slice(1).join(" "));
        if (!f || f.type !== "line") return fail("REROUTE needs a line number");
        const r = reroute(st.doc, f.id);
        if (r.error) return fail(r.error);
        st.apply(r.doc, `Re-route ${f.label}`);
        return say(r.info ?? "Re-routed");
      }
      case "CLASH": {
        const cl = Number(tokens[1] ?? 0) || 0;
        st.set({ clearance: cl });
        st.rerunClash();
        const c = S().model.clashes ?? [];
        st.set({ panel: "clash" });
        return say(`${c.filter((x) => x.hard).length} hard clashes${cl ? `, ${c.filter((x) => !x.hard).length} within ${cl} mm` : ""}`);
      }
      case "ISO": {
        const f = findByName(tokens.slice(1).join(" ") || "");
        const id = f?.type === "line" ? f.id : st.focus?.type === "line" ? st.focus.id : null;
        if (!id) return fail("ISO needs a line number (or select a line)");
        return st.set({ isoLine: id });
      }
      case "GOTO": {
        const f = findByName(tokens.slice(1).join(" "));
        if (!f) return fail(`Nothing called ${tokens.slice(1).join(" ")}`);
        const uids = S().model.comps.filter((c) => c.owner.id === f.id).map((c) => c.uid);
        st.select(uids, { type: f.type, id: f.id });
        return hooks.goto(uids);
      }
      default:
        return fail(`Unknown command ${cmd}. Type HELP.`);
    }
  } catch (e) {
    fail((e as Error).message);
  }
}
