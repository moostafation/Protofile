// Reads a DWG with LibreDWG (WebAssembly), keeping its error code so damaged files fail
// instead of opening empty. Kept apart from the worker so it can be tested with a stub library.

// LibreDWG error bits; anything from CLASSESNOTFOUND (128) up is critical. Good files often report 64/68.
// Some real files report critical errors and still hold their drawing: those open with a warning.
const DWG_ERR_CRITICAL = 128;
const DWG_ERRORS = [[8192, 'out of memory'], [4096, 'I/O error'], [2048, 'not a valid DWG file'], [1024, 'internal error'],
  [512, 'page not found'], [256, 'section not found (file truncated or damaged)'], [128, 'classes not found']];

const unreadable = (error) => new Error(`This DWG file could not be read: ${DWG_ERRORS.find(([bit]) => error & bit)?.[1] || 'unreadable'} (LibreDWG error ${error}).`);

let seq = 0;
/**
 * Like LibreDwg.dwg_read_data + convert, but keeps the error code: a file with critical errors
 * fails unless it still yields drawing objects (then it opens with a "dwgErrors" warning).
 */
export function readDwg(lib, buffer) {
  const m = lib.wasmInstance;
  const name = `in${++seq}.dwg`;
  let error, data;
  try {
    m.FS.writeFile(name, new Uint8Array(buffer));
    ({ error, data } = m.dwg_read_file(name));
  } finally {
    if (m.FS.analyzePath(name, false).exists) m.FS.unlink(name);
  }
  if (!data) throw unreadable(error);
  const critical = error >= DWG_ERR_CRITICAL;
  let db;
  try {
    db = lib.convert(data);
  } catch (err) {
    throw critical ? unreadable(error) : err;
  } finally {
    try { lib.dwg_free(data); } catch { /* the module is replaced after a failure anyway */ }
  }
  if (critical) {
    if (!db.entities?.length) throw unreadable(error);
    db.warnings = [...(db.warnings ?? []), 'dwgErrors'];
  }
  return db;
}
