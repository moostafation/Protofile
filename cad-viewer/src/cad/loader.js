// Loads a CAD file (DWG, DXF, DGN, HP-GL) into a Drawing using the parse worker.
import { buildDrawing } from './drawing.js';
import { FormatError } from '../formats/errors.js';

let worker = null;
let seq = 0;
const pending = new Map();

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('./parse-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (ev) => {
      const p = pending.get(ev.data.id);
      if (!p) return;
      pending.delete(ev.data.id);
      // Parse errors are reported per file; the worker resets its own WebAssembly state and stays usable.
      if (ev.data.ok) p.resolve(ev.data.db);
      else p.reject(new FormatError(ev.data.error, ev.data.hint, ev.data.label));
    };
    worker.onerror = (ev) => {
      // The worker itself crashed: every request still waiting on it fails.
      for (const p of pending.values()) p.reject(new Error(ev.message || 'The file parser crashed.'));
      pending.clear();
      worker.terminate();
      worker = null;
    };
  }
  return worker;
}

/** @param {'dwg'|'dxf'|'dgn'|'hpgl'} kind parser to use (defaults from the file name) */
export async function loadCad(buffer, fileName, kind = /\.dxf$/i.test(fileName) ? 'dxf' : 'dwg') {
  const id = ++seq;
  const db = await new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, kind, buffer }, [buffer]);
  });
  const drawing = buildDrawing(db, kind, fileName);
  if (!drawing.modelEntities.length && !drawing.layouts.length) {
    throw new FormatError('No drawing objects were found in this file (it may be empty or damaged).');
  }
  return drawing;
}
