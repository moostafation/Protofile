// Database files to download: the plant database (.sqlite in a zip with a readme) and every saved report as CSV.

import { strToU8, zipSync } from "fflate";
import type { PlantDB } from "./PlantDB";
import { REPORTS } from "./schema";

export const safeName = (s: string) => s.replace(/"/g, "in").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "plant";

export function databaseZip(db: PlantDB, project: string): { filename: string; blob: Blob } {
  const base = safeName(project);
  const readme = [
    `PlantForge plant database - ${project} - ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
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
  return { filename: `${base}-database.zip`, blob: new Blob([zip], { type: "application/zip" }) };
}

export function reportsZip(db: PlantDB, project: string): { filename: string; blob: Blob } {
  const files: Record<string, Uint8Array> = {};
  for (const r of REPORTS) files[`${safeName(r.name)}.csv`] = strToU8(db.csv(r.sql));
  return { filename: `${safeName(project)}-reports.zip`, blob: new Blob([zipSync(files, { level: 6 })], { type: "application/zip" }) };
}
