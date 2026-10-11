// Optional platform capabilities (claude.ai artifact runtime). Every feature degrades gracefully when absent.

import type { PlantDoc } from "../engine/doc";

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
  save(id: string, doc: PlantDoc): Promise<void>;
  load(id: string): Promise<PlantDoc | null>;
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
      async save(id, doc) {
        await col.doc(id).set({ name: doc.project.name, updatedAt: Date.now(), equipment: doc.equipment.length, lines: doc.lines.length, doc: JSON.parse(JSON.stringify(doc)) });
      },
      async load(id) {
        const d = await col.doc(id).get();
        return d.exists ? (d.data().doc as PlantDoc) : null;
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
