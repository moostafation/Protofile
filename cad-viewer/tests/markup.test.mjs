// Markups written as PDF annotations: every markup type becomes the expected annotation (type,
// rectangle, appearance stream), reads back with pdf.js, round-trips into editable markups, and
// flattening draws into the page instead. Usage: node tests/markup.test.mjs
import assert from 'node:assert/strict';
import { PDFDocument, PDFName, PDFArray, PDFDict } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { writeMarkedPdf, extractMarkups, mayHaveMarkups } from '../src/markup/pdf-annots.js';
import { MarkupStore, markupsCsv, dragHandle, handlesOf, hitTest, bboxOf } from '../src/markup/markup.js';

let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log('  ok', name); } catch (err) { failed++; console.log('FAIL', name, '\n    ', err.stack); }
};

const base = { color: '#e11d48', width: 2, opacity: 1, fontSize: 12, author: 'Tester', date: '2026-11-12T10:00:00.000Z', page: 1 };
const M = [
  { id: 'a1', type: 'pen', pts: [[50, 50], [60, 70], [80, 65], [90, 90]] },
  { id: 'a2', type: 'line', pts: [[100, 100], [200, 120]] },
  { id: 'a3', type: 'arrow', pts: [[100, 150], [200, 180]] },
  { id: 'a4', type: 'rect', pts: [[300, 300], [400, 360]], fill: '#fde047', opacity: 0.6 },
  { id: 'a5', type: 'ellipse', pts: [[300, 400], [400, 460]] },
  { id: 'a6', type: 'cloud', pts: [[100, 400], [220, 400], [220, 480], [100, 480]] },
  { id: 'a7', type: 'text', pts: [[50, 600], [250, 650]], text: 'Check this dimension — Ünïcödé ✓' },
  { id: 'a8', type: 'callout', pts: [[300, 500], [350, 600], [500, 640]], text: 'Callout text' },
  { id: 'a9', type: 'highlight', pts: [[50, 700], [250, 720]], color: '#facc15', opacity: 0.35 },
  { id: 'a10', type: 'stamp', pts: [[350, 680], [550, 760]], text: 'APPROVED' },
  { id: 'a11', type: 'measure', mode: 'dist', pts: [[50, 250], [250, 250]], text: '70.556 mm' },
  { id: 'a12', type: 'measure', mode: 'area', pts: [[300, 200], [400, 200], [400, 260]], text: '1,058.3 mm²' },
  { id: 'a13', type: 'measure', mode: 'path', pts: [[420, 100], [480, 150], [540, 100]], text: '150 mm' },
].map((m) => ({ ...base, ...m }));
const SUBTYPE = { pen: 'Ink', line: 'Line', arrow: 'Line', rect: 'Square', ellipse: 'Circle', cloud: 'Polygon', text: 'FreeText', callout: 'FreeText', highlight: 'Square', stamp: 'Stamp' };
const expected = (m) => (m.type === 'measure' ? { dist: 'Line', area: 'Polygon', path: 'PolyLine' }[m.mode] : SUBTYPE[m.type]);

async function blankPdf(rotate = 0) {
  const pdf = await PDFDocument.create();
  pdf.addPage([612, 792]);
  const p2 = pdf.addPage([612, 792]);
  if (rotate) p2.setRotation({ type: 'degrees', angle: rotate });
  return pdf.save();
}
const ident = (x, y) => [x, y];

const src = await blankPdf();
const out = await writeMarkedPdf({ source: src, pages: [{ index: 0, markups: M, map: ident, scale: 1 }] });

await check('every markup type becomes the expected PDF annotation with an appearance', async () => {
  const pdf = await PDFDocument.load(out);
  const annots = pdf.getPages()[0].node.lookup(PDFName.of('Annots'), PDFArray);
  assert.equal(annots.size(), M.length);
  for (let i = 0; i < M.length; i++) {
    const a = annots.lookup(i, PDFDict);
    assert.equal(a.get(PDFName.of('Subtype')).asString(), '/' + expected(M[i]), M[i].type);
    assert.ok(a.lookup(PDFName.of('AP'), PDFDict).get(PDFName.of('N')), 'appearance');
  }
});

await check('pdf.js reads the annotations with rectangles around the markups', async () => {
  const doc = await pdfjs.getDocument({ data: out.slice(), isEvalSupported: false, verbosity: 0 }).promise;
  const annots = await (await doc.getPage(1)).getAnnotations();
  assert.equal(annots.length, M.length);
  for (let i = 0; i < M.length; i++) {
    assert.equal(annots[i].titleObj?.str, 'Tester');
    const r = annots[i].rect, b = bboxOf(M[i]);
    assert.ok(r[0] <= b[0] + 0.01 && r[1] <= b[1] + 0.01 && r[2] >= b[2] - 0.01 && r[3] >= b[3] - 0.01, `rect of ${M[i].id}: ${r} vs ${b}`);
    assert.equal(annots[i].subtype, expected(M[i]));
  }
  const stamp = annots.find((a) => a.subtype === 'Stamp');
  assert.equal(stamp.contentsObj.str, 'APPROVED');
  const hl = (await PDFDocument.load(out)).getPages()[0].node.lookup(PDFName.of('Annots'), PDFArray).lookup(8, PDFDict);
  assert.equal(hl.get(PDFName.of('CA')).asNumber(), 0.35);
});

await check('the annotated page renders (appearance streams are valid)', async () => {
  const doc = await pdfjs.getDocument({ data: out.slice(), isEvalSupported: false, verbosity: 0 }).promise;
  const ops = await (await doc.getPage(1)).getOperatorList({ annotationMode: pdfjs.AnnotationMode.ENABLE });
  const forms = ops.fnArray.filter((f) => f === pdfjs.OPS.beginAnnotation).length;
  assert.equal(forms, M.length);
});

await check('re-opening gives the editable markups back and strips their annotations', async () => {
  assert.ok(mayHaveMarkups(out));
  const r = await extractMarkups(out);
  assert.equal(r.markups.length, M.length);
  assert.deepEqual(r.markups.map((m) => m.id), M.map((m) => m.id));
  assert.deepEqual(r.markups[7].pts, M[7].pts);
  assert.equal(r.markups[6].text, M[6].text);
  const again = await PDFDocument.load(r.bytes);
  const annots = again.getPages()[0].node.lookupMaybe(PDFName.of('Annots'), PDFArray);
  assert.equal(annots?.size() ?? 0, 0);
  assert.equal(await extractMarkups(src), null);
});

await check('flatten draws into the page content (no annotations)', async () => {
  const flat = await writeMarkedPdf({ source: src, flatten: true, pages: [{ index: 0, markups: M, map: ident, scale: 1 }] });
  const doc = await pdfjs.getDocument({ data: flat.slice(), isEvalSupported: false, verbosity: 0 }).promise;
  const page = await doc.getPage(1);
  assert.equal((await page.getAnnotations()).length, 0);
  const ops = await page.getOperatorList();
  assert.ok(ops.fnArray.filter((f) => f === pdfjs.OPS.paintFormXObjectBegin).length >= M.length);
  const text = (await page.getTextContent()).items.map((i) => i.str).join(' ');
  assert.match(text, /APPROVED/);
  assert.match(text, /Callout text/);
});

await check('image output: a page with the picture plus annotations', async () => {
  // 1x1 PNG
  const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
  const s = 0.5;
  const pdfBytes = await writeMarkedPdf({ image: { bytes: png, type: 'png', width: 400, height: 300 }, pages: [{ index: 0, markups: M.slice(0, 4), map: (x, y) => [x * s, y * s], scale: s }] });
  const doc = await pdfjs.getDocument({ data: pdfBytes, isEvalSupported: false, verbosity: 0 }).promise;
  const page = await doc.getPage(1);
  assert.deepEqual(page.view, [0, 0, 400, 300]);
  const annots = await page.getAnnotations();
  assert.equal(annots.length, 4);
  assert.ok(Math.abs(annots[1].lineCoordinates[2] - 100) < 1e-6);
});

await check('mapped coordinates on a rotated page', async () => {
  const rot = await blankPdf(90);
  // A viewer-space point (x, y) on a 90° page maps to user space (y, x) for this simple case.
  const r = await writeMarkedPdf({ source: rot, pages: [{ index: 1, markups: [M[1]], map: (x, y) => [y, x], scale: 1 }] });
  const doc = await pdfjs.getDocument({ data: r, isEvalSupported: false, verbosity: 0 }).promise;
  const [a] = await (await doc.getPage(2)).getAnnotations();
  assert.deepEqual(a.lineCoordinates, [100, 100, 120, 200]);
});

await check('store: undo/redo, modified flag, CSV', () => {
  const st = new MarkupStore();
  assert.equal(st.modified, false);
  st.add(M[1]);
  st.add(M[9]);
  assert.equal(st.modified, true);
  st.markSaved();
  assert.equal(st.modified, false);
  st.remove(['a2']);
  assert.equal(st.items.length, 1);
  assert.equal(st.undo(), 'Delete markup');
  assert.equal(st.items.length, 2);
  assert.equal(st.modified, false);
  st.redo();
  assert.equal(st.items.length, 1);
  const csv = markupsCsv(M);
  assert.equal(csv.split('\r\n').length, M.length + 2);
  assert.match(csv, /1,Stamp,APPROVED,Tester/);
  assert.match(csv, /"Measurement \(dist\)"|Measurement \(dist\)/);
});

await check('grips resize boxes and pen strokes; picking', () => {
  const r = M[3];
  const h = handlesOf(r);
  assert.equal(h.length, 4);
  const big = dragHandle(r, 2, [450, 400]); // top-right corner
  assert.deepEqual(big.pts, [[300, 300], [450, 400]]);
  const pen = dragHandle(M[0], 2, [130, 130]);
  assert.deepEqual(pen.pts.at(-1), [130, 130]);
  assert.ok(hitTest(M[1], [150, 110], 2));
  assert.ok(!hitTest(M[1], [150, 140], 2));
  assert.ok(hitTest(M[3], [350, 330], 1));
});

if (failed) { console.log(`${failed} markup test(s) failed`); process.exit(1); }
console.log('markup tests passed');
