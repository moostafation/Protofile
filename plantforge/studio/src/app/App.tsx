import { useCallback, useEffect, useState } from "react";
import { deleteObject } from "../engine/commands";
import { demoDoc } from "../engine/demo";
import { dbHub, installDatabaseSync, restoreOrCreate, schedulePersist } from "../db/service";
import { installSharedSync, joinShared } from "../db/shared";
import { cloud, currentUser, loadDraft, sampleFn } from "../platform/claude";
import { DatabaseManager } from "./DatabaseManager";
import { Assistant } from "./Assistant";
import { CommandBar, Help, IsoView, Projects, StatusBar, Toasts, TopBar } from "./Chrome";
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
  const dbOpen = useStore((s) => s.dbOpen);
  const [ready, setReady] = useState(false);
  const [projectId, setProjectIdState] = useState<string | null>(null);
  const [assistant, setAssistant] = useState(false);
  const setProjectId = (id: string | null) => {
    dbHub.projectId = id;
    setProjectIdState(id);
    schedulePersist();
  };

  // first load: the plant database kept in this browser, else the demo unit
  useEffect(() => {
    (async () => {
      installDatabaseSync();
      installSharedSync();
      const st = useStore.getState();
      st.set({ user: await currentUser() });
      const draft = loadDraft(); // documents saved by earlier versions (localStorage)
      const { sharedPid } = await restoreOrCreate(() => draft?.doc ?? demoDoc());
      performance.mark("plantforge:db-ready");
      if (sharedPid) {
        // back into the shared plant this browser was working on, with everyone's latest changes
        joinShared(sharedPid).catch((e) => st.toast(`Working on a local copy: ${(e as Error).message}`, "info"));
      }
      setProjectIdState(dbHub.projectId);
      st.logLine("PlantForge Design ready. Type HELP for commands, or /NAME to make an element current.");
      setReady(true);
      sampleFn().then((s) => setAssistant(!!s));
    })().catch((e) => {
      console.error(e);
      useStore.getState().toast(`Could not start the plant database: ${(e as Error).message}`, "error");
    });
  }, []);

  const save = useCallback(async () => {
    const st = useStore.getState();
    const db = dbHub.db;
    if (!db) return;
    if (st.shared) {
      st.set({ dirty: false });
      st.toast(st.shared.status === "readonly" ? "This shared plant is view only for you." : "Shared plant: every change is saved for everyone as you work.", "info");
      return;
    }
    const c = await cloud();
    if (!c) {
      schedulePersist();
      st.set({ dirty: false });
      st.toast("Saved in this browser. Open the page in Claude to save the database to your account.", "info");
      return;
    }
    const id = projectId ?? `${slug(st.doc.project.name)}-${Date.now().toString(36)}`;
    try {
      await c.save(id, db.exportState());
      setProjectId(id);
      st.set({ dirty: false, savedAt: Date.now() });
      st.toast(`Saved “${st.doc.project.name}” to your account`);
    } catch (e) {
      const code = (e as { code?: string }).code;
      st.toast(code === "quota_exceeded" ? "Your project storage is full - delete an old project in Projects." : "Could not save right now. Your work is kept in this browser.", "error");
    }
  }, [projectId]);

  // keyboard
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const t = ev.target as HTMLElement;
      const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
      const st = useStore.getState();
      if (typing && ev.key !== "Escape") return;
      if (st.isoLine || st.projectsOpen || st.helpOpen || st.dbOpen) return;
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
      <StatusBar />
      {isoLine && <IsoView />}
      {projectsOpen && <Projects projectId={projectId} setProjectId={setProjectId} onSave={save} />}
      {helpOpen && <Help />}
      {dbOpen && <DatabaseManager />}
      <Toasts />
    </div>
  );
}
