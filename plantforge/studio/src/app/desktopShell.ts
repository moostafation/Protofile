// The Studio inside the desktop program: plant database files on this computer, the native menus,
// the window title, unsaved-changes prompts, crash recovery and auto-save. Does nothing in a browser.

import { databaseZip, decodePlantFile, reportsZip, safeName } from "../db/files";
import { dbHub, forgetWorkingCopy, newDatabase, openBytes, persistNow, readWorkingCopy } from "../db/service";
import { demoDoc } from "../engine/demo";
import { emptyDoc } from "../engine/doc";
import { DesktopFile, MenuCommand, desktop } from "../platform/desktop";
import { saveFile } from "../platform/claude";
import { runCommand } from "./cli";
import { exportCurrent } from "./exporters";
import { cliHooks, deleteFocused, hub } from "./hub";
import { useStore } from "./store";

const S = () => useStore.getState();

let autoSave = false;
let saving: Promise<boolean> | null = null;

const plantName = () => dbHub.file?.name ?? (S().doc.project.name || "this plant");

function framed() {
  setTimeout(() => hub.viewer?.setView("iso-sw"), 50);
}

/** Open what a file holds. A .pfdb/.sqlite stays linked to its file (Save writes back to it);
 *  a backup .zip or a .json model opens as a new, not yet saved plant. */
async function openFile(f: { path: string | null; name: string; bytes: Uint8Array }, quiet = false): Promise<boolean> {
  try {
    const c = decodePlantFile(f.bytes);
    if (c.kind === "sqlite") await openBytes(c.bytes, `Opened ${f.name}`, c.fromZip || !f.path ? null : { path: f.path, name: f.name });
    else await newDatabase(c.doc, `Opened ${f.name}`);
    if (!quiet) S().toast(c.kind === "sqlite" && !c.fromZip ? `Opened ${f.name}` : `Opened ${f.name} as a new plant - Save to keep it as a .pfdb file`);
    framed();
    return true;
  } catch (e) {
    S().toast(`Could not open ${f.name}: ${(e as Error).message}`, "error");
    return false;
  }
}

/** Before replacing the plant: offer to save unsaved changes. False when the user cancels. */
export async function confirmDiscard(action: string): Promise<boolean> {
  if (!desktop || !S().dirty) return true;
  const r = await desktop.ask({
    type: "warning",
    message: `Save the changes to ${plantName()} before ${action}?`,
    detail: "If you don't save, the changes since the last save are lost.",
    buttons: ["Save", "Don't save", "Cancel"],
    defaultId: 0,
    cancelId: 2,
  });
  if (r === 2) return false;
  if (r === 0) return saveToFile();
  return true;
}

/** Save the plant database to its file (or ask where: Save as, or a plant not yet saved to a file). */
export async function saveToFile(saveAs = false, quiet = false): Promise<boolean> {
  if (!desktop) return false;
  if (saving) return saving;
  const bridge = desktop;
  saving = (async () => {
    const db = dbHub.db;
    if (!db) return false;
    const doc = S().doc;
    try {
      const res = await bridge.saveFile({ path: saveAs ? null : (dbHub.file?.path ?? null), bytes: db.export(), suggestedName: safeName(doc.project.name || "plant") });
      if (!res) return false;
      dbHub.file = res;
      // anything changed while the file was being written is still unsaved
      S().set({ file: res, dirty: S().doc !== doc, savedAt: Date.now() });
      await persistNow();
      if (!quiet) S().toast(`Saved ${res.name}`);
      return true;
    } catch (e) {
      S().toast(`Could not save ${plantName()}: ${(e as Error).message}`, "error");
      return false;
    }
  })();
  try {
    return await saving;
  } finally {
    saving = null;
  }
}

export async function openWithDialog(): Promise<void> {
  if (!desktop || !(await confirmDiscard("opening another plant"))) return;
  try {
    const f = await desktop.openDialog();
    if (f) await openFile(f);
  } catch (e) {
    S().toast(`Could not open: ${(e as Error).message}`, "error");
  }
}

export async function openPath(path: string): Promise<void> {
  if (!desktop || !(await confirmDiscard("opening another plant"))) return;
  let f: DesktopFile;
  try {
    f = await desktop.readFile(path);
  } catch (e) {
    return S().toast(`Could not read ${path}: ${(e as Error).message}`, "error");
  }
  await openFile(f);
}

export async function newPlant(): Promise<void> {
  if (!(await confirmDiscard("starting a new plant"))) return;
  await newDatabase({ ...emptyDoc(), project: { name: "New plant", plant: "", area: "A-100", unit: "U-100" } }, "Started a new plant");
  S().toast("New plant - Save (Ctrl+S) to choose where its file goes");
  framed();
}

export async function openDemo(): Promise<void> {
  if (!(await confirmDiscard("opening the demo unit"))) return;
  await newDatabase(demoDoc(), "Demo unit");
  framed();
}

async function exportKind(kind: string) {
  const db = dbHub.db;
  if (kind === "sqlite" || kind === "reports") {
    if (!db) return;
    const f = (kind === "sqlite" ? databaseZip : reportsZip)(db, S().doc.project.name);
    if ((await saveFile(f.filename, f.blob)) === "saved") S().toast(`Saved ${f.filename}`);
    return;
  }
  await exportCurrent(kind as "zip" | "csv" | "json" | "toml" | "png");
}

const MENU: Record<MenuCommand, (arg?: string | boolean) => unknown> = {
  new: newPlant,
  open: openWithDialog,
  demo: openDemo,
  save: () => saveToFile(),
  "save-as": () => saveToFile(true),
  "auto-save": (on) => {
    autoSave = !!on;
    S().toast(autoSave ? "Every change is now saved to the file automatically" : "Auto-save is off - save with Ctrl+S", "info");
    if (autoSave && S().dirty && dbHub.file) void saveToFile(false, true);
  },
  export: (kind) => exportKind(String(kind)),
  undo: () => S().undo(),
  redo: () => S().redo(),
  delete: () => deleteFocused(),
  run: (text) => runCommand(String(text), cliHooks),
  "focus-command": () => document.getElementById("command-line")?.focus(),
  database: () => S().set({ dbOpen: true, dbPage: "overview" }),
  help: () => S().set({ helpOpen: true }),
};

/** Start-up in the desktop program: the file it was opened with, else the last plant (with any unsaved
 *  changes recovered), else the most recent file, else the demo unit. */
export async function startDesktop(): Promise<void> {
  if (!desktop) return;
  const info = await desktop.info();
  autoSave = info.autoSave;
  const initial = await desktop.initialFile();
  if (initial && "error" in initial) S().toast(`Could not open ${initial.error}`, "error");
  else if (initial && (await openFile(initial))) return;

  const saved = await readWorkingCopy();
  if (saved?.bytes) {
    if (saved.file && !saved.dirty) {
      // the file is the truth: someone may have changed it since
      try {
        if (await openFile(await desktop.readFile(saved.file.path), true)) return;
      } catch {
        S().toast(`${saved.file.name} was not found - opened your last working copy of it`, "info");
      }
    }
    try {
      await openBytes(saved.bytes, saved.file ? `Reopened ${saved.file.name}` : "Reopened your last plant", saved.file ?? null);
      if (saved.dirty) {
        S().set({ dirty: true });
        if (saved.file) S().toast(`Recovered the unsaved changes to ${saved.file.name}`, "info");
      }
      return;
    } catch {
      /* fall through */
    }
  }
  for (const p of info.recent.slice(0, 1)) {
    try {
      if (await openFile(await desktop.readFile(p), true)) return;
    } catch {
      /* moved or deleted */
    }
  }
  await newDatabase(demoDoc(), "Demo unit");
}

/** Menus, window title, drag & drop, auto-save and the close prompt. Installed once after start-up. */
export function installDesktop(): void {
  if (!desktop) return;
  const bridge = desktop;

  bridge.on("menu", (cmd, arg) => void MENU[cmd]?.(arg));
  bridge.on("open-path", (p) => void openPath(p));
  bridge.on("close-requested", async (how) => {
    if (!(await confirmDiscard(how === "reload" ? "reloading" : "closing"))) return;
    if (S().dirty) {
      // "Don't save": next time, open the file as it is on disk (or start fresh)
      if (dbHub.file) {
        S().set({ dirty: false });
        await persistNow();
      } else await forgetWorkingCopy();
    } else await persistNow();
    bridge.closeNow(how);
  });

  // the window title follows the file and its unsaved changes
  const title = () => {
    const s = S();
    bridge.setDocument({ path: s.file?.path ?? null, name: s.doc.project.name, dirty: s.dirty });
  };
  title();
  let autoTimer = 0;
  useStore.subscribe((s, p) => {
    if (s.dirty !== p.dirty || s.file !== p.file || s.doc.project.name !== p.doc.project.name) title();
    if (autoSave && s.file && s.dirty && (s.doc !== p.doc || !p.dirty)) {
      clearTimeout(autoTimer);
      autoTimer = window.setTimeout(() => void saveToFile(false, true), 1500);
    }
  });

  // a plant file dropped on the window opens it
  window.addEventListener("dragover", (e) => {
    if (e.dataTransfer?.types.includes("Files")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  });
  window.addEventListener("drop", async (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    e.preventDefault();
    if (!/\.(pfdb|sqlite3?|db|json|zip)$/i.test(f.name)) return S().toast(`Drop a plant file (.pfdb) on the window to open it`, "info");
    const p = bridge.pathForFile(f);
    if (p) return openPath(p);
    if (await confirmDiscard("opening another plant")) await openFile({ path: null, name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
  });
}
