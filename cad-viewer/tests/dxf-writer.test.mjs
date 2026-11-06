// DXF writer round trip: every drawing is written as DXF, read back with our parser and
// compared with the original (entity types and counts per space and block, key geometry,
// properties, and the rendered scene's extents).
// Usage: node tests/dxf-writer.test.mjs [--out <dir>] [files...]
//   Without files: the sample drawing, the DGN and HP-GL fixtures, plus every .dwg/.dxf in the
//   folder named by the DXF_SAMPLES environment variable (e.g. the example_*.dwg files).
//   --out writes the DXF files there (tests/dxf-audit.mjs checks them with ezdxf).
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { parseDxf } from '../src/cad/dxf-parser.js';
import { parseDgn } from '../src/formats/dgn.js';
import { parseHpgl } from '../src/formats/hpgl.js';
import { readDwg } from '../src/cad/dwg-read.js';
import { buildDrawing, lineweightToMm } from '../src/cad/drawing.js';
import { buildScene } from '../src/cad/scene.js';
import { writeDxf } from '../src/cad/dxf-writer.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const args = process.argv.slice(2);
let outDir = null;
const files = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out') outDir = args[++i];
  else files.push(args[i]);
}
if (!files.length) {
  files.push(path.join(root, 'public/samples/plant.dxf'));
  for (const f of ['plant-v7.dgn', 'smalltest.dgn', 'test3d-v7.dgn', 'plot-hpgl1.plt', 'plot-hpgl2-pcl.plt']) files.push(path.join(here, 'fixtures', f));
  const extra = process.env.DXF_SAMPLES;
  if (extra && fs.existsSync(extra)) {
    for (const f of fs.readdirSync(extra).sort()) if (/\.(dwg|dxf)$/i.test(f) && !/\.out\.dxf$/i.test(f)) files.push(path.join(extra, f));
  }
}
if (outDir) fs.mkdirSync(outDir, { recursive: true });

let lib = null;
async function load(file) {
  const buf = fs.readFileSync(file);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const ext = path.extname(file).toLowerCase();
  if (ext === '.dxf') return buildDrawing(parseDxf(ab), 'dxf', path.basename(file));
  if (ext === '.dgn') return buildDrawing(parseDgn(ab), 'dgn', path.basename(file));
  if (['.plt', '.hpgl', '.hgl'].includes(ext)) return buildDrawing(parseHpgl(ab), 'hpgl', path.basename(file));
  if (!lib) {
    const { LibreDwg } = await import('@mlightcad/libredwg-web');
    lib = await LibreDwg.create(path.join(root, 'node_modules/@mlightcad/libredwg-web/wasm') + '/');
  }
  return buildDrawing(readDwg(lib, ab), 'dwg', path.basename(file));
}

const near = (a, b, what, eps = 1e-6) => {
  const tol = eps * Math.max(1, Math.abs(a), Math.abs(b));
  assert.ok(Math.abs((a ?? 0) - (b ?? 0)) <= tol, `${what}: ${a} != ${b}`);
};
const nearPt = (a, b, what) => { near(a?.x ?? 0, b?.x ?? 0, what + '.x'); near(a?.y ?? 0, b?.y ?? 0, what + '.y'); };
const angle = (a, b, what) => {
  const d = Math.abs(((((a ?? 0) - (b ?? 0)) % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI);
  assert.ok(d < 1e-9, `${what}: ${a} != ${b}`);
};

// Types the writer converts or drops, with what they become (for the per-type counts).
const CONVERTED = new Set(['MULTILEADER', 'MLINE', 'ACAD_TABLE', 'IMAGE', 'ARC_DIMENSION', 'LARGE_RADIAL_DIMENSION']);
const SKIPPED = (t) => ['3DSOLID', 'REGION', 'BODY', 'OLE2FRAME', 'OLEFRAME', 'PROXY', 'SHAPE'].includes(t) || t.startsWith('DGN_');

/** Compares one entity with its round-tripped copy. */
function compareEntity(a, b, src, where) {
  const w = `${where} ${a.type} ${a.handle}`;
  assert.equal(b.type, a.type, `${w}: type`);
  assert.equal(b.layer ?? '0', (a.layer ?? '0').replace(/[<>/\\":;?*|=`]/g, '_'), `${w}: layer`);
  const ci = (e) => (typeof e.color === 'number' ? `rgb${e.color}` : Math.abs(e.colorIndex ?? 256));
  assert.equal(ci(b), ci(a), `${w}: colour`);
  const lw = (e, s) => { const v = lineweightToMm(e.lineweight, s); return v < 0 ? v : Math.round(v * 100); };
  if (lw(a, src) >= 0) assert.ok(Math.abs(lw(b, 'dxf') - lw(a, src)) <= 30, `${w}: lineweight`);
  else assert.equal(lw(b, 'dxf'), lw(a, src), `${w}: lineweight`);
  switch (a.type) {
    case 'LINE': nearPt(b.startPoint, a.startPoint, w); nearPt(b.endPoint, a.endPoint, w); break;
    case 'CIRCLE': nearPt(b.center, a.center, w); near(b.radius, a.radius, w); break;
    case 'ARC': nearPt(b.center, a.center, w); near(b.radius, a.radius, w); angle(b.startAngle, a.startAngle, w); angle(b.endAngle, a.endAngle, w); break;
    case 'ELLIPSE': nearPt(b.center, a.center, w); near(b.axisRatio, Math.min(a.axisRatio, 1 / a.axisRatio), w); break;
    case 'LWPOLYLINE':
      assert.equal(b.vertices.length, a.vertices.length, `${w}: vertices`);
      a.vertices.forEach((v, i) => { nearPt(b.vertices[i], v, `${w} v${i}`); near(b.vertices[i].bulge, v.bulge || 0, `${w} bulge${i}`); });
      assert.equal(b.flag & 1, a.flag & 1, `${w}: closed`);
      break;
    case 'POLYLINE2D': case 'POLYLINE3D': {
      const va = a.vertices.filter((v) => !((v.flag ?? 0) & 16));
      assert.equal(b.vertices.length, va.length, `${w}: vertices`);
      va.forEach((v, i) => nearPt(b.vertices[i], v, `${w} v${i}`));
      break;
    }
    case 'SPLINE': {
      const pa = a.controlPoints?.length ? a.controlPoints : a.fitPoints;
      const pb = b.controlPoints?.length ? b.controlPoints : b.fitPoints;
      assert.equal(pb.length, pa.length, `${w}: points`);
      pa.forEach((p, i) => nearPt(pb[i], p, `${w} p${i}`));
      break;
    }
    case 'TEXT':
      assert.equal(b.text, String(a.text).slice(0, 255), `${w}: text`);
      nearPt(b.startPoint, a.startPoint, w); near(b.textHeight, a.textHeight, w); angle(b.rotation, a.rotation, w);
      assert.equal(b.halign ?? 0, a.halign ?? 0, `${w}: halign`); assert.equal(b.valign ?? 0, a.valign ?? 0, `${w}: valign`);
      break;
    case 'MTEXT':
      assert.equal(b.text, String(a.text).replace(/\r\n|\r|\n/g, '\\P'), `${w}: text`);
      nearPt(b.insertionPoint, a.insertionPoint, w); near(b.textHeight, a.textHeight, w);
      break;
    case 'INSERT':
      nearPt(b.insertionPoint, a.insertionPoint, w); near(b.xScale ?? 1, a.xScale ?? 1, w); near(b.yScale ?? 1, a.yScale ?? 1, w); angle(b.rotation, a.rotation, w);
      assert.equal(b.attribs.length, (a.attribs ?? []).filter((x) => x.text).length, `${w}: attribs`);
      b.attribs.forEach((x, i) => assert.equal(x.text.text, a.attribs.filter((y) => y.text)[i].text.text, `${w}: attrib value`));
      break;
    case 'DIMENSION':
      nearPt(b.definitionPoint, a.definitionPoint, w);
      if (Number.isFinite(a.measurement)) near(b.measurement, a.measurement, w);
      assert.equal(b.dimensionType & 7, (a.dimensionType ?? 0) & 7, `${w}: kind`);
      break;
    case 'HATCH':
      assert.equal(b.boundaryPaths.length, a.boundaryPaths.filter((p) => (p.vertices ? p.vertices.length >= 2 : p.edges?.length)).length, `${w}: paths`);
      assert.equal(b.solidFill === 1, a.solidFill === 1 || /^solid$/i.test(a.patternName || '') || a.gradientFlag === 1, `${w}: solid`);
      break;
    case 'SOLID': case 'TRACE': case '3DFACE': nearPt(b.corner1, a.corner1, w); nearPt(b.corner3, a.corner3, w); break;
    case 'POINT': nearPt(b.position, a.position, w); break;
    case 'LEADER': a.vertices.forEach((v, i) => nearPt(b.vertices[i], v, `${w} v${i}`)); break;
    case 'VIEWPORT': nearPt(b.viewportCenter, a.viewportCenter, w); near(b.width, a.width, w); near(b.height, a.height, w); break;
    case 'XLINE': case 'RAY': nearPt(b.firstPoint, a.firstPoint, w); nearPt(b.unitDirection, a.unitDirection, w); break;
  }
}

/** Compares two entity lists (one space or block). Converted and skipped types are counted apart. */
function compareList(listA, listB, src, where) {
  const plain = listA.filter((e) => !CONVERTED.has(e.type) && !SKIPPED(e.type));
  const typesB = {};
  for (const e of listB) typesB[e.type] = (typesB[e.type] || 0) + 1;
  const typesA = {};
  for (const e of plain) typesA[e.type] = (typesA[e.type] || 0) + 1;
  for (const [t, n] of Object.entries(typesA)) {
    const extra = { LWPOLYLINE: 'MLINE MULTILEADER IMAGE', INSERT: 'ACAD_TABLE ARC_DIMENSION LARGE_RADIAL_DIMENSION', SOLID: 'MULTILEADER', LINE: 'MULTILEADER', MTEXT: 'MULTILEADER' }[t];
    if (extra) assert.ok((typesB[t] || 0) >= n, `${where}: ${t} count ${typesB[t]} < ${n}`);
    else assert.equal(typesB[t] || 0, n, `${where}: ${t} count`);
  }
  // The writer keeps valid, unique handles: match by handle, else by order within the type.
  const byHandle = new Map();
  for (const e of listB) if (!byHandle.has(e.handle)) byHandle.set(e.handle, e);
  const used = new Set();
  const queue = new Map();
  for (const e of listB) { if (!queue.has(e.type)) queue.set(e.type, []); queue.get(e.type).push(e); }
  for (const e of plain) {
    let twin = byHandle.get(e.handle?.toUpperCase());
    if (!twin || twin.type !== e.type || used.has(twin)) {
      const q = queue.get(e.type) ?? [];
      while (q.length && used.has(q[0])) q.shift();
      twin = q.shift();
    }
    if (!twin) continue;
    used.add(twin);
    compareEntity(e, twin, src, where);
  }
  return plain.length;
}

let failed = 0;
for (const file of files) {
  const name = path.basename(file);
  try {
    const t0 = performance.now();
    const a = await load(file);
    const { text, report } = writeDxf(a);
    const dt = performance.now() - t0;
    if (outDir) fs.writeFileSync(path.join(outDir, name.replace(/\.[^.]+$/, '') + `.${path.extname(name).slice(1)}.out.dxf`), text);
    const b = buildDrawing(parseDxf(new TextEncoder().encode(text).buffer), 'dxf', name);
    assert.deepEqual(b.warnings, [], 'complete file');
    let n = compareList(a.modelEntities, b.modelEntities, a.source, 'model');
    // Layouts by name.
    for (const la of a.layouts) {
      const lb = b.layouts.find((l) => l.name === la.name);
      assert.ok(lb, `layout ${la.name} present`);
      n += compareList(la.entities, lb.entities, a.source, `layout ${la.name}`);
    }
    // Blocks: named blocks keep their names; anonymous ones are compared by content where the name is kept.
    for (const [bname, blk] of a.blocks) {
      if (/^\*(model|paper)_space/i.test(bname)) continue;
      const other = b.blocks.get(bname);
      if (!other) { assert.ok(bname.startsWith('*') || /[<>/\\":;?*|=`]/.test(bname), `block ${bname} kept`); continue; }
      n += compareList(blk.entities, other.entities, a.source, `block ${bname}`);
    }
    // The drawing looks the same: scene extents of model space.
    const sa = buildScene(a, a.modelEntities), sb = buildScene(b, b.modelEntities, { origin: sa.origin });
    const span = Math.max(sa.bbox[2] - sa.bbox[0], sa.bbox[3] - sa.bbox[1], 1);
    sa.bbox.forEach((v, i) => assert.ok(Math.abs(v - sb.bbox[i]) <= span * 1e-6, `scene extents ${sa.bbox} vs ${sb.bbox}`));
    console.log('  ok', name, `${dt.toFixed(0)} ms`, `${report.written} written, ${n} compared`, report.summary() ? `(${report.summary()})` : '');
  } catch (err) {
    failed++;
    console.log('FAIL', name, '\n    ', err.message);
  }
}
console.log(`${files.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
