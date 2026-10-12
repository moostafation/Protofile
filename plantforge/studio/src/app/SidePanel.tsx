import { useEffect, useState } from "react";
import { npsValue } from "../engine/catalog";
import { moveEquipment, removeInline, reroute, updateEquipment, updateLine, updateNozzle, updateStructure } from "../engine/commands";
import type { EquipmentDoc, NozzleDoc } from "../engine/doc";
import { TEMPLATES } from "../engine/equipment";
import type { Comp } from "../engine/model";
import { linePcf } from "../engine/pcf";
import { SPECS, specApi } from "../engine/spec";
import { dirName, fmtENU } from "../engine/vec";
import { ApprovalError, STATUSES, objects, setMeta } from "../engine/meta";
import type { ApprovalStatus } from "../engine/doc";
import { LINE_COLORS } from "../viewer/Viewer";
import { copyText } from "./exporters";
import { cliHooks, hub } from "./hub";
import { Icon } from "./icons";
import { personName } from "../platform/people";
import { State, useStore } from "./store";

type Panel = State["panel"];

export function SidePanel() {
  const panel = useStore((s) => s.panel);
  const model = useStore((s) => s.model);
  const set = useStore((s) => s.set);
  const todoErr = model.todo.filter((t) => t.level === "error").length;
  const todoWarn = model.todo.filter((t) => t.level === "warning").length;
  const hard = (model.clashes ?? []).filter((c) => c.hard).length;
  const tabs: [Panel, string, React.ReactNode][] = [
    ["props", "Attributes", null],
    ["todo", "To-Do", todoErr ? <b className="badge crit">{todoErr}</b> : todoWarn ? <b className="badge warn">{todoWarn}</b> : null],
    ["clash", "Clashes", hard ? <b className="badge crit">{hard}</b> : <b className="badge ok">0</b>],
    ["mto", "MTO", null],
    ["lines", "Lines", null],
  ];
  return (
    <aside className="pane side" aria-label="Properties and reports">
      <div className="side-tabs" role="tablist">
        {tabs.map(([id, label, badge]) => (
          <button key={id} id={`panel-${id}`} type="button" role="tab" aria-selected={panel === id} onClick={() => set({ panel: id })}>
            {label}
            {badge}
          </button>
        ))}
      </div>
      <div className="pane-scroll side-body">
        {panel === "props" && <Properties />}
        {panel === "todo" && <TodoList />}
        {panel === "clash" && <ClashList />}
        {panel === "mto" && <MtoTable />}
        {panel === "lines" && <LineList />}
      </div>
    </aside>
  );
}

// ------------------------------------------------------------------ fields
function NumField({ id, label, value, onCommit, step = 50, unit = "mm" }: { id: string; label: string; value: number; onCommit: (v: number) => void; step?: number; unit?: string }) {
  const [v, setV] = useState(String(Math.round(value * 100) / 100));
  useEffect(() => setV(String(Math.round(value * 100) / 100)), [value]);
  const commit = () => {
    const n = Number(v);
    if (Number.isFinite(n) && n !== value) onCommit(n);
    else setV(String(Math.round(value * 100) / 100));
  };
  return (
    <label className="field">
      <span>{label}</span>
      <span className="field-input">
        <input id={id} type="number" step={step} value={v} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()} />
        {unit && <em>{unit}</em>}
      </span>
    </label>
  );
}

function TextField({ id, label, value, onCommit }: { id: string; label: string; value: string; onCommit: (v: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <label className="field">
      <span>{label}</span>
      <input id={id} value={v} onChange={(e) => setV(e.target.value)} onBlur={() => v !== value && v.trim() && onCommit(v.trim())} onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()} />
    </label>
  );
}

const Row = ({ k, v }: { k: string; v: React.ReactNode }) => (
  <>
    <dt>{k}</dt>
    <dd>{v}</dd>
  </>
);

// ------------------------------------------------------------------ properties
function Properties() {
  const s = useStore();
  const focus = s.focus;
  const comp = s.selection.length === 1 ? s.model.byUid.get(s.selection[0]) : undefined;
  if (!focus) return <ProjectProps />;
  if (focus.type === "equipment") {
    const eq = s.doc.equipment.find((e) => e.id === focus.id);
    if (!eq) return <ProjectProps />;
    return <EquipmentProps eq={eq} nozzle={comp?.kind === "NOZZLE" ? comp : undefined} />;
  }
  if (focus.type === "structure") {
    const st = s.doc.structures.find((x) => x.id === focus.id);
    if (!st) return <ProjectProps />;
    const apply = (patch: Parameters<typeof updateStructure>[2], label: string) => s.apply(updateStructure(s.doc, st.id, patch), label);
    return (
      <div className="props">
        <Header kind="Pipe rack" title={st.tag} />
        <DbCard id={st.id} />
        <div className="fields">
          <TextField id="st-tag" label="Tag" value={st.tag} onCommit={(v) => apply({ tag: v }, `Rename ${st.tag}`)} />
          <NumField id="st-e" label="Start E" value={st.origin[0]} onCommit={(v) => apply({ origin: [v, st.origin[1], st.origin[2]] }, `Move ${st.tag}`)} step={500} />
          <NumField id="st-n" label="Start N" value={st.origin[1]} onCommit={(v) => apply({ origin: [st.origin[0], v, st.origin[2]] }, `Move ${st.tag}`)} step={500} />
          <NumField id="st-len" label="Length" value={st.length} onCommit={(v) => apply({ length: Math.max(1000, v) }, `Resize ${st.tag}`)} step={1000} />
          <NumField id="st-w" label="Width" value={st.width} onCommit={(v) => apply({ width: Math.max(2000, v) }, `Resize ${st.tag}`)} step={500} />
          <NumField id="st-bay" label="Bay" value={st.bay} onCommit={(v) => apply({ bay: Math.max(3000, v) }, `Resize ${st.tag}`)} step={500} />
          <TextField id="st-levels" label="Levels (TOS)" value={st.levels.join(", ")} onCommit={(v) => apply({ levels: v.split(/[ ,]+/).map(Number).filter((x) => x > 1000) }, `Levels ${st.tag}`)} />
        </div>
        <p className="note">Pipes running along a level at shoe elevation (TOS + 100 + OD/2) get shoes automatically at every frame.</p>
      </div>
    );
  }
  const line = s.doc.lines.find((l) => l.id === focus.id);
  const res = s.model.lines.get(focus.id);
  if (!line || !res) return <ProjectProps />;
  return <LineProps lineId={line.id} comp={comp && comp.owner.id === line.id ? comp : undefined} />;
}

const Header = ({ kind, title, sub }: { kind: string; title: string; sub?: string }) => (
  <div className="props-head">
    <span className="eyebrow">{kind}</span>
    <h3>{title}</h3>
    {sub && <p className="muted">{sub}</p>}
  </div>
);

function ProjectProps() {
  const s = useStore();
  const p = s.doc.project;
  const m = s.model;
  const pipeM = [...m.lines.values()].reduce((t, l) => t + l.pipeLength, 0) / 1000;
  const shoes = m.comps.filter((c) => c.kind === "SUPPORT").length;
  const hard = (m.clashes ?? []).filter((c) => c.hard).length;
  const setP = (patch: Partial<typeof p>, label: string) => s.apply({ ...s.doc, project: { ...p, ...patch } }, label);
  return (
    <div className="props">
      <Header kind="Project" title={p.name || "Untitled plant"} sub={p.plant} />
      <div className="stats">
        <div>
          <b>{m.equipment.size}</b>
          <span>equipment</span>
        </div>
        <div>
          <b>{m.lines.size}</b>
          <span>lines</span>
        </div>
        <div>
          <b>{pipeM.toFixed(1)}</b>
          <span>m of pipe</span>
        </div>
        <div>
          <b>{m.conn.welds.length}</b>
          <span>butt welds</span>
        </div>
        <div>
          <b>{+m.conn.inchDia.toFixed(1)}</b>
          <span>weld inch-dia</span>
        </div>
        <div>
          <b className={hard ? "crit-text" : "ok-text"}>{hard}</b>
          <span>hard clashes</span>
        </div>
      </div>
      <div className="fields">
        <TextField id="pj-name" label="Project" value={p.name} onCommit={(v) => setP({ name: v }, "Rename project")} />
        <TextField id="pj-plant" label="Plant" value={p.plant || "—"} onCommit={(v) => setP({ plant: v }, "Edit plant")} />
        <TextField id="pj-area" label="Area" value={p.area || "—"} onCommit={(v) => setP({ area: v }, "Edit area")} />
        <TextField id="pj-unit" label="Unit" value={p.unit || "—"} onCommit={(v) => setP({ unit: v }, "Edit unit")} />
      </div>
      <p className="note">
        {shoes} pipe shoes placed automatically on racks. Click anything in the model to edit it, or try <b>Piping › Auto-route</b>: pick two nozzles and the router finds a clash-free path over the rack.
      </p>
    </div>
  );
}

function EquipmentProps({ eq, nozzle }: { eq: EquipmentDoc; nozzle?: Comp }) {
  const s = useStore();
  const t = TEMPLATES[eq.template];
  const params = { ...t.params, ...eq.params };
  const connected = new Set(s.model.conn.joints.flatMap((j) => [j.a.uid, j.b.uid]));
  const move = (o: EquipmentDoc["origin"], rot = eq.rot) => {
    s.apply(moveEquipment(s.doc, eq.id, o, rot), `Move ${eq.tag}`);
    const broken = [...useStore.getState().model.lines.values()].filter((l) => l.error);
    if (broken.length) s.toast(`${broken.map((l) => l.doc.number).join(", ")} could not follow - use Re-route`, "error");
  };
  const setParam = (k: string, v: number) => {
    const before = s.doc;
    const doc = updateEquipment(before, eq.id, { params: { ...eq.params, [k]: v } });
    s.apply(moveEquipment(doc, eq.id, eq.origin), `Resize ${eq.tag}`);
  };
  const setNoz = (n: NozzleDoc, patch: Partial<NozzleDoc>, label: string) => {
    const doc = updateNozzle(s.doc, eq.id, n.name, patch);
    s.apply(moveEquipment(doc, eq.id, eq.origin), label);
  };
  return (
    <div className="props">
      <Header kind={t.name} title={eq.tag} sub={eq.description} />
      <DbCard id={eq.id} />
      <div className="fields">
        <TextField id="eq-tag" label="Tag" value={eq.tag} onCommit={(v) => s.apply(updateEquipment(s.doc, eq.id, { tag: v.toUpperCase() }), `Rename ${eq.tag}`)} />
        <TextField id="eq-desc" label="Description" value={eq.description} onCommit={(v) => s.apply(updateEquipment(s.doc, eq.id, { description: v }), `Describe ${eq.tag}`)} />
        <NumField id="eq-e" label="Position E" value={eq.origin[0]} onCommit={(v) => move([v, eq.origin[1], eq.origin[2]])} step={100} />
        <NumField id="eq-n" label="Position N" value={eq.origin[1]} onCommit={(v) => move([eq.origin[0], v, eq.origin[2]])} step={100} />
        <NumField id="eq-z" label="Position EL" value={eq.origin[2]} onCommit={(v) => move([eq.origin[0], eq.origin[1], v])} step={100} />
        <NumField id="eq-rot" label="Rotation" value={eq.rot} onCommit={(v) => move(eq.origin, v)} step={90} unit="°" />
        {t.paramSpecs.map((p) => (
          <NumField key={p.key} id={`eq-${p.key}`} label={p.label} value={params[p.key]} step={p.step} onCommit={(v) => setParam(p.key, Math.min(p.max, Math.max(p.min, v)))} />
        ))}
      </div>
      <h4 className="sub">Nozzles</h4>
      <div className="nozzles">
        {eq.nozzles.map((n) => {
          const built = s.model.equipment.get(eq.id)?.nozzles.find((x) => x.props.name === n.name);
          const isOn = nozzle?.props.name === n.name;
          return (
            <div key={n.name} className={`noz${isOn ? " on" : ""}`}>
              <div className="noz-head">
                <button type="button" className="link mono" onClick={() => built && s.select([built.uid], { type: "equipment", id: eq.id })}>
                  {n.name}
                </button>
                <span className={`dot ${built && connected.has(built.uid) ? "ok" : "free"}`} />
                <span className="muted">{built ? `${fmtENU(built.ports[0].pos)} · ${dirName(built.ports[0].dir)}` : ""}</span>
              </div>
              <div className="noz-fields">
                <label className="field">
                  <span>NPS</span>
                  <select id={`nz-${n.name}-nps`} value={n.nps} onChange={(e) => setNoz(n, { nps: e.target.value }, `Nozzle ${eq.tag}/${n.name} size`)}>
                    {specApi.sizes(SPECS.A1A).map((k) => (
                      <option key={k} value={k}>
                        {k}"
                      </option>
                    ))}
                  </select>
                </label>
                <TextField id={`nz-${n.name}-svc`} label="Service" value={n.service || "—"} onCommit={(v) => setNoz(n, { service: v }, `Nozzle ${eq.tag}/${n.name} service`)} />
                {n.place.kind === "shell" && (
                  <>
                    <NumField id={`nz-${n.name}-el`} label="Elevation" value={n.place.elev} onCommit={(v) => setNoz(n, { place: { ...(n.place as { kind: "shell"; elev: number; orient: number }), elev: v } }, `Nozzle ${n.name} elevation`)} step={100} />
                    <NumField id={`nz-${n.name}-or`} label="Orientation" value={n.place.orient} unit="° from N" onCommit={(v) => setNoz(n, { place: { ...(n.place as { kind: "shell"; elev: number; orient: number }), orient: ((v % 360) + 360) % 360 } }, `Nozzle ${n.name} orientation`)} step={90} />
                  </>
                )}
                {n.place.kind === "hshell" && (
                  <>
                    <NumField id={`nz-${n.name}-st`} label="Station" value={n.place.station} onCommit={(v) => setNoz(n, { place: { ...(n.place as { kind: "hshell"; station: number; angle: number }), station: v } }, `Nozzle ${n.name} station`)} step={100} />
                    <NumField id={`nz-${n.name}-an`} label="Angle" value={n.place.angle} unit="° 0=top" onCommit={(v) => setNoz(n, { place: { ...(n.place as { kind: "hshell"; station: number; angle: number }), angle: ((v % 360) + 360) % 360 } }, `Nozzle ${n.name} angle`)} step={90} />
                  </>
                )}
                <NumField id={`nz-${n.name}-pr`} label="Projection" value={n.proj} onCommit={(v) => setNoz(n, { proj: Math.max(100, v) }, `Nozzle ${n.name} projection`)} step={50} />
              </div>
              {built && !connected.has(built.uid) && (
                <button type="button" className="btn small" onClick={() => cliHooks.startRoute(built.tag)}>
                  <Icon name="route" size={14} /> Route from {n.name}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function LineProps({ lineId, comp }: { lineId: string; comp?: Comp }) {
  const s = useStore();
  const line = s.doc.lines.find((l) => l.id === lineId)!;
  const res = s.model.lines.get(lineId)!;
  const counts: Record<string, number> = {};
  for (const c of res.comps) counts[c.kind] = (counts[c.kind] ?? 0) + 1;
  const end = (r: typeof line.start) =>
    r.kind === "nozzle" ? `${s.doc.equipment.find((e) => e.id === r.eq)?.tag}/${r.nozzle}` : r.kind === "tee" ? `Tee on ${s.doc.lines.find((l) => l.id === r.line)?.number}` : r.kind === "flanged" ? "Flanged end" : "Open end";
  const welds = s.model.conn.welds.filter((j) => j.a.owner.id === lineId || j.b.owner.id === lineId);
  return (
    <div className="props">
      {comp && <ComponentCard comp={comp} />}
      <Header kind="Pipeline" title={line.number} sub={line.fluid} />
      <DbCard id={line.id} />
      {res.error && (
        <div className="callout crit">
          <b>Routing problem.</b> {res.error.replace(`${line.number}: `, "")}
          <button
            type="button"
            className="btn small"
            onClick={() => {
              const r = reroute(s.doc, lineId);
              if (r.error) return s.toast(r.error, "error");
              s.apply(r.doc, `Re-route ${line.number}`);
            }}
          >
            <Icon name="reroute" size={14} /> Re-route automatically
          </button>
        </div>
      )}
      <dl className="kv">
        <Row k="From" v={end(line.start)} />
        <Row k="To" v={end(line.end)} />
        <Row k="Spec / NPS" v={`${line.spec} · ${line.nps}" (DN ${Math.round(npsValue(line.nps) * 25)})`} />
        <Row k="Pipe" v={`${(res.pipeLength / 1000).toFixed(2)} m`} />
        <Row k="Fittings" v={`${counts.ELBOW ?? 0} elbows · ${counts.TEE ?? 0} tees · ${counts.FLANGE ?? 0} flanges`} />
        <Row k="Valves" v={`${counts.VALVE ?? 0}`} />
        <Row k="Shoes" v={`${counts.SUPPORT ?? 0}`} />
        <Row k="Welds" v={`${welds.length}`} />
      </dl>
      <div className="fields">
        <TextField id="ln-number" label="Line number" value={line.number} onCommit={(v) => s.apply(updateLine(s.doc, lineId, { number: v }), `Rename ${line.number}`)} />
        <TextField id="ln-fluid" label="Fluid / service" value={line.fluid} onCommit={(v) => s.apply(updateLine(s.doc, lineId, { fluid: v }), `Edit ${line.number}`)} />
        <div className="field">
          <span>Colour</span>
          <div className="swatches">
            {LINE_COLORS.map((c, i) => (
              <button key={c} type="button" className={`swatch-btn${line.color === i ? " on" : ""}`} style={{ background: c }} aria-label={`Colour ${i + 1}`} onClick={() => s.apply(updateLine(s.doc, lineId, { color: i }), `Recolour ${line.number}`)} />
            ))}
          </div>
        </div>
      </div>
      {line.inline.length > 0 && (
        <>
          <h4 className="sub">Inline items</h4>
          <ul className="inline-list">
            {line.inline.map((it) => (
              <li key={it.id}>
                <span>
                  {it.type === "tee" ? `Tee, branch ${dirName(it.branch!)}` : `${it.type} valve`} · leg {it.leg} @ {Math.round(it.station)} mm
                </span>
                <button type="button" className="icon-btn" aria-label="Remove" onClick={() => s.apply(removeInline(s.doc, lineId, it.id), `Remove ${it.type} from ${line.number}`)}>
                  <Icon name="trash" size={14} />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="actions">
        <button type="button" className="btn" onClick={() => s.set({ isoLine: lineId })} disabled={!!res.error}>
          <Icon name="iso_dwg" size={15} /> Isometric
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            const r = reroute(s.doc, lineId);
            if (r.error) return s.toast(r.error, "error");
            s.apply(r.doc, `Re-route ${line.number}`);
            s.toast(r.info ?? "Re-routed");
          }}
        >
          <Icon name="reroute" size={15} /> Re-route
        </button>
        <button type="button" className="btn" disabled={!!res.error} onClick={async () => s.toast((await copyText(linePcf(s.model, res))) ? "PCF copied to the clipboard" : "Copy is blocked here - use Drawings › Package .zip", "info")}>
          <Icon name="copy" size={15} /> Copy PCF
        </button>
        <button type="button" className="btn" onClick={() => hub.viewer?.fit(res.comps.map((c) => c.uid))}>
          <Icon name="fit" size={15} /> Zoom to
        </button>
      </div>
    </div>
  );
}

function ComponentCard({ comp }: { comp: Comp }) {
  const s = useStore();
  const p = comp.props;
  const rows: [string, string][] = [];
  if (comp.kind === "PIPE") rows.push(["Length", `${Math.round(p.length)} mm`], ["Schedule", p.schedule], ["OD × wall", `${p.od} × ${p.wall} mm`], ["Weight", `${p.weight.toFixed(1)} kg`]);
  if (comp.kind === "ELBOW") rows.push(["Type", p.variant], ["Angle", `${p.angle}°`], ["Centre to end", `${p.centerToEnd.toFixed(1)} mm`], ["Bend radius", `${p.bendRadius.toFixed(1)} mm`], ["Intersection", fmtENU(p.vertex)]);
  if (comp.kind === "VALVE") rows.push(["Valve", p.valveType], ["Face to face", `${p.faceToFace} mm`], ["Rating", p.rating], ["Operator", `handwheel ${dirName(p.stem)}`]);
  if (comp.kind === "FLANGE") rows.push(["Rating", p.rating], ["Face to weld end", `${p.length.toFixed(1)} mm`], ["Bolting", `${p.bolts} × ${p.boltDia}"`]);
  if (comp.kind === "GASKET") rows.push(["Thickness", `${p.thickness} mm`], ["Bolting", `${p.bolts} × ${p.boltDia}"`]);
  if (comp.kind === "TEE") rows.push(["Centre to end", `${p.centerToEnd} mm`], ["Centre", fmtENU(p.center)], ["Branch", dirName(p.branchDir)]);
  if (comp.kind === "SUPPORT") rows.push(["Type", "Pipe shoe"], ["Height", `${p.height} mm`], ["At", fmtENU(p.at)]);
  return (
    <div className="comp-card">
      <span className="eyebrow">
        {comp.kind.toLowerCase()} · {comp.tag}
      </span>
      <p className="comp-desc">{comp.desc}</p>
      <dl className="kv">
        <Row k="Size" v={`NPS ${comp.nps}`} />
        {rows.map(([k, v]) => (
          <Row key={k} k={k} v={v} />
        ))}
        {comp.skey && <Row k="SKEY" v={comp.skey} />}
      </dl>
      {comp.ports.length > 0 && (
        <details>
          <summary>Connection points</summary>
          <table className="tbl">
            <tbody>
              {comp.ports.map((q) => (
                <tr key={q.name}>
                  <td className="mono">{q.name}</td>
                  <td className="mono">{q.end}</td>
                  <td className="mono">{fmtENU(q.pos)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
      {p.inlineId && (
        <button type="button" className="btn small danger" onClick={() => s.apply(removeInline(s.doc, comp.owner.id, p.inlineId), `Remove ${comp.kind.toLowerCase()}`)}>
          <Icon name="trash" size={14} /> Remove this {comp.kind === "TEE" ? "tee" : "valve assembly"}
        </button>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ reports
function TodoList() {
  const s = useStore();
  const items = s.model.todo;
  if (!items.length) return <p className="empty">Nothing to fix. Every line routes, connects and fits.</p>;
  return (
    <ul className="todo">
      {items.map((t, i) => (
        <li key={i}>
          <button
            type="button"
            className={`todo-item ${t.level}`}
            onClick={() => {
              if (t.owner) {
                const uids = t.uids.length ? t.uids : s.model.comps.filter((c) => c.owner.id === t.owner!.id).map((c) => c.uid);
                s.select(uids, t.owner);
                hub.viewer?.fit(uids.length ? uids : undefined);
              }
            }}
          >
            <span className={`chip ${t.level === "error" ? "crit" : t.level === "warning" ? "warn" : "info"}`}>{t.level}</span>
            <span>{t.text}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function ClashList() {
  const s = useStore();
  const clashes = s.model.clashes ?? [];
  const name = (uid: string) => {
    const c = s.model.byUid.get(uid);
    if (!c) return uid;
    if (c.owner.type === "line") return `${s.model.lines.get(c.owner.id)?.doc.number} · ${c.tag}`;
    return c.tag;
  };
  if (!clashes.length)
    return (
      <div className="empty">
        <p>
          <b className="ok-text">Clash-free.</b> No interference between lines, equipment and steel{s.clearance ? ` within ${s.clearance} mm` : ""}.
        </p>
        <p className="muted">Parts of the same line, and parts bolted or welded to each other, are not checked against each other.</p>
      </div>
    );
  return (
    <ul className="clashes">
      {clashes.map((c, i) => (
        <li key={i}>
          <button
            type="button"
            className={`clash-item${c.hard ? "" : " soft"}`}
            onClick={() => {
              s.select([c.a, c.b], undefined);
              hub.viewer?.focusPoint(c.point, 6);
            }}
          >
            <span className={`chip ${c.hard ? "crit" : "warn"}`}>{c.hard ? "Hard clash" : `${Math.round(c.distance)} mm`}</span>
            <span className="mono">{name(c.a)}</span>
            <span className="mono">↔ {name(c.b)}</span>
            <span className="muted">near {fmtENU(c.point)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function MtoTable() {
  const s = useStore();
  const rows = s.model.mto;
  if (!rows.length) return <p className="empty">Route a line to see its material take-off.</p>;
  return (
    <div className="mto">
      <div className="table-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>#</th>
              <th>Item</th>
              <th className="num">NPS</th>
              <th className="num">Qty</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="num">{i + 1}</td>
                <td>{r.kind.toLowerCase()}</td>
                <td className="num">{r.nps}</td>
                <td className="num">
                  {r.unit === "m" ? r.qty.toFixed(2) : r.qty} {r.unit}
                </td>
                <td>{r.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="note">
        {s.model.conn.welds.length} butt welds · {+s.model.conn.inchDia.toFixed(1)} inch-dia · pipe {rows.filter((r) => r.kind === "PIPE").reduce((t, r) => t + (r.weight ?? 0), 0).toFixed(0)} kg
      </p>
    </div>
  );
}

function LineList() {
  const s = useStore();
  const lines = [...s.model.lines.values()];
  if (!lines.length) return <p className="empty">No lines yet. Use Piping › Route pipe or Auto-route.</p>;
  const end = (r: (typeof lines)[number]["doc"]["start"]) =>
    r.kind === "nozzle" ? `${s.doc.equipment.find((e) => e.id === r.eq)?.tag}/${r.nozzle}` : r.kind === "tee" ? "Tee" : r.kind === "flanged" ? "BL (flg)" : "Open";
  return (
    <div className="table-wrap">
      <table className="tbl lines">
        <thead>
          <tr>
            <th>Line</th>
            <th>From</th>
            <th>To</th>
            <th className="num">m</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.doc.id} className={l.error ? "bad" : ""} onClick={() => s.select(l.comps.map((c) => c.uid), { type: "line", id: l.doc.id })}>
              <td className="mono">
                <span className="swatch" style={{ background: LINE_COLORS[l.doc.color % LINE_COLORS.length] }} /> {l.doc.number}
              </td>
              <td className="mono">{end(l.doc.start)}</td>
              <td className="mono">{end(l.doc.end)}</td>
              <td className="num">{(l.pipeLength / 1000).toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ------------------------------------------------------------------ database card (SP3D-style object metadata)
const STATUS_CLASS: Record<ApprovalStatus, string> = { Working: "info", "In Review": "warn", Approved: "ok", Rejected: "crit" };

export function DbCard({ id }: { id: string }) {
  const s = useStore();
  const found = objects(s.doc).find((o) => o.obj.id === id);
  if (!found?.obj.meta) return null;
  const m = found.obj.meta;
  const systems = (s.doc.hierarchy ?? []).filter((h) => h.kind === "system");
  const when = (t: number) => new Date(t).toLocaleString();
  const change = (patch: Parameters<typeof setMeta>[2], label: string) => {
    try {
      s.apply(setMeta(s.doc, [id], patch, s.user), label);
    } catch (e) {
      if (e instanceof ApprovalError) s.toast(e.message, "error");
      else throw e;
    }
  };
  return (
    <div className={`db-card${m.status === "Approved" ? " locked" : ""}`}>
      <div className="db-card-head">
        <span className={`chip ${STATUS_CLASS[m.status]}`}>{m.status}</span>
        <span className="mono muted">OID {id} · rev {m.rev}</span>
        {m.status === "Approved" && <span className="lock">locked</span>}
      </div>
      <div className="fields">
        <label className="field">
          <span>Status</span>
          <select id={`db-status-${id}`} value={m.status} onChange={(e) => change({ status: e.target.value as ApprovalStatus }, `Set ${e.target.value}`)}>
            {STATUSES.map((st) => (
              <option key={st} value={st} disabled={(st === "Approved" || st === "Rejected") && !s.user.canApprove}>
                {st}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Permission group</span>
          <select id={`db-group-${id}`} value={m.group} onChange={(e) => change({ group: e.target.value }, `Permission group ${e.target.value}`)}>
            {(s.doc.groups ?? []).map((g) => (
              <option key={g}>{g}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>System</span>
          <select id={`db-system-${id}`} value={m.system} onChange={(e) => change({ system: e.target.value }, `Move to system ${systems.find((x) => x.id === e.target.value)?.name}`)}>
            {systems.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="note">
        Created by {personName(m.createdBy)} · {when(m.createdAt)}
        <br />
        Last change by {personName(m.modifiedBy)} · {when(m.modifiedAt)}
      </p>
    </div>
  );
}
