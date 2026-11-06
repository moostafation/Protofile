// Differences between the web build (browser or installed PWA) and the desktop program
// (Tauri shell in src-tauri): opening, saving and printing files, files handed over by
// the operating system, recent files and the native menu. The web paths are the app's
// original behaviour; Tauri's modules are only loaded inside the desktop program.

/** True inside the desktop program (Tauri defines window.isTauri before any page script runs). */
export const isDesktop = typeof window !== 'undefined' && window.isTauri === true;

let tauriApi = null;
function tauri() {
  tauriApi ??= Promise.all([import('@tauri-apps/api/core'), import('@tauri-apps/api/event')])
    .then(([core, event]) => ({ invoke: core.invoke, listen: event.listen }));
  return tauriApi;
}

async function invoke(cmd, args, options) {
  const { invoke: call } = await tauri();
  try {
    return await call(cmd, args, options);
  } catch (err) {
    // Commands report failures as readable strings.
    throw err instanceof Error ? err : new Error(String(err));
  }
}

async function listen(event, handler) {
  const { listen: on } = await tauri();
  return on(event, (ev) => handler(ev.payload));
}

const baseName = (path) => path.split(/[\\/]/).pop() || path;

/** A file on disk as the File-like object openFile() takes; `path` is kept for recent files. */
export function readPath(path) {
  return { name: baseName(path), path, arrayBuffer: () => invoke('read_file', { path }) };
}

/**
 * Desktop: a file next to an opened file (an OBJ's MTL and textures, a glTF's .bin), or null.
 * Only plain names in the same folder and resource types are allowed (see files.rs read_sibling).
 */
export async function readSibling(path, name) {
  if (!isDesktop) return null;
  try {
    return await invoke('read_sibling', { path, name });
  } catch {
    return null;
  }
}

let dialogOpen = false;
/** Runs a native file dialog unless one is already open (e.g. Ctrl+O reaching both menu and page). */
async function oneDialog(show) {
  if (dialogOpen) return null;
  dialogOpen = true;
  try {
    return await show();
  } finally {
    dialogOpen = false;
  }
}

/**
 * Desktop: shows the native Open dialog. Resolves to a File-like object, or null when
 * cancelled or when another file dialog is still open.
 * @param {{ name: string, extensions: string[] }[]} filters
 */
export async function openDialog(filters) {
  const path = await oneDialog(() => invoke('pick_file', { filters }));
  return path ? readPath(path) : null;
}

/**
 * Files handed over by the operating system: double-click / "Open with" and files dropped
 * on the window (desktop), or PWA file handling (web). `handler(files, errors)` receives
 * File-like objects and, on desktop, messages about handed-over files that cannot be opened.
 */
export function onOpenFiles(handler) {
  if (isDesktop) {
    const take = async () => {
      const { paths, errors } = await invoke('take_pending');
      if (paths.length || errors.length) handler(paths.map(readPath), errors);
    };
    // Paths queued before the listener existed are collected by the first take().
    listen('open-pending', take).then(take).catch((err) => console.error(err));
  } else if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async (params) => {
      const files = await Promise.all((params.files || []).map((h) => h.getFile()));
      if (files.length) handler(files);
    });
  }
}

/** Desktop: a file is being dragged over the window (true) or not any more (false). */
export function onDragState(handler) {
  if (isDesktop) listen('drag', handler).catch((err) => console.error(err));
}

/** Desktop: native menu items, by id (see src-tauri/src/menu.rs). */
export function onMenu(handler) {
  if (isDesktop) listen('menu', handler).catch((err) => console.error(err));
}

/** Desktop: recently opened files (paths, newest first); [] on the web. */
export async function recentFiles() {
  return isDesktop ? invoke('recent_files') : [];
}

export function onRecentChange(handler) {
  if (isDesktop) listen('recent-changed', handler).catch((err) => console.error(err));
}

/** Desktop: remembers a file that opened successfully (only files the user chose are accepted). */
export function addRecent(path) {
  if (isDesktop && path) invoke('add_recent', { path }).catch((err) => console.warn(err.message));
}

export function clearRecent() {
  if (isDesktop) invoke('clear_recent').catch((err) => console.warn(err.message));
}

const fileHeaders = (name, extra = {}) => ({ headers: { 'x-file-name': encodeURIComponent(name), ...extra } });

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;
/**
 * A file name that works on every system: no \ / : * ? " < > | or control characters (layout
 * names often contain them), no trailing dots or spaces, and not a reserved Windows device name
 * (CON, PRN, AUX, NUL, COM1, LPT1...), which gets a leading underscore.
 */
export function safeFileName(name, fallback = 'drawing') {
  let s = String(name ?? '').replace(/[\x00-\x1f\\/:*?"<>|]/g, '_').replace(/[. ]+$/, '').trim();
  if (!s || /^\.+$/.test(s)) s = fallback;
  if (RESERVED.test(s)) s = '_' + s;
  return s.slice(0, 200);
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/**
 * Saves a file: native Save dialog (desktop) or a browser download (web).
 * Resolves to the saved path on desktop, null when the user cancelled (or another file dialog
 * is open), and '' on the web. The desktop dialog starts in `directory` (the open drawing's
 * folder) or else the folder used last, and adds the filter's extension to a name typed without it.
 * @param {Blob} blob
 * @param {string} name suggested file name
 * @param {{ name: string, extensions: string[] }[]} filters
 * @param {{ directory?: string|null }} [opts]
 */
export async function saveFile(blob, name, filters, opts = {}) {
  name = safeFileName(name);
  if (!isDesktop) {
    download(blob, name);
    return '';
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const extra = { 'x-filters': encodeURIComponent(JSON.stringify(filters)) };
  if (opts.directory) extra['x-directory'] = encodeURIComponent(opts.directory);
  return oneDialog(() => invoke('save_file', bytes, fileHeaders(name, extra)));
}

/** Desktop: View > Theme shows the active theme. */
export function setThemeMenu(theme) {
  if (isDesktop) invoke('set_theme_menu', { theme }).catch((err) => console.warn(err.message));
}



/**
 * Desktop: writes the drawing back to a file the user opened or saved in this session (Ctrl+S on
 * a DXF). Only DXF files can be written this way; everything else goes through the Save dialog.
 */
export async function writeFile(path, blob) {
  if (!isDesktop) throw new Error('Saving to a path needs the desktop program.');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  await invoke('write_file', bytes, fileHeaders(path.split(/[\\/]/).pop(), { 'x-path': encodeURIComponent(path) }));
}

let lastModified = null;
/** Desktop: tells the window whether there are unsaved changes (closing then asks first). */
export function setModified(modified) {
  if (!isDesktop || modified === lastModified) return;
  lastModified = modified;
  invoke('set_modified', { modified }).catch((err) => console.warn(err.message));
}

/** Desktop: the user closes the window (or chooses Quit) while there are unsaved changes. */
export function onCloseRequested(handler) {
  if (isDesktop) listen('close-requested', handler).catch((err) => console.error(err));
}

/** Desktop: closes the window after the page asked about unsaved changes. */
export function closeWindow() {
  if (isDesktop) invoke('close_window').catch((err) => console.error(err));
}

function printInFrame(blob) {
  const url = URL.createObjectURL(blob);
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  frame.src = url;
  document.body.append(frame);
  frame.onload = () => {
    setTimeout(() => {
      try {
        frame.contentWindow.focus();
        frame.contentWindow.print();
      } catch {
        window.open(url, '_blank');
      }
    }, 250);
  };
  setTimeout(() => { frame.remove(); URL.revokeObjectURL(url); }, 120000);
}

/**
 * Prints a PDF. Web: the browser's print dialog through a hidden frame. Desktop: the PDF
 * opens in the system's PDF app (webviews have no reliable PDF printing), whose print
 * dialog lists every printer and paper size and can print at actual size.
 */
export async function printPdf(blob, name) {
  if (!isDesktop) {
    printInFrame(blob);
    return;
  }
  await invoke('print_pdf', new Uint8Array(await blob.arrayBuffer()), fileHeaders(name));
}

/** Web only: offline support for the installed PWA (the desktop program ships its files). */
export function registerServiceWorker() {
  if (!isDesktop && 'serviceWorker' in navigator && import.meta.env.PROD) {
    navigator.serviceWorker.register(new URL('sw.js', document.baseURI)).catch(() => {});
  }
}
