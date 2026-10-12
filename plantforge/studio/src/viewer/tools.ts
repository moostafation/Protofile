// Interactive tools. Each tool turns pointer/keyboard input into previews (ghosts) and document edits.

import { useStore } from "../app/store";
import { autoRoute } from "../engine/autoroute";
import { addEquipment, addInline, addLine, addRack, autoConnect, moveEquipment, updateLine, updateStructure } from "../engine/commands";
import { linePath, resolveEnd } from "../engine/compute";
import type { EndRef } from "../engine/doc";
import { templateShapes } from "../engine/equipment";
import type { Comp } from "../engine/model";
import { EndKind, InlineItem, route, toDocStation } from "../engine/routing";
import { getSpec } from "../engine/spec";
import { buildRack } from "../engine/structure";
import { EX, EY, EZ, V3, addScaled, dirFromName, dirName, dist, dot, fmtENU, isClose, neg, norm, sub } from "../engine/vec";
import type { InputHandler, Viewer } from "./Viewer";

export interface ToolCtx {
  viewer: Viewer;
  tip(text: string | null, ev?: { clientX: number; clientY: number }, bad?: boolean): void;
}

export interface Tool extends InputHandler {
  dispose?(): void;
  command?(text: string): boolean;
  finish?(flanged?: boolean): void;
  cancel?(): boolean;
}

const S = () => useStore.getState();
const AXES: V3[] = [EX, neg(EX), EY, neg(EY), EZ, neg(EZ)];
const snapTo = (x: number, step: number) => Math.round(x / step) * step;
const fakeComp = (shapes: Comp["shapes"]): Comp => ({ uid: "ghost", tag: "", kind: "EQUIPMENT", nps: "", ports: [], shapes, desc: "", skey: "", props: {}, owner: { type: "equipment", id: "ghost" } });

function freeNozzle(c: Comp | undefined): boolean {
  if (!c || c.kind !== "NOZZLE") return false;
  return !S().model.conn.joints.some((j) => j.a.uid === c.uid || j.b.uid === c.uid);
}

const nozzleRef = (c: Comp): EndRef => ({ kind: "nozzle", eq: c.owner.id, nozzle: c.props.name });

// ------------------------------------------------------------------ select & move
function selectClick(ctx: ToolCtx, ev: PointerEvent) {
  const h = ctx.viewer.pick(ev);
  const st = S();
  if (!h) {
    st.select([], null);
    return;
  }
  if (ev.shiftKey) st.select(st.selection.includes(h.uid) ? st.selection.filter((u) => u !== h.uid) : [...st.selection, h.uid]);
  else st.select([h.uid]);
}

function hover(ctx: ToolCtx, ev: PointerEvent, filter?: (c: Comp) => boolean) {
  const h = ctx.viewer.pick(ev, filter);
  ctx.viewer.setHover(h?.uid ?? null);
  return h;
}

function ownerUids(uid: string): string[] {
  const c = S().model.byUid.get(uid);
  if (!c) return [];
  return S().model.comps.filter((x) => x.owner.type === c.owner.type && x.owner.id === c.owner.id).map((x) => x.uid);
}

export function selectTool(ctx: ToolCtx): Tool {
  S().set({ prompt: "Click to select · double-click selects the whole line or equipment · Shift adds" });
  return {
    move: (ev) => {
      const h = hover(ctx, ev);
      const c = h ? S().model.byUid.get(h.uid) : undefined;
      if (c) ctx.tip(`${c.kind === "NOZZLE" ? c.tag : c.owner.type === "line" ? `${S().model.lines.get(c.owner.id)?.doc.number} · ${c.tag}` : c.tag}`, ev);
      else ctx.tip(null);
    },
    click: (ev) => selectClick(ctx, ev),
    dblclick: (ev) => {
      const h = ctx.viewer.pick(ev);
      if (!h) return ctx.viewer.fit();
      const all = ownerUids(h.uid);
      S().select(all);
      ctx.viewer.fit(all);
    },
    dispose: () => ctx.tip(null),
  };
}

export function moveTool(ctx: ToolCtx): Tool {
  const v = ctx.viewer;
  let base: ReturnType<typeof S>["doc"] | null = null;
  let pending: V3 | null = null;
  let raf = 0;
  const attach = () => {
    const f = S().focus;
    const doc = S().doc;
    if (f?.type === "equipment") v.attachGizmo(doc.equipment.find((e) => e.id === f.id)?.origin ?? null);
    else if (f?.type === "structure") v.attachGizmo(doc.structures.find((s) => s.id === f.id)?.origin ?? null);
    else v.attachGizmo(null);
  };
  attach();
  const unsub = useStore.subscribe((s, p) => {
    if (s.focus !== p.focus || (s.doc !== p.doc && !base)) attach();
  });
  const applyMove = (pos: V3, done: boolean) => {
    const f = S().focus;
    if (!f || f.type === "line") return;
    if (!base) base = S().doc;
    const doc = f.type === "equipment" ? moveEquipment(base, f.id, pos) : updateStructure(base, f.id, { origin: pos });
    if (done) {
      const b = base;
      base = null;
      useStore.setState({ doc: b });
      const tag = f.type === "equipment" ? doc.equipment.find((e) => e.id === f.id)?.tag : doc.structures.find((s) => s.id === f.id)?.tag;
      if (!S().apply(doc, `Move ${tag} to ${fmtENU(pos)}`)) {
        S().recompute();
        v.attachGizmo(f.type === "equipment" ? b.equipment.find((e) => e.id === f.id)!.origin : b.structures.find((s) => s.id === f.id)!.origin);
        return;
      }
      const broken = [...S().model.lines.values()].filter((l) => l.error);
      if (broken.length) S().toast(`${broken.length} line(s) could not follow the move - see the To-Do list, or use Re-route`, "error");
    } else S().preview(doc);
  };
  v.onGizmoDrag = (pos, done) => {
    if (done) {
      cancelAnimationFrame(raf);
      applyMove(pos, true);
      return;
    }
    pending = pos;
    if (!raf)
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (pending) applyMove(pending, false);
      });
  };
  S().set({ prompt: "Select equipment or a rack, then drag the arrows (50 mm snap). Connected pipes stretch with it." });
  return {
    move: (ev) => hover(ctx, ev),
    click: (ev) => selectClick(ctx, ev),
    dispose: () => {
      unsub();
      v.attachGizmo(null);
      v.onGizmoDrag = null;
    },
  };
}

// ------------------------------------------------------------------ placing
export function placeTool(ctx: ToolCtx): Tool {
  let rot = 0;
  let at: V3 | null = null;
  const t = S().template;
  S().set({ prompt: "Click to place on grade (100 mm snap) · R rotates 90° · Esc cancels" });
  const show = () => ctx.viewer.setGhost(at ? [fakeComp(templateShapes(t, at, rot))] : null);
  return {
    move: (ev) => {
      const p = ctx.viewer.planePoint(ev, 0);
      at = p ? [snapTo(p[0], 100), snapTo(p[1], 100), 0] : null;
      show();
      if (at) ctx.tip(`${fmtENU(at)} · rot ${rot}°`, ev);
    },
    key: (ev) => {
      if (ev.key.toLowerCase() === "r") {
        rot = (rot + 90) % 360;
        show();
        return true;
      }
    },
    click: () => {
      if (!at) return;
      const [doc, id] = addEquipment(S().doc, t, at, rot);
      const eq = doc.equipment.find((e) => e.id === id)!;
      S().apply(doc, `Add ${eq.tag}`);
      S().select([`${id}/BODY`], { type: "equipment", id });
      S().toast(`Placed ${eq.tag}. Drag it with Move, or edit its size and nozzles in Properties.`);
      S().setTool("select");
    },
    dispose: () => {
      ctx.viewer.setGhost(null);
      ctx.tip(null);
    },
  };
}

export function rackTool(ctx: ToolCtx): Tool {
  let start: V3 | null = null;
  let end: V3 | null = null;
  S().set({ prompt: "Click the start of the rack centre line, then its end (500 mm snap, along East or North)" });
  const geom = () => {
    if (!start || !end) return null;
    const dx = end[0] - start[0];
    const dy = end[1] - start[1];
    const axis: "x" | "y" = Math.abs(dx) >= Math.abs(dy) ? "x" : "y";
    const len = Math.abs(axis === "x" ? dx : dy);
    const origin: V3 = axis === "x" ? [Math.min(start[0], end[0]), start[1], 0] : [start[0], Math.min(start[1], end[1]), 0];
    return { axis, len, origin };
  };
  return {
    move: (ev) => {
      const p = ctx.viewer.planePoint(ev, 0);
      if (!p) return;
      const q: V3 = [snapTo(p[0], 500), snapTo(p[1], 500), 0];
      if (!start) {
        ctx.viewer.setGuides([], "#46c1ff", [q]);
        ctx.tip(`Start ${fmtENU(q)}`, ev);
        return;
      }
      end = q;
      const g = geom()!;
      if (g.len >= 1000) {
        const comp = buildRack({ id: "ghost", tag: "", type: "rack", description: "", origin: g.origin, axis: g.axis, length: g.len, width: 6000, bay: 6000, levels: [5000, 7000] });
        ctx.viewer.setGhost([comp]);
      }
      ctx.tip(`${(g.len / 1000).toFixed(1)} m along ${g.axis === "x" ? "East" : "North"}`, ev);
    },
    click: (ev) => {
      const p = ctx.viewer.planePoint(ev, 0);
      if (!p) return;
      const q: V3 = [snapTo(p[0], 500), snapTo(p[1], 500), 0];
      if (!start) {
        start = q;
        return;
      }
      end = q;
      const g = geom()!;
      if (g.len < 1000) return S().toast("A rack needs at least 1 m", "error");
      const [doc, id] = addRack(S().doc, g.origin, g.axis, g.len);
      S().apply(doc, "Add pipe rack");
      S().select([`${id}/STEEL`], { type: "structure", id });
      S().setTool("select");
    },
    dispose: () => {
      ctx.viewer.setGhost(null);
      ctx.viewer.setGuides([]);
      ctx.tip(null);
    },
  };
}

// ------------------------------------------------------------------ routing
interface Draft {
  lineId?: string;
  start: EndRef;
  startKind: EndKind;
  full: V3[];
  forced: V3 | null;
  nps: string;
  spec: string;
}

/** Closest parameter t along last + d*t to a view ray. */
function rayParam(last: V3, d: V3, o: V3, r: V3): number | null {
  const w0 = sub(last, o);
  const b = dot(d, r);
  const denom = 1 - b * b;
  if (denom < 1e-6) return null;
  return (b * dot(r, w0) - dot(d, w0)) / denom;
}

export function routeTool(ctx: ToolCtx, init?: Draft): Tool {
  const v = ctx.viewer;
  let draft: Draft | null = init ?? null;
  let candidate: V3 | null = null;
  type Completion = { full: V3[]; end: EndRef; label: string };
  let completion: Completion | null = null;
  let compCache: { uid: string; res: Completion | null } | null = null;

  const prompt = () =>
    S().set({
      prompt: draft
        ? "Move along an axis and click to add a bend · type east 2000 / up 1500 · click a free nozzle to finish there (auto-route) · Enter finishes · Backspace undoes a point"
        : "Click a free nozzle, the open end of a line, or a point on the grid to start a pipe",
    });
  prompt();

  const preview = (full: V3[], end?: { kind: EndKind; dir: V3 | null }) => {
    if (!draft) return null;
    const res = route({
      spec: getSpec(draft.spec),
      owner: "draft",
      label: "New pipe",
      nps: draft.nps,
      points: full,
      start: draft.startKind,
      end: end?.kind ?? "open",
      startDir: draft.forced,
      endDir: end?.dir ?? null,
      inline: draft.lineId ? S().doc.lines.find((l) => l.id === draft!.lineId)?.inline : [],
    });
    return res;
  };

  const showPath = (full: V3[], end?: { kind: EndKind; dir: V3 | null }) => {
    const res = preview(full, end);
    if (!res) return null;
    if (res.error) {
      const r = 30;
      v.setGhost(full.slice(1).map((p, i) => fakeComp([{ t: "cyl", a: full[i], b: p, r }])), false);
    } else v.setGhost(res.comps, true);
    return res;
  };

  const begin = (ev: PointerEvent) => {
    const h = v.pick(ev);
    const st = S();
    const c = h ? st.model.byUid.get(h.uid) : undefined;
    if (c && freeNozzle(c)) {
      const p = c.ports[0];
      draft = { start: nozzleRef(c), startKind: "nozzle", full: [p.pos], forced: p.dir, nps: c.nps, spec: st.newLine.spec };
      st.toast(`Routing from ${c.tag} (NPS ${c.nps})`, "info");
    } else if (c && c.owner.type === "line") {
      const line = st.model.lines.get(c.owner.id)!;
      const openEnd = line.doc.end.kind === "open" || line.doc.end.kind === "flanged";
      const last = line.path[line.path.length - 1];
      if (openEnd && c.ports.some((p) => dist(p.pos, last) < 2000)) {
        draft = { lineId: line.doc.id, start: line.doc.start, startKind: line.startKind, full: [...line.path], forced: line.startDir, nps: line.doc.nps, spec: line.doc.spec };
        st.toast(`Extending ${line.doc.number}`, "info");
      } else return st.toast("Start from a free nozzle, a line's open end, or empty space", "error");
    } else {
      const p = v.planePoint(ev, v.workingZ);
      if (!p) return;
      const q: V3 = [snapTo(p[0], 100), snapTo(p[1], 100), v.workingZ];
      draft = { start: { kind: "open" }, startKind: "open", full: [q], forced: null, nps: st.newLine.nps, spec: st.newLine.spec };
    }
    prompt();
  };

  const nextPoint = (ev: PointerEvent): { p: V3; d: V3; guides: [V3, V3][] } | null => {
    if (!draft) return null;
    const last = draft.full[draft.full.length - 1];
    const prev = draft.full[draft.full.length - 2];
    const lastDir = prev ? norm(sub(last, prev)) : null;
    const dirs = draft.full.length === 1 && draft.forced ? [draft.forced] : AXES.filter((d) => !lastDir || dot(d, lastDir) > -0.5);
    const { o, d: r } = v.rayMM(ev);
    const rect = v.renderer.domElement.getBoundingClientRect();
    const mx = ev.clientX - rect.left;
    const my = ev.clientY - rect.top;
    let best: { p: V3; d: V3; px: number } | null = null;
    for (const d of dirs) {
      const t = rayParam(last, d, o, r);
      if (t === null || t <= 50) continue;
      const step = ev.shiftKey ? 1 : 50;
      const p = addScaled(last, d, snapTo(t, step));
      const [sx, sy] = v.toScreen(p);
      const px = Math.hypot(sx - mx, sy - my);
      if (!best || px < best.px) best = { p, d, px };
    }
    if (!best || best.px > 160) return null;
    // align with free nozzles and the route's own points (E3D-style)
    const guides: [V3, V3][] = [];
    if (!ev.shiftKey) {
      const k = Math.abs(best.d[0]) > 0.5 ? 0 : Math.abs(best.d[1]) > 0.5 ? 1 : 2;
      const targets: V3[] = [...S().model.comps.filter((c) => freeNozzle(c)).map((c) => c.ports[0].pos), ...draft.full.slice(0, -1)];
      let snapped: V3 | null = null;
      for (const tg of targets) {
        if (Math.abs(tg[k] - best.p[k]) < 150 && (!snapped || Math.abs(tg[k] - best.p[k]) < Math.abs(snapped[k] - best.p[k]))) snapped = tg;
      }
      if (snapped) {
        const p = [...best.p] as [number, number, number];
        p[k] = snapped[k];
        if (dot(sub(p, last), best.d) > 50) {
          best.p = p;
          guides.push([p, snapped]);
        }
      }
    }
    return { p: best.p, d: best.d, guides };
  };

  const tryCompletion = (c: Comp): Completion | null => {
    if (!draft) return null;
    if (compCache?.uid === c.uid) return compCache.res;
    const st = S();
    const last = draft.full[draft.full.length - 1];
    const prev = draft.full[draft.full.length - 2];
    const port = c.ports[0];
    let res: Completion | null = null;
    if (c.nps === draft.nps) {
      const exclude = new Set(st.model.comps.filter((x) => x.ports.some((p) => isClose(p.pos, port.pos, 0.5) || isClose(p.pos, draft!.full[0], 0.5))).map((x) => x.uid));
      const startDir = draft.full.length === 1 ? draft.forced : null;
      const r = autoRoute({
        model: st.model,
        spec: getSpec(draft.spec),
        nps: draft.nps,
        start: { pos: last, dir: startDir, kind: draft.full.length === 1 ? draft.startKind : "open", avoid: prev ? norm(sub(last, prev)) : null },
        end: { pos: port.pos, dir: neg(port.dir), kind: "nozzle" },
        exclude,
        ownerId: draft.lineId,
      });
      if (r) res = { full: [...draft.full, ...r.path.slice(1)], end: nozzleRef(c), label: c.tag };
    }
    compCache = { uid: c.uid, res };
    return res;
  };

  const commit = (full: V3[], end: EndRef) => {
    if (!draft) return;
    const st = S();
    const d0 = draft;
    const hasStart = d0.start.kind === "nozzle" || d0.start.kind === "tee";
    const hasEnd = end.kind === "nozzle" || end.kind === "tee";
    const points = full.slice(hasStart ? 1 : 0, hasEnd ? full.length - 1 : full.length);
    let doc = st.doc;
    let id = d0.lineId;
    let label: string;
    if (id) {
      doc = updateLine(doc, id, { points, end });
      label = `Extend ${doc.lines.find((l) => l.id === id)!.number}`;
    } else {
      const nl = st.newLine;
      [doc, id] = addLine(doc, { nps: d0.nps, spec: d0.spec, fluid: nl.fluid, start: d0.start, end, points });
      const line = doc.lines.find((l) => l.id === id)!;
      if (nl.service !== "P") doc = updateLine(doc, id, { number: line.number.replace('-P-', `-${nl.service}-`) });
      label = `Route ${doc.lines.find((l) => l.id === id)!.number}`;
    }
    if (!st.apply(doc, label)) return;
    const res = S().model.lines.get(id!);
    if (res?.error) st.toast(res.error, "error");
    else st.toast(`${label}: ${res?.comps.filter((c) => c.kind === "ELBOW").length ?? 0} elbows, ${((res?.pipeLength ?? 0) / 1000).toFixed(2)} m pipe`);
    st.select(res?.comps.map((c) => c.uid) ?? [], { type: "line", id: id! });
    draft = null;
    candidate = null;
    completion = null;
    compCache = null;
    v.setGhost(null);
    v.setGuides([]);
    ctx.tip(null);
    prompt();
  };

  const addPoint = (p: V3) => {
    if (!draft) return false;
    const full = [...draft.full, p];
    const res = preview(full);
    if (res?.error) {
      S().toast(res.error.replace(/^New pipe: /, ""), "error");
      return false;
    }
    draft.full = full;
    return true;
  };

  const finish = (flanged = false) => {
    if (!draft) return;
    if (draft.full.length < 2) {
      draft = null;
      v.setGhost(null);
      prompt();
      return;
    }
    commit(draft.full, { kind: flanged ? "flanged" : "open" });
  };

  return {
    move: (ev) => {
      if (!draft) {
        const h = hover(ctx, ev, (c) => freeNozzle(c) || c.owner.type === "line");
        const c = h ? S().model.byUid.get(h.uid) : undefined;
        if (c && freeNozzle(c)) ctx.tip(`Start at ${c.tag} · NPS ${c.nps}`, ev);
        else {
          const p = v.planePoint(ev, v.workingZ);
          ctx.tip(p ? `Start at ${fmtENU([snapTo(p[0], 100), snapTo(p[1], 100), v.workingZ])}` : null, ev);
        }
        return;
      }
      const h = v.pick(ev, (c) => freeNozzle(c));
      const nc = h ? S().model.byUid.get(h.uid) : undefined;
      if (nc && !isClose(nc.ports[0].pos, draft.full[0], 1)) {
        v.setHover(nc.uid);
        completion = tryCompletion(nc);
        candidate = null;
        if (completion) {
          const res = showPath(completion.full, { kind: "nozzle", dir: neg(nc.ports[0].dir) });
          ctx.tip(res?.error ? res.error.replace(/^New pipe: /, "") : `Click to finish at ${nc.tag} (auto-route)`, ev, !!res?.error);
        } else ctx.tip(nc.nps !== draft.nps ? `${nc.tag} is NPS ${nc.nps}; this pipe is NPS ${draft.nps}` : `No route to ${nc.tag} from here`, ev, true);
        return;
      }
      v.setHover(null);
      completion = null;
      const np = nextPoint(ev);
      if (!np) {
        candidate = null;
        showPath(draft.full);
        v.setGuides([]);
        ctx.tip("Move the cursor along an axis from the last point", ev);
        return;
      }
      candidate = np.p;
      const res = showPath([...draft.full, np.p]);
      const last = draft.full[draft.full.length - 1];
      v.setGuides(np.guides, "#46c1ff", [np.p]);
      ctx.tip(res?.error ? res.error.replace(/^New pipe: /, "") : `${dirName(np.d)} ${Math.round(dist(last, np.p))} → ${fmtENU(np.p)}`, ev, !!res?.error);
    },
    click: (ev) => {
      if (!draft) return begin(ev);
      if (completion) return commit(completion.full, completion.end);
      if (candidate && addPoint(candidate)) {
        candidate = null;
      }
    },
    dblclick: () => finish(),
    key: (ev) => {
      if (ev.key === "Enter") {
        finish(ev.shiftKey);
        return true;
      }
      if (ev.key === "Backspace" && draft) {
        if (draft.full.length > 1 && !draft.lineId) draft.full = draft.full.slice(0, -1);
        else if (draft.lineId && draft.full.length > (linePath(S().doc.lines.find((l) => l.id === draft!.lineId)!, S().model).path.length)) draft.full = draft.full.slice(0, -1);
        else {
          draft = null;
          v.setGhost(null);
          prompt();
        }
        return true;
      }
    },
    command: (text) => {
      const m = text.trim().match(/^([ENSWUD])\s*(\d+(?:\.\d+)?)$/i);
      if (m && draft) {
        const d = dirFromName(m[1])!;
        const last = draft.full[draft.full.length - 1];
        const p = addScaled(last, d, Number(m[2]));
        if (addPoint(p)) {
          showPath(draft.full);
          S().logLine(`Added ${m[1].toUpperCase()} ${m[2]} → ${fmtENU(p)}`);
        }
        return true;
      }
      const to = text.trim().match(/^TO\s+(\S+)$/i);
      if (to && draft) {
        const c = S().model.comps.find((x) => x.kind === "NOZZLE" && x.tag.toUpperCase() === to[1].toUpperCase());
        if (!c) return S().toast(`No nozzle ${to[1]}`, "error"), true;
        const r = tryCompletion(c);
        if (!r) return S().toast(`No route to ${c.tag}`, "error"), true;
        commit(r.full, r.end);
        return true;
      }
      if (/^(FINISH|F|END)$/i.test(text.trim())) return finish(), true;
      if (/^FLANGED?$/i.test(text.trim())) return finish(true), true;
      return false;
    },
    finish,
    cancel: () => {
      if (!draft) return false;
      draft = null;
      v.setGhost(null);
      v.setGuides([]);
      prompt();
      return true;
    },
    dispose: () => {
      v.setGhost(null);
      v.setGuides([]);
      ctx.tip(null);
    },
  };
}

/** Start the route tool at a free nozzle. */
export function routeFromNozzle(ctx: ToolCtx, c: Comp): Tool {
  const p = c.ports[0];
  return routeTool(ctx, { start: nozzleRef(c), startKind: "nozzle", full: [p.pos], forced: p.dir, nps: c.nps, spec: S().newLine.spec });
}

/** Start the route tool from a tee branch (after inserting a tee). */
export function routeFromTee(ctx: ToolCtx, lineId: string, itemId: string): Tool {
  const st = S();
  const r = resolveEnd({ kind: "tee", line: lineId, item: itemId }, st.model);
  if (!r) return routeTool(ctx);
  return routeTool(ctx, { start: { kind: "tee", line: lineId, item: itemId }, startKind: "buttweld", full: [r.pos], forced: r.dir, nps: r.nps, spec: st.doc.lines.find((l) => l.id === lineId)!.spec });
}

// ------------------------------------------------------------------ insert valve / tee
export function insertTool(ctx: ToolCtx, onTee: (lineId: string, itemId: string) => void): Tool {
  const v = ctx.viewer;
  const type = S().inlineType;
  let pending: { lineId: string; item: Omit<InlineItem, "id"> } | null = null;
  let branchIdx = 0;
  S().set({ prompt: `Hover a pipe and click to insert a ${type === "tee" ? "tee (Tab turns the branch)" : `${type} valve`} · 50 mm snap` });
  const isPipe = (c: Comp) => c.kind === "PIPE";
  const compute = (ev: PointerEvent) => {
    const h = v.pick(ev, isPipe);
    if (!h) return null;
    const st = S();
    const c = st.model.byUid.get(h.uid)!;
    const line = st.model.lines.get(c.owner.id)!;
    const leg = line.legs[c.props.leg];
    const s = snapTo(dot(sub(h.point, leg.start), leg.dir), 50);
    const { leg: docLeg, station } = toDocStation(line.legs, c.props.leg, s);
    let branch: V3 | undefined;
    if (type === "tee") {
      const perps = [EX, neg(EX), EY, neg(EY), EZ, neg(EZ)].filter((d) => Math.abs(dot(d, leg.dir)) < 1e-6);
      perps.sort((a, b) => b[2] - a[2]);
      branch = perps[branchIdx % perps.length];
    }
    return { line, item: { type, leg: docLeg, station, branch } as Omit<InlineItem, "id">, at: addScaled(leg.start, leg.dir, s) };
  };
  const show = (ev: PointerEvent) => {
    const r = compute(ev);
    pending = null;
    if (!r) {
      v.setGhost(null);
      ctx.tip(null);
      return;
    }
    const d = r.line.doc;
    const res = route({
      spec: getSpec(d.spec),
      owner: "preview",
      label: d.number,
      nps: d.nps,
      points: r.line.path,
      start: r.line.startKind,
      end: r.line.endKind,
      startDir: r.line.startDir,
      endDir: r.line.endDir,
      inline: [...d.inline, { ...r.item, id: "__new" }],
    });
    if (res.error) {
      v.setGhost([fakeComp([{ t: "sph", c: r.at, r: 120 }])], false);
      ctx.tip(res.error.replace(`${d.number}: `, ""), ev, true);
      return;
    }
    v.setGhost(res.comps.filter((c) => c.props.inlineId === "__new"), true);
    pending = { lineId: d.id, item: r.item };
    ctx.tip(`${type === "tee" ? `Tee, branch ${dirName(r.item.branch!)}` : `${type} valve`} on ${d.number} at ${fmtENU(r.at)}`, ev);
  };
  let lastEv: PointerEvent | null = null;
  return {
    move: (ev) => {
      lastEv = ev;
      show(ev);
    },
    key: (ev) => {
      if (ev.key === "Tab" && type === "tee") {
        branchIdx++;
        if (lastEv) show(lastEv);
        return true;
      }
    },
    click: () => {
      if (!pending) return;
      const st = S();
      const [doc, id] = addInline(st.doc, pending.lineId, pending.item);
      st.apply(doc, `Insert ${type} on ${doc.lines.find((l) => l.id === pending!.lineId)!.number}`);
      v.setGhost(null);
      if (type === "tee") onTee(pending.lineId, id);
      pending = null;
    },
    dispose: () => {
      v.setGhost(null);
      ctx.tip(null);
    },
  };
}

// ------------------------------------------------------------------ connect two nozzles
export function connectTool(ctx: ToolCtx): Tool {
  const v = ctx.viewer;
  let first: Comp | null = null;
  let cache: { uid: string; doc: ReturnType<typeof autoConnect> } | null = null;
  const prompt = () => S().set({ prompt: first ? `Click the nozzle to connect ${first.tag} to · the router finds a clash-free path over the rack` : "Click the first free nozzle" });
  prompt();
  const tryConnect = (c: Comp) => {
    if (cache?.uid === c.uid) return cache.doc;
    const st = S();
    const res = autoConnect(st.doc, { from: nozzleRef(first!), to: nozzleRef(c), spec: st.newLine.spec, fluid: st.newLine.fluid });
    cache = { uid: c.uid, doc: res };
    return res;
  };
  return {
    move: (ev) => {
      const h = hover(ctx, ev, (c) => freeNozzle(c));
      const c = h ? S().model.byUid.get(h.uid) : undefined;
      if (!c) {
        v.setGhost(null);
        return ctx.tip(null);
      }
      if (!first || c.uid === first.uid) return ctx.tip(`${c.tag} · NPS ${c.nps} · ${c.props.service || "nozzle"}`, ev);
      const res = tryConnect(c);
      if (res.error || !res.lineId) {
        v.setGhost(null);
        return ctx.tip(res.error ?? "No route", ev, true);
      }
      const line = res.doc.lines.find((l) => l.id === res.lineId)!;
      const st = S();
      const r = route({
        spec: getSpec(line.spec),
        owner: "preview",
        label: line.number,
        nps: line.nps,
        points: linePath(line, st.model).path,
        start: "nozzle",
        end: "nozzle",
        startDir: first.ports[0].dir,
        endDir: neg(c.ports[0].dir),
      });
      v.setGhost(r.comps, !r.error);
      ctx.tip(`${first.tag} → ${c.tag}: ${res.info}`, ev);
    },
    click: (ev) => {
      const h = v.pick(ev, (c) => freeNozzle(c));
      const c = h ? S().model.byUid.get(h.uid) : undefined;
      if (!c) return;
      if (!first) {
        first = c;
        S().select([c.uid]);
        return prompt();
      }
      if (c.uid === first.uid) return;
      const res = tryConnect(c);
      if (res.error || !res.lineId) return S().toast(res.error ?? "No route found", "error");
      const line = res.doc.lines.find((l) => l.id === res.lineId)!;
      S().apply(res.doc, `Auto-route ${line.number}`);
      S().toast(`${line.number}: ${res.info}`);
      S().select(S().model.lines.get(line.id)!.comps.map((x) => x.uid), { type: "line", id: line.id });
      first = null;
      cache = null;
      v.setGhost(null);
      prompt();
    },
    cancel: () => {
      if (!first) return false;
      first = null;
      cache = null;
      v.setGhost(null);
      prompt();
      return true;
    },
    dispose: () => {
      v.setGhost(null);
      ctx.tip(null);
    },
  };
}

// ------------------------------------------------------------------ measure
export function measureTool(ctx: ToolCtx): Tool {
  const v = ctx.viewer;
  let a: V3 | null = null;
  S().set({ prompt: "Click two points (snaps to connection points) to measure" });
  const snap = (ev: PointerEvent): V3 | null => {
    const h = v.pick(ev);
    if (!h) return v.planePoint(ev, 0);
    const c = S().model.byUid.get(h.uid);
    let best: V3 = h.point;
    let bd = 250;
    for (const p of c?.ports ?? []) {
      const d = dist(p.pos, h.point);
      if (d < bd) {
        bd = d;
        best = p.pos;
      }
    }
    return best;
  };
  const describe = (p: V3, q: V3) => {
    const d = sub(q, p);
    return `${Math.round(dist(p, q))} mm  (ΔE ${Math.round(d[0])}  ΔN ${Math.round(d[1])}  ΔEL ${Math.round(d[2])})`;
  };
  return {
    move: (ev) => {
      const p = snap(ev);
      if (!p) return;
      if (a) {
        v.setGuides([[a, p]], "#ffb21a", [a, p]);
        ctx.tip(describe(a, p), ev);
      } else {
        v.setGuides([], "#ffb21a", [p]);
        ctx.tip(fmtENU(p), ev);
      }
    },
    click: (ev) => {
      const p = snap(ev);
      if (!p) return;
      if (!a) a = p;
      else {
        S().logLine(`Measure: ${describe(a, p)}`);
        S().toast(describe(a, p), "info");
        a = null;
      }
    },
    dispose: () => {
      v.setGuides([]);
      ctx.tip(null);
    },
  };
}

