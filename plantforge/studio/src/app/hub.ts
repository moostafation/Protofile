// Connects the single Viewer instance, the active tool and the store.

import type { Viewer } from "../viewer/Viewer";
import { Tool, ToolCtx, connectTool, insertTool, measureTool, moveTool, placeTool, rackTool, routeFromNozzle, routeFromTee, routeTool, selectTool } from "../viewer/tools";
import { CliHooks } from "./cli";
import { ToolId, useStore } from "./store";

type TipFn = ToolCtx["tip"];

export const hub: {
  viewer: Viewer | null;
  tool: Tool | null;
  tip: TipFn;
} = {
  viewer: null,
  tool: null,
  tip: () => {},
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
  setWorkingZ(z) {
    useStore.getState().set({ workingZ: z });
  },
};
