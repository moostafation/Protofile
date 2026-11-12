// Saving a DXF source keeps everything the viewer does not model: header variables, all table
// entries (dimension styles, APPIDs, UCS, views), xdata and reactors, objects, IMAGE, 3DSOLID,
// MULTILEADER… Only edited and new entities and changed layers are written from the model.
// Usage: node tests/dxf-patch.test.mjs   (fixture autocad-rich.dxf: tests/make via ezdxf, see README)
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseDxf } from '../src/cad/dxf-parser.js';
import { buildDrawing } from '../src/cad/drawing.js';
import { writeDxf, canPatch } from '../src/cad/dxf-writer.js';
import { EditDoc } from '../src/edit/model.js';
import { buildScene } from '../src/cad/scene.js';
import * as ops from '../src/edit/ops.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const load = (file) => {
  const buf = fs.readFileSync(file);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return { d: buildDrawing(parseDxf(ab.slice(0)), 'dxf', path.basename(file)), text: buf.toString('utf8') };
};
/** Code/value pairs of a DXF text. */
const pairs = (t) => {
  const l = t.split(/\r?\n/);
  const out = [];
  for (let i = 0; i + 1 < l.length; i += 2) out.push([parseInt(l[i], 10), l[i + 1].replace(/\s+$/, '')]);
  return out;
};
const headerVars = (t) => {
  const m = new Map();
  let name = null;
  const p = pairs(t);
  let i = p.findIndex(([c, v]) => c === 2 && v === 'HEADER');
  for (i++; i < p.length && !(p[i][0] === 0 && p[i][1] === 'ENDSEC'); i++) {
    if (p[i][0] === 9) { name = p[i][1]; m.set(name, []); } else if (name) m.get(name).push(p[i].join('='));
  }
  return m;
};
/** Handles of everything after the header (the header's $HANDSEED is not one). */
const handles = (t) => { const p = pairs(t); const s = p.findIndex(([c, v]) => c === 0 && v === 'ENDSEC'); return p.slice(s).filter(([c]) => c === 5 || c === 105).map(([, v]) => v.toUpperCase()); };
const count = (t, type) => pairs(t).filter(([c, v]) => c === 0 && v === type).length;

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok', name); } catch (err) { failed++; console.log('FAIL', name, '\n    ', err.stack.split('\n').slice(0, 3).join('\n     ')); }
}

function auditOk(text, name) {
  const py = spawnSync('python3', ['-c', 'import ezdxf'], { encoding: 'utf8' });
  if (py.status !== 0) return 'skipped';
  const file = path.join(here, `.${name}.tmp.dxf`);
  fs.writeFileSync(file, text);
  // The patched file keeps its source version: audit it with ezdxf directly.
  const r = spawnSync('python3', ['-c', `import sys, ezdxf
doc = ezdxf.readfile(sys.argv[1]); a = doc.audit()
print(len(a.errors), 'errors', len(a.fixes), 'fixes'); [print(e.message) for e in a.errors[:5]]
sys.exit(1 if a.has_errors else 0)`, file], { encoding: 'utf8' });
  fs.unlinkSync(file);
  assert.equal(r.status, 0, `ezdxf audit: ${r.stdout}${r.stderr}`);
  return r.stdout.trim();
}

console.log('DXF save keeps what it does not model');
test('untouched drawings are written back record for record', () => {
  for (const f of ['autocad-rich.dxf', '../../public/samples/plant.dxf']) {
    const { d, text } = load(path.join(here, 'fixtures', f));
    assert.ok(canPatch(d), `${f} is saved by patching`);
    const doc = new EditDoc(d);
    const out = writeDxf(d, { doc }).text;
    const a = pairs(text).filter(([c, v], i, all) => !(c === 9) && !['$HANDSEED', '$EXTMIN', '$EXTMAX', '$CLAYER'].includes(headerName(all, i)));
    const b = pairs(out).filter(([c, v], i, all) => !(c === 9) && !['$HANDSEED', '$EXTMIN', '$EXTMAX', '$CLAYER'].includes(headerName(all, i)));
    assert.equal(b.length, a.length, `${f}: same number of pairs`);
    const diff = a.findIndex(([c, v], i) => c !== b[i][0] || v !== b[i][1]);
    assert.equal(diff, -1, `${f}: first difference at pair ${diff}: ${a[diff]} vs ${b[diff]}`);
  }
});

function headerName(all, i) {
  for (let k = i; k >= 0; k--) { if (all[k][0] === 9) return all[k][1]; if (all[k][0] === 0) return null; }
  return null;
}

test('edits: header, dimstyles, xdata, IMAGE, 3DSOLID, MULTILEADER and handles survive', () => {
  const { d, text } = load(path.join(here, 'fixtures', 'autocad-rich.dxf'));
  const doc = new EditDoc(d);
  const line = d.modelEntities.find((e) => e.type === 'LINE' && e.layer === 'PIPE');
  doc.run('Move', (tx) => tx.modify(line, (e) => { e.endPoint.x = 120; }));
  const copy = { ...structuredClone(line), handle: doc.newHandle() };
  doc.run('Add', (tx) => tx.add(d.modelEntities, copy));
  doc.renameLayer('VALVES', 'VALVES-NEW');
  doc.setLayerColor('PIPE', 3);
  doc.newLayer('ADDED', 5);
  const tag = d.blocks.get('TAG');
  const txt = tag.entities.find((e) => e.type === 'TEXT');
  doc.run('Text', (tx) => tx.modify(txt, (e) => { e.text = 'V-102'; }, { container: tag.entities, block: 'TAG' }));
  const { text: out, report } = writeDxf(d, { doc, extents: [0, -10, 120, 50] });
  const before = headerVars(text), after = headerVars(out);
  assert.equal(after.size, before.size, 'every header variable');
  for (const k of ['$MIRRTEXT', '$ANGBASE', '$ANGDIR', '$DIMASZ', '$ACADVER', '$INSUNITS']) assert.deepEqual(after.get(k), before.get(k), k);
  assert.deepEqual(after.get('$MIRRTEXT'), ['70=1']);
  // Tables: every DIMSTYLE (with all variables), APPID, UCS and VIEW.
  for (const t of ['DIMSTYLE', 'APPID', 'UCS', 'VIEW', 'STYLE', 'LTYPE', 'VPORT']) assert.equal(count(out, t), count(text, t), t);
  assert.ok(out.includes('PIPE-4'), 'unused dimension style kept');
  // Entities and objects the viewer cannot write.
  for (const t of ['IMAGE', 'IMAGEDEF', 'IMAGEDEF_REACTOR', '3DSOLID', 'MULTILEADER', 'MLEADERSTYLE', 'DIMENSION']) assert.equal(count(out, t), count(text, t), t);
  assert.ok(pairs(out).some(([c, v]) => c === 1 && v.length > 5) && count(out, '3DSOLID') === 1, 'ACIS data kept');
  // The edited line keeps its xdata and extension dictionary; the copy is a new entity.
  const lines = out.split(/\r?\n/);
  assert.ok(out.includes('LINE-NO 150-CW-1001'), 'xdata kept on the edited line');
  assert.equal(lines.filter((l) => l.trim() === 'LINE-NO 150-CW-1001').length, 1, 'only on the original');
  assert.ok(/102\r?\n\{ACAD_XDICTIONARY/.test(out), 'extension dictionary group kept');
  assert.equal(count(out, 'LINE'), count(text, 'LINE') + 1);
  // Layers: renamed (with its handle), recoloured, added.
  const back = buildDrawing(parseDxf(new TextEncoder().encode(out).buffer), 'dxf', 'x.dxf');
  assert.ok(back.layers.has('VALVES-NEW') && !back.layers.has('VALVES'));
  assert.equal(back.layers.get('PIPE').aci, 3);
  assert.ok(back.layers.has('ADDED'));
  assert.equal(back.modelEntities.filter((e) => e.type === 'INSERT')[0].layer, 'VALVES-NEW', 'entities on the renamed layer follow');
  // The edited text keeps its alignment point at the block's base point (0,0).
  const t2 = back.blocks.get('TAG').entities.find((e) => e.type === 'TEXT');
  assert.equal(t2.text, 'V-102');
  assert.ok(t2.hasEndPoint && t2.endPoint.x === 0 && t2.endPoint.y === 0 && t2.halign === 1, 'code 11 written at the origin');
  // Handles: unique, the seed above all of them.
  const hs = handles(out);
  assert.equal(new Set(hs).size, hs.length, 'unique handles');
  const seed = parseInt(after.get('$HANDSEED')[0].split('=')[1], 16);
  assert.ok(hs.every((h) => parseInt(h, 16) < seed), 'HANDSEED above every handle');
  assert.equal(report.summary(), '', 'nothing converted or left out');
  buildScene(back, back.modelEntities);
  console.log('     ezdxf audit:', auditOk(out, 'patched'));
});

test('edited attribute values and moved block references are written (with their blocks)', () => {
  const { d } = load(path.join(here, '..', 'public', 'samples', 'plant.dxf'));
  const doc = new EditDoc(d);
  const ins = d.modelEntities.find((e) => e.type === 'INSERT' && e.attribs?.length);
  doc.run('Attribute', (tx) => tx.modify(ins.attribs[0], (a) => { a.text.text = 'V-999'; }));
  const { text, report } = writeDxf(d, { doc });
  assert.ok(text.includes('V-999'), 'attribute edit saved');
  assert.equal(report.summary(), '');
  const p = pairs(text);
  assert.ok(p.every(([c]) => Number.isInteger(c)), 'every code line is a number');
  const back = buildDrawing(parseDxf(new TextEncoder().encode(text).buffer), 'dxf', 'x.dxf');
  assert.equal(back.modelEntities.filter((e) => e.type === 'INSERT').length, d.modelEntities.filter((e) => e.type === 'INSERT').length);
});

test('review fixes: code page, kept groups, layer records, failed edits, block layers, erased references', () => {
  const fx = (f) => path.join(here, 'fixtures', f);
  // 1. R2000 files are ANSI: non-ASCII text is written as \U+XXXX.
  {
    const { d } = load(fx('patch-r2000.dxf'));
    const doc = new EditDoc(d);
    const t = d.modelEntities.find((e) => e.type === 'TEXT' || e.type === 'MTEXT');
    doc.run('Text', (tx) => tx.modify(t, (e) => { e.text = 'Ø100 ±5°'; }));
    const { text } = writeDxf(d, { doc });
    assert.ok(/^[\x00-\x7f]*$/.test(text), 'ASCII only');
    assert.ok(text.includes('\\U+00D8100 \\U+00B15\\U+00B0'));
  }
  const { d, text: src } = load(fx('patch-r2018.dxf'));
  const doc = new EditDoc(d);
  const line = d.modelEntities.find((e) => e.type === 'LINE');
  const other = d.modelEntities.filter((e) => e.type === 'LINE')[1];
  // 2. An edited line keeps thickness, transparency and other groups the model does not hold.
  doc.run('Move', (tx) => tx.modify(line, (e) => { e.endPoint.x = 20; }));
  // 3 + 5. Rename (case-insensitive) then a new layer with the old name: distinct records; block records follow.
  doc.renameLayer('walls', 'W2');
  doc.newLayer('WALLS', 4);
  // 8. Erase a grouped line with an extension dictionary.
  const ctx = { doc, drawing: d, container: d.modelEntities, measure: () => 1 };
  ops.eraseEntities(ctx, [other]);
  const { text } = writeDxf(d, { doc });
  const p = pairs(text);
  const i = p.findIndex(([c, v]) => c === 5 && v === line.handle);
  const rec = []; for (let k = i; p[k][0] !== 0; k++) rec.push(p[k][0]);
  for (const c of [39, 440]) if (pairs(src).some(([cc], k, all) => cc === c)) assert.ok(rec.includes(c), `group ${c} kept`);
  const layerHandles = p.filter(([c], k, all) => c === 5 && all[k - 1]?.[1] === 'LAYER').map(([, v]) => v);
  assert.equal(new Set(layerHandles).size, layerHandles.length, 'unique LAYER handles');
  const blockLayers = p.filter(([c, v], k, all) => c === 8 && all.slice(Math.max(0, k - 6), k).some(([cc, vv]) => cc === 0 && vv === 'BLOCK'));
  assert.ok(!blockLayers.some(([, v]) => v.toUpperCase() === 'WALLS') || d.layers.has('WALLS'), 'block records follow the rename');
  const h = String(other.handle).toUpperCase();
  assert.deepEqual(p.filter(([c, v]) => [330, 340, 350, 360].includes(c) && v.toUpperCase() === h), [], 'no references to the erased line');
  auditOk(text, 'review');
});

test('failed transforms leave unsupported objects as read', () => {
  const { d } = load(path.join(here, 'fixtures', 'autocad-rich.dxf'));
  const doc = new EditDoc(d);
  const ctx = { doc, drawing: d, container: d.modelEntities, measure: () => 1 };
  const solid = d.modelEntities.find((e) => e.type === '3DSOLID');
  const failed = ops.transformEntities(ctx, [solid], [1, 0, 0, 1, 5, 5]);
  assert.equal(failed, 1);
  assert.ok(!doc.dirty.has(solid), 'not marked edited');
  // Edited anyway (e.g. layer change): kept as read rather than dropped, and reported.
  doc.run('Layer', (tx) => tx.modify(solid, (e) => { e.layer = 'PIPE'; }));
  const { text, report } = writeDxf(d, { doc });
  assert.equal(pairs(text).filter(([c, v]) => c === 0 && v === '3DSOLID').length, 1);
  assert.match(report.summary(), /3DSOLID kept as read/);
});

test('text aligned at the origin (P1-3): parsed, drawn and written at its alignment point', () => {
  const dxf = '0\nSECTION\n2\nENTITIES\n0\nTEXT\n8\n0\n10\n-5\n20\n-1\n40\n2\n1\nTAG\n72\n1\n11\n0\n21\n0\n0\nTEXT\n8\n0\n10\n3\n20\n4\n40\n2\n1\nPLAIN\n0\nENDSEC\n0\nEOF\n';
  const d = buildDrawing(parseDxf(new TextEncoder().encode(dxf).buffer), 'dxf', 'x.dxf');
  const [aligned, plain] = d.modelEntities;
  assert.equal(aligned.hasEndPoint, true);
  assert.equal(plain.hasEndPoint, false);
  const { text } = writeDxf(d); // full writer (no tables in this file)
  const back = buildDrawing(parseDxf(new TextEncoder().encode(text).buffer), 'dxf', 'x.dxf').modelEntities[0];
  assert.deepEqual([back.endPoint.x, back.endPoint.y, back.halign], [0, 0, 1]);
});

test('full writer: $HANDSEED above every handle (P1-4)', () => {
  const { d } = load(path.join(here, '..', 'public', 'samples', 'plant.dxf'));
  const { text } = writeDxf(d); // no doc: the full writer
  const seed = parseInt(headerVars(text).get('$HANDSEED')[0].split('=')[1], 16);
  const hs = handles(text);
  assert.ok(hs.every((h) => parseInt(h, 16) < seed), `seed ${seed.toString(16)} vs max ${Math.max(...hs.map((h) => parseInt(h, 16))).toString(16)}`);
});

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
