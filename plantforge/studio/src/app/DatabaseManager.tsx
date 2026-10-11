// The plant database manager: in one dialog, what SP3D spreads over Project Management, the catalog
// task, Excel bulkload, the reports database and the transaction history.

import { strToU8, unzipSync, zipSync } from "fflate";
import { useEffect, useMemo, useRef, useState } from "react";
import type { SqlValue } from "sql.js";
import type { ApprovalStatus } from "../engine/doc";
import { ApprovalError, ObjType, STATUSES, setMeta } from "../engine/meta";
import type { QueryResult, TableInfo } from "../db/PlantDB";
import { EDITABLE, REPORTS } from "../db/schema";
import { catalogChanged, dbHub, openBytes, resetCatalog } from "../db/service";
import { saveFile } from "../platform/claude";
import { personName } from "../platform/people";
import { Modal } from "./Chrome";
import { hub } from "./hub";
import { Icon } from "./icons";
import { DbPage, useStore } from "./store";

type Page = DbPage;

const PAGES: [Page, string, string][] = [
  ["overview", "Overview", "database"],
  ["objects", "Objects & approval", "shield"],
  ["catalog", "Catalog & specs", "table"],
  ["sql", "SQL & reports", "terminal"],
  ["history", "Transactions", "history"],
];

const S = () => useStore.getState();
const toast = (text: string, kind: "ok" | "error" | "info" = "ok") => S().toast(text, kind);
const safe = (s: string) => s.replace(/"/g, "in").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "plant";

export const STATUS_CLASS: Record<ApprovalStatus, string> = { Working: "st-working", "In Review": "st-review", Approved: "st-approved", Rejected: "st-rejected" };

function fmt(v: SqlValue): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000);
  if (v instanceof Uint8Array) return `<${v.length} bytes>`;
  return String(v);
}

async function offer(filename: string, data: string | Blob) {
  const r = await saveFile(filename, data);
  if (r === "saved") toast(`Saved ${filename}`);
  else if (r === "unavailable") toast("Downloads are not available in this view. Open the page in Claude to download.", "error");
}

export function DatabaseManager() {
  const set = useStore((s) => s.set);
  const page = useStore((s) => s.dbPage);
  const setPage = (p: Page) => set({ dbPage: p });
  const [sql, setSql] = useState(REPORTS[0].sql);
  const db = dbHub.db;
  const openSql = (text: string) => {
    setSql(text);
    setPage("sql");
  };
  return (
    <Modal title="Plant database" onClose={() => set({ dbOpen: false })} wide>
      {!db ? (
        <p className="muted pad">The plant database is still opening…</p>
      ) : (
        <div className="dbm">
          <nav className="dbm-nav" aria-label="Database sections">
            {PAGES.map(([id, label, icon]) => (
              <button key={id} id={`dbm-${id}`} type="button" className={page === id ? "on" : ""} aria-current={page === id ? "page" : undefined} onClick={() => setPage(id)}>
                <Icon name={icon} size={17} />
                <span>{label}</span>
              </button>
            ))}
          </nav>
          <section className="dbm-body">
            {page === "overview" && <Overview openSql={openSql} />}
            {page === "objects" && <Objects />}
            {page === "catalog" && <Catalog />}
            {page === "sql" && <SqlConsole text={sql} setText={setSql} />}
            {page === "history" && <History />}
          </section>
        </div>
      )}
    </Modal>
  );
}

// ------------------------------------------------------------------ result grid
function ResultGrid({ r, max = 1000 }: { r: QueryResult; max?: number }) {
  const numeric = r.columns.map((_, i) => r.rows.length > 0 && r.rows.every((row) => row[i] === null || typeof row[i] === "number"));
  return (
    <div className="dbm-grid">
      <table className="tbl dbm-tbl">
        <thead>
          <tr>
            {r.columns.map((c, i) => (
              <th key={i} className={numeric[i] ? "num" : ""}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {r.rows.slice(0, max).map((row, i) => (
            <tr key={i}>
              {row.map((v, j) => {
                const s = fmt(v);
                return (
                  <td key={j} className={numeric[j] ? "num" : ""} title={s.length > 60 ? s : undefined}>
                    {s.length > 120 ? `${s.slice(0, 117)}…` : s}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {r.rows.length === 0 && <p className="muted pad">No rows.</p>}
    </div>
  );
}

// ------------------------------------------------------------------ overview
const GROUP_LABEL: Record<TableInfo["group"], string> = {
  plant: "Plant & hierarchy",
  catalog: "Catalog (reference data)",
  spec: "Piping specs",
  model: "Model objects",
  report: "Report tables (derived)",
  log: "Transaction log",
  view: "Report views",
};

function Overview({ openSql }: { openSql: (sql: string) => void }) {
  const dbRev = useStore((s) => s.dbRev);
  const user = useStore((s) => s.user);
  const shared = useStore((s) => s.shared);
  const project = useStore((s) => s.doc.project);
  const db = dbHub.db!;
  const tables = useMemo(() => db.tables(), [db, dbRev]);
  const info = useMemo(() => db.info(), [db, dbRev]);
  const status = useMemo(() => db.rows<{ status: ApprovalStatus; n: number }>("SELECT status, COUNT(*) AS n FROM object GROUP BY status"), [db, dbRev]);
  const size = useMemo(() => db.sizeBytes(), [db, dbRev]);
  const total = status.reduce((a, r) => a + r.n, 0);
  const txns = tables.find((t) => t.name === "txn")?.rows ?? 0;
  const file = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<{ name: string; bytes: Uint8Array } | null>(null);
  const groups = (["plant", "catalog", "spec", "model", "report", "log", "view"] as const).map((g) => [g, tables.filter((t) => t.group === g)] as const);

  const backup = () => {
    const base = safe(project.name);
    const readme = [
      `PlantForge plant database - ${project.name} - ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
      "",
      `${base}.sqlite is a standard SQLite 3 database. Open it with DB Browser for SQLite, DBeaver,`,
      "Python (sqlite3), Excel/Power BI (ODBC) or any SQL tool.",
      "",
      "Tables: catalog (cat_*), specs (spec_*), model objects (object, equipment, nozzle, line, structure),",
      "report tables (component, weld, clash, mto), transaction log (txn) and report views (v_*).",
      "",
      "Restore it in PlantForge Studio: Database > Plant database > Overview > Restore.",
    ].join("\n");
    const zip = zipSync({ [`${base}.sqlite`]: db.export(), "README.txt": strToU8(readme) }, { level: 6 });
    offer(`${base}-database.zip`, new Blob([zip], { type: "application/zip" }));
  };

  const pick = async (f: File) => {
    try {
      let bytes = new Uint8Array(await f.arrayBuffer());
      if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
        const entries = unzipSync(bytes);
        const name = Object.keys(entries).find((n) => /\.(sqlite|db|sqlite3)$/i.test(n));
        if (!name) throw new Error("the zip has no .sqlite file");
        bytes = entries[name];
      }
      if (new TextDecoder().decode(bytes.slice(0, 15)) !== "SQLite format 3") throw new Error("not a SQLite database");
      setPending({ name: f.name, bytes });
    } catch (e) {
      toast(`Could not read ${f.name}: ${(e as Error).message}`, "error");
    }
  };

  const restore = async () => {
    if (!pending) return;
    try {
      await openBytes(pending.bytes, `Restored ${pending.name}`);
      dbHub.db?.logTxn(`Restored database from ${pending.name}`, S().user.name);
      setPending(null);
      toast(`Restored ${pending.name}`);
      setTimeout(() => hub.viewer?.setView("iso-sw"), 50);
    } catch (e) {
      toast(`Could not restore: ${(e as Error).message}`, "error");
    }
  };

  const reports = () => {
    const files: Record<string, Uint8Array> = {};
    for (const r of REPORTS) files[`${safe(r.name)}.csv`] = strToU8(db.csv(r.sql));
    offer(`${safe(project.name)}-reports.zip`, new Blob([zipSync(files, { level: 6 })], { type: "application/zip" }));
  };

  return (
    <div className="dbm-page">
      <div className="dbm-stats">
        <Stat label="Plant" value={project.name || "Untitled"} sub={[project.area, project.unit].filter(Boolean).join(" · ")} />
        <Stat label="Objects" value={String(total)} sub={`${tables.find((t) => t.name === "component")?.rows ?? 0} components`} />
        <Stat label="Transactions" value={String(txns)} sub="audit trail" />
        <Stat label="Database" value={`${(size / 1024).toFixed(0)} KB`} sub={`SQLite 3 · schema v${info.schema_version ?? "?"}`} />
        <Stat label="You" value={personName(user.id) || user.name} sub={user.canApprove ? "can approve & edit catalog" : "can model, not approve"} />
        <Stat label="Mode" value={shared ? `Shared · ${shared.status}` : "This browser"} sub={shared ? shared.name : "kept in this browser, save to your account"} />
      </div>

      <div className="dbm-section">
        <h3>Approval status</h3>
        <div className="st-bar" role="img" aria-label={status.map((s) => `${s.status} ${s.n}`).join(", ")}>
          {STATUSES.map((st) => {
            const n = status.find((s) => s.status === st)?.n ?? 0;
            return n ? <span key={st} className={STATUS_CLASS[st]} style={{ flexGrow: n }} title={`${st}: ${n}`} /> : null;
          })}
        </div>
        <div className="st-legend">
          {STATUSES.map((st) => (
            <span key={st}>
              <i className={`st-dot ${STATUS_CLASS[st]}`} /> {st} <b className="mono">{status.find((s) => s.status === st)?.n ?? 0}</b>
            </span>
          ))}
        </div>
      </div>

      <div className="dbm-section">
        <h3>Backup &amp; restore</h3>
        <div className="dbm-actions">
          <button type="button" id="db-backup" className="btn accent" onClick={backup}>
            <Icon name="download" size={15} /> Back up (.sqlite in .zip)
          </button>
          <button type="button" id="db-restore" className="btn" onClick={() => file.current?.click()}>
            <Icon name="upload" size={15} /> Restore…
          </button>
          <button type="button" className="btn" onClick={reports}>
            <Icon name="mto" size={15} /> All reports (.csv in .zip)
          </button>
          <input
            ref={file}
            id="db-restore-file"
            type="file"
            accept=".sqlite,.sqlite3,.db,.zip"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) pick(f);
            }}
          />
        </div>
        {pending && (
          <div className="dbm-confirm" role="alert">
            <span>
              Replace the current plant database with <b>{pending.name}</b>? Back up first if you need the current one.
            </span>
            <button type="button" id="db-restore-confirm" className="btn small danger" onClick={restore}>
              Replace
            </button>
            <button type="button" className="btn small" onClick={() => setPending(null)}>
              Cancel
            </button>
          </div>
        )}
      </div>

      <div className="dbm-section">
        <h3>Tables and views</h3>
        <div className="dbm-tables">
          {groups.map(([g, list]) =>
            list.length ? (
              <div key={g} className="dbm-tgroup">
                <h4>{GROUP_LABEL[g]}</h4>
                <ul>
                  {list.map((t) => (
                    <li key={t.name}>
                      <button type="button" className="link mono" onClick={() => openSql(`SELECT * FROM ${t.name} LIMIT 500;`)}>
                        {t.name}
                      </button>
                      <span className="mono muted">{t.rows}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null,
          )}
        </div>
      </div>
    </div>
  );
}

const Stat = ({ label, value, sub }: { label: string; value: string; sub?: string }) => (
  <div className="dbm-stat">
    <span className="muted">{label}</span>
    <b>{value}</b>
    {sub && <small className="muted">{sub}</small>}
  </div>
);

// ------------------------------------------------------------------ objects & approval
interface ObjRow {
  oid: string;
  type: ObjType;
  name: string;
  status: ApprovalStatus;
  grp: string;
  system: string;
  sys_name: string;
  rev: number;
  modified_by: string;
  modified_at: string;
}

function Objects() {
  const dbRev = useStore((s) => s.dbRev);
  useStore((s) => s.peopleRev);
  const user = useStore((s) => s.user);
  const doc = useStore((s) => s.doc);
  const db = dbHub.db!;
  const [type, setType] = useState<"all" | ObjType>("all");
  const [status, setStatus] = useState<"all" | ApprovalStatus>("all");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [toStatus, setToStatus] = useState<ApprovalStatus>("In Review");
  const [toGroup, setToGroup] = useState(doc.groups?.[0] ?? "Piping");
  const systems = (doc.hierarchy ?? []).filter((h) => h.kind === "system");
  const [toSystem, setToSystem] = useState(systems[0]?.id ?? "");
  const rows = useMemo(
    () =>
      db.rows<ObjRow>(
        `SELECT o.oid, o.type, o.name, o.status, o.permission_group AS grp, o.system, COALESCE(h.name, o.system) AS sys_name, o.rev, o.modified_by, o.modified_at
         FROM object o LEFT JOIN hierarchy h ON h.oid = o.system ORDER BY o.type, o.name`,
      ),
    [db, dbRev],
  );
  const needle = q.trim().toUpperCase();
  const shown = rows.filter((r) => (type === "all" || r.type === type) && (status === "all" || r.status === status) && (!needle || r.name.toUpperCase().includes(needle) || r.sys_name.toUpperCase().includes(needle)));
  const chosen = [...sel].filter((id) => rows.some((r) => r.oid === id));
  const allOn = shown.length > 0 && shown.every((r) => sel.has(r.oid));

  const act = (patch: Parameters<typeof setMeta>[2], label: string) => {
    if (!chosen.length) return toast("Tick the objects to change first", "error");
    try {
      const next = setMeta(S().doc, chosen, patch, user);
      if (S().apply(next, `${label} (${chosen.length} object${chosen.length > 1 ? "s" : ""})`)) toast(`${label}: ${chosen.length} object${chosen.length > 1 ? "s" : ""}`);
    } catch (e) {
      if (e instanceof ApprovalError) toast(e.message, "error");
      else throw e;
    }
  };

  const show = (r: ObjRow) => {
    const st = S();
    const uids = st.model.comps.filter((c) => c.owner.type === r.type && c.owner.id === r.oid).map((c) => c.uid);
    st.select(uids, { type: r.type, id: r.oid });
    st.set({ dbOpen: false });
    setTimeout(() => hub.viewer?.fit(uids), 30);
  };

  return (
    <div className="dbm-page">
      <div className="dbm-toolbar">
        <input type="search" placeholder="Filter by name or system" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter objects" />
        <select value={type} onChange={(e) => setType(e.target.value as typeof type)} aria-label="Object type">
          <option value="all">All types</option>
          <option value="equipment">Equipment</option>
          <option value="line">Pipelines</option>
          <option value="structure">Structures</option>
        </select>
        <select id="obj-filter-status" value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="Status">
          <option value="all">Any status</option>
          {STATUSES.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <span className="grow" />
        <span className="muted">
          {shown.length} of {rows.length} · {chosen.length} ticked
        </span>
      </div>
      <div className="dbm-bulk">
        <label>
          Status
          <select id="bulk-status" value={toStatus} onChange={(e) => setToStatus(e.target.value as ApprovalStatus)}>
            {STATUSES.map((s) => (
              <option key={s} disabled={!user.canApprove && (s === "Approved" || s === "Rejected")}>
                {s}
              </option>
            ))}
          </select>
          <button type="button" id="bulk-status-apply" className="btn small accent" disabled={!chosen.length} onClick={() => act({ status: toStatus }, `Set status ${toStatus}`)}>
            Set
          </button>
        </label>
        <label>
          Permission group
          <select value={toGroup} onChange={(e) => setToGroup(e.target.value)}>
            {(doc.groups ?? []).map((g) => (
              <option key={g}>{g}</option>
            ))}
          </select>
          <button type="button" className="btn small" disabled={!chosen.length} onClick={() => act({ group: toGroup }, `Set permission group ${toGroup}`)}>
            Set
          </button>
        </label>
        <label>
          System
          <select value={toSystem} onChange={(e) => setToSystem(e.target.value)}>
            {systems.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </select>
          <button type="button" className="btn small" disabled={!chosen.length} onClick={() => act({ system: toSystem }, `Move to system ${systems.find((h) => h.id === toSystem)?.name ?? toSystem}`)}>
            Set
          </button>
        </label>
      </div>
      <div className="dbm-grid">
        <table className="tbl dbm-tbl" id="obj-table">
          <thead>
            <tr>
              <th>
                <input type="checkbox" aria-label="Tick all shown" checked={allOn} onChange={() => setSel(allOn ? new Set([...sel].filter((id) => !shown.some((r) => r.oid === id))) : new Set([...sel, ...shown.map((r) => r.oid)]))} />
              </th>
              <th>Type</th>
              <th>Name</th>
              <th>Status</th>
              <th>Permission group</th>
              <th>System</th>
              <th className="num">Rev</th>
              <th>Modified by</th>
              <th>Modified</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.oid} className={sel.has(r.oid) ? "on" : ""}>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`Tick ${r.name}`}
                    checked={sel.has(r.oid)}
                    onChange={() => {
                      const n = new Set(sel);
                      if (n.has(r.oid)) n.delete(r.oid);
                      else n.add(r.oid);
                      setSel(n);
                    }}
                  />
                </td>
                <td className="muted">{r.type}</td>
                <td>
                  <button type="button" className="link mono" onClick={() => show(r)} title="Show in the model">
                    {r.name}
                  </button>
                </td>
                <td>
                  <span className="st-chip">
                    <i className={`st-dot ${STATUS_CLASS[r.status]}`} />
                    {r.status}
                    {r.status === "Approved" && <Icon name="lock" size={12} />}
                  </span>
                </td>
                <td>{r.grp}</td>
                <td>{r.sys_name}</td>
                <td className="num">{r.rev}</td>
                <td>{personName(r.modified_by)}</td>
                <td className="mono small">{r.modified_at.slice(0, 16)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="note">Approved objects are locked: moving, re-routing or deleting them is refused until an editor sets them back to Working. Each status change is a transaction with a new revision.</p>
    </div>
  );
}

// ------------------------------------------------------------------ catalog & specs
function Catalog() {
  const dbRev = useStore((s) => s.dbRev);
  const user = useStore((s) => s.user);
  const db = dbHub.db!;
  const [table, setTable] = useState("cat_fitting");
  const [tick, setTick] = useState(0);
  const [problems, setProblems] = useState<string[]>([]);
  const [mode, setMode] = useState<"merge" | "replace">("merge");
  const [armed, setArmed] = useState<number | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const data = useMemo(() => db.editableRows(table), [db, table, dbRev, tick]);
  const counts = useMemo(() => Object.fromEntries(Object.keys(EDITABLE).map((t) => [t, Number(db.query(`SELECT COUNT(*) FROM ${t}`).rows[0][0])])), [db, dbRev, tick]);
  const keys = EDITABLE[table].keys;
  const numeric = data.columns.map((_, i) => data.rows.some((r) => typeof r[i] === "number"));
  const canEdit = user.canApprove;

  /** Run a catalog change; if the engine cannot route with the result, put the table back. */
  const change = (label: string, fn: () => void) => {
    const before = db.csv(table);
    const broken = () => [...S().model.lines.values()].filter((l) => l.error).length;
    const errorsBefore = broken();
    try {
      fn();
      setProblems(catalogChanged(label));
      const added = broken() - errorsBefore;
      if (added > 0) toast(`${added} line${added > 1 ? "s" : ""} no longer fit${added > 1 ? "" : "s"} with the new dimensions: see the To-Do list`, "info");
      return true;
    } catch (e) {
      try {
        db.importCsv(table, before, "replace");
        catalogChanged(`Reverted ${table}`);
      } catch {
        /* the table is unchanged when fn() itself threw */
      }
      toast(`Not changed: ${(e as Error).message}`, "error");
      return false;
    } finally {
      setTick((t) => t + 1);
    }
  };

  const commit = (row: SqlValue[], col: string, raw: string) => {
    const ci = data.columns.indexOf(col);
    const old = row[ci];
    const text = raw.trim();
    const value: SqlValue = text === "" ? null : numeric[ci] ? Number(text) : text;
    if (typeof value === "number" && !Number.isFinite(value)) return toast(`${col} must be a number`, "error"), setTick((t) => t + 1);
    if (value === old) return;
    const key = Object.fromEntries(keys.map((k) => [k, row[data.columns.indexOf(k)]]));
    change(`Catalog edit ${table}.${col} [${keys.map((k) => key[k]).join(" / ")}]: ${fmt(old) || "empty"} -> ${fmt(value) || "empty"}`, () => db.updateCell(table, key, col, value));
  };

  return (
    <div className="dbm-cat">
      <ul className="dbm-cat-list" aria-label="Catalog tables">
        {Object.entries(EDITABLE).map(([t, def]) => (
          <li key={t}>
            <button type="button" id={`cat-${t}`} className={t === table ? "on" : ""} onClick={() => (setTable(t), setArmed(null))}>
              <span>{def.label}</span>
              <span className="mono muted">
                {t} · {counts[t]}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div className="dbm-page">
        <div className="dbm-toolbar">
          <b className="mono">{table}</b>
          <span className="muted">key: {keys.join(", ")}</span>
          <span className="grow" />
          <button type="button" className="btn small" onClick={() => offer(`${table}.csv`, db.csv(table))}>
            <Icon name="download" size={14} /> CSV
          </button>
          {canEdit && (
            <>
              <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)} aria-label="Bulkload mode">
                <option value="merge">Merge (add / update rows)</option>
                <option value="replace">Replace the whole table</option>
              </select>
              <button type="button" id="cat-import" className="btn small accent" onClick={() => file.current?.click()}>
                <Icon name="upload" size={14} /> Bulkload CSV
              </button>
              <input
                ref={file}
                id="cat-import-file"
                type="file"
                accept=".csv,text/csv,text/plain"
                hidden
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (!f) return;
                  const text = await f.text();
                  let n = 0;
                  if (change(`Bulkload ${f.name} into ${table} (${mode})`, () => (n = db.importCsv(table, text, mode)))) toast(`Loaded ${n} row${n === 1 ? "" : "s"} into ${table}`);
                }}
              />
            </>
          )}
        </div>
        {!canEdit && <p className="dbm-banner">View only: changing the catalog needs edit access to this plant database.</p>}
        {problems.length > 0 && (
          <div className="dbm-banner warn" role="status">
            <b>Catalog check</b>
            <ul>
              {problems.slice(0, 6).map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        )}
        <div className="dbm-grid">
          <table className="tbl dbm-tbl edit" id="cat-grid">
            <thead>
              <tr>
                {data.columns.map((c, i) => (
                  <th key={c} className={`${numeric[i] ? "num" : ""}${keys.includes(c) ? " key" : ""}`}>
                    {c}
                  </th>
                ))}
                {canEdit && <th aria-label="Row actions" />}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row, i) => (
                <tr key={`${tick}-${dbRev}-${i}`}>
                  {row.map((v, j) => {
                    const col = data.columns[j];
                    if (keys.includes(col) || !canEdit)
                      return (
                        <td key={col} className={`${numeric[j] ? "num" : ""}${keys.includes(col) ? " key" : ""}`}>
                          {fmt(v)}
                        </td>
                      );
                    return (
                      <td key={col} className={numeric[j] ? "num" : ""}>
                        <input
                          className="cell"
                          defaultValue={fmt(v)}
                          aria-label={`${col} for ${keys.map((k) => fmt(row[data.columns.indexOf(k)])).join(" ")}`}
                          data-col={col}
                          inputMode={numeric[j] ? "decimal" : undefined}
                          onBlur={(e) => commit(row, col, e.currentTarget.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") e.currentTarget.blur();
                            if (e.key === "Escape") {
                              e.stopPropagation();
                              e.currentTarget.value = fmt(v);
                              e.currentTarget.blur();
                            }
                          }}
                        />
                      </td>
                    );
                  })}
                  {canEdit && (
                    <td>
                      {armed === i ? (
                        <button
                          type="button"
                          className="btn small danger"
                          onClick={() => {
                            const key = Object.fromEntries(keys.map((k) => [k, row[data.columns.indexOf(k)]]));
                            change(`Delete ${table} row [${keys.map((k) => key[k]).join(" / ")}]`, () => db.deleteRow(table, key));
                            setArmed(null);
                          }}
                        >
                          Delete
                        </button>
                      ) : (
                        <button type="button" className="icon-btn small" aria-label="Delete row" onClick={() => setArmed(i)}>
                          <Icon name="trash" size={14} />
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="dbm-foot">
          <p className="note">Edits are written to the database, logged as transactions and re-route every line at once, as in SP3D after a catalog bulkload. Export a table as CSV, edit it in Excel and bulkload it back.</p>
          {canEdit &&
            (confirmReset ? (
              <span className="confirm">
                <button
                  type="button"
                  className="btn small danger"
                  onClick={() => {
                    resetCatalog();
                    setConfirmReset(false);
                    setProblems([]);
                    setTick((t) => t + 1);
                    toast("Catalog and specs reset to the standard tables");
                  }}
                >
                  Reset all catalog tables
                </button>
                <button type="button" className="btn small" onClick={() => setConfirmReset(false)}>
                  Keep
                </button>
              </span>
            ) : (
              <button type="button" className="btn small" onClick={() => setConfirmReset(true)}>
                Reset to standard…
              </button>
            ))}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ SQL console
function SqlConsole({ text, setText }: { text: string; setText: (s: string) => void }) {
  const dbRev = useStore((s) => s.dbRev);
  const db = dbHub.db!;
  const [res, setRes] = useState<QueryResult | null>(null);
  const [err, setErr] = useState("");
  const [report, setReport] = useState(() => REPORTS.find((r) => r.sql === text)?.name ?? "");
  const last = useRef("");
  const names = useMemo(() => db.tables().map((t) => t.name), [db]);
  const run = (sql = text) => {
    last.current = sql;
    try {
      setRes(db.query(sql));
      setErr("");
    } catch (e) {
      setErr((e as Error).message);
      setRes(null);
    }
  };
  useEffect(() => {
    if (text.trim()) run(text);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (last.current && !err) run(last.current); // follow model changes
  }, [dbRev]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="dbm-page">
      <div className="dbm-toolbar">
        <label className="inline">
          Saved report
          <select
            id="sql-report"
            value={report}
            onChange={(e) => {
              const r = REPORTS.find((x) => x.name === e.target.value);
              setReport(e.target.value);
              if (r) (setText(r.sql), run(r.sql));
            }}
          >
            <option value="">Custom query</option>
            {REPORTS.map((r) => (
              <option key={r.name}>{r.name}</option>
            ))}
          </select>
        </label>
        <span className="grow" />
        <button type="button" className="btn small" disabled={!res} onClick={() => offer(`${safe(report || "query")}.csv`, db.csv(last.current))}>
          <Icon name="download" size={14} /> CSV
        </button>
        <button type="button" id="sql-run" className="btn small accent" onClick={() => run()}>
          Run <kbd>Ctrl+Enter</kbd>
        </button>
      </div>
      <textarea
        id="sql-input"
        className="sql-input"
        spellCheck={false}
        value={text}
        rows={4}
        onChange={(e) => (setText(e.target.value), setReport(""))}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
            e.preventDefault();
            run();
          }
        }}
        aria-label="SQL query"
      />
      <div className="sql-tables">
        {names.map((n) => (
          <button
            key={n}
            type="button"
            className="sql-chip mono"
            onClick={() => {
              const q = `SELECT * FROM ${n} LIMIT 500;`;
              setText(q);
              setReport("");
              run(q);
            }}
          >
            {n}
          </button>
        ))}
      </div>
      {err && (
        <p className="dbm-banner crit" role="alert">
          {err}
        </p>
      )}
      {res && (
        <>
          <p className="muted small" id="sql-meta">
            {res.rows.length} row{res.rows.length === 1 ? "" : "s"}
            {res.truncated ? " (first 2000)" : ""} · {res.ms.toFixed(1)} ms
          </p>
          <ResultGrid r={res} />
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ transactions
function History() {
  const dbRev = useStore((s) => s.dbRev);
  useStore((s) => s.peopleRev);
  const db = dbHub.db!;
  const txns = useMemo(() => db.txns(300), [db, dbRev]);
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const shown = txns.filter((t) => !needle || t.action.toLowerCase().includes(needle) || (t.user ?? "").toLowerCase().includes(needle) || (t.objects ?? "").toLowerCase().includes(needle));
  return (
    <div className="dbm-page">
      <div className="dbm-toolbar">
        <input type="search" placeholder="Filter by action, user or object" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter transactions" />
        <span className="grow" />
        <button type="button" className="btn small" onClick={() => offer("audit-trail.csv", db.csv("SELECT id, at, user, action, objects FROM txn ORDER BY id"))}>
          <Icon name="download" size={14} /> CSV
        </button>
      </div>
      <div className="dbm-grid">
        <table className="tbl dbm-tbl" id="txn-table">
          <thead>
            <tr>
              <th className="num">#</th>
              <th>When (UTC)</th>
              <th>User</th>
              <th>Transaction</th>
              <th>Objects</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((t) => {
              let objs: { name: string; op: string }[] = [];
              try {
                objs = JSON.parse(t.objects || "[]");
              } catch {
                /* free text */
              }
              return (
                <tr key={t.id}>
                  <td className="num">{t.id}</td>
                  <td className="mono small">{t.at.slice(0, 19)}</td>
                  <td>{personName(t.user)}</td>
                  <td>{t.action}</td>
                  <td className="small" title={objs.map((o) => `${o.name} (${o.op})`).join(", ")}>
                    {objs.slice(0, 4).map((o, i) => (
                      <span key={i} className={`op op-${o.op}`}>
                        {o.name}
                      </span>
                    ))}
                    {objs.length > 4 && <span className="muted"> +{objs.length - 4}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
