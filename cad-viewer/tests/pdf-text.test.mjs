// PDF text extraction: Arabic stored glyph by glyph (presentation forms, visual order) must come
// out as logical, searchable text. Usage: node tests/pdf-text.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { buildLines, findInLines } from '../src/pdf/text-lines.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const data = new Uint8Array(fs.readFileSync(path.join(here, 'fixtures', 'arabic-text.pdf')));
const pdf = await pdfjs.getDocument({ data, isEvalSupported: false, verbosity: 0 }).promise;
const pages = [];
for (let n = 1; n <= pdf.numPages; n++) pages.push(buildLines((await (await pdf.getPage(n)).getTextContent()).items));

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log('  ok', name); } catch (err) { failed++; console.log('FAIL', name, '\n    ', err.message); }
};
check('lines are in logical order with normal letters', () => {
  const texts = pages[0].map((l) => l.text.trim());
  assert.deepEqual(texts, ['مضخة المياه المثلجة P-101', 'صمام بوابة V-101 قطر DN100', 'Valve schedule / جدول المحابس']);
  assert.ok(!/[ﭐ-﷿ﹰ-﻿]/.test(texts.join('')), 'no presentation forms');
});
check('Arabic search finds words and maps back to their glyph items', () => {
  const pump = findInLines(pages[0], 'مضخة');
  assert.equal(pump.length, 1);
  assert.equal(pump[0].items.length, 4, 'one item per glyph');
  assert.equal(findInLines(pages[0], 'المياه').length, 1);
  assert.equal(findInLines(pages[2], 'الثالثة').length, 1);
  assert.equal(findInLines(pages[0], 'v-101').length, 1, 'case-insensitive Latin');
});
await pdf.loadingTask.destroy();

// A writer that stores whole Arabic lines in visual (reversed) order.
const visual = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(path.join(here, 'fixtures', 'arabic-visual.pdf'))), isEvalSupported: false, verbosity: 0 }).promise;
const vlines = buildLines((await (await visual.getPage(1)).getTextContent()).items);
check('visual-order Arabic lines are restored to logical order', () => {
  assert.deepEqual(vlines.map((l) => l.text.trim()), ['Chilled water pump مضخة المياه المثلجة', 'صمام بوابة V-101', 'Valve schedule / جدول المحابس']);
  assert.equal(findInLines(vlines, 'المياه').length, 1);
});
await visual.loadingTask.destroy();
process.exit(failed ? 1 : 0);
