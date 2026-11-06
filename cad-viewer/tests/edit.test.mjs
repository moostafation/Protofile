// Editing tests: undo/redo, transforms of every entity type, offset, explode, layers,
// typed coordinates, incremental scene updates (compared with a full rebuild) and saving
// edited drawings as DXF. Usage: node tests/edit.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { parseDxf } from '../src/cad/dxf-parser.js';
import { buildDrawing } from '../src/cad/drawing.js';
import { buildScene, updateScene, compactScene, STROKE } from '../src/cad/scene.js';
import { PickIndex } from '../src/tools/pick.js';
import { analyze } from '../src/tools/analysis.js';
import { EditDoc } from '../src/edit/model.js';
import * as ops from '../src/edit/ops.js';
import {
  moveMatrix, rotateMatrix, scaleMatrix, mirrorMatrix, makeLine, makeLwPolyline, makeCircle, makeArc, makeText,
  makeRectangle, makeRevisionCloud, arcFrom3, gripsOf, offsetEntity, bulgeArc, transformEntity,
} from '../src/edit/entities.js';
import { parsePoint, parseNumber, orthoPoint } from '../src/tools/cmdline.js';
import { writeDxf } from '../src/cad/dxf-writer.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const sample = () => {
  const buf = fs.readFileSync(path.join(here, '../public/samples/plant.dxf'));
  return buildDrawing(parseDxf(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)), 'dxf', 'plant.dxf');
};
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b)), `${a} ≉ ${b}`);
const strip = (v) => JSON.stringify(v, (k, x) => (typeof x === 'number' ? +x.toFixed(6) : x));

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok', name);
  } catch (err) {
    failed++;
    console.log('FAIL', name, '\n    ', err.stack.split('\n').slice(0, 3).join('\n     '));
  }
}

function setup() {
  const d = sample();
  const doc = new EditDoc(d);
  const ctx = { doc, drawing: d, container: d.modelEntities };
  const env = { doc, drawing: d, layer: '0' };
  return { d, doc, ctx, env };
}

console.log('Edit model');
test('undo/redo restore entities exactly, modified flag follows the save point', () => {
  const { d, doc, ctx, env } = setup();
  const before = strip(d.modelEntities);
  assert.equal(doc.modified, false);
  ops.addEntities(ctx, [makeLine(env, [0, 0], [100, 0])]);
  assert.equal(doc.modified, true);
  doc.markSaved();
  assert.equal(doc.modified, false);
  ops.transformEntities(ctx, [...d.modelEntities], rotateMatrix(10, 10, 1), 'Rotate');
  ops.eraseEntities(ctx, d.modelEntities.slice(0, 5));
  assert.equal(doc.modified, true);
  doc.undo(); doc.undo();
  assert.equal(doc.modified, false, 'back at the save point');
  doc.undo();
  assert.equal(strip(d.modelEntities), before);
  doc.redo(); doc.redo(); doc.redo();
  assert.equal(d.modelEntities.length, 28);
  assert.equal(doc.canRedo, false);
});

test('new entities get fresh unique handles', () => {
  const { d, doc, ctx, env } = setup();
  const used = new Set();
  const all = [...d.modelEntities, ...[...d.blocks.values()].flatMap((b) => b.entities)];
  for (const e of all) used.add(e.handle);
  const made = ops.addEntities(ctx, [makeLine(env, [0, 0], [1, 1]), makeCircle(env, [0, 0], 5)]);
  const copies = ops.copyEntities(ctx, d.modelEntities.filter((e) => e.type === 'INSERT'), moveMatrix(10, 0));
  for (const e of [...made, ...copies, ...copies.flatMap((c) => c.attribs ?? [])]) {
    assert.ok(/^[0-9A-F]+$/.test(e.handle) && !used.has(e.handle), `handle ${e.handle}`);
    used.add(e.handle);
  }
});

test('a failing step rolls back', () => {
  const { d, doc } = setup();
  const n = d.modelEntities.length;
  assert.throws(() => doc.run('bad', (tx) => { tx.remove(d.modelEntities, [d.modelEntities[0]]); throw new Error('boom'); }));
  assert.equal(d.modelEntities.length, n);
  assert.equal(doc.canUndo, false);
});

console.log('Transforms');
test('move/rotate/scale/mirror every type and back (inverse matrices)', () => {
  const { d, ctx } = setup();
  const ents = [...d.modelEntities];
  const before = strip(ents);
  const pairs = [
    [moveMatrix(123.5, -40), moveMatrix(-123.5, 40)],
    [rotateMatrix(500, 300, 0.6), rotateMatrix(500, 300, -0.6)],
    [scaleMatrix(10, 20, 2.5), scaleMatrix(10, 20, 1 / 2.5)],
  ];
  for (const [m, inv] of pairs) {
    assert.equal(ops.transformEntities(ctx, ents, m), 0);
    ops.transformEntities(ctx, ents, inv);
  }
  const close = (a, b, p = '') => {
    if (typeof a === 'number') { near(a, b, 1e-6); return; }
    if (a && typeof a === 'object') for (const k of Object.keys(a)) if (!['startAngle', 'endAngle', 'rotation', 'angle', 'patternAngle', 'rotationAngle'].includes(k)) close(a[k], b?.[k], p + '.' + k);
  };
  close(JSON.parse(before), JSON.parse(strip(ents)));
});

test('mirror keeps text readable and flips arcs/inserts consistently', () => {
  const { d, ctx, env } = setup();
  const t = makeText(env, [100, 100], 10, 0, 'TAG-1');
  const a = makeArc(env, [0, 0], 10, 0, Math.PI / 2);
  ops.addEntities(ctx, [t, a]);
  ops.transformEntities(ctx, [t, a], mirrorMatrix(0, 0, 0, 1), 'Mirror');
  near(Math.cos(t.rotation), 1); // still reads left to right
  assert.ok(t.startPoint.x < -100, 'text moved to the mirrored side');
  // Arc from 90° to 180° after mirroring about the Y axis.
  near(a.startAngle, Math.PI / 2); near(a.endAngle, Math.PI);
  const ins = d.modelEntities.find((e) => e.type === 'INSERT');
  const ip = { ...ins.insertionPoint };
  ops.transformEntities(ctx, [ins], mirrorMatrix(0, 0, 0, 1), 'Mirror');
  near(ins.insertionPoint.x, -ip.x);
  assert.ok(ins.xScale * ins.yScale < 0, 'mirrored block');
});

test('dimension blocks move with their dimension; copies get their own block', () => {
  const { d, ctx } = setup();
  const dim = d.modelEntities.find((e) => e.type === 'DIMENSION');
  const block = d.blocks.get(dim.name);
  const first = strip(block.entities[0]);
  ops.transformEntities(ctx, [dim], moveMatrix(1000, 0));
  assert.notEqual(strip(block.entities[0]), first);
  const [copy] = ops.copyEntities(ctx, [dim], moveMatrix(0, 500));
  assert.notEqual(copy.name, dim.name);
  assert.ok(d.blocks.has(copy.name));
  ctx.doc.undo();
  assert.ok(!d.blocks.has(copy.name), 'undo removes the copied block');
});

test('scaled dimensions show the new measurement', () => {
  const { d, ctx } = setup();
  const dims = d.modelEntities.filter((e) => e.type === 'DIMENSION');
  const texts = dims.map((dim) => d.blocks.get(dim.name).entities.find((e) => e.type === 'MTEXT' || e.type === 'TEXT'));
  assert.deepEqual(texts.map((x) => x.text), ['20000', '12000', 'R700']);
  ops.transformEntities(ctx, dims, scaleMatrix(0, 0, 2), 'Scale');
  assert.deepEqual(texts.map((x) => x.text), ['40000', '24000', 'R1400']);
  ops.transformEntities(ctx, dims, moveMatrix(10, 10));
  assert.deepEqual(texts.map((x) => x.text), ['40000', '24000', 'R1400'], 'moving keeps the value');
  ctx.doc.undo(); ctx.doc.undo();
  assert.deepEqual(texts.map((x) => x.text), ['20000', '12000', 'R700']);
});

test('hatch boundaries and pattern lines transform together', () => {
  const { d, ctx } = setup();
  const h = d.modelEntities.find((e) => e.type === 'HATCH' && e.definitionLines?.length) ?? d.modelEntities.find((e) => e.type === 'HATCH');
  const scene0 = buildScene(d, [h]);
  ops.transformEntities(ctx, [h], rotateMatrix(0, 0, Math.PI / 2), 'Rotate');
  const scene1 = buildScene(d, [h], { origin: scene0.origin });
  // A quarter turn about the scene origin's world point maps the extents.
  const o = scene0.origin;
  const [x0, y0, x1, y1] = scene0.bbox.map((v, i) => v + (i % 2 ? o.y : o.x));
  const [a0, b0, a1, b1] = scene1.bbox.map((v, i) => v + (i % 2 ? o.y : o.x));
  near(a0, -y1, 1e-3); near(a1, -y0, 1e-3); near(b0, x0, 1e-3); near(b1, x1, 1e-3);
});

console.log('Draw helpers, grips, offset, explode');
test('arc through 3 points, revision cloud, rectangle', () => {
  const arc = arcFrom3([10, 0], [0, 10], [-10, 0]);
  near(arc.radius, 10); near(arc.startAngle, 0); near(arc.endAngle, Math.PI);
  const cw = arcFrom3([-10, 0], [0, 10], [10, 0]);
  near(cw.startAngle, 0); near(cw.endAngle, Math.PI);
  const { env } = setup();
  const cloud = makeRevisionCloud(env, [0, 0], [100, 50]);
  assert.ok(cloud.vertices.length >= 20 && cloud.flag === 1 && cloud.vertices.every((v) => v.bulge > 0));
  const rect = makeRectangle(env, [5, 5], [0, 0]);
  assert.deepEqual(rect.vertices.map((v) => [v.x, v.y]), [[0, 0], [5, 0], [5, 5], [0, 5]]);
});

test('grips edit lines, circles, polylines and arcs', () => {
  const { env } = setup();
  const l = makeLine(env, [0, 0], [10, 0]);
  const [g0, , gm] = gripsOf(l);
  g0.apply(l, -5, 0);
  assert.equal(l.startPoint.x, -5);
  gm.apply(l, gm.x, 10);
  near(l.startPoint.y, 10); near(l.endPoint.y, 10);
  const c = makeCircle(env, [0, 0], 5);
  gripsOf(c)[1].apply(c, 0, 20);
  near(c.radius, 20);
  const p = makeLwPolyline(env, [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], false);
  gripsOf(p)[1].apply(p, 12, 1);
  assert.deepEqual([p.vertices[1].x, p.vertices[1].y], [12, 1]);
  const a = makeArc(env, [0, 0], 10, 0, Math.PI);
  const mid = gripsOf(a).find((g) => g.kind === 'mid');
  mid.apply(a, 0, 20);
  near(a.radius, 12.5, 1e-9);
});

test('offset lines, circles, arcs and polylines (both sides)', () => {
  const { env } = setup();
  const l = offsetEntity(makeLine(env, [0, 0], [10, 0]), 2, [5, 5]);
  near(l.startPoint.y, 2);
  const l2 = offsetEntity(makeLine(env, [0, 0], [10, 0]), 2, [5, -5]);
  near(l2.startPoint.y, -2);
  near(offsetEntity(makeCircle(env, [0, 0], 5), 1, [10, 0]).radius, 6);
  near(offsetEntity(makeCircle(env, [0, 0], 5), 1, [1, 0]).radius, 4);
  const sq = makeRectangle(env, [0, 0], [10, 10]);
  const inner = offsetEntity(sq, 1, [5, 5]);
  assert.deepEqual(inner.vertices.map((v) => [+v.x.toFixed(9), +v.y.toFixed(9)]), [[1, 1], [9, 1], [9, 9], [1, 9]]);
  const outer = offsetEntity(sq, 1, [20, 5]);
  assert.deepEqual(outer.vertices.map((v) => [+v.x.toFixed(9), +v.y.toFixed(9)]), [[-1, -1], [11, -1], [11, 11], [-1, 11]]);
  // A polyline with an arc segment: the arc keeps its bulge, its radius grows by the distance.
  const pl = makeLwPolyline(env, [{ x: 0, y: 0, bulge: 0 }, { x: 10, y: 0, bulge: 1 }, { x: 10, y: 10, bulge: 0 }, { x: 0, y: 10 }], false);
  const off = offsetEntity(pl, 1, [8, 5]);
  const arcV = off.vertices.find((v) => v.bulge === 1);
  const next = off.vertices[off.vertices.indexOf(arcV) + 1];
  near(bulgeArc(arcV, next, 1).r, 4);
});

test('explode block references, polylines and dimensions', () => {
  const { d, ctx } = setup();
  const ins = d.modelEntities.filter((e) => e.type === 'INSERT');
  const withAttr = ins.find((e) => e.attribs?.length);
  const n = d.modelEntities.length;
  const res = ops.explodeEntities(ctx, [...ins, ...d.modelEntities.filter((e) => e.type === 'LWPOLYLINE' || e.type === 'DIMENSION')]);
  assert.equal(res.skipped, 0);
  assert.ok(d.modelEntities.length > n);
  assert.ok(!d.modelEntities.some((e) => e === withAttr));
  const tagText = withAttr.attribs[0].text.text;
  assert.ok(res.created.some((e) => e.type === 'TEXT' && e.text === tagText), 'attributes become text');
  assert.ok(res.created.every((e) => e.layer !== '0' || ins.some((i) => i.layer === '0')), 'layer 0 contents take the reference layer');
  // The drawing still looks the same: same scene extents.
  const fresh = sample();
  const s0 = buildScene(fresh, fresh.modelEntities);
  const s1 = buildScene(d, d.modelEntities, { origin: s0.origin });
  s0.bbox.forEach((v, i) => near(v, s1.bbox[i], 1e-6));
  ctx.doc.undo();
  assert.equal(d.modelEntities.length, n);
});

console.log('Layers');
test('new, rename (all entities follow), colour, lock, current, delete — all undoable', () => {
  const { d, doc, ctx, env } = setup();
  doc.newLayer('PIPING-NEW', 3);
  assert.ok(d.layers.has('PIPING-NEW'));
  assert.throws(() => doc.newLayer('piping-new'), /already exists/);
  const onTarget = d.modelEntities.filter((e) => e.layer === 'TEXT').length;
  const inBlocks = [...d.blocks.values()].flatMap((b) => b.entities).filter((e) => e.layer === 'TEXT').length;
  doc.renameLayer('TEXT', 'ANNO-TEXT');
  assert.equal(d.modelEntities.filter((e) => e.layer === 'ANNO-TEXT').length, onTarget);
  assert.equal([...d.blocks.values()].flatMap((b) => b.entities).filter((e) => e.layer === 'ANNO-TEXT').length, inBlocks);
  assert.ok(!d.layers.has('TEXT'));
  doc.setLayerColor('ANNO-TEXT', 1);
  assert.equal(d.layers.get('ANNO-TEXT').rgb, 0xff0000);
  doc.setCurrentLayer('PIPING-NEW');
  assert.equal(doc.currentLayer, 'PIPING-NEW');
  assert.throws(() => doc.deleteLayer('PIPING-NEW'), /current/);
  doc.setCurrentLayer('0');
  ops.addEntities(ctx, [{ ...makeLine(env, [0, 0], [1, 1]), layer: 'PIPING-NEW' }]);
  assert.throws(() => doc.deleteLayer('PIPING-NEW'), /not empty/);
  doc.undo();
  doc.deleteLayer('PIPING-NEW');
  assert.ok(!d.layers.has('PIPING-NEW'));
  doc.setLayerLock('ANNO-TEXT', true);
  assert.equal(d.layers.get('ANNO-TEXT').locked, true);
  while (doc.undo()) { /* all the way back */ }
  assert.ok(d.layers.has('TEXT') && !d.layers.has('ANNO-TEXT') && !d.layers.has('PIPING-NEW'));
  assert.equal(d.modelEntities.filter((e) => e.layer === 'TEXT').length, onTarget);
  assert.equal(d.layers.get('TEXT').locked, false);
});

console.log('Command line');
test('typed coordinates', () => {
  assert.deepEqual(parsePoint('100,200'), [100, 200]);
  assert.deepEqual(parsePoint('@10,-5', { base: [1, 1] }), [11, -4]);
  const p = parsePoint('@100<90', { base: [0, 0] });
  near(p[0], 0, 1e-9); near(p[1], 100);
  const q = parsePoint('1500', { base: [10, 10], dir: [3, 4] });
  near(q[0], 10 + 900); near(q[1], 10 + 1200);
  assert.deepEqual(parsePoint('250', { base: [0, 0], dir: [10, 3], ortho: true }), [250, 0]);
  assert.deepEqual(parsePoint('250', { base: [0, 0], dir: [-1, -9], ortho: true }), [0, -250]);
  assert.equal(parsePoint('abc', { base: [0, 0] }), null);
  assert.equal(parseNumber(' 2.5e1 '), 25);
  assert.equal(parseNumber('1,2'), null);
  assert.deepEqual(orthoPoint([0, 0], [5, 2]), [5, 0]);
});

console.log('Incremental scene updates');
test('incremental scene, pick index and analysis match a full rebuild', () => {
  const { d, doc, ctx, env } = setup();
  const scene = buildScene(d, d.modelEntities);
  const pick = new PickIndex(scene);
  analyze(d, scene);
  doc.onChange((c) => {
    const rebuild = [], remove = [];
    for (const e of c.ents) {
      const own = doc.owner.get(e);
      if (own === d.modelEntities || (own === undefined && scene.itemOf.has(e))) rebuild.push(e);
      else if (scene.itemOf.has(e)) remove.push(e);
    }
    const r = updateScene(scene, { rebuild, remove });
    pick.update(r);
  });
  ops.addEntities(ctx, [makeLine(env, [0, 0], [5000, 5000]), makeCircle(env, [100, 100], 50)]);
  ops.transformEntities(ctx, d.modelEntities.slice(0, 10), moveMatrix(250, 0));
  ops.eraseEntities(ctx, d.modelEntities.slice(10, 14));
  ops.explodeEntities(ctx, d.modelEntities.filter((e) => e.type === 'INSERT').slice(0, 2));
  doc.undo(); doc.redo();
  const full = buildScene(d, d.modelEntities, { origin: scene.origin });
  const live = scene.items.filter((it) => !it.deleted);
  assert.equal(live.length, full.items.length);
  for (const it of live) {
    const twin = full.items[full.itemOf.get(it.ent)];
    assert.ok(twin, 'item exists in the full rebuild');
    assert.equal(it.last - it.first, twin.last - twin.first, `${it.type} primitives`);
    it.bb.forEach((v, i) => near(v, twin.bb[i], 1e-9));
  }
  const a1 = analyze(d, scene), a2 = analyze(d, full);
  assert.deepEqual(a1.layerStats.map((s) => [s.name, s.entities]).sort(), a2.layerStats.map((s) => [s.name, s.entities]).sort());
  assert.equal(a1.blocks.reduce((n, b) => n + b.count, 0), a2.blocks.reduce((n, b) => n + b.count, 0));
  // Picking finds the new line and never a deleted entity.
  const line = d.modelEntities.find((e) => e.type === 'LINE' && e.endPoint.x === 5000);
  const id = pick.pick(2500 - scene.origin.x, 2500 - scene.origin.y, 1, () => false);
  assert.equal(scene.items[id].ent, line);
  for (const it of scene.items.filter((x) => x.deleted)) assert.equal(it.last - it.first, 0);
  compactScene(scene);
  assert.ok(scene.prims.every((p) => !p.dead));
  for (const it of scene.items) for (let k = it.first; k < it.last; k++) assert.equal(scene.prims[k].item, it.id);
});

test('layer colour reaches ByLayer primitives through blocks (lc)', () => {
  const { d } = setup();
  const scene = buildScene(d, d.modelEntities);
  const layer = d.modelEntities.find((e) => e.type === 'INSERT').layer;
  assert.ok(scene.prims.some((p) => p.lc === layer && p.k === STROKE));
});

test('snaps: intersection and perpendicular', () => {
  const { d, env } = setup();
  const ents = [makeLine(env, [0, 0], [100, 100]), makeLine(env, [0, 100], [100, 0]), makeLine(env, [0, -50], [200, -50])];
  const scene = buildScene(d, ents, { origin: { x: 0, y: 0 } });
  const pick = new PickIndex(scene);
  const s1 = pick.snap(52, 49, 5, () => false, { near: false });
  assert.equal(s1.kind, 'int'); near(s1.x, 50); near(s1.y, 50);
  const s2 = pick.snap(81, -48, 5, () => false, { near: false, from: [80, 20] });
  assert.equal(s2.kind, 'perp'); near(s2.x, 80); near(s2.y, -50);
  assert.equal(pick.snap(81, -48, 5, () => false, { near: false }), null, 'no nearest snap for drawing tools');
});

console.log('Saving edits');
test('edited drawing saves as DXF and reopens with the edits', () => {
  const { d, doc, ctx, env } = setup();
  doc.newLayer('REV-1', 1);
  doc.setCurrentLayer('REV-1');
  const cloud = makeRevisionCloud({ ...env, layer: 'REV-1' }, [0, 0], [3000, 2000]);
  const text = makeText({ ...env, layer: 'REV-1' }, [100, 2100], 150, 0, 'REV A — pump moved');
  ops.addEntities(ctx, [cloud, text]);
  const valve = d.modelEntities.find((e) => e.type === 'INSERT' && e.attribs?.length);
  ops.modifyEntities(ctx, [valve], (e) => { e.attribs[0].text.text = 'DN150'; }, 'Attribute');
  ops.transformEntities(ctx, [valve], moveMatrix(500, 0));
  const { text: dxf } = writeDxf(d);
  const back = buildDrawing(parseDxf(new TextEncoder().encode(dxf).buffer), 'dxf', 'x.dxf');
  assert.equal(back.header.CLAYER, 'REV-1');
  assert.ok(back.layers.has('REV-1'));
  const bc = back.modelEntities.find((e) => e.handle === cloud.handle);
  assert.equal(bc.type, 'LWPOLYLINE');
  assert.equal(bc.vertices.length, cloud.vertices.length);
  assert.equal(back.modelEntities.find((e) => e.handle === text.handle).text, 'REV A — pump moved');
  const bv = back.modelEntities.find((e) => e.handle === valve.handle);
  assert.equal(bv.attribs[0].text.text, 'DN150');
  near(bv.insertionPoint.x, valve.insertionPoint.x);
});

test('edits in a layout are saved in that layout', () => {
  const { d, doc, env } = setup();
  const layout = d.layouts[0];
  const ctx = { doc, drawing: d, container: layout.entities };
  const [note] = ops.addEntities(ctx, [makeText(env, [20, 20], 3.5, 0, 'CHECKED BY: ENG')]);
  const back = buildDrawing(parseDxf(new TextEncoder().encode(writeDxf(d).text).buffer), 'dxf', 'x.dxf');
  const lb = back.layouts.find((l) => l.name === layout.name);
  assert.ok(lb.entities.some((e) => e.handle === note.handle && e.text === 'CHECKED BY: ENG'));
  assert.ok(!back.modelEntities.some((e) => e.handle === note.handle));
});

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
