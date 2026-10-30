// Parses DWG (libredwg WebAssembly) and DXF files off the main thread.
import { LibreDwg, createModule, Dwg_File_Type } from '@mlightcad/libredwg-web';
// The package does not export its .wasm file, so it is referenced by path.
import wasmUrl from '../../node_modules/@mlightcad/libredwg-web/wasm/libredwg-web.wasm?url';
import { parseDxf } from './dxf-parser.js';

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
    } else {
      const lib = await libredwg();
      const data = lib.dwg_read_data(buffer, Dwg_File_Type.DWG);
      if (!data) throw new Error('This DWG file could not be read.');
      db = lib.convert(data);
      lib.dwg_free(data);
    }
    // Drop heavy fields the viewer never uses before cloning back.
    delete db.thumbnailImage;
    self.postMessage({ id, ok: true, db });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message || err) });
  }
};
