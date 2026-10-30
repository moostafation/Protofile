// Loads a CAD file into a Drawing using the parse worker.
import { buildDrawing } from './drawing.js';

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
      if (ev.data.ok) p.resolve(ev.data.db);
      else {
        p.reject(new Error(ev.data.error));
        // A failed WebAssembly parse can leave the module in a bad state: start fresh next time.
        worker.terminate();
        worker = null;
      }
    };
    worker.onerror = (ev) => {
      for (const p of pending.values()) p.reject(new Error(ev.message || 'Parser crashed'));
      pending.clear();
      worker.terminate();
      worker = null;
    };
  }
  return worker;
}

export async function loadCad(buffer, fileName) {
  const kind = /\.dxf$/i.test(fileName) ? 'dxf' : 'dwg';
  const id = ++seq;
  const db = await new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, kind, buffer }, [buffer]);
  });
  return buildDrawing(db, kind, fileName);
}
