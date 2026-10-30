// Every file type the app knows: extensions, category, how to open it, and for
// formats that cannot be opened in the browser, which export to ask for instead.
// Used by openFile, the file picker `accept`, drag & drop and the welcome screen;
// public/manifest.webmanifest (file_handlers) lists the same openable extensions.
import { loadCad } from '../cad/loader.js';
import { FormatError } from './errors.js';

/**
 * Categories: 'cad' (2D drawings -> Drawing), 'document' (PDF), 'image',
 * '3d' (reserved for 3D models), 'unsupported' (known formats with an export hint).
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

/** Recognises a few formats from their first bytes (wrong or missing extensions). */
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

/** Opens a file buffer. Resolves to { kind: 'cad', drawing } | { kind: 'pdf'|'image', sheet }. */
export async function openBuffer(format, buffer, name) {
  if (!format) throw new FormatError('Unsupported file type.', 'unknown');
  if (format.category === 'unsupported') throw new FormatError(`${format.label} files cannot be opened in the browser.`, format.hint, format.label);
  return format.open(buffer, name);
}

/** The file input's `accept` list: every known extension (unsupported ones get an explanation). */
export function acceptAttribute() {
  return FORMATS.flatMap((f) => f.exts.map((e) => `.${e}`)).join(',');
}

/** Extensions that the app can open (for manifest file_handlers). */
export function openableExtensions() {
  return FORMATS.filter((f) => f.open).flatMap((f) => f.exts);
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
