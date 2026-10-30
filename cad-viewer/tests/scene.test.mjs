// Smoke test: parse DXF/DWG files and build scenes. Usage: node tests/scene.test.mjs <files...>
import fs from 'node:fs';
import path from 'node:path';
import { parseDxf } from '../src/cad/dxf-parser.js';
import { buildDrawing } from '../src/cad/drawing.js';
import { buildScene } from '../src/cad/scene.js';

let failed = 0;
for (const file of process.argv.slice(2)) {
  const buf = fs.readFileSync(file);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const t0 = performance.now();
  let db, source;
  if (file.toLowerCase().endsWith('.dxf')) {
    db = parseDxf(ab);
    source = 'dxf';
  } else {
    const { LibreDwg, Dwg_File_Type } = await import('@mlightcad/libredwg-web');
    const lib = await LibreDwg.create(path.resolve('node_modules/@mlightcad/libredwg-web/wasm') + '/');
    const data = lib.dwg_read_data(ab, Dwg_File_Type.DWG);
    db = lib.convert(data);
    lib.dwg_free(data);
    source = 'dwg';
  }
  const drawing = buildDrawing(db, source, path.basename(file));
  const scene = buildScene(drawing, drawing.modelEntities);
  const kinds = {};
  for (const p of scene.prims) kinds[p.k] = (kinds[p.k] || 0) + 1;
  const bad = scene.prims.filter((p) => !p.bb.every(Number.isFinite) && !p.infinite);
  console.log(path.basename(file), `${(performance.now() - t0).toFixed(0)}ms`,
    'layers', drawing.layers.size, 'blocks', drawing.blocks.size, 'model', drawing.modelEntities.length,
    'layouts', drawing.layouts.map((l) => `${l.name}:${l.entities.length}`).join(','),
    'prims', JSON.stringify(kinds), 'bbox', scene.bbox.map((v) => v.toFixed(1)).join(','),
    'inserts', JSON.stringify(Object.fromEntries(scene.insertCounts)), 'warn', scene.warnings.join('|'));
  const texts = scene.prims.filter((p) => p.k === 2).map((p) => p.lines.map((l) => l.s).join(' / '));
  console.log('  texts:', texts.slice(0, 14).join(' ¦ '));
  if (bad.length) { console.log('  NON-FINITE BBOX', bad.length, bad.slice(0, 3)); failed++; }
  for (const lo of drawing.layouts) {
    const s = buildScene(drawing, lo.entities);
    console.log('  layout', lo.name, 'prims', s.prims.length, 'vports', s.prims.filter((p) => p.k === 5).length);
  }
}
process.exit(failed ? 1 : 0);
