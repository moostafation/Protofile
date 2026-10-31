// Tests for the DGN V7 and HP-GL readers and the format registry. Usage: node tests/formats.test.mjs
// Fixtures: tests/fixtures (smalltest.dgn and test_dgnv8.dgn come from GDAL's autotest data, MIT/X
// licence; the others are written by tests/make_format_fixtures.py).
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { parseDgn } from '../src/formats/dgn.js';
import { parseHpgl } from '../src/formats/hpgl.js';
import { FormatError } from '../src/formats/errors.js';
import { formatFor, resolveFormat, acceptAttribute, openableExtensions, FORMATS } from '../src/formats/registry.js';
import { buildDrawing } from '../src/cad/drawing.js';
import { buildScene, STROKE, TEXT, FILL } from '../src/cad/scene.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => {
  const buf = fs.readFileSync(path.join(here, 'fixtures', name));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
};
const bytes = (s) => new TextEncoder().encode(s).buffer;
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);
const byType = (db, type) => db.entities.filter((e) => e.type === type);

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok', name);
  } catch (err) {
    failed++;
    console.log('FAIL', name, '\n    ', err.message);
  }
}

/** Builds the scene like the app does and checks it is drawable. */
function scene(db, source) {
  const drawing = buildDrawing(db, source, 'test');
  const s = buildScene(drawing, drawing.modelEntities);
  assert.ok(s.prims.length > 0, 'scene has primitives');
  assert.ok(s.prims.every((p) => p.infinite || p.bb.every(Number.isFinite)), 'finite bounding boxes');
  return { drawing, scene: s };
}

console.log('DGN');
test('GDAL smalltest.dgn matches ogrinfo', () => {
  const db = parseDgn(fixture('smalltest.dgn'));
  const [text] = byType(db, 'TEXT');
  assert.equal(text.text, 'Demo Text');
  near(text.startPoint.x, 0.7365); near(text.startPoint.y, 4.2198); near(text.textHeight, 1, 1e-5);
  const [circle] = byType(db, 'CIRCLE');
  near(circle.center.x, 5.0082); near(circle.center.y, 4.5835); near(circle.radius, 4.6796, 1e-4);
  const shape = byType(db, 'LWPOLYLINE')[0];
  assert.equal(shape.flag & 1, 1);
  assert.equal(shape.color, 0xb40000, 'default palette colour 83');
  assert.equal(byType(db, 'HATCH').length, 1, 'shape fill linkage');
  const [line] = byType(db, 'LINE');
  near(line.startPoint.x, 2.5562); near(line.endPoint.y, 6.0709);
  assert.deepEqual(db.tables.LAYER.entries.map((l) => l.name), ['Level 1', 'Level 2']);
  scene(db, 'dgn');
});

test('plant-v7.dgn: elements, cells, colour table, units', () => {
  const db = parseDgn(fixture('plant-v7.dgn'));
  assert.equal(db.header.INSUNITS, 6, 'master units m');
  assert.equal(db.header.ACADVER, 'V7 2D');
  // Colour table element overrides the defaults (colour 1 = orange).
  assert.equal(byType(db, 'LWPOLYLINE').find((e) => e.layer === 'Level 11').color, 0xff8c00);
  // Deleted line is skipped: only two lines on level 10, the second with style 2.
  const lines = byType(db, 'LINE');
  assert.equal(lines.length, 2);
  assert.equal(lines[1].lineType, 'DGN_STYLE_2');
  assert.ok(lines[0].lineweight > 0, 'weight -> lineweight');
  // Arc 0..90° around (6,4) r=1.
  const arc = byType(db, 'ARC')[0];
  near(arc.center.x, 6); near(arc.radius, 1); near(arc.startAngle, 0); near(arc.endAngle, Math.PI / 2);
  // Elliptical arcs: rotated, and one with the secondary axis longer and a negative sweep.
  const ells = byType(db, 'ELLIPSE');
  assert.equal(ells.length, 3);
  near(Math.atan2(ells[0].majorAxisEndPoint.y, ells[0].majorAxisEndPoint.x), Math.PI / 6);
  near(Math.hypot(ells[1].majorAxisEndPoint.x, ells[1].majorAxisEndPoint.y), 1);
  near(ells[1].axisRatio, 0.5);
  const [curve, bspline] = byType(db, 'SPLINE');
  assert.equal(curve.fitPoints.length, 4, 'curve element: interior vertices');
  assert.equal(bspline.degree, 3);
  assert.deepEqual(bspline.controlPoints.map((p) => [p.x, p.y]), [[0.5, 3.5], [1, 5], [1.5, 3.5], [2, 5]]);
  // Complex chain line+arc+linestring becomes one open polyline; complex shape closed + filled.
  const chain = byType(db, 'LWPOLYLINE').find((e) => e.layer === 'Level 23');
  assert.equal(chain.flag & 1, 0);
  near(chain.vertices[0].x, 1); near(chain.vertices.at(-1).x, 3);
  assert.ok(chain.vertices.length > 6, 'arc member tessellated');
  const cshape = byType(db, 'LWPOLYLINE').find((e) => e.layer === 'Level 24');
  assert.equal(cshape.flag & 1, 1);
  assert.equal(byType(db, 'HATCH').length, 2, 'filled ellipse and complex shape');
  // Cells -> block references sharing a display name.
  const inserts = byType(db, 'INSERT');
  assert.deepEqual(inserts.map((e) => e.name), ['VALVE', 'VALVE', 'PUMP']);
  assert.equal(new Set(inserts.map((e) => e.blockName)).size, 3);
  const pump = db.tables.BLOCK_RECORD.entries.find((b) => b.name === inserts[2].blockName);
  assert.deepEqual(pump.entities.map((e) => e.type), ['CIRCLE', 'TEXT']);
  // Text node members and a rotated text.
  const texts = byType(db, 'TEXT').map((e) => e.text);
  assert.deepEqual(texts, ['PLANT ROOM', 'CHW PUMPS', 'CHWS 150']);
  near(byType(db, 'TEXT')[2].rotation, Math.PI / 6);
  assert.equal(byType(db, 'POINT').length, 1, 'zero-length line is a point');
  const { scene: s, drawing } = scene(db, 'dgn');
  assert.ok(s.warnings.includes('DGN_DIM'), 'dimension reported as unsupported');
  assert.equal(s.insertCounts.get('VALVE'), 2);
  const valve = s.items.find((it) => it.type === 'INSERT');
  assert.ok(s.prims.slice(valve.first, valve.last).some((p) => p.k === STROKE), 'cell members drawn');
  assert.ok(s.prims.some((p) => p.k === TEXT && p.lines[0].s === 'P-1'), 'text inside cell drawn');
  assert.ok(drawing.layers.has('Level 30'));
});

test('test3d-v7.dgn: 3D file, quaternion rotations, plan projection', () => {
  const db = parseDgn(fixture('test3d-v7.dgn'));
  assert.equal(db.header.ACADVER, 'V7 3D');
  const [line] = byType(db, 'LINE');
  near(line.endPoint.x, 10); near(line.endPoint.z, 3);
  const [arc] = byType(db, 'ARC');
  near(arc.startAngle, Math.PI / 6, 1e-6);
  near(arc.endAngle, (150 * Math.PI) / 180, 1e-6);
  const tilted = byType(db, 'LWPOLYLINE').find((e) => e.layer === 'Level 3');
  const ys = tilted.vertices.map((v) => v.y);
  near(Math.min(...ys), 2.5, 1e-3); near(Math.max(...ys), 3.5, 1e-3);
  near(byType(db, 'TEXT')[0].rotation, Math.PI / 12, 1e-6);
  assert.deepEqual(byType(db, 'INSERT').map((e) => e.name), ['NOZZLE']);
  scene(db, 'dgn');
});

test('DGN V8 is detected with a friendly hint', () => {
  assert.throws(() => parseDgn(fixture('test_dgnv8.dgn')), (err) => err instanceof FormatError && err.hint === 'dgnV8');
});

test('Damaged and foreign files fail cleanly', () => {
  assert.throws(() => parseDgn(bytes('not a design file')), FormatError);
  const full = fixture('plant-v7.dgn');
  const db = parseDgn(full.slice(0, Math.floor(full.byteLength * 0.6))); // keeps what could be read
  assert.ok(db.entities.length > 3 && db.entities.length < parseDgn(full).entities.length);
  assert.throws(() => parseDgn(full.slice(0, 2000)), FormatError, 'settings only, nothing to draw');
});

console.log('HP-GL');
test('plot-hpgl1.plt: pens, circle, arcs, relative moves, labels, line types', () => {
  const db = parseHpgl(fixture('plot-hpgl1.plt'));
  assert.equal(db.header.INSUNITS, 4);
  const polys = byType(db, 'LWPOLYLINE');
  assert.equal(polys[0].flag & 1, 1, 'closed border');
  near(polys[0].vertices[1].x, 200); near(polys[0].vertices[2].y, 150);
  const [circle] = byType(db, 'CIRCLE');
  near(circle.center.x, 125); near(circle.radius, 20);
  assert.equal(circle.layer, 'PEN 2');
  assert.equal(circle.lineweight, 50, 'PW 0.5 mm on pen 2');
  const arc = polys.find((p) => p.vertices[0].bulge);
  near(arc.vertices[0].bulge, -Math.tan(Math.PI / 8)); near(arc.vertices[1].y, 100);
  const rel = polys.find((p) => p.vertices[0].x === 130);
  near(rel.vertices[3].y, 117.5);
  assert.ok(polys.some((p) => p.lineType && p.layer === 'PEN 3'), 'LT dashed line');
  const [l1, l2] = byType(db, 'TEXT');
  assert.equal(l1.text, 'PLANT ROOM HPGL'); near(l1.textHeight, 6);
  assert.equal(l2.text, 'RISER'); near(l2.rotation, Math.PI / 2);
  const layer2 = db.tables.LAYER.entries.find((l) => l.name === 'PEN 2');
  assert.equal(layer2.color, 0xff0000);
  scene(db, 'hpgl');
});

test('plot-hpgl2-pcl.plt: PCL wrapper, PE encoding, PC colours, DT terminator', () => {
  const db = parseHpgl(fixture('plot-hpgl2-pcl.plt'));
  assert.equal(db.header.ACADVER, 'HP-GL/2');
  const pe = byType(db, 'LWPOLYLINE').find((p) => p.layer === 'PEN 3');
  assert.deepEqual(pe.vertices.map((v) => [v.x, v.y]), [[50, 50], [150, 50], [150, 100], [50, 100]]);
  assert.equal(pe.flag & 1, 1);
  assert.equal(db.tables.LAYER.entries.find((l) => l.name === 'PEN 3').color, 0x00a0ff);
  assert.equal(byType(db, 'TEXT')[0].text, 'HPGL2 PCL');
  near(byType(db, 'CIRCLE')[0].radius, 12.5);
  scene(db, 'hpgl');
});

test('Space separators, scaling, polygon fill, three-point arc, 7-bit PE', () => {
  const db = parseHpgl(bytes('IN;IP 0 0 4000 4000;SC 0 100 0 100;SP1;PU 10 10;PD 90 10 90 90;PU;'
    + 'PM0;PU 0 0;PD 50 0 50 50 0 50;PM2;FP;'
    + 'PU 0 0;PD;AT 50 50 100 0;PU;'
    + 'PE7<=__s_;'));
  const polys = byType(db, 'LWPOLYLINE');
  near(polys[0].vertices[0].x, 10); near(polys[0].vertices[2].y, 90); // 4000 plu / 100 units = 1 mm per unit
  const [fill] = byType(db, 'HATCH');
  assert.equal(fill.solidFill, 1);
  assert.equal(fill.boundaryPaths[0].vertices.length, 4);
  const at = polys.find((p) => p.vertices.some((v) => v.bulge));
  near(at.vertices.at(-1).x, 100); near(at.vertices.at(-1).y, 0);
  assert.ok(polys.some((p) => JSON.stringify(p.vertices.map((v) => [v.x, v.y])) === '[[0,0],[10,0]]'), '7-bit PE line');
  scene(db, 'hpgl');
});

test('Binary or empty input is rejected', () => {
  assert.throws(() => parseHpgl(new Uint8Array([0, 1, 2, 3, 0, 0, 5, 80, 68, 0, 0, 0, 0]).buffer), FormatError);
  assert.throws(() => parseHpgl(bytes('IN;SP1;')), FormatError);
});

console.log('Registry');
test('extensions, sniffing and unsupported formats', () => {
  assert.equal(formatFor('Plan.DWT').id, 'dwg');
  assert.equal(formatFor('std.dws').id, 'dwg');
  assert.equal(formatFor('a.dgn').id, 'dgn');
  assert.equal(formatFor('plot.hp2').id, 'hpgl');
  assert.equal(formatFor('scan.TIF').id, 'tiff');
  assert.equal(formatFor('model.rvt').category, 'unsupported');
  assert.equal(formatFor('noext'), null);
  assert.equal(resolveFormat('print.plt', new TextEncoder().encode('%PDF-1.7')).id, 'pdf');
  assert.equal(resolveFormat('drawing', new Uint8Array([0x08, 0x09, 0xfe, 0x02])).id, 'dgn');
  assert.equal(resolveFormat('model.rvt', new TextEncoder().encode('%PDF')).id, 'revit');
  const accept = acceptAttribute().split(',');
  for (const e of ['.dwg', '.dwt', '.dgn', '.plt', '.pdf', '.svg', '.tiff', '.rvt']) assert.ok(accept.includes(e), e);
  for (const f of FORMATS) assert.ok(f.open || f.hint, `${f.id} has a loader or a hint`);
});

test('manifest file_handlers list exactly the openable extensions', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(here, '..', 'public', 'manifest.webmanifest'), 'utf8'));
  const listed = new Set(manifest.file_handlers.flatMap((h) => Object.values(h.accept).flat()).map((e) => e.slice(1)));
  assert.deepEqual([...listed].sort(), [...new Set(openableExtensions())].sort());
});

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
