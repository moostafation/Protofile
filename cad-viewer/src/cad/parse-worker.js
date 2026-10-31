// Parses CAD files off the main thread: DWG (libredwg WebAssembly), DXF, DGN V7 and HP-GL.
import { LibreDwg, createModule } from '@mlightcad/libredwg-web';
// The package does not export its .wasm file, so it is referenced by path.
import wasmUrl from '../../node_modules/@mlightcad/libredwg-web/wasm/libredwg-web.wasm?url';
import { parseDxf } from './dxf-parser.js';
import { parseDgn } from '../formats/dgn.js';
import { parseHpgl } from '../formats/hpgl.js';

// LibreDWG error bits; anything from CLASSESNOTFOUND (128) up is critical. Good files often report 64/68.
const DWG_ERR_CRITICAL = 128;
const DWG_ERRORS = [[8192, 'out of memory'], [4096, 'I/O error'], [2048, 'not a valid DWG file'], [1024, 'internal error'],
  [512, 'page not found'], [256, 'section not found (file truncated or damaged)'], [128, 'classes not found']];

let libPromise = null;
function libredwg() {
  libPromise ??= createModule({ locateFile: () => wasmUrl }).then((m) => LibreDwg.createByWasmInstance(m));
  return libPromise;
}

let seq = 0;
/** Like LibreDwg.dwg_read_data, but keeps the error code so damaged files fail instead of opening empty. */
function readDwg(lib, buffer) {
  const m = lib.wasmInstance;
  const name = `in${++seq}.dwg`;
  try {
    m.FS.writeFile(name, new Uint8Array(buffer));
    const { error, data } = m.dwg_read_file(name);
    if (error >= DWG_ERR_CRITICAL || !data) {
      const why = DWG_ERRORS.find(([bit]) => error & bit)?.[1] || 'unreadable';
      throw new Error(`This DWG file could not be read: ${why} (LibreDWG error ${error}).`);
    }
    return data;
  } finally {
    if (m.FS.analyzePath(name, false).exists) m.FS.unlink(name);
  }
}

self.onmessage = async (ev) => {
  const { id, kind, buffer } = ev.data;
  try {
    let db;
    if (kind === 'dxf') {
      db = parseDxf(buffer);
    } else if (kind === 'dgn') {
      db = parseDgn(buffer);
    } else if (kind === 'hpgl') {
      db = parseHpgl(buffer);
    } else {
      const lib = await libredwg();
      try {
        const data = readDwg(lib, buffer);
        db = lib.convert(data);
        lib.dwg_free(data);
      } catch (err) {
        // A failed parse can leave the WebAssembly module in a bad state: use a fresh one next time.
        libPromise = null;
        throw err;
      }
    }
    // Drop heavy fields the viewer never uses before cloning back.
    delete db.thumbnailImage;
    self.postMessage({ id, ok: true, db });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message || err), hint: err?.hint ?? null, label: err?.label ?? null });
  }
};
