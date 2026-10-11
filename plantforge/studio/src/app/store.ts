// Application state: the document, its computed model, undo history, selection and tools.

import { create } from "zustand";
import type { ObjRef } from "../engine/commands";
import { Model, computeModel, runClash } from "../engine/compute";
import type { PlantDoc, TemplateId } from "../engine/doc";

export type ToolId = "select" | "move" | "place" | "rack" | "route" | "insert" | "connect" | "measure";

export interface Toast {
  id: number;
  text: string;
  kind: "ok" | "error" | "info";
}

export interface NewLineSettings {
  nps: string;
  spec: string;
  fluid: string;
  service: string;
}

export interface State {
  doc: PlantDoc;
  model: Model;
  history: { doc: PlantDoc; label: string }[];
  future: { doc: PlantDoc; label: string }[];
  lastLabel: string;
  selection: string[];
  focus: ObjRef | null;
  tool: ToolId;
  template: TemplateId;
  inlineType: "gate" | "globe" | "check" | "tee";
  newLine: NewLineSettings;
  prompt: string;
  showClashes: boolean;
  labels: boolean;
  clearance: number;
  workingZ: number;
  section: { lo: [number, number, number]; hi: [number, number, number] } | null;
  log: { text: string; kind: "in" | "out" | "error" }[];
  toasts: Toast[];
  savedAt: number | null;
  dirty: boolean;
  panel: "props" | "todo" | "clash" | "mto" | "lines";
  isoLine: string | null;
  assistantOpen: boolean;
  projectsOpen: boolean;
  helpOpen: boolean;
}

export interface Actions {
  load(doc: PlantDoc, label?: string): void;
  apply(doc: PlantDoc, label: string): void;
  preview(doc: PlantDoc): void;
  undo(): void;
  redo(): void;
  select(uids: string[], focus?: ObjRef | null): void;
  setTool(tool: ToolId, opts?: Partial<Pick<State, "template" | "inlineType">>): void;
  set(patch: Partial<State>): void;
  toast(text: string, kind?: Toast["kind"]): void;
  logLine(text: string, kind?: "in" | "out" | "error"): void;
  rerunClash(): void;
}

let toastId = 1;

const compute = (doc: PlantDoc, clearance: number) => {
  const m = computeModel(doc, { clash: false });
  m.clashes = runClash(m, clearance);
  return m;
};

export const useStore = create<State & Actions>((set, get) => ({
  doc: { version: 1, project: { name: "", plant: "", area: "", unit: "" }, equipment: [], structures: [], lines: [], seq: 1 },
  model: computeModel({ version: 1, project: { name: "", plant: "", area: "", unit: "" }, equipment: [], structures: [], lines: [], seq: 1 }),
  history: [],
  future: [],
  lastLabel: "",
  selection: [],
  focus: null,
  tool: "select",
  template: "pump",
  inlineType: "gate",
  newLine: { nps: "4", spec: "A1A", fluid: "Process", service: "P" },
  prompt: "",
  showClashes: true,
  labels: true,
  clearance: 0,
  workingZ: 0,
  section: null,
  log: [],
  toasts: [],
  savedAt: null,
  dirty: false,
  panel: "props",
  isoLine: null,
  assistantOpen: false,
  projectsOpen: false,
  helpOpen: false,

  load(doc, label = "Opened") {
    set({ doc, model: compute(doc, get().clearance), history: [], future: [], selection: [], focus: null, lastLabel: label, dirty: false, isoLine: null });
  },

  apply(doc, label) {
    const { doc: prev, history, clearance } = get();
    set({
      doc,
      model: compute(doc, clearance),
      history: [...history.slice(-99), { doc: prev, label }],
      future: [],
      lastLabel: label,
      dirty: true,
    });
    get().select(get().selection.filter((u) => get().model.byUid.has(u)), get().focus);
  },

  preview(doc) {
    set({ model: computeModel(doc, { clash: false }) });
  },

  undo() {
    const { history, doc, future, lastLabel, clearance } = get();
    const h = history[history.length - 1];
    if (!h) return;
    set({ doc: h.doc, model: compute(h.doc, clearance), history: history.slice(0, -1), future: [...future, { doc, label: lastLabel }], lastLabel: h.label, dirty: true });
    get().toast(`Undid: ${lastLabel}`, "info");
  },

  redo() {
    const { history, doc, future, lastLabel, clearance } = get();
    const f = future[future.length - 1];
    if (!f) return;
    set({ doc: f.doc, model: compute(f.doc, clearance), future: future.slice(0, -1), history: [...history, { doc, label: lastLabel }], lastLabel: f.label, dirty: true });
    get().toast(`Redid: ${f.label}`, "info");
  },

  select(uids, focus) {
    const model = get().model;
    let f = focus;
    if (f === undefined) {
      const c = uids.length ? model.byUid.get(uids[uids.length - 1]) : undefined;
      f = c ? { type: c.owner.type, id: c.owner.id } : null;
    }
    set({ selection: uids, focus: f, panel: uids.length || f ? "props" : get().panel });
  },

  setTool(tool, opts = {}) {
    set({ tool, ...opts, prompt: "" });
  },

  set(patch) {
    set(patch);
  },

  toast(text, kind = "ok") {
    const id = toastId++;
    set({ toasts: [...get().toasts.slice(-3), { id, text, kind }] });
    setTimeout(() => set({ toasts: get().toasts.filter((t) => t.id !== id) }), kind === "error" ? 6000 : 3500);
  },

  logLine(text, kind = "out") {
    set({ log: [...get().log.slice(-200), { text, kind }] });
  },

  rerunClash() {
    const m = get().model;
    set({ model: { ...m, clashes: runClash(m, get().clearance) } });
  },
}));

export const store = useStore;
