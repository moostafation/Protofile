// The plant database: a real SQLite database (sql.js, pure-JS build) holding catalog, specs, model
// objects with their metadata, derived report tables and a transaction log.

import initSqlJs from "sql.js/dist/sql-asm-memory-growth.js";
import type { Database, SqlJsStatic, SqlValue } from "sql.js";
import { CatalogData, standardCatalogData } from "../engine/catalog";
import type { Model } from "../engine/compute";
import type { PlantDoc } from "../engine/doc";
import { ModelObject, ObjType, normalizeDoc, objName, objects } from "../engine/meta";
import { PipingSpec, standardSpecs } from "../engine/spec";
import { dirName } from "../engine/vec";
import { DDL, EDITABLE, SCHEMA_VERSION, TABLE_GROUPS, TableGroup } from "./schema";

let SQL: SqlJsStatic | null = null;
export async function sqlEngine(): Promise<SqlJsStatic> {
  if (!SQL) SQL = await initSqlJs();
  return SQL;
}

export interface QueryResult {
  columns: string[];
  rows: SqlValue[][];
  truncated: boolean;
  ms: number;
}

export interface TableInfo {
  name: string;
  kind: "table" | "view";
  group: TableGroup | "view";
  rows: number;
}

export interface DbState {
  doc: PlantDoc;
  catalog: CatalogData;
  specs: Record<string, PipingSpec>;
  txns?: { at: string; user: string; action: string; objects: string }[];
}

const iso = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 23);
const fromIso = (s: string | null) => (s ? Date.parse(s.replace(" ", "T") + "Z") : Date.now());

export class DbError extends Error {}

export class PlantDB {
  private saved = new Map<string, string>(); // oid -> data JSON last written

  private constructor(readonly db: Database) {}

  // ------------------------------------------------------------ open / create
  static async create(doc: PlantDoc, catalog: CatalogData = standardCatalogData(), specs = standardSpecs()): Promise<PlantDB> {
    const SQL = await sqlEngine();
    const p = new PlantDB(new SQL.Database());
    p.db.run(DDL);
    p.db.run("INSERT INTO db_info VALUES ('schema_version', ?), ('created_at', ?), ('application', 'PlantForge Studio')", [SCHEMA_VERSION, iso(Date.now())]);
    p.writeCatalog(catalog);
    p.writeSpecs(specs);
    p.saveDoc(normalizeDoc(doc), { action: "Create plant database", user: "system" });
    return p;
  }

  static async fromState(state: DbState): Promise<PlantDB> {
    const p = await PlantDB.create(state.doc, state.catalog, state.specs);
    if (state.txns?.length) {
      p.db.run("DELETE FROM txn");
      const st = p.db.prepare("INSERT INTO txn (at, user, action, objects) VALUES (?, ?, ?, ?)");
      for (const t of state.txns) st.run([t.at, t.user, t.action, t.objects]);
      st.free();
    }
    return p;
  }

  static async open(bytes: Uint8Array): Promise<PlantDB> {
    const SQL = await sqlEngine();
    const db = new SQL.Database(bytes);
    try {
      const v = db.exec("SELECT value FROM db_info WHERE key = 'schema_version'");
      if (!v.length) throw new Error();
    } catch {
      db.close();
      throw new DbError("This file is not a PlantForge plant database.");
    }
    db.run("PRAGMA foreign_keys = ON");
    db.run("CREATE TABLE IF NOT EXISTS person (id TEXT PRIMARY KEY, name TEXT)");
    const p = new PlantDB(db);
    for (const { obj } of objects(p.readDoc())) p.saved.set(obj.id, JSON.stringify(obj));
    return p;
  }

  export(): Uint8Array {
    const bytes = this.db.export();
    this.db.run("PRAGMA foreign_keys = ON"); // sql.js re-opens the database on export, resetting pragmas
    return bytes;
  }

  exportState(maxTxns = 300): DbState {
    const txns = this.rows<{ at: string; user: string; action: string; objects: string }>(`SELECT at, user, action, objects FROM txn ORDER BY id DESC LIMIT ${maxTxns}`).reverse();
    return { doc: this.readDoc(), catalog: this.readCatalog(), specs: this.readSpecs(), txns };
  }

  close() {
    this.db.close();
  }

  // ------------------------------------------------------------ helpers
  rows<T = Record<string, SqlValue>>(sql: string, params: SqlValue[] = []): T[] {
    const st = this.db.prepare(sql);
    st.bind(params);
    const out: T[] = [];
    while (st.step()) out.push(st.getAsObject() as T);
    st.free();
    return out;
  }

  private tx(fn: () => void) {
    this.db.run("BEGIN");
    try {
      fn();
      this.db.run("COMMIT");
    } catch (e) {
      this.db.run("ROLLBACK");
      throw e;
    }
  }

  // ------------------------------------------------------------ catalog & specs
  writeCatalog(c: CatalogData) {
    this.tx(() => {
      for (const t of ["cat_pipe_wall", "cat_pipe", "cat_fitting", "cat_flange", "cat_flange_rating", "cat_valve"]) this.db.run(`DELETE FROM ${t}`);
      for (const [nps, r] of Object.entries(c.pipe)) {
        this.db.run("INSERT INTO cat_pipe VALUES (?, ?, ?)", [nps, r.dn, r.od]);
        for (const [sch, w] of Object.entries(r.wall)) this.db.run("INSERT INTO cat_pipe_wall VALUES (?, ?, ?)", [nps, sch, w]);
      }
      for (const [nps, r] of Object.entries(c.fittings)) this.db.run("INSERT INTO cat_fitting VALUES (?, ?, ?, ?)", [nps, r.elbow90_lr, r.elbow45_lr, r.tee]);
      for (const [rating, t] of Object.entries(c.flanges)) {
        this.db.run("INSERT INTO cat_flange_rating VALUES (?, ?)", [rating, t.rf_height]);
        for (const [nps, r] of Object.entries(t.sizes))
          this.db.run("INSERT INTO cat_flange VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [rating, nps, r.o, r.tf, r.y, r.rf_dia, r.hub_dia, r.bc, r.bolts, r.bolt_dia]);
      }
      for (const [rating, types] of Object.entries(c.valves))
        for (const [type, sizes] of Object.entries(types)) for (const [nps, f] of Object.entries(sizes)) this.db.run("INSERT INTO cat_valve VALUES (?, ?, ?, ?)", [rating, type, nps, f]);
    });
  }

  readCatalog(): CatalogData {
    const c: CatalogData = { pipe: {}, fittings: {}, flanges: {}, valves: {} };
    for (const r of this.rows<{ nps: string; dn: number; od: number }>("SELECT * FROM cat_pipe")) c.pipe[r.nps] = { dn: r.dn, od: r.od, wall: {} };
    for (const r of this.rows<{ nps: string; schedule: string; wall: number }>("SELECT * FROM cat_pipe_wall")) if (c.pipe[r.nps]) c.pipe[r.nps].wall[r.schedule] = r.wall;
    for (const r of this.rows<{ nps: string; elbow90_lr: number; elbow45_lr: number; tee: number }>("SELECT * FROM cat_fitting"))
      c.fittings[r.nps] = { elbow90_lr: r.elbow90_lr, elbow45_lr: r.elbow45_lr, tee: r.tee };
    for (const r of this.rows<{ rating: string; rf_height: number }>("SELECT * FROM cat_flange_rating")) c.flanges[r.rating] = { rf_height: r.rf_height, sizes: {} };
    for (const r of this.rows<Record<string, SqlValue>>("SELECT * FROM cat_flange")) {
      const t = c.flanges[String(r.rating)];
      if (t)
        t.sizes[String(r.nps)] = {
          o: Number(r.o),
          tf: Number(r.tf),
          y: Number(r.y),
          rf_dia: Number(r.rf_dia),
          hub_dia: Number(r.hub_dia),
          bc: Number(r.bc),
          bolts: Number(r.bolts),
          bolt_dia: String(r.bolt_dia),
        };
    }
    for (const r of this.rows<{ rating: string; type: string; nps: string; face_to_face: number }>("SELECT * FROM cat_valve")) {
      c.valves[r.rating] ??= {};
      c.valves[r.rating][r.type] ??= {};
      c.valves[r.rating][r.type][r.nps] = r.face_to_face;
    }
    return c;
  }

  writeSpecs(specs: Record<string, PipingSpec>) {
    this.tx(() => {
      for (const t of ["spec_pipe", "spec_part", "spec_valve", "spec"]) this.db.run(`DELETE FROM ${t}`);
      for (const s of Object.values(specs)) {
        this.db.run("INSERT INTO spec VALUES (?, ?, ?, ?, ?, ?)", [s.name, s.description, s.rating, s.material, s.minPipeLength, s.gasketThickness]);
        for (const r of s.pipeRules) this.db.run("INSERT INTO spec_pipe VALUES (?, ?, ?, ?, ?)", [s.name, npsLabel(r.lo), npsLabel(r.hi), r.schedule, r.description]);
        for (const [k, p] of Object.entries(s.parts)) this.db.run("INSERT INTO spec_part VALUES (?, ?, ?, ?)", [s.name, k, p.description, p.skey]);
        for (const [k, p] of Object.entries(s.valves)) this.db.run("INSERT INTO spec_valve VALUES (?, ?, ?, ?)", [s.name, k, p.description, p.skey]);
      }
    });
  }

  readSpecs(): Record<string, PipingSpec> {
    const out: Record<string, PipingSpec> = {};
    for (const r of this.rows<Record<string, SqlValue>>("SELECT * FROM spec"))
      out[String(r.name)] = {
        name: String(r.name),
        description: String(r.description ?? ""),
        rating: String(r.rating),
        material: String(r.material ?? ""),
        minPipeLength: Number(r.min_pipe_length),
        gasketThickness: Number(r.gasket_thickness),
        pipeRules: [],
        parts: {},
        valves: {},
      };
    for (const r of this.rows<Record<string, SqlValue>>("SELECT * FROM spec_pipe ORDER BY rowid"))
      out[String(r.spec)]?.pipeRules.push({ lo: npsNum(String(r.nps_from)), hi: npsNum(String(r.nps_to)), schedule: String(r.schedule), description: String(r.description) });
    for (const r of this.rows<Record<string, SqlValue>>("SELECT * FROM spec_part")) {
      const s = out[String(r.spec)];
      if (s) s.parts[String(r.part)] = { description: String(r.description), skey: String(r.skey ?? "") };
    }
    for (const r of this.rows<Record<string, SqlValue>>("SELECT * FROM spec_valve")) {
      const s = out[String(r.spec)];
      if (s) s.valves[String(r.type)] = { description: String(r.description), skey: String(r.skey ?? "") };
    }
    return out;
  }

  // ------------------------------------------------------------ model
  /** Write the document: only objects whose content changed are touched; one txn row records the change. */
  saveDoc(doc: PlantDoc, change: { action: string; user: string }, log: "always" | "changes" = "always") {
    const objs = objects(doc);
    const now = iso(Date.now());
    const touched: { oid: string; name: string; op: string }[] = [];
    this.tx(() => {
      const p = doc.project;
      this.db.run("INSERT OR REPLACE INTO plant VALUES (1, ?, ?, ?, ?, ?)", [p.name, p.plant, p.area, p.unit, doc.seq]);
      this.db.run("DELETE FROM permission_group");
      for (const g of doc.groups ?? []) this.db.run("INSERT INTO permission_group VALUES (?)", [g]);
      this.db.run("DELETE FROM hierarchy");
      (doc.hierarchy ?? []).forEach((h, i) => this.db.run("INSERT INTO hierarchy VALUES (?, ?, ?, ?, ?)", [h.id, h.parent, h.kind, h.name, i]));
      const live = new Set<string>();
      for (const { type, obj } of objs) {
        live.add(obj.id);
        const json = JSON.stringify(obj);
        if (this.saved.get(obj.id) === json) continue;
        const m = obj.meta!;
        this.db.run("INSERT OR REPLACE INTO object VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [
          obj.id,
          type,
          objName(obj),
          m.system,
          m.group,
          m.status,
          m.rev,
          m.createdBy,
          iso(m.createdAt),
          m.modifiedBy,
          iso(m.modifiedAt),
          json,
        ]);
        touched.push({ oid: obj.id, name: objName(obj), op: this.saved.has(obj.id) ? "modified" : "created" });
        this.saved.set(obj.id, json);
      }
      for (const oid of [...this.saved.keys()]) {
        if (live.has(oid)) continue;
        const name = this.rows<{ name: string }>("SELECT name FROM object WHERE oid = ?", [oid])[0]?.name ?? oid;
        this.db.run("DELETE FROM object WHERE oid = ?", [oid]);
        this.saved.delete(oid);
        touched.push({ oid, name, op: "deleted" });
      }
      if (touched.length || log === "always")
        this.db.run("INSERT INTO txn (at, user, action, objects) VALUES (?, ?, ?, ?)", [now, change.user, change.action, JSON.stringify(touched)]);
    });
    return touched;
  }

  readDoc(): PlantDoc {
    const p = this.rows<Record<string, SqlValue>>("SELECT * FROM plant WHERE id = 1")[0];
    const hierarchy = this.rows<Record<string, SqlValue>>("SELECT * FROM hierarchy ORDER BY sort").map((h) => ({
      id: String(h.oid),
      parent: h.parent === null ? null : String(h.parent),
      kind: String(h.kind) as "area" | "unit" | "system",
      name: String(h.name),
    }));
    const groups = this.rows<{ name: string }>("SELECT name FROM permission_group").map((g) => g.name);
    const doc: PlantDoc = {
      version: 1,
      project: { name: String(p?.name ?? "Plant"), plant: String(p?.plant ?? ""), area: String(p?.area ?? ""), unit: String(p?.unit ?? "") },
      equipment: [],
      lines: [],
      structures: [],
      seq: Number(p?.seq ?? 1),
      hierarchy,
      groups,
    };
    for (const r of this.rows<Record<string, SqlValue>>("SELECT * FROM object ORDER BY rowid")) {
      const obj = JSON.parse(String(r.data)) as ModelObject;
      obj.meta = {
        status: String(r.status) as "Working",
        group: String(r.permission_group ?? ""),
        system: String(r.system ?? ""),
        rev: Number(r.rev),
        createdBy: String(r.created_by ?? ""),
        createdAt: fromIso(r.created_at as string),
        modifiedBy: String(r.modified_by ?? ""),
        modifiedAt: fromIso(r.modified_at as string),
      };
      const type = String(r.type) as ObjType;
      if (type === "equipment") doc.equipment.push(obj as PlantDoc["equipment"][number]);
      else if (type === "line") doc.lines.push(obj as PlantDoc["lines"][number]);
      else doc.structures.push(obj as PlantDoc["structures"][number]);
    }
    return doc;
  }

  /** Refresh the report tables from a computed model (equipment, nozzles, lines, components, welds, clashes, MTO). */
  refreshDerived(model: Model) {
    this.tx(() => {
      for (const t of ["equipment", "nozzle", "line", "structure", "component", "weld", "clash", "mto"]) this.db.run(`DELETE FROM ${t}`);
      const lineOfNozzle = new Map<string, string>();
      for (const j of model.conn.joints) {
        for (const [x, y] of [
          [j.a, j.b],
          [j.b, j.a],
        ])
          if (x.kind === "NOZZLE" && y.owner.type === "line") lineOfNozzle.set(x.uid, model.lines.get(y.owner.id)?.doc.number ?? "");
      }
      for (const e of model.equipment.values()) {
        const d = e.doc;
        this.db.run("INSERT INTO equipment VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [d.id, d.tag, d.template, d.description, d.origin[0], d.origin[1], d.origin[2], d.rot]);
        for (const n of e.nozzles) {
          const pt = n.ports[0];
          this.db.run("INSERT INTO nozzle VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [d.id, n.tag, n.props.name, n.nps, n.props.service ?? "", n.props.proj, pt.pos[0], pt.pos[1], pt.pos[2], dirName(pt.dir), lineOfNozzle.get(n.uid) ?? null]);
        }
      }
      const refName = (r: PlantDoc["lines"][number]["start"]) => {
        if (r.kind === "nozzle") return `${model.equipment.get(r.eq)?.doc.tag ?? "?"}/${r.nozzle}`;
        if (r.kind === "tee") return `tee on ${model.lines.get(r.line)?.doc.number ?? "?"}`;
        return r.kind;
      };
      for (const l of model.lines.values()) {
        const count = (k: string) => l.comps.filter((c) => c.kind === k).length;
        const welds = model.conn.welds.filter((w) => w.a.owner.id === l.doc.id || w.b.owner.id === l.doc.id).length;
        this.db.run("INSERT INTO line VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [
          l.doc.id,
          l.doc.number,
          l.doc.spec,
          l.doc.nps,
          l.doc.fluid,
          refName(l.doc.start),
          refName(l.doc.end),
          l.error ? "ERROR" : "OK",
          l.error ?? null,
          l.pipeLength / 1000,
          count("ELBOW"),
          count("VALVE"),
          count("TEE"),
          count("SUPPORT"),
          welds,
        ]);
        const st = this.db.prepare("INSERT INTO component VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
        for (const c of l.comps) {
          const a = c.ports[0]?.pos ?? c.props.at ?? [0, 0, 0];
          const b = c.ports[1]?.pos ?? a;
          st.run([c.uid, l.doc.id, l.doc.number, c.kind, c.tag, c.nps, c.desc, c.kind === "PIPE" ? c.props.length : null, c.kind === "PIPE" ? c.props.weight : null, a[0], a[1], a[2], b[0], b[1], b[2], c.skey || null]);
        }
        st.free();
      }
      for (const s of model.structures.values()) {
        const d = s.doc;
        this.db.run("INSERT INTO structure VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [d.id, d.tag, d.axis, d.length, d.width, d.bay, d.levels.join(","), d.origin[0], d.origin[1]]);
      }
      const lineNo = (uid: string) => {
        const c = model.byUid.get(uid);
        return c?.owner.type === "line" ? (model.lines.get(c.owner.id)?.doc.number ?? "") : (c?.tag ?? uid);
      };
      for (const w of model.conn.welds) {
        const owner = w.a.owner.type === "line" ? w.a : w.b;
        this.db.run("INSERT INTO weld (line_number, a, b, nps, inch_dia, e, n, el) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
          lineNo(owner.uid),
          w.a.tag,
          w.b.tag,
          w.pa.nps,
          npsNum(w.pa.nps),
          w.pa.pos[0],
          w.pa.pos[1],
          w.pa.pos[2],
        ]);
      }
      const nameOf = (uid: string) => {
        const c = model.byUid.get(uid);
        if (!c) return uid;
        return c.owner.type === "line" ? `${model.lines.get(c.owner.id)?.doc.number} ${c.tag}` : c.tag;
      };
      for (const c of model.clashes ?? [])
        this.db.run("INSERT INTO clash (a, b, hard, distance_mm, e, n, el) VALUES (?, ?, ?, ?, ?, ?, ?)", [nameOf(c.a), nameOf(c.b), c.hard ? 1 : 0, c.distance, c.point[0], c.point[1], c.point[2]]);
      for (const r of model.mto) this.db.run("INSERT INTO mto (kind, spec, nps, description, qty, unit, weight_kg) VALUES (?, ?, ?, ?, ?, ?, ?)", [r.kind, r.spec, r.nps, r.description, r.qty, r.unit, r.weight ?? null]);
    });
  }

  // ------------------------------------------------------------ SQL console
  /** Run read-only SQL (SELECT / WITH / PRAGMA / EXPLAIN). Model tables change only through the application. */
  query(sql: string, limit = 2000): QueryResult {
    const text = sql.trim().replace(/;+\s*$/, "");
    if (!/^(select|with|pragma|explain)\b/i.test(text)) throw new DbError("The SQL console is read-only: use SELECT (or WITH / PRAGMA / EXPLAIN). Edit data in the model, the catalog grid or by CSV bulkload.");
    if (/;\s*\S/.test(text)) throw new DbError("Run one statement at a time.");
    if (/^pragma\s+\w+\s*=/i.test(text)) throw new DbError("Setting PRAGMAs is not allowed here.");
    const t0 = performance.now();
    const st = this.db.prepare(text);
    const columns = st.getColumnNames();
    const rows: SqlValue[][] = [];
    let truncated = false;
    while (st.step()) {
      if (rows.length >= limit) {
        truncated = true;
        break;
      }
      rows.push(st.get());
    }
    st.free();
    return { columns, rows, truncated, ms: performance.now() - t0 };
  }

  tables(): TableInfo[] {
    const list = this.rows<{ name: string; type: string }>("SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name");
    return list.map((t) => ({
      name: t.name,
      kind: t.type as "table" | "view",
      group: t.type === "view" ? "view" : (TABLE_GROUPS[t.name] ?? "model"),
      rows: Number(this.db.exec(`SELECT COUNT(*) FROM "${t.name}"`)[0].values[0][0]),
    }));
  }

  sizeBytes(): number {
    const r = this.db.exec("PRAGMA page_count")[0].values[0][0] as number;
    const s = this.db.exec("PRAGMA page_size")[0].values[0][0] as number;
    return r * s;
  }

  info(): Record<string, string> {
    return Object.fromEntries(this.rows<{ key: string; value: string }>("SELECT key, value FROM db_info").map((r) => [r.key, r.value]));
  }

  // ------------------------------------------------------------ catalog editing & bulkload
  editableRows(table: string): QueryResult {
    const def = EDITABLE[table];
    if (!def) throw new DbError(`${table} is not editable`);
    const r = this.query(`SELECT * FROM ${table} ORDER BY rowid`, 100000);
    // sizes in engineering order (1/2, 3/4, 1, 1-1/2 …), other keys alphabetically
    const sortKey = (v: SqlValue, col: string): number | string => (/nps/.test(col) ? npsNum(String(v)) : String(v));
    const idx = def.keys.map((k) => [k, r.columns.indexOf(k)] as const);
    r.rows.sort((a, b) => {
      for (const [k, i] of idx) {
        const x = sortKey(a[i], k);
        const y = sortKey(b[i], k);
        if (x < y) return -1;
        if (x > y) return 1;
      }
      return 0;
    });
    return r;
  }

  /** Update one cell of an editable table; the row is identified by its key columns. */
  updateCell(table: string, key: Record<string, SqlValue>, column: string, value: SqlValue) {
    const def = EDITABLE[table];
    if (!def) throw new DbError(`${table} is not editable`);
    const cols = this.query(`SELECT * FROM ${table} LIMIT 0`).columns;
    if (!cols.includes(column)) throw new DbError(`no column ${column}`);
    const where = def.keys.map((k) => `"${k}" = ?`).join(" AND ");
    this.db.run(`UPDATE ${table} SET "${column}" = ? WHERE ${where}`, [value, ...def.keys.map((k) => key[k])]);
    if (this.db.getRowsModified() !== 1) throw new DbError("row not found");
  }

  deleteRow(table: string, key: Record<string, SqlValue>) {
    const def = EDITABLE[table];
    if (!def) throw new DbError(`${table} is not editable`);
    this.db.run(`DELETE FROM ${table} WHERE ${def.keys.map((k) => `"${k}" = ?`).join(" AND ")}`, def.keys.map((k) => key[k]));
  }

  /** SP3D-style bulkload: CSV with a header row; mode "replace" empties the table first, "merge" upserts by key. */
  importCsv(table: string, text: string, mode: "merge" | "replace"): number {
    const def = EDITABLE[table];
    if (!def) throw new DbError(`${table} cannot be bulkloaded`);
    const rows = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ""));
    if (rows.length < 2) throw new DbError("The CSV needs a header row and at least one data row.");
    const cols = this.query(`SELECT * FROM ${table} LIMIT 0`).columns;
    const header = rows[0].map((h) => h.trim());
    const unknown = header.filter((h) => !cols.includes(h));
    if (unknown.length) throw new DbError(`Unknown column(s) for ${table}: ${unknown.join(", ")}. Expected: ${cols.join(", ")}`);
    const missing = def.keys.filter((k) => !header.includes(k));
    if (missing.length) throw new DbError(`The CSV must include the key column(s): ${missing.join(", ")}`);
    let n = 0;
    this.tx(() => {
      if (mode === "replace") this.db.run(`DELETE FROM ${table}`);
      const st = this.db.prepare(`INSERT OR REPLACE INTO ${table} (${header.map((h) => `"${h}"`).join(", ")}) VALUES (${header.map(() => "?").join(", ")})`);
      for (const r of rows.slice(1)) {
        st.run(header.map((_, i) => toValue(r[i] ?? "")));
        n += 1;
      }
      st.free();
    });
    return n;
  }

  csv(sqlOrTable: string): string {
    const sql = /\s/.test(sqlOrTable.trim()) ? sqlOrTable : `SELECT * FROM ${sqlOrTable}`;
    const r = this.query(sql, 1000000);
    const q = (v: SqlValue) => {
      if (v === null) return "";
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return [r.columns.join(","), ...r.rows.map((row) => row.map(q).join(","))].join("\n") + "\n";
  }

  /** Names for the user ids stored in the model (local to this copy: the shared store keeps ids only). */
  setPeople(people: [string, string][]) {
    this.tx(() => {
      this.db.run("DELETE FROM person");
      for (const [id, name] of people) this.db.run("INSERT OR REPLACE INTO person VALUES (?, ?)", [id, name]);
    });
  }

  /** Bring in transactions recorded elsewhere (the shared plant's log), keeping their time and author. */
  importTxns(list: { at: string; user: string; action: string; objects: string }[], replace = false) {
    this.tx(() => {
      if (replace) this.db.run("DELETE FROM txn");
      for (const t of list) this.db.run("INSERT INTO txn (at, user, action, objects) VALUES (?, ?, ?, ?)", [t.at, t.user, t.action, t.objects]);
    });
  }

  /** Record a transaction that is not a model change (catalog edits, approvals by bulk, restores). */
  logTxn(action: string, user: string, objs: { oid: string; name: string; op: string }[] = []) {
    this.db.run("INSERT INTO txn (at, user, action, objects) VALUES (?, ?, ?, ?)", [iso(Date.now()), user, action, JSON.stringify(objs)]);
  }

  txns(limit = 200) {
    return this.rows<{ id: number; at: string; user: string; action: string; objects: string }>(`SELECT * FROM txn ORDER BY id DESC LIMIT ${limit}`);
  }

  /** Validate catalog edits against the engine's needs (every spec size must exist, etc.). */
  checkCatalog(): string[] {
    const problems: string[] = [];
    const c = this.readCatalog();
    for (const s of Object.values(this.readSpecs())) {
      if (!c.flanges[s.rating]) problems.push(`Spec ${s.name} uses rating ${s.rating}, which has no flange table.`);
      for (const r of s.pipeRules) {
        for (const nps of Object.keys(c.pipe)) {
          const v = npsNum(nps);
          if (v < r.lo || v > r.hi) continue;
          if (c.pipe[nps].wall[r.schedule] === undefined) problems.push(`Spec ${s.name}: NPS ${nps} has no SCH ${r.schedule} wall thickness.`);
          if (!c.fittings[nps]) problems.push(`Spec ${s.name}: NPS ${nps} has no fitting dimensions.`);
        }
      }
    }
    return problems;
  }
}

// ------------------------------------------------------------ small utilities
export function npsNum(nps: string): number {
  const [w, f] = nps.includes("-") ? nps.split("-") : [nps, ""];
  const part = (s: string) => (s ? (s.includes("/") ? Number(s.split("/")[0]) / Number(s.split("/")[1]) : Number(s)) : 0);
  return part(w) + part(f);
}

export function npsLabel(v: number): string {
  const e = Math.round(v * 8);
  const whole = Math.floor(e / 8);
  let rem = e % 8;
  if (!rem) return String(whole);
  let den = 8;
  while (rem % 2 === 0) {
    rem /= 2;
    den /= 2;
  }
  return whole ? `${whole}-${rem}/${den}` : `${rem}/${den}`;
}

function toValue(s: string): SqlValue {
  const t = s.trim();
  if (t === "") return null;
  if (/^-?\d+(\.\d+)?$/.test(t) && !/^0\d/.test(t)) return Number(t);
  return t;
}

export function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      out.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    out.push(row);
  }
  return out;
}

