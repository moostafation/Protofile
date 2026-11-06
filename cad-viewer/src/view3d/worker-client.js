// Request/response over a dedicated worker, with progress messages and cancellation: aborting the
// signal (another file was opened) terminates the worker, which frees all its memory at once.
import { FormatError } from '../formats/errors.js';

export function workerClient(worker, signal) {
  let seq = 0;
  let dead = null;
  const pending = new Map();
  const fail = (err) => {
    dead = err;
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };
  worker.onmessage = (ev) => {
    const m = ev.data;
    const p = pending.get(m.req);
    if (!p) return;
    if (m.type === 'progress') { p.progress?.(m); return; }
    pending.delete(m.req);
    if (m.ok) p.resolve(m.res);
    else p.reject(new FormatError(m.error));
  };
  worker.onerror = (ev) => {
    ev.preventDefault?.();
    fail(new Error(ev.message || 'The 3D file reader stopped unexpectedly (the file may be too large for the available memory).'));
    worker.terminate();
  };
  const abort = () => { worker.terminate(); fail(new DOMException('Loading was cancelled.', 'AbortError')); };
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  return {
    call(cmd, data = {}, transfer = [], progress = null) {
      if (dead) return Promise.reject(dead);
      const req = ++seq;
      return new Promise((resolve, reject) => {
        pending.set(req, { resolve, reject, progress });
        worker.postMessage({ cmd, req, ...data }, transfer);
      });
    },
    /** The load finished: later aborts (another file chosen) no longer stop this worker. */
    detach() { signal?.removeEventListener('abort', abort); },
    dispose() {
      signal?.removeEventListener('abort', abort);
      worker.terminate();
      fail(new DOMException('Closed.', 'AbortError'));
    },
  };
}
