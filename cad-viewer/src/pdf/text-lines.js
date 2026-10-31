// Turns pdf.js text items into readable lines. PDFs often store Arabic one glyph per item,
// in visual (left-to-right) order and as presentation forms; this joins items by geometry,
// restores logical order for right-to-left runs and normalises the text (NFKC), keeping
// for every item its character range so search hits can be mapped back to rectangles.

const RTL = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
const LTR = /[A-Za-z0-9À-ɏͰ-ϿЀ-ӿ]/;
const MARKS = /[̀-ͯؐ-ًؚ-ٰٟۖ-ۭـ]/g;

/** Text form used for matching: NFKC, lower case, without diacritics, tatweel or repeated spaces. */
export function searchKey(s) {
  return s.normalize('NFKC').toLowerCase().normalize('NFKD').replace(MARKS, '').replace(/\s+/g, ' ');
}

const display = (s) => s.normalize('NFKC').replace(/\s+/g, ' ');

function geometry(it) {
  const [a, b, c, d, e, f] = it.transform;
  const len = Math.hypot(a, b) || 1;
  const ux = a / len, uy = b / len;
  return { along: e * ux + f * uy, across: -e * uy + f * ux, angle: Math.atan2(b, a), size: Math.hypot(c, d) || it.height || len, width: it.width || 0 };
}

function direction(str) {
  if (RTL.test(str)) return 'r';
  if (LTR.test(str)) return 'l';
  return 'n';
}

/**
 * @param items pdf.js TextItems ({ str, transform, width, height, dir, hasEOL })
 * @returns [{ text, key, spans: [{ item, ts, te, ks, ke }] }] (item = index into `items`)
 */
export function buildLines(items) {
  // 1. Group items into lines: same angle and baseline, in content order.
  const groups = [];
  let cur = null, breakNext = false;
  items.forEach((it, index) => {
    if (it.str) {
      const g = { index, str: it.str, ...geometry(it) };
      const same = cur && !breakNext && Math.abs(g.angle - cur.angle) < 0.05 && Math.abs(g.across - cur.across) < 0.5 * Math.max(g.size, cur.size);
      if (!same) groups.push((cur = { angle: g.angle, across: g.across, size: g.size, parts: [] }));
      cur.parts.push(g);
      breakNext = false;
    }
    if (it.hasEOL) breakNext = true;
  });

  return groups.map((line) => {
    // 2. Visual order, with a space wherever the gap between neighbours looks like one.
    const vis = [];
    for (const g of line.parts.sort((p, q) => p.along - q.along)) {
      const prev = vis[vis.length - 1];
      if (prev && g.along - (prev.along + prev.width) > 0.2 * line.size && !/\s$/.test(prev.str) && !/^\s/.test(g.str)) {
        vis.push({ index: -1, str: ' ', dir: 'n' });
      }
      vis.push({ ...g, dir: direction(g.str) });
    }
    // 3. Base direction by majority; neutrals between two runs of one direction join them.
    let r = 0, l = 0;
    for (const v of vis) for (const ch of v.str) { if (RTL.test(ch)) r++; else if (LTR.test(ch)) l++; }
    const base = r > l ? 'r' : 'l';
    for (let i = 0; i < vis.length; i++) {
      if (vis[i].dir !== 'n') continue;
      const before = vis.slice(0, i).reverse().find((v) => v.dir !== 'n')?.dir;
      const after = vis.slice(i + 1).find((v) => v.dir !== 'n')?.dir;
      vis[i].run = before && before === after ? before : base;
    }
    const runs = [];
    for (const v of vis) {
      const d = v.dir === 'n' ? v.run : v.dir;
      if (!runs.length || runs[runs.length - 1].dir !== d) runs.push({ dir: d, parts: [] });
      runs[runs.length - 1].parts.push(v);
    }
    // 4. Logical order: right-to-left runs (and the run order on RTL lines) are reversed.
    if (base === 'r') runs.reverse();
    const ordered = runs.flatMap((run) => (run.dir === 'r' ? [...run.parts].reverse() : run.parts));
    let text = '', key = '';
    const spans = [];
    for (const v of ordered) {
      let t = display(v.str), k = searchKey(v.str);
      if (/^\s*$/.test(t) && (!text || text.endsWith(' '))) { t = ''; k = ''; }
      const span = { item: v.index, ts: text.length, ks: key.length };
      text += t;
      key += k;
      span.te = text.length;
      span.ke = key.length;
      if (v.index >= 0) spans.push(span);
    }
    return { text, key, spans };
  });
}

/** Matches of `query` in the lines: [{ line, start, end, items }] with item indexes. */
export function findInLines(lines, query, limit = Infinity) {
  const q = searchKey(query).trim();
  const out = [];
  if (!q) return out;
  for (const line of lines) {
    let at = line.key.indexOf(q);
    while (at >= 0 && out.length < limit) {
      const end = at + q.length;
      const items = line.spans.filter((s) => s.ks < end && s.ke > at).map((s) => s.item);
      out.push({ line, start: at, end, items });
      at = line.key.indexOf(q, end);
    }
    if (out.length >= limit) break;
  }
  return out;
}
