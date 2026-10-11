// Who did what: the database stores user ids only (names change and differ per viewer); names are
// resolved for display through the platform's user profiles, or come from the local user outside Claude.

import { useStore } from "../app/store";
import { cap, inClaude } from "./claude";

const names = new Map<string, string>([
  ["local", "Local user"],
  ["system", "System"],
]);
const pending = new Set<string>();
let timer = 0;

export function rememberPerson(id: string, name: string) {
  if (id && name) names.set(id, name);
}

/** Every id with a known name (for the database's local `person` table). */
export const knownPeople = (): [string, string][] => [...names];

/** A display name for a stored user id. Unknown ids are looked up in the background. */
export function personName(id: string | null | undefined): string {
  if (!id) return "";
  const n = names.get(id);
  if (n !== undefined) return n;
  if (!inClaude()) return id; // documents from before ids were stored hold names
  pending.add(id);
  clearTimeout(timer);
  timer = window.setTimeout(resolvePending, 60);
  return "…";
}

/** The display name once it is known (for one-off messages such as "Basma: Move P-101A"). */
export async function personNameAsync(id: string): Promise<string> {
  const known = names.get(id);
  if (known !== undefined) return known;
  if (!inClaude()) return id;
  try {
    const user = await cap("user");
    const ps: Record<string, { name: string }> | undefined = await user?.profiles([id]);
    const name = ps?.[id]?.name || "Someone";
    names.set(id, name);
    return name;
  } catch {
    return "Someone";
  }
}

async function resolvePending() {
  const ids = [...pending];
  pending.clear();
  const user = await cap("user");
  if (!user || !ids.length) {
    ids.forEach((id) => names.set(id, "Someone"));
  } else {
    try {
      const ps: Record<string, { name: string }> = await user.profiles(ids);
      ids.forEach((id) => names.set(id, ps[id]?.name || "Someone"));
    } catch {
      ids.forEach((id) => names.set(id, "Someone"));
    }
  }
  const st = useStore.getState();
  st.set({ peopleRev: st.peopleRev + 1 });
}
