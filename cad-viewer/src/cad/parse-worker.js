// Parses CAD files off the main thread: DWG (libredwg WebAssembly), DXF, DGN V7 and HP-GL.
import { LibreDwg, createModule } from '@mlightcad/libredwg-web';
// The package does not export its .wasm file, so it is referenced by path.
import wasmUrl from '../../node_modules/@mlightcad/libredwg-web/wasm/libredwg-web.wasm?url';
import { parseDxf } from './dxf-parser.js';
import { parseDgn } from '../formats/dgn.js';
import { parseHpgl } from '../formats/hpgl.js';
import { readDwg } from './dwg-read.js';

let libPromise = null;
function libredwg() {
  libPromise ??= createModule({ locateFile: () => wasmUrl }).then((m) => LibreDwg.createByWasmInstance(m));
  return libPromise;
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
        db = readDwg(lib, buffer);
        // Opened despite critical LibreDWG errors: do not reuse a module that may be damaged.
        if (db.warnings?.includes('dwgErrors')) libPromise = null;
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
