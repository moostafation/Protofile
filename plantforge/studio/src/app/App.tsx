import { useCallback, useEffect, useState } from "react";
import { deleteObject } from "../engine/commands";
import { demoDoc } from "../engine/demo";
import { cloud, loadDraft, sampleFn, saveDraft } from "../platform/claude";
import { Assistant } from "./Assistant";
import { CommandBar, Help, IsoView, Projects, Toasts, TopBar } from "./Chrome";
import { Explorer } from "./Explorer";
import { hub } from "./hub";
import { Ribbon } from "./Ribbon";
import { SidePanel } from "./SidePanel";
import { useStore } from "./store";
import { Viewport } from "./Viewport";

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "plant";

export function App() {
  const isoLine = useStore((s) => s.isoLine);
  const assistantOpen = useStore((s) => s.assistantOpen);
  const projectsOpen = useStore((s) => s.projectsOpen);
  const helpOpen = useStore((s) => s.helpOpen);
  const [ready, setReady] = useState(false);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [assistant, setAssistant] = useState(false);

  // first load: the last draft in this browser, else the demo unit
  useEffect(() => {
    const draft = loadDraft();
    const st = useStore.getState();
    if (draft) {
      st.load(draft.doc, "Restored your last session");
      setProjectId(draft.projectId);
    } else st.load(demoDoc(), "Demo unit");
    st.logLine("PlantForge Studio ready. Type HELP for commands.");
    setReady(true);
    sampleFn().then((s) => setAssistant(!!s));
  }, []);

  // keep a draft in this browser (per-viewer convenience; the account copy is saved explicitly)
  useEffect(() => {
    let t = 0;
    return useStore.subscribe((s, p) => {
      if (s.doc === p.doc) return;
      clearTimeout(t);
      t = window.setTimeout(() => saveDraft(s.doc, projectId), 700);
    });
  }, [projectId]);

  const save = useCallback(async () => {
    const st = useStore.getState();
    const c = await cloud();
    if (!c) {
      saveDraft(st.doc, projectId);
      st.set({ dirty: false });
      st.toast("Saved in this browser. Open the page in Claude to save to your account.", "info");
      return;
    }
    const id = projectId ?? `${slug(st.doc.project.name)}-${Date.now().toString(36)}`;
    try {
      await c.save(id, st.doc);
      setProjectId(id);
      st.set({ dirty: false, savedAt: Date.now() });
      st.toast(`Saved “${st.doc.project.name}” to your account`);
    } catch (e) {
      const code = (e as { code?: string }).code;
      st.toast(code === "quota_exceeded" ? "Your project storage is full - delete an old project in Projects." : "Could not save right now. Your work is kept in this browser.", "error");
      saveDraft(st.doc, projectId);
    }
  }, [projectId]);

  // keyboard
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const t = ev.target as HTMLElement;
      const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
      const st = useStore.getState();
      if (typing && ev.key !== "Escape") return;
      if (st.isoLine || st.projectsOpen || st.helpOpen) return;
      if (hub.tool?.key?.(ev)) return ev.preventDefault();
      const mod = ev.ctrlKey || ev.metaKey;
      if (mod && ev.key.toLowerCase() === "z") {
        ev.preventDefault();
        return ev.shiftKey ? st.redo() : st.undo();
      }
      if (mod && ev.key.toLowerCase() === "y") return ev.preventDefault(), st.redo();
      if (mod && ev.key.toLowerCase() === "s") return ev.preventDefault(), save();
      if (ev.key === "Escape") {
        if (hub.tool?.cancel?.()) return;
        if (st.tool !== "select") return st.setTool("select");
        return st.select([], null);
      }
      if (ev.key === "Delete" && st.focus) {
        const f = st.focus;
        const label = f.type === "equipment" ? st.doc.equipment.find((e) => e.id === f.id)?.tag : f.type === "line" ? st.doc.lines.find((l) => l.id === f.id)?.number : st.doc.structures.find((x) => x.id === f.id)?.tag;
        st.apply(deleteObject(st.doc, f), `Delete ${label}`);
        return st.select([], null);
      }
      if (ev.key.toLowerCase() === "f" && !mod) return hub.viewer?.fit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  return (
    <div className={`app${assistantOpen ? " with-assistant" : ""}`}>
      <TopBar assistantAvailable={assistant} projectId={projectId} onSave={save} />
      <Ribbon />
      <div className="work">
        <Explorer />
        {ready && <Viewport />}
        <SidePanel />
        {assistantOpen && <Assistant />}
      </div>
      <CommandBar />
      {isoLine && <IsoView />}
      {projectsOpen && <Projects projectId={projectId} setProjectId={setProjectId} onSave={save} />}
      {helpOpen && <Help />}
      <Toasts />
    </div>
  );
}
