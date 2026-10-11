import { useMemo, useState } from "react";
import { LINE_COLORS } from "../viewer/Viewer";
import { hub } from "./hub";
import { Icon } from "./icons";
import { useStore } from "./store";
import { objName, objects } from "../engine/meta";

const KIND_LABEL: Record<string, string> = { PIPE: "Pipe", ELBOW: "Elbow", TEE: "Tee", FLANGE: "Flange", GASKET: "Gasket", VALVE: "Valve", SUPPORT: "Shoe" };

export function Explorer() {
  const model = useStore((s) => s.model);
  const focus = useStore((s) => s.focus);
  const select = useStore((s) => s.select);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [view, setView] = useState<"system" | "type">("system");
  const needle = q.trim().toUpperCase();
  const match = (t: string) => !needle || t.toUpperCase().includes(needle);
  const toggle = (k: string) => setOpen((o) => ({ ...o, [k]: !o[k] }));

  const connected = useMemo(() => new Set(model.conn.joints.flatMap((j) => [j.a.uid, j.b.uid])), [model]);
  const pick = (uids: string[], f: { type: "equipment" | "line" | "structure"; id: string }, fit = false) => {
    select(uids, f);
    if (fit) hub.viewer?.fit(uids);
  };
  const p = model.doc.project;
  const equipment = [...model.equipment.values()].filter((e) => match(e.doc.tag) || e.nozzles.some((n) => match(n.tag)));
  const lines = [...model.lines.values()].filter((l) => match(l.doc.number) || match(l.doc.fluid));
  const steel = [...model.structures.values()].filter((s) => match(s.doc.tag));

  return (
    <aside className="pane explorer" aria-label="Model explorer">
      <div className="pane-head">
        <div className="pane-head-row">
          <h2>Model</h2>
          <div className="seg-tabs" role="tablist" aria-label="Explorer view">
            <button type="button" role="tab" id="ex-system" aria-selected={view === "system"} onClick={() => setView("system")}>
              System
            </button>
            <button type="button" role="tab" id="ex-type" aria-selected={view === "type"} onClick={() => setView("type")}>
              Type
            </button>
          </div>
        </div>
        <input id="explorer-search" className="search" type="search" placeholder="Find tag or line" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {view === "system" ? (
        <SystemTree match={match} pick={pick} />
      ) : (
      <div className="pane-scroll">
        <div className="tree-root">
          <span className="eyebrow">{p.plant || "Plant"}</span>
          <span className="tree-root-name">{[p.area, p.unit].filter(Boolean).join(" · ") || p.name}</span>
        </div>

        <TreeSection title="Equipment" count={model.equipment.size}>
          {equipment.map((e) => {
            const k = `eq:${e.doc.id}`;
            const uids = [e.body.uid, ...e.nozzles.map((n) => n.uid)];
            return (
              <li key={k}>
                <div className={`tree-row${focus?.id === e.doc.id ? " on" : ""}`}>
                  <button type="button" className="twisty" aria-expanded={!!open[k]} onClick={() => toggle(k)} aria-label="Show nozzles">
                    <Icon name="chevron" size={12} />
                  </button>
                  <button type="button" className="tree-item" onClick={() => pick([e.body.uid], { type: "equipment", id: e.doc.id })} onDoubleClick={() => pick(uids, { type: "equipment", id: e.doc.id }, true)}>
                    <Icon name={e.doc.template} size={15} />
                    <span className="mono">{e.doc.tag}</span>
                    <span className="tree-meta">{e.doc.description}</span>
                  </button>
                </div>
                {open[k] && (
                  <ul className="tree-children">
                    {e.nozzles.map((n) => (
                      <li key={n.uid}>
                        <button type="button" className="tree-item small" onClick={() => pick([n.uid], { type: "equipment", id: e.doc.id })}>
                          <span className={`dot ${connected.has(n.uid) ? "ok" : "free"}`} title={connected.has(n.uid) ? "Connected" : "Free"} />
                          <span className="mono">{n.props.name}</span>
                          <span className="tree-meta">
                            {n.nps}" {n.props.service}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </TreeSection>

        <TreeSection title="Pipelines" count={model.lines.size}>
          {lines.map((l) => {
            const k = `ln:${l.doc.id}`;
            const uids = l.comps.map((c) => c.uid);
            return (
              <li key={k}>
                <div className={`tree-row${focus?.id === l.doc.id ? " on" : ""}`}>
                  <button type="button" className="twisty" aria-expanded={!!open[k]} onClick={() => toggle(k)} aria-label="Show components">
                    <Icon name="chevron" size={12} />
                  </button>
                  <button type="button" className="tree-item" onClick={() => pick(uids, { type: "line", id: l.doc.id })} onDoubleClick={() => pick(uids, { type: "line", id: l.doc.id }, true)}>
                    <span className="swatch" style={{ background: LINE_COLORS[l.doc.color % LINE_COLORS.length] }} />
                    <span className="mono">{l.doc.number}</span>
                    {l.error ? <span className="chip crit">error</span> : <span className="tree-meta">{l.doc.fluid}</span>}
                  </button>
                </div>
                {open[k] && (
                  <ul className="tree-children">
                    {l.comps.map((c) => (
                      <li key={c.uid}>
                        <button type="button" className="tree-item small" onClick={() => pick([c.uid], { type: "line", id: l.doc.id })} onDoubleClick={() => pick([c.uid], { type: "line", id: l.doc.id }, true)}>
                          <span className="mono">{c.tag}</span>
                          <span className="tree-meta">
                            {KIND_LABEL[c.kind] ?? c.kind}
                            {c.kind === "PIPE" ? ` ${Math.round(c.props.length)} mm` : c.kind === "VALVE" ? ` ${c.props.valveType}` : c.kind === "ELBOW" ? ` ${c.props.angle}°` : ""}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </TreeSection>

        <TreeSection title="Structures" count={model.structures.size}>
          {steel.map((s) => (
            <li key={s.doc.id}>
              <div className={`tree-row${focus?.id === s.doc.id ? " on" : ""}`}>
                <span className="twisty" />
                <button type="button" className="tree-item" onClick={() => pick([s.comp.uid], { type: "structure", id: s.doc.id })} onDoubleClick={() => pick([s.comp.uid], { type: "structure", id: s.doc.id }, true)}>
                  <Icon name="rack" size={15} />
                  <span className="mono">{s.doc.tag}</span>
                  <span className="tree-meta">{(s.doc.length / 1000).toFixed(0)} m rack</span>
                </button>
              </div>
            </li>
          ))}
        </TreeSection>
      </div>
      )}
    </aside>
  );
}

function TreeSection({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <section className="tree-section">
      <h3>
        {title} <span className="count">{count}</span>
      </h3>
      <ul className="tree">{children}</ul>
    </section>
  );
}

// ------------------------------------------------------------------ system hierarchy (Area > Unit > System > objects)
const STATUS_DOT: Record<string, string> = { Working: "st-working", "In Review": "st-review", Approved: "st-approved", Rejected: "st-rejected" };

function SystemTree({ match, pick }: { match: (t: string) => boolean; pick: (uids: string[], f: { type: "equipment" | "line" | "structure"; id: string }, fit?: boolean) => void }) {
  const s = useStore();
  const [adding, setAdding] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const nodes = s.doc.hierarchy ?? [];
  const objs = objects(s.doc);
  const focus = s.focus;
  const uidsOf = (type: string, id: string) => s.model.comps.filter((c) => c.owner.type === type && c.owner.id === id).map((c) => c.uid);
  const iconOf = (type: string, o: (typeof objs)[number]["obj"]) => (type === "equipment" ? (o as { template: string }).template : type === "line" ? "route" : "rack");
  const addSystem = (parent: string) => {
    const n = name.trim();
    if (!n) return setAdding(null);
    const id = `sys-${Date.now().toString(36)}`;
    s.apply({ ...s.doc, hierarchy: [...nodes, { id, parent, kind: "system", name: n }] }, `Add system ${n}`);
    setAdding(null);
    setName("");
  };
  const render = (parent: string | null, depth: number): React.ReactNode =>
    nodes
      .filter((h) => h.parent === parent)
      .map((h) => {
        const members = objs.filter((o) => o.obj.meta?.system === h.id && match(objName(o.obj)));
        const isClosed = !!closed[h.id];
        return (
          <li key={h.id}>
            <div className="sys-row" style={{ paddingLeft: 8 + depth * 14 }}>
              <button type="button" className="twisty" aria-expanded={!isClosed} onClick={() => setClosed((c) => ({ ...c, [h.id]: !c[h.id] }))}>
                <Icon name="chevron" size={12} />
              </button>
              <Icon name={h.kind === "system" ? "folder" : h.kind === "unit" ? "iso" : "plan"} size={14} />
              <span className={`sys-name ${h.kind}`}>{h.name}</span>
              {h.kind === "system" && <span className="count">{members.length}</span>}
              {h.kind === "unit" && (
                <button type="button" className="icon-btn small" aria-label="Add a system" title="Add a system" onClick={() => setAdding(h.id)}>
                  <Icon name="plus" size={13} />
                </button>
              )}
            </div>
            {!isClosed && (
              <ul className="tree">
                {adding === h.id && (
                  <li style={{ paddingLeft: 30 + depth * 14 }} className="sys-add">
                    <input id="new-system" autoFocus placeholder="System name, e.g. Steam" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => (e.key === "Enter" ? addSystem(h.id) : e.key === "Escape" && setAdding(null))} />
                    <button type="button" className="btn small" onClick={() => addSystem(h.id)}>
                      Add
                    </button>
                  </li>
                )}
                {render(h.id, depth + 1)}
                {members.map(({ type, obj }) => (
                  <li key={obj.id}>
                    <button
                      type="button"
                      className={`tree-item sys-obj${focus?.id === obj.id ? " on" : ""}`}
                      style={{ paddingLeft: 30 + depth * 14 }}
                      onClick={() => pick(type === "equipment" ? [`${obj.id}/BODY`] : uidsOf(type, obj.id), { type, id: obj.id })}
                      onDoubleClick={() => pick(uidsOf(type, obj.id), { type, id: obj.id }, true)}
                    >
                      <Icon name={iconOf(type, obj)} size={14} />
                      <span className="mono">{objName(obj)}</span>
                      <span className={`st-dot ${STATUS_DOT[obj.meta?.status ?? "Working"]}`} title={obj.meta?.status} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      });
  return (
    <div className="pane-scroll">
      <div className="tree-root">
        <span className="eyebrow">Plant</span>
        <span className="tree-root-name">{s.doc.project.plant || s.doc.project.name}</span>
      </div>
      <ul className="tree sys-tree">{render(null, 0)}</ul>
    </div>
  );
}
