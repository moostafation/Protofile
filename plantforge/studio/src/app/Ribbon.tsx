import { useState } from "react";
import { addNozzle, deleteObject, moveEquipment, reroute } from "../engine/commands";
import type { TemplateId } from "../engine/doc";
import { TEMPLATES } from "../engine/equipment";
import type { ApprovalStatus } from "../engine/doc";
import { ApprovalError, setMeta } from "../engine/meta";
import { SPECS, specApi } from "../engine/spec";
import { exportCurrent } from "./exporters";
import { hub } from "./hub";
import { Icon } from "./icons";
import { ToolId, useStore } from "./store";

type Tab = "home" | "equipment" | "piping" | "structure" | "review" | "database" | "drawings";

const TABS: [Tab, string][] = [
  ["home", "Home"],
  ["equipment", "Equipment"],
  ["piping", "Piping"],
  ["structure", "Structure"],
  ["review", "Review"],
  ["database", "Database"],
  ["drawings", "Drawings & Export"],
];

function Btn(p: { icon: string; label: string; onClick: () => void; active?: boolean; disabled?: boolean; title?: string; id?: string }) {
  return (
    <button type="button" id={p.id} className={`rb-btn${p.active ? " on" : ""}`} onClick={p.onClick} disabled={p.disabled} title={p.title ?? p.label} aria-pressed={p.active}>
      <Icon name={p.icon} size={20} />
      <span>{p.label}</span>
    </button>
  );
}

/** A ribbon group; `tone` colours its icons by discipline, as plant design ribbons do. */
const Group = ({ title, children, tone = "general" }: { title: string; children: React.ReactNode; tone?: "general" | "equipment" | "piping" | "steel" | "review" | "data" | "output" }) => (
  <div className="rb-group" data-tone={tone}>
    <div className="rb-items">{children}</div>
    <div className="rb-title">{title}</div>
  </div>
);

export function Ribbon() {
  const [tab, setTab] = useState<Tab>("home");
  const s = useStore();
  const tool = s.tool;
  const setTool = (t: ToolId, opts?: Parameters<typeof s.setTool>[1]) => s.setTool(t, opts);
  const focusEq = s.focus?.type === "equipment" ? s.doc.equipment.find((e) => e.id === s.focus!.id) : undefined;
  const focusLine = s.focus?.type === "line" ? s.doc.lines.find((l) => l.id === s.focus!.id) : undefined;
  const sizes = specApi.sizes(SPECS[s.newLine.spec] ?? SPECS.A1A);
  const hard = (s.model.clashes ?? []).filter((c) => c.hard).length;

  // objects behind the current selection (several when picked in the viewer with Ctrl)
  const owners = [...new Set([...s.selection.map((u) => s.model.byUid.get(u)?.owner.id), s.focus?.id].filter((x): x is string => !!x))];
  const setStatus = (status: ApprovalStatus) => {
    if (!owners.length) return s.toast("Select objects first", "error");
    try {
      if (s.apply(setMeta(s.doc, owners, { status }, s.user), `Set status ${status} (${owners.length} object${owners.length > 1 ? "s" : ""})`)) s.toast(`${status}: ${owners.length} object${owners.length > 1 ? "s" : ""}`);
    } catch (e) {
      if (e instanceof ApprovalError) s.toast(e.message, "error");
      else throw e;
    }
  };
  const openDb = (page: typeof s.dbPage) => s.set({ dbOpen: true, dbPage: page });

  const del = () => {
    if (!s.focus) return s.toast("Select something to delete", "error");
    const label =
      s.focus.type === "equipment"
        ? s.doc.equipment.find((e) => e.id === s.focus!.id)?.tag
        : s.focus.type === "line"
          ? s.doc.lines.find((l) => l.id === s.focus!.id)?.number
          : s.doc.structures.find((x) => x.id === s.focus!.id)?.tag;
    s.apply(deleteObject(s.doc, s.focus), `Delete ${label}`);
    s.select([], null);
  };

  return (
    <nav className="ribbon" aria-label="Tools">
      <div className="rb-tabs" role="tablist">
        <button type="button" className="rb-file" onClick={() => s.set({ projectsOpen: true })} title="Projects: new, open, save, shared plants">
          FILE
        </button>
        {TABS.map(([id, label]) => (
          <button key={id} id={`tab-${id}`} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      <div className="rb-body">
        {tab === "home" && (
          <>
            <Group title="Edit">
              <Btn icon="select" label="Select" active={tool === "select"} onClick={() => setTool("select")} />
              <Btn icon="move" label="Move" active={tool === "move"} onClick={() => setTool("move")} />
              <Btn icon="trash" label="Delete" onClick={del} disabled={!s.focus} />
            </Group>
            <Group title="History">
              <Btn icon="undo" label="Undo" onClick={s.undo} disabled={!s.history.length} title={s.history.length ? `Undo: ${s.lastLabel}` : "Nothing to undo"} />
              <Btn icon="redo" label="Redo" onClick={s.redo} disabled={!s.future.length} />
            </Group>
            <Group title="View">
              <Btn icon="fit" label="Fit all" onClick={() => hub.viewer?.fit()} />
              <Btn icon="eye" label="Fit selected" onClick={() => hub.viewer?.fit(s.selection)} disabled={!s.selection.length} />
              <Btn icon="labels" label="Labels" active={s.labels} onClick={() => s.set({ labels: !s.labels })} />
              <Btn icon="section" label="Section" active={!!s.section} onClick={() => toggleSection()} />
              <Btn icon="measure" label="Measure" active={tool === "measure"} onClick={() => setTool("measure")} />
            </Group>
          </>
        )}
        {tab === "equipment" && (
          <>
            <Group title="Place equipment" tone="equipment">
              {(Object.keys(TEMPLATES) as TemplateId[]).map((t) => (
                <Btn key={t} icon={t} label={TEMPLATES[t].name.replace("Shell & tube exchanger", "Exchanger")} active={tool === "place" && s.template === t} onClick={() => setTool("place", { template: t })} />
              ))}
            </Group>
            <Group title="Selected equipment" tone="equipment">
              <Btn icon="move" label="Move" active={tool === "move"} onClick={() => setTool("move")} disabled={!focusEq} />
              <Btn icon="rotate" label="Rotate 90°" disabled={!focusEq} onClick={() => focusEq && s.apply(moveEquipment(s.doc, focusEq.id, focusEq.origin, (focusEq.rot + 90) % 360), `Rotate ${focusEq.tag}`)} />
              <Btn icon="nozzle" label="Add nozzle" disabled={!focusEq || focusEq.template === "pump"} onClick={() => focusEq && s.apply(addNozzle(s.doc, focusEq.id), `Add nozzle to ${focusEq.tag}`)} />
            </Group>
          </>
        )}
        {tab === "piping" && (
          <>
            <Group title="Route" tone="piping">
              <Btn id="tool-route" icon="route" label="Route pipe" active={tool === "route"} onClick={() => setTool("route")} />
              <Btn id="tool-connect" icon="connect" label="Auto-route" active={tool === "connect"} onClick={() => setTool("connect")} title="Pick two nozzles: the router finds a clash-free path" />
              <Btn
                icon="reroute"
                label="Re-route line"
                disabled={!focusLine}
                onClick={() => {
                  if (!focusLine) return;
                  const r = reroute(s.doc, focusLine.id);
                  if (r.error) return s.toast(r.error, "error");
                  s.apply(r.doc, `Re-route ${focusLine.number}`);
                  s.toast(r.info ?? "Re-routed");
                }}
              />
            </Group>
            <Group title="Insert on a pipe" tone="piping">
              {(["gate", "globe", "check", "tee"] as const).map((t) => (
                <Btn key={t} icon={t} label={t === "tee" ? "Tee + branch" : `${t[0].toUpperCase()}${t.slice(1)} valve`} active={tool === "insert" && s.inlineType === t} onClick={() => setTool("insert", { inlineType: t })} />
              ))}
            </Group>
            <Group title="New line settings" tone="piping">
              <div className="rb-fields">
                <label>
                  Spec
                  <select id="nl-spec" value={s.newLine.spec} onChange={(e) => s.set({ newLine: { ...s.newLine, spec: e.target.value } })}>
                    {Object.keys(SPECS).map((k) => (
                      <option key={k}>{k}</option>
                    ))}
                  </select>
                </label>
                <label>
                  NPS
                  <select id="nl-nps" value={s.newLine.nps} onChange={(e) => s.set({ newLine: { ...s.newLine, nps: e.target.value } })}>
                    {sizes.map((k) => (
                      <option key={k} value={k}>
                        {k}"
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Service
                  <select id="nl-svc" value={s.newLine.service} onChange={(e) => s.set({ newLine: { ...s.newLine, service: e.target.value } })}>
                    {[
                      ["P", "P · process"],
                      ["CW", "CW · cooling water"],
                      ["ST", "ST · steam"],
                      ["VG", "VG · vent gas"],
                      ["N", "N · nitrogen"],
                    ].map(([k, l]) => (
                      <option key={k} value={k}>
                        {l}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </Group>
          </>
        )}
        {tab === "structure" && (
          <Group title="Steel" tone="steel">
            <Btn icon="rack" label="Pipe rack" active={tool === "rack"} onClick={() => setTool("rack")} />
          </Group>
        )}
        {tab === "review" && (
          <>
            <Group title="Interference" tone="review">
              <Btn icon="clash" label={`Clash check${hard ? ` (${hard})` : ""}`} onClick={() => (s.rerunClash(), s.set({ panel: "clash" }))} />
              <Btn icon="eye" label="Show clashes" active={s.showClashes} onClick={() => s.set({ showClashes: !s.showClashes })} />
              <div className="rb-fields">
                <label>
                  Clearance mm
                  <input id="clearance" type="number" min={0} step={10} value={s.clearance} onChange={(e) => s.set({ clearance: Math.max(0, Number(e.target.value) || 0) })} onBlur={() => s.rerunClash()} />
                </label>
              </div>
            </Group>
            <Group title="Reports" tone="review">
              <Btn icon="todo" label="To-Do list" onClick={() => s.set({ panel: "todo" })} />
              <Btn icon="mto" label="MTO" onClick={() => s.set({ panel: "mto" })} />
              <Btn icon="lines" label="Line list" onClick={() => s.set({ panel: "lines" })} />
            </Group>
          </>
        )}
        {tab === "database" && (
          <>
            <Group title="Plant database" tone="data">
              <Btn id="db-open" icon="database" label="Manager" onClick={() => openDb("overview")} title="Plant database: tables, backup and restore" />
              <Btn icon="table" label="Catalog & specs" onClick={() => openDb("catalog")} />
              <Btn icon="terminal" label="SQL & reports" onClick={() => openDb("sql")} />
              <Btn icon="history" label="Transactions" onClick={() => openDb("history")} />
            </Group>
            <Group title="Approval" tone="data">
              <Btn icon="shield" label="Objects" onClick={() => openDb("objects")} title="Every object with its status, permission group, system and revision" />
              <Btn id="color-status" icon="status" label="Color by status" active={s.colorBy === "status"} onClick={() => s.set({ colorBy: s.colorBy === "status" ? "line" : "status" })} />
              <Btn icon="send" label="Submit for review" disabled={!owners.length} onClick={() => setStatus("In Review")} />
              <Btn id="approve-sel" icon="tick" label="Approve" disabled={!owners.length || !s.user.canApprove} onClick={() => setStatus("Approved")} title={s.user.canApprove ? "Approve the selected objects (locks them)" : "Only editors can approve"} />
              <Btn icon="undo" label="Back to Working" disabled={!owners.length} onClick={() => setStatus("Working")} />
            </Group>
            <Group title="Workshare" tone="data">
              <Btn id="shared-open" icon="user" label={s.shared ? "Shared plant" : "Share plant"} active={!!s.shared} onClick={() => s.set({ projectsOpen: true })} title="Work on one plant with your team, live" />
            </Group>
          </>
        )}
        {tab === "drawings" && (
          <>
            <Group title="Drawings" tone="output">
              <Btn icon="iso_dwg" label="Isometric" onClick={() => s.set({ isoLine: focusLine?.id ?? s.doc.lines[0]?.id ?? null })} disabled={!s.doc.lines.length} />
            </Group>
            <Group title="Export" tone="output">
              <Btn icon="download" label="Package .zip" onClick={() => exportCurrent("zip")} title="PCF + isometric DXF/SVG + MTO + model, in one zip" />
              <Btn icon="mto" label="MTO .csv" onClick={() => exportCurrent("csv")} />
              <Btn icon="download" label="Model .json" onClick={() => exportCurrent("json")} />
              <Btn icon="download" label="For IFC (.toml)" onClick={() => exportCurrent("toml")} title="Project file for the PlantForge Python engine: plantforge build file.toml -> IFC" />
              <Btn icon="camera" label="Screenshot" onClick={() => exportCurrent("png")} />
            </Group>
          </>
        )}
      </div>
    </nav>
  );
}

function toggleSection() {
  const s = useStore.getState();
  if (s.section) return s.set({ section: null });
  const b = hub.viewer?.modelBoundsMM();
  if (!b) return;
  const pad = 500;
  s.set({ section: { lo: [b.lo[0] - pad, b.lo[1] - pad, b.lo[2] - pad], hi: [b.hi[0] + pad, b.hi[1] + pad, Math.round((b.lo[2] + b.hi[2]) / 2)] } });
}
