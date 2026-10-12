// The shared plant: several people model one plant at the same time, like SP3D's central Model
// database. The plant lives in the page's `db` store, one document per object; every session keeps a
// local SQLite copy in step through live snapshots and writes its own transactions back.
//
// Store layout
//   plants/{pid}                      name, area, unit, createdBy (user id), createdAt, updatedAt, objects
//   plants/{pid}/objects/{oid}        type, v (version), data (the object with its metadata), at, by, act
//   plants/{pid}/meta/project         v, project, hierarchy, groups, seq
//   plants/{pid}/log/{chunk}          at, by, entries[] (each session appends to its own chunk)
//   catalogs/{pid}                    v, catalog, specs, by, act (editors only: rule write = admin)
//
// Concurrency: a transaction leases every object it changes (acquire), re-reads their versions and
// writes only if nobody changed them since this session last saw them. Otherwise nothing is written,
// the session reloads the other person's version and says so - no silent overwrites.

import { commits, useStore } from "../app/store";
import { CatalogData, getCatalogData, standardCatalogData } from "../engine/catalog";
import { HierNode, PlantDoc, setIdSuffix } from "../engine/doc";
import { DEFAULT_GROUPS, ModelObject, ObjType, changedIds, objName, objects } from "../engine/meta";
import { PipingSpec, standardSpecs } from "../engine/spec";
import { cap } from "../platform/claude";
import { personName, personNameAsync } from "../platform/people";
import type { DbState } from "./PlantDB";
import { applyCatalog, dbEvents, dbHub, openShared, schedulePersist } from "./service";

type AnyCap = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface SharedPlantMeta {
  id: string;
  name: string;
  area: string;
  unit: string;
  objects: number;
  updatedAt: number;
  createdBy: string;
}

interface Remote {
  v: number;
  type: ObjType;
  data: ModelObject;
}

interface ProjectBody {
  project: PlantDoc["project"];
  hierarchy: HierNode[];
  groups: string[];
  seq: number;
}

interface LogEntry {
  at: string;
  user: string;
  action: string;
  objects: string;
}

interface Session {
  pid: string;
  name: string;
  db: AnyCap;
  me: string;
  tab: string;
  objs: Map<string, Remote>;
  projectV: number;
  catalogV: number;
  inflight: Map<string, number>;
  /** Versions this session's queued edits will write, per object, while they are pending. */
  expected: Map<string, number>;
  pending: Map<string, number>;
  projectExpected: number | null;
  projectPending: number;
  queue: Promise<void>;
  generation: number;
  unsubs: (() => void)[];
  log: { id: string; entries: LogEntry[]; queue: Promise<void> };
}

class Conflict extends Error {}

const S = () => useStore.getState();
let session: Session | null = null;
const LEASE_MS = 3000;
const LOG_CHUNK = 150;

const iso = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 23);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "plant";
const rand = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");
const objPath = (pid: string, oid: string) => `plants/${pid}/objects/${oid}`;
const projectKey = (d: PlantDoc) => JSON.stringify([d.project, d.hierarchy ?? [], d.groups ?? []]);
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function caps(): Promise<{ db: AnyCap; user: AnyCap; me: string }> {
  const [db, user] = await Promise.all([cap("db"), cap("user")]);
  if (!db || !user) throw new Error("Shared plants work when this page is opened in Claude.");
  const me: string | null = await user.id().catch(() => null);
  if (!me) throw new Error("Sign in to Claude to work on a shared plant.");
  return { db, user, me };
}

/** Writes retry once on a transient condition, after a short random pause. */
async function retry<T = AnyCap>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code !== "unavailable" && code !== "resource_exhausted") throw e;
    await delay(300 + Math.random() * 600);
    return fn();
  }
}

function setStatus(status: "connecting" | "live" | "saving" | "offline" | "readonly") {
  const sh = S().shared;
  if (sh && sh.status !== status) S().set({ shared: { ...sh, status } });
}

export const isShared = () => !!session;

export async function sharedAvailable(): Promise<boolean> {
  try {
    await caps();
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ listing, sharing, deleting
export async function listShared(): Promise<SharedPlantMeta[]> {
  const { db } = await caps();
  const snap = await db.collection("plants").get();
  return snap.docs
    .filter((d: AnyCap) => d.exists && d.data()?.name)
    .map((d: AnyCap) => {
      const x = d.data();
      return { id: d.id, name: String(x.name), area: String(x.area ?? ""), unit: String(x.unit ?? ""), objects: Number(x.objects ?? 0), updatedAt: Number(x.updatedAt ?? 0), createdBy: String(x.createdBy ?? "") };
    })
    .sort((a: SharedPlantMeta, b: SharedPlantMeta) => b.updatedAt - a.updatedAt);
}

async function inBatches<T>(items: T[], size: number, fn: (t: T) => Promise<unknown>) {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}

/** Put the plant on screen into the shared database, then work on it there. */
export async function shareCurrent(): Promise<string> {
  const { db, user, me } = await caps();
  const local = dbHub.db;
  if (!local) throw new Error("The plant database is not open yet.");
  const doc = S().doc;
  const pid = `${slug(doc.project.name)}-${Date.now().toString(36)}`;
  const now = Date.now();
  if (await user.canEdit()) await retry(() => db.doc(`catalogs/${pid}`).set({ v: 1, catalog: local.readCatalog(), specs: local.readSpecs(), by: me, act: "Shared the plant" }));
  await retry(() => db.doc(`plants/${pid}/meta/project`).set({ v: 1, project: doc.project, hierarchy: doc.hierarchy ?? [], groups: doc.groups ?? [...DEFAULT_GROUPS], seq: doc.seq }));
  await inBatches(objects(doc), 6, ({ type, obj }) => retry(() => db.doc(objPath(pid, obj.id)).set({ type, v: 1, data: obj, at: now, by: me, act: "Shared the plant" })));
  // the history so far travels with the plant
  let entries: LogEntry[] = local.txns(LOG_CHUNK).reverse().map((t) => ({ at: t.at, user: t.user, action: t.action, objects: t.objects ?? "[]" }));
  entries.push({ at: iso(now), user: me, action: "Shared the plant", objects: "[]" });
  while (JSON.stringify(entries).length > 200_000 && entries.length > 10) entries = entries.slice(Math.floor(entries.length / 2));
  await retry(() => db.doc(`plants/${pid}/log/0-${rand(6)}`).set({ at: now, by: me, entries }));
  await retry(() => db.doc(`plants/${pid}`).set({ name: doc.project.name || "Untitled plant", area: doc.project.area, unit: doc.project.unit, createdBy: me, createdAt: now, updatedAt: now, objects: objects(doc).length }));
  await joinShared(pid);
  return pid;
}

/** Remove a shared plant for everyone (editors only). */
export async function deleteShared(pid: string) {
  const { db } = await caps();
  if (session?.pid === pid) leaveShared(true);
  const [objs, logs] = await Promise.all([db.collection(`plants/${pid}/objects`).get(), db.collection(`plants/${pid}/log`).get()]);
  await inBatches(objs.docs, 6, (d: AnyCap) => retry(() => db.doc(objPath(pid, d.id)).delete()));
  await inBatches(logs.docs, 6, (d: AnyCap) => retry(() => db.doc(`plants/${pid}/log/${d.id}`).delete()));
  await db.doc(`plants/${pid}/meta/project`).delete();
  await db.doc(`catalogs/${pid}`).delete().catch(() => undefined);
  await db.doc(`plants/${pid}`).delete();
}

// ------------------------------------------------------------------ joining and leaving
const sortObjs = (list: Remote[]) => list.sort((a, b) => (a.data.meta?.createdAt ?? 0) - (b.data.meta?.createdAt ?? 0) || (a.data.id < b.data.id ? -1 : 1));

function buildDoc(objs: Map<string, Remote>, p: ProjectBody): PlantDoc {
  const list = sortObjs([...objs.values()]);
  const of = <T extends ModelObject>(t: ObjType) => list.filter((r) => r.type === t).map((r) => r.data as T);
  return { version: 1, project: p.project, hierarchy: p.hierarchy, groups: p.groups, seq: p.seq, equipment: of("equipment"), lines: of("line"), structures: of("structure") } as PlantDoc;
}

/** Open a shared plant: load it, keep it live, and write this session's transactions to it. */
export async function joinShared(pid: string) {
  const { db, user, me } = await caps();
  leaveShared(true);
  S().set({ shared: { plantId: pid, name: "…", status: "connecting" } });
  try {
    const [plant, proj, cat, objSnap, logSnap] = await Promise.all([
      db.doc(`plants/${pid}`).get(),
      db.doc(`plants/${pid}/meta/project`).get(),
      db.doc(`catalogs/${pid}`).get(),
      db.collection(`plants/${pid}/objects`).get(),
      db.collection(`plants/${pid}/log`).orderBy("at", "desc").limit(8).get(),
    ]);
    if (!plant.exists) throw new Error("That shared plant no longer exists.");
    const objs = new Map<string, Remote>();
    for (const d of objSnap.docs) {
      const x = d.exists ? d.data() : null;
      if (x && typeof x.v === "number" && x.data) objs.set(d.id, { v: x.v, type: x.type, data: x.data });
    }
    const pb = proj.exists ? (proj.data() as ProjectBody & { v: number }) : null;
    const body: ProjectBody = {
      project: pb?.project ?? { name: plant.data().name, plant: "", area: plant.data().area ?? "", unit: plant.data().unit ?? "" },
      hierarchy: pb?.hierarchy ?? [],
      groups: pb?.groups ?? [...DEFAULT_GROUPS],
      seq: Math.max(pb?.seq ?? 1, objs.size + 1),
    };
    const cb = cat.exists ? (cat.data() as { v: number; catalog: CatalogData; specs: Record<string, PipingSpec> }) : null;
    const txns: LogEntry[] = logSnap.docs
      .flatMap((d: AnyCap) => (d.exists ? (d.data().entries as LogEntry[]) ?? [] : []))
      .sort((a: LogEntry, b: LogEntry) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    const name = String(plant.data().name ?? pid);
    await openShared(buildDoc(objs, body), cb?.catalog ?? standardCatalogData(), cb?.specs ?? standardSpecs(), txns as DbState["txns"], `Opened shared plant ${name}`, pid);
    const tab = rand(5);
    session = {
      pid,
      name,
      db,
      me,
      tab,
      objs,
      projectV: pb?.v ?? 0,
      catalogV: cb?.v ?? 0,
      inflight: new Map(),
      expected: new Map(),
      pending: new Map(),
      projectExpected: null,
      projectPending: 0,
      queue: Promise.resolve(),
      generation: 0,
      unsubs: [],
      log: { id: `${Date.now().toString(36)}-${tab}`, entries: [], queue: Promise.resolve() },
    };
    setIdSuffix(`-${tab}`);
    dbEvents.catalog = (action) => pushCatalog(action);
    dbEvents.leave = () => leaveShared(true);
    subscribe(session);
    const canWrite: boolean | null = await user.can("data.write").catch(() => null);
    S().set({ shared: { plantId: pid, name, status: canWrite === false ? "readonly" : "live" } });
    dbHub.db?.logTxn(`Joined the shared plant`, me);
    schedulePersist();
  } catch (e) {
    S().set({ shared: null });
    dbHub.sharedPid = null;
    throw e;
  }
}

/** Stop working on the shared plant; the plant on screen stays as a local copy. */
export function leaveShared(quiet = false) {
  if (!session) return;
  session.unsubs.forEach((u) => u());
  session = null;
  dbEvents.catalog = null;
  dbEvents.leave = null;
  setIdSuffix("");
  dbHub.sharedPid = null;
  S().set({ shared: null });
  schedulePersist();
  if (!quiet) S().toast("Left the shared plant. The model stays here as your local copy.", "info");
}

// ------------------------------------------------------------------ incoming changes
let noticeTimer = 0;
/** "Basma: Move P-101A" - one toast per burst of incoming changes. */
function notice(by: string, text: string) {
  clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(async () => S().toast(`${await personNameAsync(by)}${text}`, "info"), 250);
}

function withObject(doc: PlantDoc, oid: string, r: Remote | undefined): PlantDoc {
  const drop = <T extends ModelObject>(list: T[]) => list.filter((o) => o.id !== oid);
  const put = <T extends ModelObject>(list: T[], obj: T) => (list.some((o) => o.id === oid) ? list.map((o) => (o.id === oid ? obj : o)) : [...list, obj]);
  const base = { ...doc, equipment: drop(doc.equipment), lines: drop(doc.lines), structures: drop(doc.structures) };
  if (!r) return base;
  if (r.type === "equipment") return { ...doc, equipment: put(doc.equipment, r.data as PlantDoc["equipment"][number]) };
  if (r.type === "line") return { ...doc, lines: put(doc.lines, r.data as PlantDoc["lines"][number]) };
  return { ...doc, structures: put(doc.structures, r.data as PlantDoc["structures"][number]) };
}

function subscribe(s: Session) {
  const fail = (e: { code?: string }) => {
    if (session !== s) return;
    setStatus("offline");
    S().toast(e.code === "revoked" ? "Access to the shared plant ended. Your changes are no longer saved there." : "Lost the live connection to the shared plant. Reopen it from Projects.", "error");
  };

  s.unsubs.push(
    s.db.collection(`plants/${s.pid}/objects`).onSnapshot((snap: AnyCap) => {
      if (session !== s) return;
      let doc = S().doc;
      let by = "";
      let act = "";
      let changed = false;
      for (const ch of snap.docChanges()) {
        const oid = ch.doc.id as string;
        if (ch.type === "removed") {
          if (!s.objs.has(oid)) continue;
          s.objs.delete(oid);
        } else {
          const x = ch.doc.data();
          if (!x || typeof x.v !== "number" || !x.data) continue;
          const cur = s.objs.get(oid);
          if (cur && cur.v >= x.v) continue;
          s.objs.set(oid, { v: x.v, type: x.type, data: x.data });
          if (s.inflight.get(oid) === x.v) continue; // this session's own write
          by = x.by ?? by;
          act = x.act ?? act;
        }
        const local = objects(doc).find((o) => o.obj.id === oid)?.obj;
        const remote = s.objs.get(oid);
        if (JSON.stringify(local ?? null) === JSON.stringify(remote?.data ?? null)) continue;
        doc = withObject(doc, oid, remote);
        changed = true;
      }
      if (!changed) return;
      S().applyRemote(doc, act || "Change from the shared plant", by || undefined);
      if (by && by !== s.me) notice(by, `: ${act || "changed the model"}`);
    }, fail),
  );

  s.unsubs.push(
    s.db.doc(`plants/${s.pid}/meta/project`).onSnapshot((snap: AnyCap) => {
      if (session !== s || !snap.exists) return;
      const x = snap.data() as ProjectBody & { v: number; by?: string; act?: string };
      if (typeof x.v !== "number" || x.v <= s.projectV) return;
      s.projectV = x.v;
      const doc = S().doc;
      const next = { ...doc, project: x.project, hierarchy: x.hierarchy, groups: x.groups, seq: Math.max(doc.seq, x.seq ?? 1) };
      if (projectKey(next) === projectKey(doc)) return;
      S().applyRemote(next, x.act ?? "Plant settings changed", x.by);
      if (x.by && x.by !== s.me) notice(x.by, `: ${x.act ?? "changed the plant settings"}`);
    }, fail),
  );

  s.unsubs.push(
    s.db.doc(`catalogs/${s.pid}`).onSnapshot((snap: AnyCap) => {
      if (session !== s || !snap.exists) return;
      const x = snap.data() as { v: number; catalog: CatalogData; specs: Record<string, PipingSpec>; by?: string; act?: string };
      if (typeof x.v !== "number" || x.v <= s.catalogV) return;
      s.catalogV = x.v;
      if (JSON.stringify(x.catalog) === JSON.stringify(getCatalogData()) && JSON.stringify(x.specs) === JSON.stringify(dbHub.db?.readSpecs())) return;
      applyCatalog(x.catalog, x.specs, x.act ?? "Catalog changed", x.by ?? "");
      if (x.by && x.by !== s.me) notice(x.by, ` changed the catalog: ${x.act ?? ""}`);
    }, fail),
  );
}

// ------------------------------------------------------------------ outgoing transactions
/** Installed once at start-up: every committed edit in a shared plant becomes a shared transaction. */
export function installSharedSync() {
  commits.add((next, label, kind, prev) => {
    const s = session;
    if (!s || kind === "load" || kind === "remote") return;
    const { upserts, deletes } = changedIds(prev, next);
    const projChanged = projectKey(prev) !== projectKey(next);
    if (!upserts.length && !deletes.length && !projChanged) return;
    // The versions this edit was made on: the shared version, or the one this session's own queued edits
    // will write. A change from someone else in between makes the save fail instead of overwriting it.
    const base = new Map<string, number>();
    for (const oid of [...upserts, ...deletes]) {
      const b = s.expected.get(oid) ?? s.objs.get(oid)?.v ?? 0;
      base.set(oid, b);
      s.expected.set(oid, deletes.includes(oid) ? 0 : b + 1);
      s.pending.set(oid, (s.pending.get(oid) ?? 0) + 1);
    }
    const projBase = s.projectExpected ?? s.projectV;
    if (projChanged) {
      s.projectExpected = projBase + 1;
      s.projectPending += 1;
    }
    const tx: Tx = { label, next, upserts, deletes, projChanged, base, projBase, gen: s.generation };
    s.queue = s.queue.then(() => push(s, tx)).then(() => settle(s, tx), (e) => failed(s, label, e));
  });
}

interface Tx {
  label: string;
  next: PlantDoc;
  upserts: string[];
  deletes: string[];
  projChanged: boolean;
  base: Map<string, number>;
  projBase: number;
  gen: number;
}

/** A transaction left the queue: forget its expected versions once nothing else is pending on them. */
function settle(s: Session, tx: Tx) {
  if (tx.gen !== s.generation) return;
  for (const oid of [...tx.upserts, ...tx.deletes]) {
    const n = (s.pending.get(oid) ?? 1) - 1;
    if (n > 0) s.pending.set(oid, n);
    else {
      s.pending.delete(oid);
      s.expected.delete(oid);
    }
  }
  if (tx.projChanged && --s.projectPending <= 0) {
    s.projectPending = 0;
    s.projectExpected = null;
  }
}

async function push(s: Session, tx: Tx) {
  if (session !== s || tx.gen !== s.generation) return; // dropped after an earlier failure
  const { label, next, upserts, deletes, projChanged, base } = tx;
  setStatus("saving");
  const ids = [...upserts, ...deletes];
  const refs = ids.map((oid) => s.db.doc(objPath(s.pid, oid)));
  const projRef = s.db.doc(`plants/${s.pid}/meta/project`);
  const all = projChanged ? [...refs, projRef] : refs;
  const nameOf = (oid: string) => {
    const o = objects(next).find((x) => x.obj.id === oid)?.obj ?? s.objs.get(oid)?.data;
    return o ? objName(o) : oid;
  };

  // 1. lease everything this transaction touches
  const leases: { acquired: boolean }[] = await Promise.all(all.map((r: AnyCap) => retry<{ acquired: boolean }>(() => r.acquire({ holder: s.tab, ttlMs: LEASE_MS }))));
  const busy = leases.map((l, i) => (l.acquired ? null : i < ids.length ? nameOf(ids[i]) : "the plant settings")).filter(Boolean);
  if (busy.length) throw new Conflict(`${busy.join(", ")} ${busy.length > 1 ? "are" : "is"} being saved by someone else right now`);

  // 2. nobody changed them since the version this edit was made on
  const snaps = await Promise.all(all.map((r: AnyCap) => retry(() => r.get())));
  const stale: string[] = [];
  let staleBy = "";
  snaps.forEach((snap: AnyCap, i: number) => {
    const x = snap.exists ? snap.data() : null;
    const remoteV = x && typeof x.v === "number" ? x.v : 0;
    const baseV = i < ids.length ? (base.get(ids[i]) ?? 0) : tx.projBase;
    if (remoteV !== baseV) {
      stale.push(i < ids.length ? nameOf(ids[i]) : "the plant settings");
      staleBy = x?.by ?? staleBy;
      if (i < ids.length && x?.data) s.objs.set(ids[i], { v: remoteV, type: x.type, data: x.data });
      if (i < ids.length && !x?.data) s.objs.delete(ids[i]);
    }
  });
  if (stale.length) throw new Conflict(`${stale.join(", ")} ${stale.length > 1 ? "were" : "was"} changed${staleBy && staleBy !== s.me ? ` by ${personName(staleBy)}` : ""} in the meantime`);

  // 3. write
  const now = Date.now();
  const byId = new Map(objects(next).map((o) => [o.obj.id, o]));
  const touched: { oid: string; name: string; op: string }[] = [];
  await Promise.all(
    upserts.map(async (oid, i) => {
      const o = byId.get(oid)!;
      const v = (base.get(oid) ?? 0) + 1;
      touched.push({ oid, name: objName(o.obj), op: base.get(oid) ? "modified" : "created" });
      s.inflight.set(oid, v);
      await retry(() => refs[i].set({ type: o.type, v, data: o.obj, at: now, by: s.me, act: label }));
      s.objs.set(oid, { v, type: o.type, data: o.obj });
    }),
  );
  await Promise.all(
    deletes.map(async (oid, j) => {
      touched.push({ oid, name: nameOf(oid), op: "deleted" });
      await retry(() => refs[upserts.length + j].delete());
      s.objs.delete(oid);
    }),
  );
  if (projChanged) {
    const v = tx.projBase + 1;
    await retry(() => projRef.set({ v, project: next.project, hierarchy: next.hierarchy ?? [], groups: next.groups ?? [], seq: next.seq, by: s.me, act: label }));
    s.projectV = v;
  }
  for (const oid of upserts) s.inflight.delete(oid);
  appendLog(s, { at: iso(now), user: s.me, action: label, objects: JSON.stringify(touched) });
  // the plant's summary row: one write at a time, after this transaction's own writes
  const summary = { updatedAt: now, objects: s.objs.size, area: next.project.area, unit: next.project.unit };
  s.log.queue = s.log.queue.then(() => s.db.doc(`plants/${s.pid}`).update(summary)).catch(() => undefined);
  if (session === s && tx.gen === s.generation) setStatus("live");
}

/** A transaction that could not be saved: drop it (and anything queued after it) and show the shared truth. */
function failed(s: Session, label: string, e: unknown) {
  if (session !== s) return;
  s.generation += 1;
  s.inflight.clear();
  s.expected.clear();
  s.pending.clear();
  s.projectExpected = null;
  s.projectPending = 0;
  const code = (e as { code?: string }).code;
  const doc = S().doc;
  const truth = buildDoc(s.objs, { project: doc.project, hierarchy: doc.hierarchy ?? [], groups: doc.groups ?? [], seq: doc.seq });
  S().applyRemote(truth, `Not saved: ${label}`, s.me);
  if (e instanceof Conflict) {
    S().toast(`Not saved: “${label}”. ${e.message}. The plant now shows the shared version - please redo your change.`, "error");
    setStatus("live");
  } else if (code === "invalid_argument") {
    S().toast(`Not saved: “${label}”. You can view this shared plant but not change it.`, "error");
    setStatus("readonly");
  } else {
    S().toast(`Not saved: “${label}”. The shared plant cannot be reached right now.`, "error");
    setStatus("offline");
  }
}

function appendLog(s: Session, entry: LogEntry) {
  s.log.entries.push(entry);
  if (s.log.entries.length > LOG_CHUNK) s.log = { id: `${Date.now().toString(36)}-${s.tab}`, entries: [entry], queue: s.log.queue };
  const log = s.log;
  const body = { at: Date.now(), by: s.me, entries: [...log.entries] };
  log.queue = log.queue.then(() => retry<void>(() => s.db.doc(`plants/${s.pid}/log/${log.id}`).set(body))).catch(() => undefined);
}

async function pushCatalog(action: string) {
  const s = session;
  const local = dbHub.db;
  if (!s || !local) return;
  const ref = s.db.doc(`catalogs/${s.pid}`);
  try {
    const lease = await retry<{ acquired: boolean }>(() => ref.acquire({ holder: s.tab, ttlMs: LEASE_MS }));
    if (!lease.acquired) throw new Conflict("someone else is saving the catalog right now");
    const snap = await retry<AnyCap>(() => ref.get());
    const x = snap.exists ? snap.data() : null;
    if ((x && typeof x.v === "number" ? x.v : 0) !== s.catalogV) throw new Conflict("the catalog was changed by someone else in the meantime");
    const v = s.catalogV + 1;
    await retry(() => ref.set({ v, catalog: local.readCatalog(), specs: local.readSpecs(), by: s.me, act: action }));
    s.catalogV = v;
    appendLog(s, { at: iso(Date.now()), user: s.me, action, objects: "[]" });
  } catch (e) {
    const code = (e as { code?: string }).code;
    S().toast(
      e instanceof Conflict ? `Catalog not shared: ${e.message}. Reopen the plant to get the latest catalog.` : code === "invalid_argument" ? "Only editors of this page can change the shared catalog. Your change stays on this computer." : "The catalog change could not be shared right now.",
      "error",
    );
  }
}
