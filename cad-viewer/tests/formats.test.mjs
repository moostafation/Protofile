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
import { parseDxf } from '../src/cad/dxf-parser.js';
import { buildScene, STROKE, TEXT, FILL } from '../src/cad/scene.js';
import { readDwg } from '../src/cad/dwg-read.js';
import { imageDpi } from '../src/formats/image-meta.js';
import { colorCss, relativeLuminance } from '../src/render/cad-renderer.js';
import { aciToRgb } from '../src/cad/aci.js';

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

test('HP-GL review fixes: pen colours, clamps, RO, IP/SC, wedges, labels', () => {
  const colors = parseHpgl(bytes('IN;PC10,255,0,0;SP10;PU0,0;PD400,0;PC10,0,0,255;PU0,400;PD400,400;PU;'));
  assert.deepEqual(byType(colors, 'LWPOLYLINE').map((e) => e.color), [0xff0000, 0x0000ff], 'colour fixed when drawn, pens 8+ use PC');
  assert.equal(colors.tables.LAYER.entries[0].color, 0xff0000);
  const huge = parseHpgl(bytes('IN;SP1;PU0,0;EW100,0,36000000;PU100,0;PD;AA0,0,3600000;PU;'));
  assert.ok(huge.entities.every((e) => (e.vertices?.length ?? 0) < 200), 'sweeps clamped to 360°');
  const ro = parseHpgl(bytes('IN;RO90;SP1;PU0,0;PD400,0;'));
  near(byType(ro, 'LWPOLYLINE')[0].vertices[1].x, 0); near(byType(ro, 'LWPOLYLINE')[0].vertices[1].y, 10);
  const ip = parseHpgl(bytes('IN;IP0,0,4000,4000;SC0,100,0,100;IP1000,1000;PU0,0;PD100,100;'));
  assert.deepEqual(byType(ip, 'LWPOLYLINE')[0].vertices.map((v) => [v.x, v.y]), [[25, 25], [125, 125]], 'IP moves P2 with P1 and SC follows');
  const wedge = parseHpgl(bytes('IN;SP1;PU0,0;EW-100,0,90;'));
  near(byType(wedge, 'LWPOLYLINE')[0].vertices[1].x, -2.5);
  const pen0 = parseHpgl(bytes('IN;SI0.19,0.27;SP0;PU0,0;LBABC\x03SP1;PD400,0;'));
  near(byType(pen0, 'LWPOLYLINE')[0].vertices[0].x, 8.55, 1e-9);
  const labels = parseHpgl(bytes('IN;SP1;' + 'PU0,0;LBA\x03'.repeat(200)));
  assert.equal(byType(labels, 'TEXT').length, 200, 'label terminators are not treated as binary data');
  assert.equal(parseHpgl(fixture('plot-hpgl1.plt')).header.ACADVER, 'HP-GL');
});

console.log('DGN review fixes');
test('closed B-spline is periodic and closed; deep cell nesting is flattened', () => {
  const tcb = new Uint8Array(1536); tcb.set([0x08, 0x09, 0xfe, 0x02]);
  const elem = (type, body, complex) => {
    const b = [...body]; if (b.length % 2) b.push(0);
    const size = 36 + b.length, h = new Array(36).fill(0);
    h[0] = 1 | (complex ? 0x80 : 0); h[1] = type; h[2] = ((size - 4) / 2) & 255; h[3] = (size - 4) >> 9;
    h[30] = ((36 + b.length - 32) / 2) & 255;
    return [...h, ...b];
  };
  const i32 = (v) => [(v >>> 16) & 255, (v >>> 24) & 255, v & 255, (v >>> 8) & 255];
  const poles = [[0, 0], [1000, 0], [1000, 1000], [0, 1000]];
  const spline = [...elem(27, [0, 0, 0, 0, 0x82, 0, 4, 0, 0, 0]), ...elem(21, [4, 0, ...poles.flatMap(([x, y]) => [...i32(x), ...i32(y)])], true)];
  const db = parseDgn(new Uint8Array([...tcb, ...spline, 0xff, 0xff]).buffer);
  const [sp] = byType(db, 'SPLINE');
  assert.equal(sp.flag & 1, 1);
  assert.equal(sp.controlPoints.length, 7);
  assert.equal(sp.knots.length, 11);
  const { scene: s } = scene(db, 'dgn');
  const p = s.prims[0];
  assert.ok(p.closed, 'closed stroke');
  near(p.pts[0], p.pts[p.pts.length - 2], 1e-6); near(p.pts[1], p.pts[p.pts.length - 1], 1e-6);
  // 3000 nested cells (each claiming a huge length) must not overflow the stack.
  const cell = (complex) => { const c = elem(2, new Array(56).fill(0), complex); c[36] = 0xff; c[37] = 0xff; return c; };
  const parts = [...tcb, ...cell(false)];
  for (let i = 0; i < 3000; i++) parts.push(...cell(true));
  parts.push(...elem(3, [...i32(0), ...i32(0), ...i32(10), ...i32(10)], true), 0xff, 0xff);
  const nested = parseDgn(new Uint8Array(parts).buffer);
  assert.equal(nested.entities.length, 1);
  scene(nested, 'dgn');
});

console.log('DXF review fixes');
test('DXF sniffing, missing sections and truncation', () => {
  const dxf = '  0\nSECTION\n  2\nENTITIES\n  0\nLINE\n  8\n0\n 10\n0\n 20\n0\n 11\n10\n 21\n0\n  0\nENDSEC\n  0\nEOF\n';
  const enc = (s) => new TextEncoder().encode(s);
  assert.equal(resolveFormat('plan.dwg', enc(dxf)).id, 'dxf', 'DXF named .dwg');
  assert.equal(resolveFormat('noext', enc('999\ncomment\n' + dxf)).id, 'dxf');
  assert.equal(resolveFormat('plot.plt', enc(dxf)).id, 'dxf');
  assert.deepEqual(parseDxf(enc(dxf).buffer).warnings, []);
  const cut = parseDxf(enc(dxf.slice(0, dxf.indexOf('  0\nENDSEC'))).buffer);
  assert.deepEqual(cut.warnings, ['truncated']);
  assert.equal(cut.entities.length, 1, 'what was read is kept');
  assert.throws(() => parseDxf(enc('just some text\n').buffer), FormatError);
  assert.throws(() => parseDxf(new ArrayBuffer(0)), FormatError);
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
  assert.equal(resolveFormat('drawing.png', new TextEncoder().encode('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>')).id, 'svg');
  const accept = acceptAttribute().split(',');
  for (const e of ['.dwg', '.dwt', '.dgn', '.plt', '.pdf', '.svg', '.tiff', '.rvt']) assert.ok(accept.includes(e), e);
  for (const f of FORMATS) assert.ok(f.open || f.hint, `${f.id} has a loader or a hint`);
});

test('manifest file_handlers list exactly the openable extensions', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(here, '..', 'public', 'manifest.webmanifest'), 'utf8'));
  const listed = new Set(manifest.file_handlers.flatMap((h) => Object.values(h.accept).flat()).map((e) => e.slice(1)));
  assert.deepEqual([...listed].sort(), [...new Set(openableExtensions())].sort());
});

test('desktop file associations (src-tauri/tauri.conf.json) list exactly the openable extensions', () => {
  const conf = JSON.parse(fs.readFileSync(path.join(here, '..', 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const assoc = conf.bundle.fileAssociations;
  const exts = assoc.flatMap((a) => a.ext);
  assert.equal(new Set(exts).size, exts.length, 'no extension is associated twice');
  assert.deepEqual([...exts].sort(), [...new Set(openableExtensions())].sort());
  // Windows uses `name` as the registry class (ProgID) and `description` in Explorer; Linux needs a MIME type.
  for (const a of assoc) {
    assert.match(a.name, /^ProtoCAD\.[A-Z]+$/, `${a.ext} has a ProtoCAD class name`);
    assert.ok(a.description && a.mimeType, `${a.ext} has a description and a MIME type`);
  }
});

console.log('Robustness and display');
test('DGN: deeply chained text nodes do not overflow the stack', () => {
  const tcb = new Uint8Array(1536); tcb.set([0x08, 0x09, 0xfe, 0x02]);
  const node = (complex) => { const c = new Uint8Array(80); c[0] = 1 | (complex ? 0x80 : 0); c[1] = 7; c[2] = 38; c[30] = 24; c[38] = 1; return c; };
  const line = () => { const c = new Uint8Array(52); c[0] = 1 | 0x80; c[1] = 3; c[2] = 24; c[30] = 8; c[38] = 1; return c; };
  const parts = [tcb, node(false), ...Array.from({ length: 50000 }, () => node(true)), line()];
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0) + 2);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  out.set([0xff, 0xff], o);
  assert.doesNotThrow(() => parseDgn(out.buffer));
});

test('HP-GL: a zero character size falls back to the default (label stays visible)', () => {
  const db = parseHpgl(bytes('IN;SP1;PU0,0;PD400,0;PU0,0;SI0.2,0;LBABC\x03;SR0,0;LBDEF\x03'));
  const texts = byType(db, 'TEXT');
  assert.equal(texts.length, 2);
  for (const t of texts) assert.ok(Number.isFinite(t.xScale) && t.xScale > 0 && t.textHeight > 0, JSON.stringify(t));
});

test('DWG: critical LibreDWG errors fail unless the file still has drawing objects', () => {
  const stub = (error, entities, data = {}) => ({
    wasmInstance: { FS: { writeFile() {}, analyzePath: () => ({ exists: false }), unlink() {} }, dwg_read_file: () => ({ error, data }) },
    convert: () => ({ entities }),
    dwg_free() {},
  });
  assert.deepEqual(readDwg(stub(256, [{ type: 'LINE' }]), new ArrayBuffer(8)).warnings, ['dwgErrors']);
  assert.equal(readDwg(stub(68, [{ type: 'LINE' }]), new ArrayBuffer(8)).warnings, undefined, 'non-critical bits are not reported');
  assert.throws(() => readDwg(stub(256, []), new ArrayBuffer(8)), /section not found/);
  assert.throws(() => readDwg(stub(2048, [], null), new ArrayBuffer(8)), /not a valid DWG/);
});

test('layouts with nothing but the overall paper viewport get no tab', () => {
  const vp = (id) => ({ type: 'VIEWPORT', viewportId: id, viewportCenter: { x: 0, y: 0 }, width: 10, height: 10 });
  const db = {
    tables: { BLOCK_RECORD: { entries: [
      { name: '*Model_Space', handle: '1F', entities: [{ type: 'LINE', layer: '0', startPoint: { x: 0, y: 0 }, endPoint: { x: 1, y: 1 } }] },
      { name: '*Paper_Space', handle: '20', entities: [vp(1)] },
      { name: '*Paper_Space0', handle: '21', entities: [vp(1), vp(2)] },
    ] } },
    objects: { LAYOUT: [{ layoutName: 'Layout1', paperSpaceTableId: '20', tabOrder: 1 }, { layoutName: 'Layout2', paperSpaceTableId: '21', tabOrder: 2 }] },
  };
  assert.deepEqual(buildDrawing(db, 'dwg', 'x').layouts.map((l) => l.name), ['Layout2']);
});

test('image resolution: per-axis DPI from PNG pHYs and JPEG JFIF', () => {
  const png = new Uint8Array(8 + 21);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const dv = new DataView(png.buffer);
  dv.setUint32(8, 9); png.set([...'pHYs'].map((c) => c.charCodeAt(0)), 12);
  dv.setUint32(16, 8031); dv.setUint32(20, 3858); png[24] = 1; // 204 × 98 dpi in dots per metre
  const d = imageDpi('PNG', png);
  near(d.x, 204, 0.05); near(d.y, 98, 0.05);
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, ...[...'JFIF\0'].map((c) => c.charCodeAt(0)), 1, 1, 1, 0, 72, 0, 72, 0, 0]);
  assert.deepEqual(imageDpi('JPEG', jpg), { x: 72, y: 72 });
});

test('light theme: every ACI colour has at least 3:1 contrast against white', () => {
  const theme = { bg: '#ffffff', fg: '#000000', mono: false };
  for (let i = 1; i < 256; i++) {
    const rgb = aciToRgb(i);
    if (rgb < 0) continue;
    const [r, g, b] = colorCss(rgb, theme).match(/\d+/g).map(Number);
    const contrast = 1.05 / (relativeLuminance((r << 16) | (g << 8) | b) + 0.05);
    assert.ok(contrast >= 3, `ACI ${i}: ${contrast.toFixed(2)}`);
  }
});

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
