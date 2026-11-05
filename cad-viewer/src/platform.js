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
 * on the window (desktop), or PWA file handling (web). `handler` receives File-like objects.
 */
export function onOpenFiles(handler) {
  if (isDesktop) {
    const take = async () => {
      const paths = await invoke('take_pending');
      if (paths.length) handler(paths.map(readPath));
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
 * is open), and '' on the web.
 * @param {Blob} blob
 * @param {string} name suggested file name
 * @param {{ name: string, extensions: string[] }[]} filters
 */
export async function saveFile(blob, name, filters) {
  if (!isDesktop) {
    download(blob, name);
    return '';
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return oneDialog(() => invoke('save_file', bytes, fileHeaders(name, { 'x-filters': encodeURIComponent(JSON.stringify(filters)) })));
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
