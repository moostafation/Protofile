import { strToU8, zipSync } from "fflate";
import { toDxf, toSvg } from "../engine/drawing";
import { exportToml } from "../engine/exportToml";
import { lineIsometric } from "../engine/iso";
import { mtoCsv } from "../engine/mto";
import { linePcf } from "../engine/pcf";
import { saveFile } from "../platform/claude";
import { hub } from "./hub";
import { useStore } from "./store";

const safe = (s: string) => s.replace(/"/g, "in").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "plantforge";

async function offer(filename: string, data: string | Blob) {
  const st = useStore.getState();
  const r = await saveFile(filename, data);
  if (r === "saved") st.toast(`Saved ${filename}`);
  else if (r === "unavailable") st.toast("Downloads are not available in this view. Use Copy where offered, or open the page in Claude.", "error");
}

export function packageZip(lineIds?: string[]): Uint8Array {
  const { model } = useStore.getState();
  const files: Record<string, Uint8Array> = {};
  const date = new Date().toISOString().slice(0, 10);
  for (const l of model.lines.values()) {
    if (lineIds && !lineIds.includes(l.doc.id)) continue;
    const name = safe(l.doc.number);
    if (!l.error) files[`pcf/${name}.pcf`] = strToU8(linePcf(model, l));
    const iso = lineIsometric(model, l.doc.id, date);
    files[`iso/${name}.dxf`] = strToU8(toDxf(iso));
    files[`iso/${name}.svg`] = strToU8(toSvg(iso, true));
  }
  if (!lineIds) {
    files["mto.csv"] = strToU8(mtoCsv(model.mto, model.conn.welds.length, model.conn.inchDia));
    files["model.plantforge.json"] = strToU8(JSON.stringify(model.doc, null, 1));
    files["project-for-ifc.toml"] = strToU8(exportToml(model));
    files["README.txt"] = strToU8(
      [
        `PlantForge Studio export - ${model.doc.project.name} - ${date}`,
        "",
        "pcf/   Piping Component Files (ISOGEN and other isometric tools)",
        "iso/   Automatic isometrics: DXF (AutoCAD) and SVG",
        "mto.csv                 Material take-off",
        "model.plantforge.json   Re-open in PlantForge Studio (Projects > Import)",
        "project-for-ifc.toml    For the PlantForge Python engine: plantforge build project-for-ifc.toml -o out  (IFC 4 + PCF + DXF)",
      ].join("\n"),
    );
  }
  return zipSync(files, { level: 6 });
}

export async function exportCurrent(kind: "zip" | "csv" | "json" | "toml" | "png") {
  const { model } = useStore.getState();
  const base = safe(model.doc.project.name);
  if (kind === "zip") return offer(`${base}-package.zip`, new Blob([packageZip()], { type: "application/zip" }));
  if (kind === "csv") return offer(`${base}-mto.csv`, mtoCsv(model.mto, model.conn.welds.length, model.conn.inchDia));
  if (kind === "json") return offer(`${base}.plantforge.json`, JSON.stringify(model.doc, null, 1));
  if (kind === "toml") return offer(`${base}-for-ifc.txt`, exportToml(model));
  if (kind === "png") {
    const blob = hub.viewer?.snapshot();
    if (blob) return offer(`${base}.png`, blob);
  }
}

export async function exportLine(lineId: string, kind: "svg" | "zip") {
  const { model } = useStore.getState();
  const l = model.lines.get(lineId);
  if (!l) return;
  const name = safe(l.doc.number);
  if (kind === "svg") return offer(`${name}-iso.svg`, toSvg(lineIsometric(model, lineId), true));
  return offer(`${name}-iso.zip`, new Blob([packageZip([lineId])], { type: "application/zip" }));
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
