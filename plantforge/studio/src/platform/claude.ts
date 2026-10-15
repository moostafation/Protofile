// Optional platform capabilities (claude.ai artifact runtime). Every feature degrades gracefully when absent.

import type { PlantDoc } from "../engine/doc";
import type { User } from "../engine/meta";
import type { DbState } from "../db/PlantDB";
import { desktop } from "./desktop";
import { rememberPerson } from "./people";

type AnyCap = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const runtime = (): { use?: (n: string) => Promise<AnyCap> } | undefined => (window as unknown as { claude?: { use?: (n: string) => Promise<AnyCap> } }).claude;

export const inClaude = () => typeof runtime()?.use === "function";

const memo = new Map<string, Promise<AnyCap | null>>();
export function cap(name: string): Promise<AnyCap | null> {
  if (!inClaude()) return Promise.resolve(null);
  if (!memo.has(name)) memo.set(name, runtime()!.use!(name).catch(() => null));
  return memo.get(name)!;
}

export type SaveOutcome = "saved" | "declined" | "unavailable";

/** Offer a file to the viewer: the platform's download prompt inside claude.ai, a normal download elsewhere. */
export async function saveFile(filename: string, data: string | Blob): Promise<SaveOutcome> {
  if (desktop) {
    // the desktop program: a native Save dialog
    try {
      const r = await desktop.exportFile({ filename, data: typeof data === "string" ? data : new Uint8Array(await data.arrayBuffer()) });
      return r ? "saved" : "declined";
    } catch {
      return "unavailable";
    }
  }
  const dl = await cap("downloads");
  if (dl) {
    try {
      await dl.save({ filename, data });
      return "saved";
    } catch (e) {
      return (e as { code?: string }).code === "declined" ? "declined" : "unavailable";
    }
  }
  if (inClaude()) return "unavailable";
  const blob = typeof data === "string" ? new Blob([data], { type: "text/plain" }) : data;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
  return "saved";
}

export async function canDownload(): Promise<boolean> {
  return !inClaude() || !!(await cap("downloads"));
}

// ---------------------------------------------------------------- cloud projects (per user, private)

export interface ProjectMeta {
  id: string;
  name: string;
  updatedAt: number;
  equipment: number;
  lines: number;
}

export interface Cloud {
  list(): Promise<ProjectMeta[]>;
  save(id: string, state: DbState): Promise<void>;
  load(id: string): Promise<DbState | { doc: PlantDoc } | null>;
  remove(id: string): Promise<void>;
}

let cloudPromise: Promise<Cloud | null> | null = null;

export function cloud(): Promise<Cloud | null> {
  if (cloudPromise) return cloudPromise;
  cloudPromise = (async () => {
    const [db, user] = await Promise.all([cap("db"), cap("user")]);
    if (!db || !user) return null;
    const uid: string | null = await user.id().catch(() => null);
    if (!uid) return null;
    const col = db.collection(`data/users/${uid}`);
    return {
      async list() {
        const snap = await col.get();
        return snap.docs
          .filter((d: AnyCap) => d.exists)
          .map((d: AnyCap) => {
            const x = d.data();
            return { id: d.id, name: String(x.name ?? d.id), updatedAt: Number(x.updatedAt ?? 0), equipment: Number(x.equipment ?? 0), lines: Number(x.lines ?? 0) };
          })
          .sort((a: ProjectMeta, b: ProjectMeta) => b.updatedAt - a.updatedAt);
      },
      async save(id, state) {
        const doc = state.doc;
        let st: DbState = JSON.parse(JSON.stringify(state));
        // a document holds at most 256 KiB: keep the newest audit entries that fit
        while (JSON.stringify(st).length > 240_000 && (st.txns?.length ?? 0) > 20) st = { ...st, txns: st.txns!.slice(Math.floor(st.txns!.length / 2)) };
        await col.doc(id).set({ name: doc.project.name, updatedAt: Date.now(), equipment: doc.equipment.length, lines: doc.lines.length, state: st });
      },
      async load(id) {
        const d = await col.doc(id).get();
        if (!d.exists) return null;
        const x = d.data();
        return (x.state as DbState) ?? (x.doc ? { doc: x.doc as PlantDoc } : null);
      },
      async remove(id) {
        await col.doc(id).delete();
      },
    };
  })();
  return cloudPromise;
}

// ---------------------------------------------------------------- local draft (per-browser convenience)

const DRAFT_KEY = "plantforge.studio.draft.v1";

export function saveDraft(doc: PlantDoc, projectId: string | null) {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ doc, projectId, at: Date.now() }));
  } catch {
    /* storage unavailable */
  }
}

export function loadDraft(): { doc: PlantDoc; projectId: string | null } | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const x = JSON.parse(raw);
    return x?.doc?.version === 1 ? x : null;
  } catch {
    return null;
  }
}

export async function sampleFn(): Promise<AnyCap | null> {
  return cap("sample");
}

/** Who is working: the signed-in Claude user (editors may approve), or a local user outside Claude. */
export async function currentUser(): Promise<User> {
  if (desktop) {
    // the desktop program: whoever is signed in to this computer
    const name = (await desktop.info().catch(() => null))?.user || "Local user";
    const user = { id: name.toLowerCase(), name, canApprove: true };
    rememberPerson(user.id, user.name);
    return user;
  }
  const u = await cap("user");
  if (!u) return { id: "local", name: "Local user", canApprove: true };
  try {
    const me = await u.me();
    const user = { id: me.id ?? "anon", name: me.name || "You", canApprove: !!(me.canEdit || me.isOwner) };
    rememberPerson(user.id, user.name);
    return user;
  } catch {
    return { id: "anon", name: "You", canApprove: false };
  }
}
