// Keeps the plant database in step with the application: every committed transaction is written to
// SQLite (with an audit-trail row), report tables are refreshed when the user pauses, and the database
// file is kept in this browser.

import { useStore, commits } from "../app/store";
import { CatalogData, setCatalogData, standardCatalogData } from "../engine/catalog";
import type { PlantDoc } from "../engine/doc";
import { normalizeDoc } from "../engine/meta";
import { PipingSpec, setSpecs, standardSpecs } from "../engine/spec";
import { idbGet, idbSet } from "../platform/idb";
import { knownPeople } from "../platform/people";
import { DbState, PlantDB } from "./PlantDB";

const IDB_KEY = "plant-db";

/** The plant database file on this computer (desktop program). */
export interface PlantFile {
  path: string;
  name: string;
}

export const dbHub: { db: PlantDB | null; projectId: string | null; sharedPid: string | null; file: PlantFile | null } = { db: null, projectId: null, sharedPid: null, file: null };

/** What is kept between visits: the database file itself, and where it came from. */
export interface WorkingCopy {
  bytes: Uint8Array;
  projectId: string | null;
  sharedPid?: string | null;
  file?: PlantFile | null;
  /** Changes not yet saved to `file`. */
  dirty?: boolean;
  at: number;
}

/** Hooks for the shared plant: catalog edits made here are pushed to everyone. */
export const dbEvents: { catalog: ((action: string) => void) | null; leave: (() => void) | null } = { catalog: null, leave: null };

let refreshTimer = 0;
let persistTimer = 0;
let suppress = false;

const S = () => useStore.getState();

function bump() {
  useStore.setState({ dbRev: S().dbRev + 1 });
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => {
    if (!dbHub.db) return;
    try {
      dbHub.db.refreshDerived(S().model);
      dbHub.db.setPeople(knownPeople());
      bump();
    } catch (e) {
      console.error("report refresh failed", e);
    }
  }, 350);
}

export function schedulePersist() {
  clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => void persistNow(), 1200);
}

/** Keep the working copy now (before the desktop window closes, after saving to a file). */
export async function persistNow(): Promise<void> {
  clearTimeout(persistTimer);
  if (!dbHub.db) return;
  const copy: WorkingCopy = { bytes: dbHub.db.export(), projectId: dbHub.projectId, sharedPid: dbHub.sharedPid, file: dbHub.file, dirty: S().dirty, at: Date.now() };
  await idbSet(IDB_KEY, copy);
}

export const readWorkingCopy = () => idbGet<WorkingCopy>(IDB_KEY);

/** Drop the working copy (the user chose not to keep unsaved changes). */
export async function forgetWorkingCopy(): Promise<void> {
  clearTimeout(persistTimer);
  await idbSet(IDB_KEY, null);
}

/** Route committed transactions into the database. Installed once at start-up. */
export function installDatabaseSync() {
  commits.add((doc, label, kind, _prev, by) => {
    if (suppress || kind === "load" || !dbHub.db) return;
    dbHub.db.saveDoc(doc, { action: label, user: kind === "remote" ? (by ?? "remote") : S().user.id });
    bump();
    scheduleRefresh();
    schedulePersist();
  });
}

function activate(db: PlantDB, label: string, projectId: string | null, sharedPid: string | null = null, file: PlantFile | null = null) {
  if (!sharedPid) dbEvents.leave?.(); // opening anything else ends work on the shared plant
  dbHub.db?.close();
  dbHub.db = db;
  dbHub.projectId = projectId;
  dbHub.sharedPid = sharedPid;
  dbHub.file = file;
  S().set({ file });
  setCatalogData(db.readCatalog());
  setSpecs(db.readSpecs());
  suppress = true;
  try {
    S().load(db.readDoc(), label);
  } finally {
    suppress = false;
  }
  // load() may have added metadata (older documents): write it back silently
  db.saveDoc(S().doc, { action: "Upgrade object metadata", user: "system" }, "changes");
  db.refreshDerived(S().model);
  db.setPeople(knownPeople());
  bump();
  schedulePersist();
}

/** A new database around a document (new plant, demo, JSON import) with the standard catalog and specs. */
export async function newDatabase(doc: PlantDoc, label: string, projectId: string | null = null) {
  const db = await PlantDB.create(normalizeDoc(doc, S().user), standardCatalogData(), standardSpecs());
  activate(db, label, projectId);
}

export async function openState(state: DbState | { doc: PlantDoc }, label: string, projectId: string | null) {
  const full: DbState = "catalog" in state ? state : { doc: state.doc, catalog: standardCatalogData(), specs: standardSpecs() };
  activate(await PlantDB.fromState(full), label, projectId);
}

/** A plant database file; `file` is where it lives on this computer (desktop), so Save writes back to it. */
export async function openBytes(bytes: Uint8Array, label: string, file: PlantFile | null = null) {
  activate(await PlantDB.open(bytes), label, null, null, file);
}

/** A local copy of a shared plant: its document, catalog and the shared transaction log. */
export async function openShared(doc: PlantDoc, catalog: CatalogData, specs: Record<string, PipingSpec>, txns: DbState["txns"], label: string, sharedPid: string) {
  const db = await PlantDB.create(doc, catalog, specs);
  db.importTxns(txns ?? [], true);
  activate(db, label, null, sharedPid);
}

/** Start-up: the database kept in this browser (and the shared plant it belongs to), else the fallback. */
export async function restoreOrCreate(fallback: () => PlantDoc): Promise<{ how: "restored" | "created"; sharedPid: string | null }> {
  const saved = await idbGet<{ bytes: Uint8Array; projectId: string | null; sharedPid?: string | null }>(IDB_KEY);
  if (saved?.bytes) {
    try {
      activate(await PlantDB.open(saved.bytes), "Restored your plant database", saved.projectId ?? null, saved.sharedPid ?? null);
      return { how: "restored", sharedPid: saved.sharedPid ?? null };
    } catch {
      /* fall through to a fresh database */
    }
  }
  await newDatabase(fallback(), "Demo unit");
  return { how: "created", sharedPid: null };
}

/** A catalog change that arrived from the shared plant. */
export function applyCatalog(catalog: CatalogData, specs: Record<string, PipingSpec>, action: string, by: string) {
  const db = dbHub.db;
  if (!db) return;
  db.writeCatalog(catalog);
  db.writeSpecs(specs);
  setCatalogData(db.readCatalog());
  setSpecs(db.readSpecs());
  db.logTxn(action, by);
  S().recompute();
  scheduleRefresh();
  schedulePersist();
}

/** After editing catalog or spec tables: reload them into the engine, re-route, log and persist. */
export function catalogChanged(action: string): string[] {
  const db = dbHub.db;
  if (!db) return [];
  setCatalogData(db.readCatalog());
  setSpecs(db.readSpecs());
  db.logTxn(action, S().user.id);
  S().recompute();
  S().set({ dirty: true });
  scheduleRefresh();
  schedulePersist();
  dbEvents.catalog?.(action);
  return db.checkCatalog();
}

export function resetCatalog() {
  const db = dbHub.db;
  if (!db) return;
  db.writeCatalog(standardCatalogData());
  db.writeSpecs(standardSpecs());
  catalogChanged("Reset catalog and specs to the standard tables");
}
