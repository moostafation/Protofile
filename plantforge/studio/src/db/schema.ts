// SQLite schema of a PlantForge plant database, organised like SP3D's databases:
//   site/plant  ->  catalog (dimensions)  ->  specs (pipe classes)  ->  model (objects)  ->  reports (derived)
// plus a transaction log (audit trail). Report views are what the SQL console and reports query.

export const SCHEMA_VERSION = "1";

export const DDL = `
PRAGMA foreign_keys = ON;

-- ============================================================ plant / site
CREATE TABLE db_info (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE plant (id INTEGER PRIMARY KEY CHECK (id = 1), name TEXT NOT NULL, plant TEXT, area TEXT, unit TEXT, seq INTEGER NOT NULL DEFAULT 1);
CREATE TABLE permission_group (name TEXT PRIMARY KEY);
CREATE TABLE hierarchy (
  oid TEXT PRIMARY KEY,
  parent TEXT REFERENCES hierarchy(oid) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('area', 'unit', 'system')),
  name TEXT NOT NULL,
  sort INTEGER
);

-- ============================================================ catalog (reference data)
CREATE TABLE cat_pipe (nps TEXT PRIMARY KEY, dn INTEGER NOT NULL, od REAL NOT NULL);
CREATE TABLE cat_pipe_wall (
  nps TEXT NOT NULL REFERENCES cat_pipe(nps) ON DELETE CASCADE,
  schedule TEXT NOT NULL,
  wall REAL NOT NULL CHECK (wall > 0),
  PRIMARY KEY (nps, schedule)
);
CREATE TABLE cat_fitting (nps TEXT PRIMARY KEY, elbow90_lr REAL NOT NULL, elbow45_lr REAL NOT NULL, tee REAL NOT NULL, reducer REAL);
CREATE TABLE cat_flange_rating (rating TEXT PRIMARY KEY, rf_height REAL NOT NULL);
CREATE TABLE cat_flange (
  rating TEXT NOT NULL REFERENCES cat_flange_rating(rating) ON DELETE CASCADE,
  nps TEXT NOT NULL,
  o REAL NOT NULL, tf REAL NOT NULL, y REAL NOT NULL, rf_dia REAL NOT NULL, hub_dia REAL NOT NULL,
  bc REAL NOT NULL, bolts INTEGER NOT NULL, bolt_dia TEXT NOT NULL,
  PRIMARY KEY (rating, nps)
);
CREATE TABLE cat_valve (rating TEXT NOT NULL, type TEXT NOT NULL, nps TEXT NOT NULL, face_to_face REAL NOT NULL, PRIMARY KEY (rating, type, nps));

-- ============================================================ specs (pipe classes)
CREATE TABLE spec (
  name TEXT PRIMARY KEY, description TEXT, rating TEXT NOT NULL, material TEXT,
  min_pipe_length REAL NOT NULL DEFAULT 50, gasket_thickness REAL NOT NULL DEFAULT 3
);
CREATE TABLE spec_pipe (
  spec TEXT NOT NULL REFERENCES spec(name) ON DELETE CASCADE,
  nps_from TEXT NOT NULL, nps_to TEXT NOT NULL, schedule TEXT NOT NULL, description TEXT NOT NULL
);
CREATE TABLE spec_part (spec TEXT NOT NULL REFERENCES spec(name) ON DELETE CASCADE, part TEXT NOT NULL, description TEXT NOT NULL, skey TEXT, PRIMARY KEY (spec, part));
CREATE TABLE spec_valve (spec TEXT NOT NULL REFERENCES spec(name) ON DELETE CASCADE, type TEXT NOT NULL, description TEXT NOT NULL, skey TEXT, PRIMARY KEY (spec, type));

-- ============================================================ model
CREATE TABLE object (
  oid TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('equipment', 'line', 'structure')),
  name TEXT NOT NULL,
  system TEXT,
  permission_group TEXT,
  status TEXT NOT NULL DEFAULT 'Working' CHECK (status IN ('Working', 'In Review', 'Approved', 'Rejected')),
  rev INTEGER NOT NULL DEFAULT 1,
  created_by TEXT, created_at TEXT, modified_by TEXT, modified_at TEXT,
  data TEXT NOT NULL
);
CREATE INDEX object_type ON object(type);
CREATE TABLE equipment (oid TEXT PRIMARY KEY, tag TEXT, template TEXT, description TEXT, e REAL, n REAL, el REAL, rotation REAL);
CREATE TABLE nozzle (
  equipment TEXT NOT NULL, tag TEXT NOT NULL, name TEXT NOT NULL, nps TEXT, service TEXT, projection REAL,
  e REAL, n REAL, el REAL, facing TEXT, connected_line TEXT,
  PRIMARY KEY (equipment, name)
);
CREATE TABLE line (
  oid TEXT PRIMARY KEY, number TEXT, spec TEXT, nps TEXT, fluid TEXT, from_ref TEXT, to_ref TEXT,
  route_status TEXT, route_error TEXT, pipe_length_m REAL, elbows INTEGER, valves INTEGER, tees INTEGER, shoes INTEGER, welds INTEGER
);
CREATE TABLE structure (oid TEXT PRIMARY KEY, tag TEXT, axis TEXT, length REAL, width REAL, bay REAL, levels TEXT, e REAL, n REAL);

-- ============================================================ derived reporting tables (refreshed after every transaction)
CREATE TABLE component (
  uid TEXT PRIMARY KEY, owner TEXT, line_number TEXT, kind TEXT, tag TEXT, nps TEXT, description TEXT,
  length_mm REAL, weight_kg REAL, x1 REAL, y1 REAL, z1 REAL, x2 REAL, y2 REAL, z2 REAL, skey TEXT
);
CREATE INDEX component_line ON component(line_number);
CREATE TABLE weld (id INTEGER PRIMARY KEY, line_number TEXT, a TEXT, b TEXT, nps TEXT, inch_dia REAL, e REAL, n REAL, el REAL);
CREATE TABLE clash (id INTEGER PRIMARY KEY, a TEXT, b TEXT, hard INTEGER, distance_mm REAL, e REAL, n REAL, el REAL);
CREATE TABLE mto (id INTEGER PRIMARY KEY, kind TEXT, spec TEXT, nps TEXT, description TEXT, qty REAL, unit TEXT, weight_kg REAL);

-- ============================================================ transactions (audit trail)
CREATE TABLE txn (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, user TEXT, action TEXT NOT NULL, objects TEXT);

-- people: the model stores user ids; names are filled in by this copy of the database for reports
CREATE TABLE person (id TEXT PRIMARY KEY, name TEXT);

-- ============================================================ report views
CREATE VIEW v_line_list AS
  SELECT l.number AS line_number, l.nps, l.spec, l.fluid, l.from_ref AS "from", l.to_ref AS "to",
         ROUND(l.pipe_length_m, 2) AS pipe_m, l.elbows, l.valves, l.tees, l.shoes, l.welds, l.route_status,
         o.status, o.rev, COALESCE(p.name, o.modified_by) AS modified_by
  FROM line l JOIN object o ON o.oid = l.oid LEFT JOIN person p ON p.id = o.modified_by ORDER BY l.number;
CREATE VIEW v_equipment_list AS
  SELECT e.tag, e.template, e.description, ROUND(e.e) AS e, ROUND(e.n) AS n, ROUND(e.el) AS el, e.rotation,
         (SELECT COUNT(*) FROM nozzle z WHERE z.equipment = e.oid) AS nozzles, o.status, o.permission_group, o.rev
  FROM equipment e JOIN object o ON o.oid = e.oid ORDER BY e.tag;
CREATE VIEW v_nozzle_schedule AS
  SELECT z.tag AS nozzle, z.nps, z.service, ROUND(z.e) AS e, ROUND(z.n) AS n, ROUND(z.el) AS el, z.facing,
         COALESCE(z.connected_line, 'free') AS connected_line
  FROM nozzle z ORDER BY z.tag;
CREATE VIEW v_valve_list AS
  SELECT line_number, tag, nps, description FROM component WHERE kind = 'VALVE' ORDER BY line_number, tag;
CREATE VIEW v_weld_summary AS
  SELECT line_number, COUNT(*) AS welds, ROUND(SUM(inch_dia), 1) AS inch_dia FROM weld GROUP BY line_number ORDER BY line_number;
CREATE VIEW v_mto_by_line AS
  SELECT line_number, kind, nps, description, COUNT(*) AS qty, ROUND(SUM(length_mm) / 1000.0, 2) AS length_m, ROUND(SUM(weight_kg), 1) AS weight_kg
  FROM component WHERE kind NOT IN ('NOZZLE', 'EQUIPMENT', 'STEEL') GROUP BY line_number, kind, nps, description ORDER BY line_number, kind;
CREATE VIEW v_status_summary AS
  SELECT type, status, COUNT(*) AS objects FROM object GROUP BY type, status ORDER BY type, status;
CREATE VIEW v_clash_report AS
  SELECT a, b, CASE hard WHEN 1 THEN 'HARD' ELSE 'CLEARANCE' END AS kind, ROUND(distance_mm) AS distance_mm, ROUND(e) AS e, ROUND(n) AS n, ROUND(el) AS el FROM clash;
`;

export interface SavedReport {
  name: string;
  sql: string;
}

export const REPORTS: SavedReport[] = [
  { name: "Line list", sql: "SELECT * FROM v_line_list;" },
  { name: "Equipment list", sql: "SELECT * FROM v_equipment_list;" },
  { name: "Nozzle schedule", sql: "SELECT * FROM v_nozzle_schedule;" },
  { name: "Valve list", sql: "SELECT * FROM v_valve_list;" },
  { name: "MTO (whole plant)", sql: "SELECT kind, nps, description, qty, unit, ROUND(weight_kg, 1) AS weight_kg FROM mto;" },
  { name: "MTO by line", sql: "SELECT * FROM v_mto_by_line;" },
  { name: "Weld summary", sql: "SELECT * FROM v_weld_summary;" },
  { name: "Clash report", sql: "SELECT * FROM v_clash_report;" },
  { name: "Approval status", sql: "SELECT * FROM v_status_summary;" },
  { name: "Objects not approved", sql: "SELECT o.type, o.name, o.status, o.rev, COALESCE(p.name, o.modified_by) AS modified_by, o.modified_at FROM object o LEFT JOIN person p ON p.id = o.modified_by WHERE o.status <> 'Approved' ORDER BY o.type, o.name;" },
  { name: "Free nozzles", sql: "SELECT nozzle, nps, service, e, n, el FROM v_nozzle_schedule WHERE connected_line = 'free';" },
  { name: "Pipe length by size", sql: "SELECT nps, ROUND(SUM(length_mm) / 1000.0, 2) AS metres, ROUND(SUM(weight_kg)) AS kg FROM component WHERE kind = 'PIPE' GROUP BY nps ORDER BY CAST(nps AS REAL);" },
  { name: "Audit trail", sql: "SELECT t.id, t.at, COALESCE(p.name, t.user) AS user, t.action FROM txn t LEFT JOIN person p ON p.id = t.user ORDER BY t.id DESC LIMIT 200;" },
  { name: "Changes by person", sql: "SELECT COALESCE(p.name, t.user) AS person, COUNT(*) AS transactions, MIN(t.at) AS first, MAX(t.at) AS last FROM txn t LEFT JOIN person p ON p.id = t.user GROUP BY t.user ORDER BY transactions DESC;" },
  { name: "Spec A1A - pipe rules", sql: "SELECT * FROM spec_pipe WHERE spec = 'A1A';" },
];

export type TableGroup = "plant" | "catalog" | "spec" | "model" | "report" | "log";

export const TABLE_GROUPS: Record<string, TableGroup> = {
  db_info: "plant",
  plant: "plant",
  permission_group: "plant",
  hierarchy: "plant",
  cat_pipe: "catalog",
  cat_pipe_wall: "catalog",
  cat_fitting: "catalog",
  cat_flange_rating: "catalog",
  cat_flange: "catalog",
  cat_valve: "catalog",
  spec: "spec",
  spec_pipe: "spec",
  spec_part: "spec",
  spec_valve: "spec",
  object: "model",
  equipment: "model",
  nozzle: "model",
  line: "model",
  structure: "model",
  component: "report",
  weld: "report",
  clash: "report",
  mto: "report",
  txn: "log",
  person: "log",
};

/** Catalog tables an engineer may edit or bulkload, with their key columns. */
export const EDITABLE: Record<string, { label: string; keys: string[] }> = {
  cat_pipe: { label: "Pipe sizes (B36.10M)", keys: ["nps"] },
  cat_pipe_wall: { label: "Pipe wall thickness by schedule", keys: ["nps", "schedule"] },
  cat_fitting: { label: "BW fittings (B16.9)", keys: ["nps"] },
  cat_flange: { label: "Flanges (B16.5)", keys: ["rating", "nps"] },
  cat_valve: { label: "Valve face-to-face (B16.10)", keys: ["rating", "type", "nps"] },
  spec_pipe: { label: "Spec pipe rules", keys: ["spec", "nps_from", "nps_to"] },
  spec_part: { label: "Spec parts", keys: ["spec", "part"] },
  spec_valve: { label: "Spec valves", keys: ["spec", "type"] },
  spec: { label: "Specs", keys: ["name"] },
};
