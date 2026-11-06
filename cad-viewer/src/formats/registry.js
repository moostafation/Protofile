// Every file type the app knows: extensions, category, how to open it, and for
// formats that cannot be opened in the browser, which export to ask for instead.
// Used by openFile, the file picker `accept`, drag & drop and the welcome screen;
// public/manifest.webmanifest (file_handlers) and src-tauri/tauri.conf.json (fileAssociations)
// list the same openable extensions (tests/formats.test.mjs checks both).
import { loadCad } from '../cad/loader.js';
import { FormatError } from './errors.js';

/**
 * Categories: 'cad' (2D drawings -> Drawing), 'document' (PDF), 'image',
 * '3d' (3D models, src/view3d), 'unsupported' (known formats with an export hint).
 * `associate`: 3D formats the desktop installer makes ProtoCAD Viewer the default app for
 * (engineering exchange formats); the other 3D formats are only offered under "Open with".
 */
const cad = (kind) => async (buffer, name) => ({ kind: 'cad', drawing: await loadCad(buffer, name, kind) });

const pdf = async (buffer, name) => {
  const { openPdf } = await import('../pdf/pdf-doc.js');
  return { kind: 'pdf', sheet: await openPdf(buffer, name) };
};

const image = (format) => async (buffer, name) => {
  const { openImage } = await import('./image-doc.js');
  return { kind: 'image', sheet: await openImage(buffer, name, format) };
};

// 3D models: three.js and the parsers are loaded only when such a file is opened.
const model3d = (kind) => async (buffer, name, ctx) => {
  const { open3d } = await import('../view3d/open3d.js');
  return { kind: '3d', model: await open3d(kind, buffer, name, ctx) };
};

export const FORMATS = [
  { id: 'dwg', label: 'DWG', exts: ['dwg', 'dwt', 'dws'], category: 'cad', open: cad('dwg') },
  { id: 'dxf', label: 'DXF', exts: ['dxf'], category: 'cad', open: cad('dxf') },
  { id: 'dgn', label: 'DGN (V7)', exts: ['dgn'], category: 'cad', open: cad('dgn') },
  { id: 'hpgl', label: 'HPGL / PLT', exts: ['plt', 'hpgl', 'hgl', 'hp2', 'pen'], category: 'cad', open: cad('hpgl') },
  { id: 'pdf', label: 'PDF', exts: ['pdf'], category: 'document', open: pdf },
  { id: 'png', label: 'PNG', exts: ['png'], category: 'image', open: image('PNG') },
  { id: 'jpeg', label: 'JPG', exts: ['jpg', 'jpeg'], category: 'image', open: image('JPEG') },
  { id: 'gif', label: 'GIF', exts: ['gif'], category: 'image', open: image('GIF') },
  { id: 'bmp', label: 'BMP', exts: ['bmp'], category: 'image', open: image('BMP') },
  { id: 'webp', label: 'WebP', exts: ['webp'], category: 'image', open: image('WEBP') },
  { id: 'svg', label: 'SVG', exts: ['svg'], category: 'image', open: image('SVG') },
  { id: 'tiff', label: 'TIFF', exts: ['tif', 'tiff'], category: 'image', open: image('TIFF') },
  { id: 'ifc', label: 'IFC', exts: ['ifc', 'ifczip'], category: '3d', associate: true, open: model3d('ifc') },
  { id: 'step', label: 'STEP', exts: ['step', 'stp'], category: '3d', associate: true, open: model3d('step') },
  { id: 'iges', label: 'IGES', exts: ['iges', 'igs'], category: '3d', associate: true, open: model3d('iges') },
  { id: 'pcf', label: 'PCF (piping)', exts: ['pcf'], category: '3d', associate: true, open: model3d('pcf') },
  { id: 'brep', label: 'BREP', exts: ['brep'], category: '3d', open: model3d('brep') },
  { id: 'stl', label: 'STL', exts: ['stl'], category: '3d', open: model3d('stl') },
  { id: 'obj', label: 'OBJ', exts: ['obj'], category: '3d', open: model3d('obj') },
  { id: 'gltf', label: 'glTF / GLB', exts: ['gltf', 'glb'], category: '3d', open: model3d('gltf') },
  { id: 'fbx', label: 'FBX', exts: ['fbx'], category: '3d', open: model3d('fbx') },
  { id: 'dae', label: 'COLLADA (DAE)', exts: ['dae'], category: '3d', open: model3d('dae') },
  { id: 'ply', label: 'PLY', exts: ['ply'], category: '3d', open: model3d('ply') },
  { id: '3mf', label: '3MF', exts: ['3mf'], category: '3d', open: model3d('3mf') },
  // Known proprietary formats: explained instead of opened. `hint` is an i18n key suffix.
  { id: 'revit', label: 'Revit', exts: ['rvt', 'rfa', 'rte'], category: 'unsupported', hint: 'revit' },
  { id: 'navisworks', label: 'Navisworks', exts: ['nwd', 'nwc', 'nwf'], category: 'unsupported', hint: 'navisworks' },
  { id: 'solidworks', label: 'SolidWorks', exts: ['sldprt', 'sldasm', 'slddrw'], category: 'unsupported', hint: 'mcad' },
  { id: 'inventor', label: 'Inventor', exts: ['ipt', 'iam', 'idw'], category: 'unsupported', hint: 'mcad' },
  { id: 'catia', label: 'CATIA', exts: ['catpart', 'catproduct', 'catdrawing'], category: 'unsupported', hint: 'mcad' },
  { id: 'nx', label: 'NX / Creo', exts: ['prt', 'asm'], category: 'unsupported', hint: 'mcad' },
  { id: 'sketchup', label: 'SketchUp', exts: ['skp'], category: 'unsupported', hint: 'sketchup' },
  { id: 'dwf', label: 'DWF', exts: ['dwf', 'dwfx'], category: 'unsupported', hint: 'dwf' },
  { id: 'aveva', label: 'AVEVA / PDMS', exts: ['rvm', 'e3d'], category: 'unsupported', hint: 'aveva' },
  { id: 'kernel', label: 'Parasolid / ACIS / JT', exts: ['x_t', 'x_b', 'sat', 'sab', 'jt'], category: 'unsupported', hint: 'mcad' },
  { id: 'rhino', label: 'Rhino', exts: ['3dm'], category: 'unsupported', hint: 'rhino' },
  { id: 'dcc', label: '3ds Max / Blender / 3DS', exts: ['max', 'blend', '3ds'], category: 'unsupported', hint: 'dcc' },
  { id: 'postscript', label: 'PostScript', exts: ['ps', 'eps'], category: 'unsupported', hint: 'postscript' },
];

const BY_EXT = new Map();
for (const f of FORMATS) for (const e of f.exts) BY_EXT.set(e, f);

export function extensionOf(name) {
  const m = /\.([^./\\]+)$/.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

/** Format for a file name (by extension), or null. */
export function formatFor(name) {
  return BY_EXT.get(extensionOf(name)) ?? null;
}

export function formatById(id) {
  return FORMATS.find((f) => f.id === id) ?? null;
}

export const SNIFF_BYTES = 4096;

/** ASCII DXF: a "0 / SECTION / 2 / <name>" group near the start (comments and whitespace allowed). */
const DXF_START = /(^|\n)[ \t]*0[ \t]*\r?\n[ \t]*SECTION[ \t]*\r?\n[ \t]*2[ \t]*\r?\n[ \t]*(HEADER|CLASSES|TABLES|BLOCKS|ENTITIES|OBJECTS|THUMBNAILIMAGE)\b/;

/** PCF (piping component file): header or pipeline keywords at the start of a line (same test as pcf.js looksLikePcf). */
const PCF_START = /(^|\n)\s*(ISOGEN-FILES|UNITS-CO-ORDS|UNITS-BORE|PIPELINE-REFERENCE)\b/;

/** SVG: an <svg> root after an optional XML declaration, comments and doctype. */
const SVG_START = /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE\s+svg[^>]*>\s*)?<svg[\s>]/i;

/** Recognises formats from their first bytes (up to SNIFF_BYTES), for wrong or missing extensions. */
export function sniff(bytes) {
  const b = bytes;
  const ascii = (i, s) => [...s].every((ch, k) => b[i + k] === ch.charCodeAt(0));
  if (ascii(0, '%PDF')) return formatById('pdf');
  if (b[0] === 0x89 && ascii(1, 'PNG')) return formatById('png');
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return formatById('jpeg');
  if (ascii(0, 'GIF8')) return formatById('gif');
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return formatById('webp');
  if ((ascii(0, 'II') && b[2] === 42 && b[3] === 0) || (ascii(0, 'MM') && b[2] === 0 && b[3] === 42)) return formatById('tiff');
  if (ascii(0, 'AC10')) return formatById('dwg');
  if ((b[0] === 0x08 || b[0] === 0xc8) && b[1] === 0x09 && b[2] === 0xfe && b[3] === 0x02) return formatById('dgn');
  if (ascii(0, '(DWF V')) return formatById('dwf');
  if (ascii(0, '%!PS')) return formatById('postscript');
  if (ascii(0, 'AutoCAD Binary DXF')) return formatById('dxf');
  if (ascii(0, 'glTF')) return formatById('gltf');
  if (ascii(0, 'Kaydara FBX Binary')) return formatById('fbx');
  let head = '';
  for (let i = 0; i < Math.min(b.length, SNIFF_BYTES); i++) head += String.fromCharCode(b[i]);
  if (DXF_START.test(head)) return formatById('dxf');
  if (SVG_START.test(head)) return formatById('svg');
  // STEP physical files: IFC by its schema, other schemas (AP203/AP214/AP242) are CAD STEP.
  if (/^\s*ISO-10303-21\s*;/.test(head)) {
    const schema = /FILE_SCHEMA\s*\(\s*\(\s*'([^']*)'/i.exec(head)?.[1];
    if (schema) return formatById(/^IFC/i.test(schema) ? 'ifc' : 'step');
    return null;
  }
  if (/^[^\r\n]{72}S[ 0]{0,6}1\r?\n/.test(head)) return formatById('iges');
  if (/^\s*(DBRep_DrawableShape|CASCADE Topology V\d)/.test(head)) return formatById('brep');
  if (/^ply\r?\n/.test(head)) return formatById('ply');
  if (/^; FBX \d/.test(head)) return formatById('fbx');
  if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<COLLADA[\s>]/.test(head)) return formatById('dae');
  if (/^\s*solid\b[^\n]*\r?\n\s*(facet|endsolid)\b/.test(head)) return formatById('stl');
  if (PCF_START.test(head)) return formatById('pcf');
  return null;
}

/**
 * Chooses how to open a file: by extension, corrected by the content when the
 * bytes clearly say otherwise (e.g. a PDF saved as .plt).
 */
export function resolveFormat(name, bytes) {
  const byExt = formatFor(name);
  const byContent = bytes ? sniff(bytes) : null;
  if (byExt?.category === 'unsupported') return byExt;
  if (byContent && byContent !== byExt) return byContent;
  return byExt;
}

/**
 * Opens a file buffer. Resolves to { kind: 'cad', drawing } | { kind: 'pdf'|'image', sheet } | { kind: '3d', model }.
 * `ctx` (3D models): { signal, onProgress(text), resources: Map<name, Blob>, readSibling(name) }.
 */
export async function openBuffer(format, buffer, name, ctx = {}) {
  if (!format) throw new FormatError('Unsupported file type.', 'unknown');
  if (format.category === 'unsupported') throw new FormatError(`${format.label} files cannot be opened in the browser.`, format.hint, format.label);
  return format.open(buffer, name, ctx);
}

/** The file input's `accept` list: every known extension (unsupported ones get an explanation). */
export function acceptAttribute() {
  return FORMATS.flatMap((f) => f.exts.map((e) => `.${e}`)).join(',');
}

/** Extensions that the app can open (for manifest file_handlers). */
export function openableExtensions() {
  return FORMATS.filter((f) => f.open).flatMap((f) => f.exts);
}

/**
 * Desktop file associations: extensions ProtoCAD Viewer becomes the default app for (CAD drawings
 * and the engineering 3D formats) and those it is only offered for under "Open with".
 */
export function defaultAssociations() {
  return FORMATS.filter((f) => f.open && (f.category === 'cad' || f.associate)).flatMap((f) => f.exts);
}
export function openWithOnly() {
  const def = new Set(defaultAssociations());
  return openableExtensions().filter((e) => !def.has(e));
}

/** Openable extensions grouped by category (for the desktop Open dialog's file type filters). */
export function openableByCategory() {
  const groups = new Map();
  for (const f of FORMATS) {
    if (!f.open) continue;
    if (!groups.has(f.category)) groups.set(f.category, []);
    groups.get(f.category).push(...f.exts);
  }
  return [...groups.entries()].map(([category, extensions]) => ({ category, extensions }));
}

/** Labels of openable formats grouped by category, for the welcome screen. */
export function supportedGroups() {
  const groups = new Map();
  for (const f of FORMATS) {
    if (!f.open) continue;
    if (!groups.has(f.category)) groups.set(f.category, []);
    groups.get(f.category).push(f.id === 'dwg' ? 'DWG / DWT / DWS' : f.label);
  }
  return [...groups.entries()].map(([category, labels]) => ({ category, labels }));
}
