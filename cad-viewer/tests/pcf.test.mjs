// Tests for the PCF reader, its bill of materials and 3D model, and the geometry merge builder.
// Usage: node tests/pcf.test.mjs   (fixture: tests/fixtures/cooling-water.pcf, also public/samples)
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { parsePcf, pcfBom, pcfBomCsv, sizeLabel, componentSize, parsePoint, categoryOf } from '../src/formats/pcf.js';
import { FormatError } from '../src/formats/errors.js';
import { buildPcfModel, elbowPath } from '../src/view3d/pcf-model.js';
import { MergeBuilder, unionBox } from '../src/view3d/merge.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const sample = fs.readFileSync(path.join(here, 'fixtures', 'cooling-water.pcf'));
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

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

console.log('PCF reader');
test('sample: header, units, pipelines, components, materials', () => {
  const p = parsePcf(sample);
  assert.equal(p.units.coords, 'MM');
  assert.equal(p.units.bore, 'MM');
  assert.equal(p.header['ISOGEN-FILES'], 'ISOGEN.FLS');
  assert.deepEqual(p.pipelines.map((x) => x.ref), ['150-CW-1001-A1A', '100-CW-1002-A1A', '50-DR-1003-B1A']);
  assert.equal(p.components.length, 119);
  assert.equal(p.materials.size, 29);
  assert.ok(p.pipelines[0].attrs.some(([k, v]) => k === 'PIPING-SPEC' && v === 'A1A'));
  const tee = p.components.find((c) => c.type === 'TEE');
  assert.equal(tee.endPoints.length, 2);
  assert.ok(tee.centre && tee.branches[0].bore === 100);
  assert.equal(tee.description, 'TEE REDUCING, ASME B16.9, ASTM A234 WPB, SCH 40, BW', 'description from MATERIALS');
  const olet = p.components.find((c) => c.type === 'OLET');
  assert.equal(olet.headerBore, 150, 'olet size from the header pipe it sits on');
  const valve = p.components.find((c) => c.skey === 'VTFL');
  assert.equal(valve.tag, 'HV-1001');
  assert.equal(valve.category, 'Valves');
  const support = p.components.find((c) => c.type === 'SUPPORT');
  assert.ok(support.coords && !support.endPoints.length);
  assert.equal(p.components.filter((c) => !c.physical).map((c) => c.type).join(), 'END-CONNECTION-EQUIPMENT,END-CONNECTION-EQUIPMENT,END-CONNECTION-PIPELINE,END-CONNECTION-PIPELINE');
  assert.deepEqual(p.warnings, []);
});

test('bill of materials and pipe length per size', () => {
  const p = parsePcf(sample);
  const bom = pcfBom(p);
  const row = (code) => bom.rows.find((r) => r.itemCode === code);
  near(row('PIPE-150-S40').qty, 9.649, 1e-9);
  assert.equal(row('PIPE-150-S40').unit, 'm');
  assert.equal(row('FLG-WN-150-150').qty, 5);
  assert.equal(row('GSK-100-150').qty, 5);
  assert.equal(row('BLT-M20-110').qty, 40, 'bolt quantity attribute (5 joints × 8)');
  assert.equal(row('TEE-R-150X100').size, '150 × 100 mm');
  assert.equal(row('OLET-WOL-150X50').size, '150 × 50 mm');
  assert.equal(row('RED-E-100X80').size, '100 × 80 mm');
  assert.equal(row('VLV-GATE-150').description, 'GATE VALVE, CL150 RF, A216 WCB, TRIM 8, HANDWHEEL, API 600');
  // An item without item code: grouped by type, SKEY and size, described by ITEM-DESCRIPTION.
  const elbow50 = bom.rows.find((r) => !r.itemCode && r.size === '50 mm' && r.category === 'Fittings');
  assert.equal(elbow50.description, 'ELBOW 90 LR, ASME B16.9, A234 WPB, SCH 80');
  assert.deepEqual(bom.pipeLengths.map((x) => [x.size, x.length]), [['150 mm', 9.649], ['100 mm', 5.7], ['80 mm', 0.45], ['50 mm', 0.75]]);
  near(bom.totalPipe, 16.549, 1e-9);
  assert.deepEqual([...new Set(bom.rows.map((r) => r.category))], ['Pipe', 'Fittings', 'Flanges', 'Gaskets', 'Bolts', 'Valves', 'Instruments', 'Specials', 'Supports', 'Welds']);
  assert.equal(bom.rows.filter((r) => r.category === 'Welds').reduce((s, r) => s + r.qty, 0), 33);
  const drain = pcfBom(p, { pipeline: '50-DR-1003-B1A' });
  assert.deepEqual(drain.pipeLengths.map((x) => x.size), ['50 mm']);
  assert.ok(drain.rows.every((r) => r.pipelines.every((pl) => pl === '50-DR-1003-B1A')));
  const csv = pcfBomCsv(bom, 'cooling-water.pcf');
  const lines = csv.split('\r\n');
  assert.equal(lines[2], 'Category,Item code,Description,Size,Quantity,Unit,Pipelines');
  assert.ok(lines.includes('Pipe,PIPE-150-S40,"PIPE, SMLS, ASTM A106 GR.B, SCH 40, BE, ASME B36.10M",150 mm,9.649,m,150-CW-1001-A1A'), 'quoted description');
  assert.ok(lines.includes('Total,16.549,m'));
});

test('units, sizes and point parsing', () => {
  const inch = { bore: 'INCH', boreMm: 25.4 };
  assert.equal(sizeLabel(6, inch), '6"');
  assert.equal(sizeLabel(0.75, inch), '3/4"');
  assert.equal(sizeLabel(1.5, inch), '1-1/2"');
  assert.equal(sizeLabel(12, { bore: 'INCH-SIXTEENTH', boreMm: 25.4 / 16 }), '3/4"');
  assert.equal(sizeLabel(150, { bore: 'MM', boreMm: 1 }), '150 mm');
  assert.deepEqual(parsePoint('1000.5 -20 3e3 150.0000 BW'), { x: 1000.5, y: -20, z: 3000, bore: 150 });
  assert.equal(parsePoint('10 20'), null);
  assert.equal(categoryOf('REDUCER-ECCENTRIC'), 'Fittings');
  assert.equal(categoryOf('VALVE-ANGLE'), 'Valves');
  assert.equal(categoryOf('FLANGE-BLIND'), 'Flanges');
  assert.equal(categoryOf('MISC-COMPONENT'), 'Specials');
});

test('imperial file, CRLF, attributes at column 0, components before a pipeline, Latin-1', () => {
  const text = 'ISOGEN-FILES ISOGEN.FLS\r\nUNITS-BORE INCH\r\nUNITS-CO-ORDS INCH\r\n'
    + 'PIPE\r\nEND-POINT 0 0 0 6\r\nEND-POINT 120 0 0 6\r\nITEM-CODE P6\r\n'
    + 'PIPELINE-REFERENCE 6"-W-1\r\n    PIPING-SPEC C1\r\n'
    + 'ELBOW\r\n    END-POINT 120 0 0 6\r\n    END-POINT 129 9 0 6\r\n    CENTRE-POINT 129 0 0\r\n    SKEY ELBW\r\n    ITEM-DESCRIPTION ELBOW 90 LR \xb0\r\n'
    + 'PIPE\r\n    END-POINT 129 9 0 6\r\n    END-POINT 129 249 0 6\r\n    ITEM-CODE P6\r\n'
    + 'BOLT\r\n    BOLT-DIA 0.75\r\n    BOLT-LENGTH 4.5\r\n    BOLT-QUANTITY 8\r\n'
    + 'MATERIALS\r\nITEM-CODE P6\r\n    DESCRIPTION PIPE 6" SCH 40\r\n    DESCRIPTION SMLS\r\n';
  const bytes = Uint8Array.from(text, (c) => c.charCodeAt(0)); // Latin-1 degree sign
  const p = parsePcf(bytes.buffer);
  assert.deepEqual(p.pipelines.map((x) => x.ref), ['(no pipeline reference)', '6"-W-1']);
  assert.equal(p.components[0].endPoints.length, 2, 'END-POINT at column 0');
  assert.equal(p.components[1].description, 'ELBOW 90 LR °');
  assert.equal(p.materials.get('P6'), 'PIPE 6" SCH 40 SMLS', 'continued DESCRIPTION');
  const bom = pcfBom(p);
  const pipe = bom.rows.find((r) => r.itemCode === 'P6');
  assert.equal(pipe.unit, 'ft');
  near(pipe.qty, 30, 1e-9); // 120 + 240 inches
  assert.equal(pipe.size, '6"');
  assert.equal(bom.rows.find((r) => r.category === 'Bolts').qty, 8);
  assert.equal(componentSize(p.components.find((c) => c.type === 'BOLT'), p.units), '0.75 × 4.5');
});

test('files without piping fail with a readable error', () => {
  assert.throws(() => parsePcf('UNITS-BORE MM\nUNITS-CO-ORDS MM\n'), FormatError);
  assert.throws(() => parsePcf(''), FormatError);
  assert.throws(() => parsePcf('hello world\nthis is text'), FormatError);
});

console.log('PCF 3D model');
test('elbow path: circular arc through the centre point, exact ends', () => {
  const R = 228.6;
  const path90 = elbowPath([0, 0, 0], [R, 0, 0], [R, R, 0]);
  assert.deepEqual(path90[0], [0, 0, 0]);
  assert.deepEqual(path90.at(-1), [R, R, 0]);
  // Every point is R from the arc centre (0, R, 0).
  for (const p of path90) near(Math.hypot(p[0], p[1] - R, p[2]), R, 1e-6);
  const straight = elbowPath([0, 0, 0], [5, 0, 0], [10, 0, 0]);
  assert.equal(straight.length, 2);
  const uneven = elbowPath([0, 0, 0], [10, 0, 0], [10, 30, 0]);
  assert.deepEqual(uneven.at(-1), [10, 30, 0]);
});

test('sample model: elements, tree, geometry per component, BOM, summary', () => {
  const m = buildPcfModel(sample.buffer.slice(sample.byteOffset, sample.byteOffset + sample.byteLength), 'cooling-water.pcf');
  assert.equal(m.format, 'PCF');
  assert.equal(m.units.label, 'mm');
  assert.equal(m.elements.length, 119);
  assert.deepEqual(m.tree.children.map((n) => [n.name, n.children.length]), [['150-CW-1001-A1A', 56], ['100-CW-1002-A1A', 44], ['50-DR-1003-B1A', 19]]);
  assert.ok(m.elements.every((e) => !e.warning), 'every component drawn');
  const g = m.geometry;
  assert.equal(g.boxes.length, 119 * 6);
  const has = (i) => g.boxes[i * 6] <= g.boxes[i * 6 + 3];
  const pcf = m.pcf;
  pcf.components.forEach((c, i) => {
    const drawn = has(i);
    if (c.physical && c.type !== 'BOLT') assert.ok(drawn, `${c.type} line ${c.line} has geometry`);
    if (!c.physical || c.type === 'BOLT') assert.ok(!drawn, `${c.type} has no geometry`);
  });
  // A pipe's box follows its end points (shifted) plus the radius.
  const i = pcf.components.findIndex((c) => c.type === 'PIPE' && c.bore === 150 && c.endPoints[0].x !== c.endPoints[1].x);
  const c = pcf.components[i], s = g.shift, o = i * 6;
  near(g.boxes[o], Math.min(c.endPoints[0].x, c.endPoints[1].x) - s[0], 1e-3);
  near(g.boxes[o + 3], Math.max(c.endPoints[0].x, c.endPoints[1].x) - s[0], 1e-3);
  near(g.boxes[o + 5] - g.boxes[o + 2], 150, 1e-2);
  // Chunks: one material each, ranges cover every index, picking cells cover every triangle.
  const keys = g.chunks.map((ch) => ch.matKey);
  for (const k of ['Pipe', 'Fittings', 'Flanges', 'Valves', 'Handwheel', 'Welds', 'Supports', 'Reducer', 'Gaskets', 'Instruments', 'Specials']) assert.ok(keys.includes(k), k);
  for (const ch of g.chunks) {
    assert.ok(m.materials[ch.matKey], `material ${ch.matKey}`);
    let n = 0;
    for (let r = 0; r < ch.ranges.length; r += 3) { assert.ok(ch.ranges[r] >= 0 && ch.ranges[r] < 119); n += ch.ranges[r + 2]; }
    assert.equal(n, ch.index.length);
    let cells = 0;
    for (let k = 0; k < ch.cellRefs.length; k += 3) cells += ch.cellRefs[k + 1];
    assert.equal(cells, ch.index.length);
    assert.ok(Math.max(...ch.index) < ch.positions.length / 3);
  }
  // Valves with a handwheel get two materials; the check valve has no operator.
  const gate = pcf.components.findIndex((x) => x.skey === 'VTFL');
  const check = pcf.components.findIndex((x) => x.skey === 'CKFL');
  const wheelIds = (k) => { const ch = g.chunks.find((x) => x.matKey === k); const out = new Set(); for (let r = 0; r < ch.ranges.length; r += 3) out.add(ch.ranges[r]); return out; };
  assert.ok(wheelIds('Handwheel').has(gate) && !wheelIds('Handwheel').has(check));
  assert.equal(m.bom.kind, 'pcf');
  assert.ok(m.summary().includes('Pipe length per size: 150 mm: 9.649 m'));
  assert.ok(m.elements[gate].props[0].rows.some(([k, v]) => k === 'Tag' && v === 'HV-1001'));
  assert.ok(m.elements[gate].text.includes('gate valve'));
});

console.log('Merge builder');
test('far-away coordinates keep precision; repeated geometry becomes instanced; cells and boxes', () => {
  const big = 6_000_000; // site coordinates in millimetres
  const b = new MergeBuilder({ shift: [big, big, 0], instanceMin: 3 });
  const quad = { pos: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], nrm: null, idx: [0, 1, 2, 0, 2, 3] };
  b.addMesh(0, 'grey', [big + 0.25, big, 0, big + 0.75, big, 0, big + 0.75, big + 0.5, 0], null, null);
  for (let k = 0; k < 4; k++) b.addPlaced(1 + k, 'g1', quad, 'red', [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, big + k * 10, big, 5, 1]);
  b.addPlaced(5, 'g2', quad, 'red', [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, big, big + 100, 0, 1]);
  const r = b.build(7);
  assert.equal(r.elementCount, 7);
  const grey = r.chunks.find((c) => c.matKey === 'grey');
  near(grey.positions[0], 0.25, 1e-6);
  near(grey.positions[3], 0.75, 1e-6);
  assert.equal(r.instanced.length, 1, 'g1 placed 4 times (>= 3) is instanced');
  assert.equal(r.instanced[0].ids.length, 4);
  near(r.instanced[0].matrices[12 + 16 * 2], 20, 1e-6);
  const red = r.chunks.find((c) => c.matKey === 'red');
  assert.equal(red.index.length, 6, 'g2 placed once is merged');
  near(red.positions[3], 2, 1e-6);
  near(r.boxes[3 * 6], 20, 1e-6); near(r.boxes[3 * 6 + 2], 5, 1e-6); // element 3: third instance
  assert.ok(!(r.boxes[6 * 6] <= r.boxes[6 * 6 + 3]), 'element without geometry has an empty box');
  assert.deepEqual(unionBox(r.boxes, [0]).map((v) => +v.toFixed(3)), [0.25, 0, 0, 0.75, 0.5, 0]);
  // Normals computed for meshes without them.
  near(Math.abs(grey.normals[2]), 1, 1e-6);
  // Cells split long ranges (1024 triangles each).
  const many = new MergeBuilder();
  const pos = [], idx = [];
  for (let t = 0; t < 3000; t++) { pos.push(t, 0, 0, t + 1, 0, 0, t, 1, 0); idx.push(t * 3, t * 3 + 1, t * 3 + 2); }
  const r2 = many.build ? (many.addMesh(0, 'k', pos, null, idx), many.build()) : null;
  assert.equal(r2.chunks[0].cellRefs.length / 3, 3);
});

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
