import { useMemo, useRef, useState } from "react";
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
  const focusRef = useRef<HTMLDivElement>(null);
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
          <h2>Model Explorer</h2>
          <div className="seg-tabs" role="tablist" aria-label="Explorer view">
            <button type="button" role="tab" id="ex-system" aria-selected={view === "system"} onClick={() => setView("system")}>
              Model
            </button>
            <button type="button" role="tab" id="ex-type" aria-selected={view === "type"} onClick={() => setView("type")}>
              Lists
            </button>
          </div>
        </div>
        <input id="explorer-search" className="search" type="search" placeholder="Find element (name)" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {view === "system" ? (
        <ModelTree match={match} pick={pick} rowRef={focusRef} />
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

// ------------------------------------------------------------------ model hierarchy, E3D style
// WORLD > SITE (area) > ZONE (unit) > SYST (system) > EQUI / PIPE / STRU > NOZZ / BRAN > components
const STATUS_DOT: Record<string, string> = { Working: "st-working", "In Review": "st-review", Approved: "st-approved", Rejected: "st-rejected" };
const E3D_TYPE: Record<string, string> = { ELBOW: "ELBO", TEE: "TEE", FLANGE: "FLAN", GASKET: "GASK", VALVE: "VALV", SUPPORT: "ATTA", PIPE: "TUBE" };
const E3D_NAME: Record<string, string> = { ELBO: "ELBOW", TEE: "TEE", FLAN: "FLANGE", GASK: "GASKET", VALV: "VALVE", ATTA: "ATTACHMENT" };

type Pick = (uids: string[], f: { type: "equipment" | "line" | "structure"; id: string }, fit?: boolean) => void;

function Row({ depth, open, onToggle, icon, code, name, meta, on, onClick, onDoubleClick, children, extra }: {
  depth: number;
  open?: boolean;
  onToggle?: () => void;
  icon: string;
  code: string;
  name: string;
  meta?: React.ReactNode;
  on?: boolean;
  onClick?: () => void;
  onDoubleClick?: () => void;
  children?: React.ReactNode;
  extra?: React.ReactNode;
}) {
  return (
    <li>
      <div className={`mx-row${on ? " on" : ""}`} style={{ paddingLeft: 4 + depth * 14 }}>
        {onToggle ? (
          <button type="button" className="twisty" aria-expanded={!!open} onClick={onToggle} aria-label={open ? "Collapse" : "Expand"}>
            <Icon name="chevron" size={11} />
          </button>
        ) : (
          <span className="twisty" />
        )}
        <button type="button" className="mx-item" onClick={onClick} onDoubleClick={onDoubleClick} title={`${code} ${name}`}>
          <Icon name={icon} size={14} className={`mx-ic mx-${code.toLowerCase()}`} />
          <span className="mx-name">{name}</span>
          {meta}
        </button>
        {extra}
      </div>
      {open && children && <ul className="tree">{children}</ul>}
    </li>
  );
}

function ModelTree({ match, pick, rowRef }: { match: (t: string) => boolean; pick: Pick; rowRef: React.RefObject<HTMLDivElement> }) {
  const s = useStore();
  const [adding, setAdding] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({ world: true });
  const nodes = s.doc.hierarchy ?? [];
  const objs = objects(s.doc);
  const sel = new Set(s.selection);
  const focus = s.focus;
  const isOpen = (k: string, dflt = false) => open[k] ?? dflt;
  const toggle = (k: string, dflt = false) => setOpen((o) => ({ ...o, [k]: !(o[k] ?? dflt) }));
  const uidsOf = (type: string, id: string) => s.model.comps.filter((c) => c.owner.type === type && c.owner.id === id).map((c) => c.uid);
  const addSystem = (parent: string) => {
    const n = name.trim();
    if (!n) return setAdding(null);
    const id = `sys-${Date.now().toString(36)}`;
    s.apply({ ...s.doc, hierarchy: [...nodes, { id, parent, kind: "system", name: n }] }, `Add system ${n}`);
    setAdding(null);
    setName("");
  };
  const dot = (status?: string) => <span className={`st-dot ${STATUS_DOT[status ?? "Working"]}`} title={status ?? "Working"} />;

  const element = (type: "equipment" | "line" | "structure", obj: (typeof objs)[number]["obj"], depth: number) => {
    const k = `o:${obj.id}`;
    const on = focus?.id === obj.id;
    const status = obj.meta?.status;
    if (type === "equipment") {
      const e = s.model.equipment.get(obj.id);
      const tpl = (obj as { template: string }).template;
      return (
        <Row key={k} depth={depth} open={isOpen(k)} onToggle={() => toggle(k)} icon={tpl} code="EQUI" name={`/${objName(obj)}`} meta={dot(status)} on={on}
          onClick={() => pick([`${obj.id}/BODY`], { type, id: obj.id })} onDoubleClick={() => pick(uidsOf(type, obj.id), { type, id: obj.id }, true)}>
          {e?.nozzles.map((n) => (
            <Row key={n.uid} depth={depth + 1} icon="nozzle" code="NOZZ" name={`${n.props.name}`} meta={<span className="mx-meta">{n.nps}" {n.props.service}</span>} on={sel.has(n.uid)} onClick={() => pick([n.uid], { type, id: obj.id })} />
          ))}
        </Row>
      );
    }
    if (type === "line") {
      const l = s.model.lines.get(obj.id);
      const bk = `b:${obj.id}`;
      const counters: Record<string, number> = {};
      const comps = (l?.comps ?? []).filter((c) => c.kind !== "PIPE");
      const color = LINE_COLORS[((obj as { color: number }).color ?? 0) % LINE_COLORS.length];
      return (
        <Row key={k} depth={depth} open={isOpen(k)} onToggle={() => toggle(k)} icon="route" code="PIPE" name={`/${objName(obj)}`}
          meta={<>{l?.error ? <span className="chip crit">error</span> : <span className="swatch" style={{ background: color }} />}{dot(status)}</>}
          on={on} onClick={() => pick(uidsOf(type, obj.id), { type, id: obj.id })} onDoubleClick={() => pick(uidsOf(type, obj.id), { type, id: obj.id }, true)}>
          <Row key={bk} depth={depth + 1} open={isOpen(bk, true)} onToggle={() => toggle(bk, true)} icon="lines" code="BRAN" name={`/${objName(obj)}/B1`} meta={<span className="mx-meta">{l?.doc.nps}" {comps.length} comps</span>}
            onClick={() => pick(uidsOf(type, obj.id), { type, id: obj.id })}>
            {comps.map((c) => {
              const code = E3D_TYPE[c.kind] ?? c.kind;
              counters[code] = (counters[code] ?? 0) + 1;
              const detail = c.kind === "VALVE" ? ` ${c.props.valveType}` : c.kind === "ELBOW" ? ` ${Math.round(c.props.angle)}°` : "";
              return (
                <Row key={c.uid} depth={depth + 2} icon={c.kind === "VALVE" ? (c.props.valveType as string) : ({ TEE: "tee", SUPPORT: "shoe", ELBOW: "elbow", FLANGE: "flange", GASKET: "gasket" } as Record<string, string>)[c.kind] ?? "pipe"} code={code} name={`${E3D_NAME[code] ?? code} ${counters[code]}`}
                  meta={<span className="mx-meta">{c.nps}"{detail}</span>} on={sel.has(c.uid)} onClick={() => pick([c.uid], { type, id: obj.id })} onDoubleClick={() => pick([c.uid], { type, id: obj.id }, true)} />
              );
            })}
          </Row>
        </Row>
      );
    }
    return (
      <Row key={k} depth={depth} icon="rack" code="STRU" name={`/${objName(obj)}`} meta={dot(status)} on={on}
        onClick={() => pick(uidsOf(type, obj.id), { type, id: obj.id })} onDoubleClick={() => pick(uidsOf(type, obj.id), { type, id: obj.id }, true)} />
    );
  };

  const CODE = { area: "SITE", unit: "ZONE", system: "SYST" } as const;
  const render = (parent: string | null, depth: number): React.ReactNode =>
    nodes
      .filter((h) => h.parent === parent)
      .map((h) => {
        const members = objs.filter((o) => o.obj.meta?.system === h.id && match(objName(o.obj)));
        const k = `h:${h.id}`;
        return (
          <Row key={k} depth={depth} open={isOpen(k, true)} onToggle={() => toggle(k, true)} icon={h.kind === "system" ? "folder" : h.kind === "unit" ? "iso" : "plan"} code={CODE[h.kind]}
            name={h.kind === "system" ? h.name : `/${h.name}`} meta={h.kind === "system" ? <span className="count">{members.length}</span> : undefined}
            extra={h.kind === "unit" ? (
              <button type="button" className="icon-btn small" aria-label="Add a system" title="Add a system" onClick={() => setAdding(h.id)}>
                <Icon name="plus" size={13} />
              </button>
            ) : undefined}>
            {adding === h.id && (
              <li style={{ paddingLeft: 30 + depth * 14 }} className="sys-add">
                <input id="new-system" autoFocus placeholder="System name, e.g. Steam" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => (e.key === "Enter" ? addSystem(h.id) : e.key === "Escape" && setAdding(null))} />
                <button type="button" className="btn small" onClick={() => addSystem(h.id)}>
                  Add
                </button>
              </li>
            )}
            {render(h.id, depth + 1)}
            {members.map(({ type, obj }) => element(type, obj, depth + 1))}
          </Row>
        );
      });
  return (
    <div className="pane-scroll mx" ref={rowRef}>
      <ul className="tree mx-tree">
        <Row depth={0} open={isOpen("world", true)} onToggle={() => toggle("world", true)} icon="iso" code="WORLD" name="*" meta={<span className="mx-meta">{s.doc.project.plant || s.doc.project.name}</span>}>
          {render(null, 1)}
        </Row>
      </ul>
    </div>
  );
}
