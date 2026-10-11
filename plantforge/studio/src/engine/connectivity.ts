// Which ports meet, where the welds are, and what is left open.

import { npsValue } from "./catalog";
import type { Comp, Port } from "./model";
import { dot } from "./vec";

export interface Joint {
  a: Comp;
  pa: Port;
  b: Comp;
  pb: Port;
  weld: boolean;
}

export interface Connectivity {
  joints: Joint[];
  open: { comp: Comp; port: Port }[];
  problems: { text: string; uids: string[] }[];
  welds: Joint[];
  inchDia: number;
  near(hops?: number): Set<string>;
}

const key = (p: Port) => p.pos.map((c) => Math.round(c * 10) / 10 + 0).join(",");
export const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

export function analyse(comps: readonly Comp[]): Connectivity {
  const buckets = new Map<string, { comp: Comp; port: Port }[]>();
  for (const comp of comps) for (const p of comp.ports) {
    const k = key(p);
    const list = buckets.get(k);
    if (list) list.push({ comp, port: p });
    else buckets.set(k, [{ comp, port: p }]);
  }
  const joints: Joint[] = [];
  const open: Connectivity["open"] = [];
  const problems: Connectivity["problems"] = [];
  for (const items of buckets.values()) {
    if (items.length === 1) {
      open.push(items[0]);
      continue;
    }
    if (items.length > 2) {
      problems.push({ text: `${items.length} connections meet at one point`, uids: items.map((i) => i.comp.uid) });
      continue;
    }
    const [x, y] = items;
    if (dot(x.port.dir, y.port.dir) > -1 + 1e-6) problems.push({ text: `${x.comp.tag} and ${y.comp.tag} meet but do not face each other`, uids: [x.comp.uid, y.comp.uid] });
    if (x.port.end !== y.port.end) problems.push({ text: `end type mismatch: ${x.comp.tag} (${x.port.end}) vs ${y.comp.tag} (${y.port.end})`, uids: [x.comp.uid, y.comp.uid] });
    if (x.port.nps !== y.port.nps) problems.push({ text: `size mismatch: ${x.comp.tag} NPS ${x.port.nps} vs ${y.comp.tag} NPS ${y.port.nps}`, uids: [x.comp.uid, y.comp.uid] });
    joints.push({ a: x.comp, pa: x.port, b: y.comp, pb: y.port, weld: x.port.end === "BW" && y.port.end === "BW" });
  }
  const welds = joints.filter((j) => j.weld);
  let cache: Set<string> | null = null;
  return {
    joints,
    open,
    problems,
    welds,
    inchDia: welds.reduce((s, j) => s + npsValue(j.pa.nps), 0),
    near(hops = 3) {
      if (cache) return cache;
      const graph = new Map<string, Set<string>>();
      const link = (a: string, b: string) => {
        if (!graph.has(a)) graph.set(a, new Set());
        graph.get(a)!.add(b);
      };
      for (const j of joints) {
        link(j.a.uid, j.b.uid);
        link(j.b.uid, j.a.uid);
      }
      const out = new Set<string>();
      for (const start of graph.keys()) {
        let frontier = new Set([start]);
        const seen = new Set([start]);
        for (let h = 0; h < hops; h++) {
          const next = new Set<string>();
          for (const f of frontier) for (const n of graph.get(f) ?? []) if (!seen.has(n)) next.add(n);
          next.forEach((n) => seen.add(n));
          frontier = next;
        }
        for (const o of seen) if (o !== start) out.add(pairKey(start, o));
      }
      cache = out;
      return out;
    },
  };
}
