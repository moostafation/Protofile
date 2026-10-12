// The command window: the PlantForge command language (src/cmd) connected to the application -
// store, viewer, route tool, exporters and the plant database.

import type { Env } from "../cmd/commands";
import { COMMANDS } from "../cmd/commands";
import { Suggestions, suggest } from "../cmd/complete";
import { execute, newSession } from "../cmd/run";
import { Ref, World } from "../cmd/world";
import { databaseZip, reportsZip } from "../db/files";
import { dbHub } from "../db/service";
import { saveFile } from "../platform/claude";
import type { V3 } from "../engine/vec";
import type { ViewName } from "../viewer/Viewer";
import { exportCurrent, exportLine } from "./exporters";
import { useStatus } from "./status";
import { useStore } from "./store";

const S = () => useStore.getState();

/** One line per command for the help dialog. */
export const HELP = COMMANDS.filter((c) => c.verb !== "flanged" && c.verb !== "again").map((c) => c.syntax);

export interface CliHooks {
  routeCommand(text: string): boolean;
  startRoute(fromNozzle?: string): void;
  goto(uids: string[]): void;
  setWorkingZ(z: number): void;
  fit(uids: string[] | null): void;
  view(name: ViewName): void;
  sectionAround(uids: string[]): void;
  save(): void;
}

// ------------------------------------------------------------------ macros (kept in this browser)
const MACRO_KEY = "plantforge.macros.v1";
function loadMacros(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(MACRO_KEY) ?? "{}") ?? {};
  } catch {
    return {};
  }
}
function saveMacros(m: Record<string, string>) {
  try {
    localStorage.setItem(MACRO_KEY, JSON.stringify(m));
  } catch {
    /* storage unavailable */
  }
}

const session = newSession(loadMacros());
const typed: string[] = [];

const uidsOf = (refs: Ref[]) => {
  const ids = new Set(refs.map((r) => r.id));
  return S().model.comps.filter((c) => ids.has(c.owner.id)).map((c) => c.uid);
};

function selectionRefs(): Ref[] {
  const st = S();
  const w = new World(st.doc, st.model);
  const owners = new Map<string, Ref>();
  const add = (type: Ref["type"], id: string) => {
    const r = w.all().find((q) => q.id === id && q.type === type);
    if (r) owners.set(id, r);
  };
  for (const u of st.selection) {
    const c = st.model.byUid.get(u);
    if (c) add(c.owner.type, c.owner.id);
  }
  if (st.focus) add(st.focus.type, st.focus.id);
  return [...owners.values()];
}

const DIR_LETTER = (d: V3, mm: number): [string, number] => {
  const [x, y, z] = d;
  const s = Math.sign(mm) || 1;
  const letter = x * s > 0.5 ? "E" : x * s < -0.5 ? "W" : y * s > 0.5 ? "N" : y * s < -0.5 ? "S" : z * s > 0.5 ? "U" : "D";
  return [letter, Math.abs(mm)];
};

function makeEnv(hooks: CliHooks): Env {
  const offer = async (filename: string, data: Blob) => {
    const r = await saveFile(filename, data);
    S().logLine(r === "saved" ? `Saved ${filename}` : r === "declined" ? "Download declined" : "Downloads are not available in this view", r === "saved" ? "ok" : "error");
  };
  return {
    doc: () => S().doc,
    model: () => S().model,
    user: () => S().user,
    selection: selectionRefs,
    apply: (doc, label) => S().apply(doc, label),
    select: (refs, frame) => {
      const uids = uidsOf(refs);
      S().select(uids, refs.length ? { type: refs[0].type, id: refs[0].id } : null);
      if (frame && uids.length) hooks.goto(uids);
    },
    out: (text, kind) => S().logLine(text, kind ?? "out"),
    newLine: () => S().newLine,
    view: (name) => hooks.view(name as ViewName),
    fit: (refs) => hooks.fit(refs ? uidsOf(refs) : null),
    visibility: (mode, ids) => {
      const st = S();
      const all = [...st.doc.equipment, ...st.doc.lines, ...st.doc.structures].map((o) => o.id);
      const hidden = new Set(st.hidden);
      if (mode === "all") hidden.clear();
      else if (mode === "hide") ids.forEach((i) => hidden.add(i));
      else if (mode === "show") ids.forEach((i) => hidden.delete(i));
      else {
        hidden.clear();
        all.filter((i) => !ids.includes(i)).forEach((i) => hidden.add(i));
      }
      st.set({ hidden: [...hidden] });
    },
    colorBy: (mode) => S().set({ colorBy: mode }),
    labels: (on) => S().set({ labels: on ?? !S().labels }),
    section: (refs) => (refs ? hooks.sectionAround(uidsOf(refs)) : S().set({ section: null })),
    clash: (cl) => {
      if (cl !== null) S().set({ clearance: Math.max(0, cl) });
      S().rerunClash();
      S().set({ panel: "clash" });
      return S().model.clashes ?? [];
    },
    undo: (n) => {
      for (let i = 0; i < n; i++) S().undo();
    },
    redo: (n) => {
      for (let i = 0; i < n; i++) S().redo();
    },
    iso: (id) => S().set({ isoLine: id }),
    exportFile: (kind, ref) => {
      const db = dbHub.db;
      if (kind === "sqlite" || kind === "reports") {
        if (!db) return S().logLine("The database is not open", "error");
        const f = (kind === "sqlite" ? databaseZip : reportsZip)(db, S().doc.project.name);
        return void offer(f.filename, f.blob);
      }
      if (kind === "zip" && ref) return void exportLine(ref.id, "zip");
      void exportCurrent(kind as "zip" | "csv" | "json" | "toml" | "png");
    },
    save: () => hooks.save(),
    sql: (q) => {
      if (!dbHub.db) throw new Error("The database is not open");
      return dbHub.db.query(q, 200);
    },
    routing: () => S().tool === "route",
    routeStep: (dir, mm) => {
      const [l, d] = DIR_LETTER(dir, mm);
      if (!hooks.routeCommand(`${l} ${d}`)) S().logLine("Start the pipe first: click a nozzle or a point", "error");
    },
    routeTo: (end) => {
      if (end.ref.kind !== "nozzle") return S().logLine("While drawing, finish at a nozzle; for a tee branch use connect", "error");
      const eq = S().doc.equipment.find((e) => e.id === (end.ref as { eq: string }).eq)!;
      hooks.routeCommand(`TO ${eq.tag}/${(end.ref as { nozzle: string }).nozzle}`);
    },
    routeFinish: (flanged) => void hooks.routeCommand(flanged ? "FLANGED" : "FINISH"),
    startRoute: (from) => {
      if (from?.ref.kind === "nozzle") {
        const eq = S().doc.equipment.find((e) => e.id === (from.ref as { eq: string }).eq)!;
        hooks.startRoute(`${eq.tag}/${(from.ref as { nozzle: string }).nozzle}`);
      } else hooks.startRoute();
    },
    history: () => typed,
    clear: () => S().set({ log: [] }),
  };
}

let env: Env | null = null;

export function runCommand(raw: string, hooks: CliHooks): void {
  const text = raw.trim();
  if (!text) return;
  env ??= makeEnv(hooks);
  S().logLine(text, "in");
  typed.push(text);
  execute(text, env, session);
  saveMacros(session.macros);
  useStatus.setState({ it: session.it.map((r) => r.name).join(", ") });
}

/** Suggestions for the command window while typing. */
export function suggestFor(text: string): Suggestions {
  const st = S();
  return suggest(text, new World(st.doc, st.model, session.it, selectionRefs()), session.macros);
}
