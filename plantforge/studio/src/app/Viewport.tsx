import { useEffect, useRef, useState } from "react";
import { fmtENU } from "../engine/vec";
import { Viewer, ViewName } from "../viewer/Viewer";
import { activateTool, hub } from "./hub";
import { Icon } from "./icons";
import { useStore } from "./store";

export function Viewport() {
  const host = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = useState<string>("");
  const prompt = useStore((s) => s.prompt);
  const tool = useStore((s) => s.tool);
  const section = useStore((s) => s.section);
  const workingZ = useStore((s) => s.workingZ);

  useEffect(() => {
    const v = new Viewer(host.current!);
    hub.viewer = v;
    hub.tip = (text, ev, bad) => {
      const el = tipRef.current;
      if (!el) return;
      if (!text || !ev) {
        el.hidden = true;
        return;
      }
      const r = host.current!.getBoundingClientRect();
      el.hidden = false;
      el.textContent = text;
      el.classList.toggle("bad", !!bad);
      const x = Math.min(ev.clientX - r.left + 16, r.width - el.offsetWidth - 8);
      const y = Math.min(ev.clientY - r.top + 18, r.height - el.offsetHeight - 8);
      el.style.transform = `translate(${Math.max(8, x)}px, ${Math.max(8, y)}px)`;
    };
    v.onCursor = (p) => setCursor(p ? fmtENU(p) : "");
    const st = useStore.getState();
    v.setModel(st.model);
    v.setClashes(st.model.clashes, st.showClashes);
    v.setSelection(st.selection);
    activateTool(st.tool);
    v.setView("iso-sw");

    const unsub = useStore.subscribe((s, p) => {
      if (s.model !== p.model) {
        v.setModel(s.model);
        v.setClashes(s.model.clashes, s.showClashes);
      }
      if (s.showClashes !== p.showClashes) v.setClashes(s.model.clashes, s.showClashes);
      if (s.selection !== p.selection) v.setSelection(s.selection);
      if (s.labels !== p.labels) v.setLabels(s.labels, s.model);
      if (s.section !== p.section) v.setSection(s.section);
      if (s.tool !== p.tool || s.template !== p.template || s.inlineType !== p.inlineType) activateTool(s.tool);
    });
    return () => {
      unsub();
      hub.viewer = null;
    };
  }, []);

  useEffect(() => {
    if (hub.viewer) hub.viewer.workingZ = workingZ;
  }, [workingZ]);
  const setWorkingZ = (z: number) => useStore.getState().set({ workingZ: z });

  const view = (n: ViewName) => hub.viewer?.setView(n);
  const box = hub.viewer?.modelBoundsMM();

  return (
    <section className="viewport" aria-label="3D model">
      <div className="vp-host" ref={host} />
      <div className="vp-tip" ref={tipRef} hidden />
      <div className="vp-views" role="toolbar" aria-label="Views">
        <button type="button" onClick={() => view("iso")} title="South-east isometric">
          SE ISO
        </button>
        <button type="button" onClick={() => view("iso-sw")} title="South-west isometric">
          SW ISO
        </button>
        <button type="button" onClick={() => view("plan")} title="Plan (looking down)">
          PLAN
        </button>
        <button type="button" onClick={() => view("north")} title="Elevation looking north">
          ELEV N
        </button>
        <button type="button" onClick={() => view("east")} title="Elevation looking west">
          ELEV E
        </button>
        <button type="button" onClick={() => hub.viewer?.fit()} title="Fit all (F)">
          <Icon name="fit" size={15} />
        </button>
      </div>
      {prompt && tool !== "select" && <div className="vp-prompt">{prompt}</div>}
      {section && box && (
        <div className="vp-section">
          <span className="eyebrow">Section · top of cut</span>
          <input
            id="section-top"
            type="range"
            min={Math.floor(box.lo[2])}
            max={Math.ceil(box.hi[2]) + 1}
            step={50}
            value={section.hi[2]}
            onChange={(e) => useStore.getState().set({ section: { ...section, hi: [section.hi[0], section.hi[1], Number(e.target.value)] } })}
            aria-label="Section top elevation"
          />
          <span className="mono">EL +{Math.round(section.hi[2])}</span>
          <button type="button" className="link" onClick={() => useStore.getState().set({ section: null })}>
            Clear
          </button>
        </div>
      )}
      <div className="vp-status">
        <span className="mono">{cursor || "—"}</span>
        {tool === "route" && (
          <label className="vp-el">
            Working EL
            <input id="working-el" type="number" step={100} value={workingZ} onChange={(e) => setWorkingZ(Number(e.target.value) || 0)} />
          </label>
        )}
      </div>
    </section>
  );
}
