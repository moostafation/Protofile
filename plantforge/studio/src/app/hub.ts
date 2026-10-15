// Connects the single Viewer instance, the active tool and the store.

import { deleteObject } from "../engine/commands";
import type { Viewer } from "../viewer/Viewer";
import { Tool, ToolCtx, connectTool, insertTool, measureTool, moveTool, placeTool, rackTool, routeFromNozzle, routeFromTee, routeTool, selectTool } from "../viewer/tools";
import { CliHooks } from "./cli";
import { useStatus } from "./status";
import { ToolId, useStore } from "./store";

const VIEW_LABEL: Record<string, string> = { iso: "Iso SE", "iso-sw": "Iso SW", "iso-nw": "Iso NW", "iso-ne": "Iso NE", plan: "Plan", north: "Elevation N", east: "Elevation E", south: "Elevation S", west: "Elevation W" };

type TipFn = ToolCtx["tip"];

export const hub: {
  viewer: Viewer | null;
  tool: Tool | null;
  tip: TipFn;
  /** Set by the app: save to the account / shared plant. */
  save: () => void;
} = {
  viewer: null,
  tool: null,
  tip: () => {},
  save: () => {},
};

function ctx(): ToolCtx {
  return { viewer: hub.viewer!, tip: (t, ev, bad) => hub.tip(t, ev, bad) };
}

export function activateTool(id: ToolId, override?: Tool) {
  const v = hub.viewer;
  if (!v) return;
  hub.tool?.dispose?.();
  v.setHover(null);
  const c = ctx();
  const onTee = (lineId: string, itemId: string) => {
    useStore.getState().toast("Tee inserted - now route the branch", "info");
    useStore.setState({ tool: "route" });
    activateTool("route", routeFromTee(ctx(), lineId, itemId));
  };
  const make: Record<ToolId, () => Tool> = {
    select: () => selectTool(c),
    move: () => moveTool(c),
    place: () => placeTool(c),
    rack: () => rackTool(c),
    route: () => routeTool(c),
    insert: () => insertTool(c, onTee),
    connect: () => connectTool(c),
    measure: () => measureTool(c),
  };
  hub.tool = override ?? make[id]();
  v.handler = hub.tool;
}

export const cliHooks: CliHooks = {
  routeCommand(text) {
    return useStore.getState().tool === "route" ? (hub.tool?.command?.(text) ?? false) : false;
  },
  startRoute(from) {
    const st = useStore.getState();
    st.setTool("route");
    if (from) {
      const c = st.model.comps.find((x) => x.kind === "NOZZLE" && x.tag.toUpperCase() === from.toUpperCase());
      if (!c) return st.logLine(`No nozzle ${from}`, "error");
      activateTool("route", routeFromNozzle(ctx(), c));
      st.logLine(`Routing from ${c.tag} (NPS ${c.nps})`);
    }
  },
  goto(uids) {
    hub.viewer?.fit(uids);
  },
  fit(uids) {
    hub.viewer?.fit(uids ?? undefined);
  },
  view(name) {
    hub.viewer?.setView(name);
    useStatus.setState({ view: VIEW_LABEL[name] ?? name });
  },
  sectionAround(uids) {
    const b = hub.viewer?.boundsOf(uids);
    if (!b || b.isEmpty()) return;
    const pad = 1500;
    useStore.getState().set({ section: { lo: [b.min.x * 1000 - pad, b.min.y * 1000 - pad, b.min.z * 1000 - pad], hi: [b.max.x * 1000 + pad, b.max.y * 1000 + pad, b.max.z * 1000 + pad] } });
  },
  save() {
    hub.save();
  },
  setWorkingZ(z) {
    useStore.getState().set({ workingZ: z });
  },
};

/** Delete the object in focus (Delete key, Edit > Delete). */
export function deleteFocused(): boolean {
  const st = useStore.getState();
  const f = st.focus;
  if (!f) return false;
  const label = f.type === "equipment" ? st.doc.equipment.find((e) => e.id === f.id)?.tag : f.type === "line" ? st.doc.lines.find((l) => l.id === f.id)?.number : st.doc.structures.find((x) => x.id === f.id)?.tag;
  st.apply(deleteObject(st.doc, f), `Delete ${label}`);
  st.select([], null);
  return true;
}
