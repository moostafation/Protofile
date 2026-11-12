// Markups (Bluebeam-style review marks) on PDF pages and images. A markup lives on one page and
// keeps its geometry in that page's world coordinates (PDF points or image units, y up), so it
// stays put while zooming and is written to PDF annotations in the same place.
//
// Markup: { id, type, page, pts: [[x, y]...], text, color, fill, opacity, width, fontSize,
//           author, date (ISO), mode (measure: 'dist' | 'path' | 'area'), arc (cloud bulge) }
// Geometry by type: pen = stroke points; line/arrow = [a, b]; rect/ellipse/highlight/text/stamp =
// two opposite corners; cloud = polygon vertices; callout = [tip, corner, opposite corner];
// measure = the measured points.

export const STAMPS = ['APPROVED', 'REJECTED', 'FOR CONSTRUCTION'];
export const TYPE_LABEL = {
  pen: 'Pen', line: 'Line', arrow: 'Arrow', rect: 'Rectangle', ellipse: 'Ellipse', cloud: 'Revision cloud',
  text: 'Text box', callout: 'Callout', highlight: 'Highlight', stamp: 'Stamp', measure: 'Measurement',
};
/** Types whose geometry is a box given by two corners (pts[0], pts[1]). */
const BOXED = new Set(['rect', 'ellipse', 'highlight', 'text', 'stamp']);
export const HAS_TEXT = new Set(['text', 'callout', 'stamp']);

let seq = 0;
export function newId() {
  return `mk-${Date.now().toString(36)}-${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export const clone = (m) => JSON.parse(JSON.stringify(m));

const norm = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];

/** The text box of a boxed markup or a callout: [x0, y0, x1, y1]. */
export function boxOf(m) {
  if (m.type === 'callout') return norm(m.pts[1], m.pts[2]);
  return norm(m.pts[0], m.pts[1]);
}

/** Bounding box including line width, arrow heads, cloud bulges and labels. */
export function bboxOf(m) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of m.pts) { b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y); }
  let pad = (m.width || 1) / 2;
  if (m.type === 'arrow' || m.type === 'callout') pad += headLen(m);
  if (m.type === 'cloud') pad += cloudArc(m);
  if (m.type === 'measure') pad += (m.fontSize || 12) * 1.5;
  return [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad];
}

export const headLen = (m) => Math.max((m.width || 1) * 4, (m.fontSize || 12) * 0.8);
export const cloudArc = (m) => m.arc || (m.fontSize || 12) * 0.8;

// ---------------------------------------------------------------- geometry helpers
function distSeg(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

function distPolyline(p, pts, closed) {
  let d = Infinity;
  for (let i = 1; i < pts.length; i++) d = Math.min(d, distSeg(p, pts[i - 1], pts[i]));
  if (closed && pts.length > 2) d = Math.min(d, distSeg(p, pts[pts.length - 1], pts[0]));
  if (pts.length === 1) d = Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]);
  return d;
}

function inside(p, b) { return p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3]; }

function signedArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % pts.length];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

/** Corners of a box as a polygon (counter-clockwise, y up). */
export const boxPolygon = (b) => [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]];

/** Vertices of a revision cloud's outline: the polygon edges split into arcs that bulge outward. */
export function cloudOutline(m) {
  const poly = m.pts;
  const r = cloudArc(m);
  const ccw = signedArea(poly) > 0;
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1e-9) continue;
    const n = Math.max(1, Math.round(len / (2 * r)));
    const ux = (b[0] - a[0]) / len, uy = (b[1] - a[1]) / len;
    // Outward normal: right of the edge for a counter-clockwise polygon.
    const nx = ccw ? uy : -uy, ny = ccw ? -ux : ux;
    const seg = len / n;
    for (let k = 0; k < n; k++) {
      const cx = a[0] + ux * seg * (k + 0.5), cy = a[1] + uy * seg * (k + 0.5);
      const rad = seg / 2;
      // Half circle from the segment start to its end, through the outside.
      for (let j = 0; j < 8; j++) {
        const t = (Math.PI * j) / 8;
        out.push([cx - ux * rad * Math.cos(t) + nx * rad * Math.sin(t), cy - uy * rad * Math.cos(t) + ny * rad * Math.sin(t)]);
      }
    }
  }
  return out;
}

/** Arrow head lines at `tip` coming from `from`: [[left], tip, [right]]. */
export function arrowHead(from, tip, len) {
  const ang = Math.atan2(tip[1] - from[1], tip[0] - from[0]);
  const s = Math.PI / 7;
  return [
    [tip[0] - len * Math.cos(ang - s), tip[1] - len * Math.sin(ang - s)],
    tip,
    [tip[0] - len * Math.cos(ang + s), tip[1] - len * Math.sin(ang + s)],
  ];
}

/** Where a callout's leader meets its text box (middle of the nearest side). */
export function calloutJoin(m) {
  const b = boxOf(m), tip = m.pts[0];
  const cands = [[b[0], (b[1] + b[3]) / 2], [b[2], (b[1] + b[3]) / 2], [(b[0] + b[2]) / 2, b[1]], [(b[0] + b[2]) / 2, b[3]]];
  let best = cands[0], bd = Infinity;
  for (const c of cands) { const d = Math.hypot(c[0] - tip[0], c[1] - tip[1]); if (d < bd) { bd = d; best = c; } }
  return best;
}

/** Splits text into lines that fit `maxW` (measure(str) gives a width). */
export function wrapText(text, maxW, measure) {
  const out = [];
  for (const para of String(text ?? '').split('\n')) {
    const words = para.split(/(\s+)/);
    let line = '';
    for (const w of words) {
      const next = line + w;
      if (line && measure(next.trimEnd()) > maxW && w.trim()) { out.push(line.trimEnd()); line = w.trimStart(); } else line = next;
    }
    out.push(line.trimEnd());
  }
  return out;
}

/** Text lines of a text box / callout, with the layout used both on screen and in the PDF. */
export function textLayout(m, measure) {
  const b = boxOf(m), fs = m.fontSize || 12, pad = fs * 0.35;
  const lines = wrapText(m.text, Math.max(fs, b[2] - b[0] - 2 * pad), (s) => measure(s, fs));
  return { b, fs, pad, lh: fs * 1.2, lines };
}

/** Stamp layout: big label and a small "author · date" line. */
export function stampLayout(m, measure, measureBold) {
  const b = boxOf(m);
  const w = b[2] - b[0], h = b[3] - b[1];
  const label = m.text || 'APPROVED';
  const fs = Math.max(1, Math.min(h * 0.42, (w * 0.86) / Math.max(1, measureBold(label, 1))));
  const sub = [m.author, m.date ? m.date.slice(0, 10) : ''].filter(Boolean).join('  ·  ');
  const fs2 = Math.max(1, Math.min(h * 0.18, (w * 0.86) / Math.max(1, measure(sub, 1))));
  return { b, label, fs, sub, fs2 };
}

/** Where a measurement's value label goes. */
export function measureLabelAt(m) {
  const p = m.pts;
  if (m.mode === 'area') {
    let x = 0, y = 0;
    for (const q of p) { x += q[0]; y += q[1]; }
    return [x / p.length, y / p.length];
  }
  const i = Math.floor((p.length - 1) / 2);
  return [(p[i][0] + p[i + 1][0]) / 2, (p[i][1] + p[i + 1][1]) / 2];
}

// ---------------------------------------------------------------- picking and editing
export function hitTest(m, p, tol) {
  const bb = bboxOf(m);
  if (p[0] < bb[0] - tol || p[0] > bb[2] + tol || p[1] < bb[1] - tol || p[1] > bb[3] + tol) return false;
  const near = (m.width || 1) / 2 + tol;
  switch (m.type) {
    case 'pen': case 'line': case 'arrow': return distPolyline(p, m.pts, false) <= near;
    case 'measure': return distPolyline(p, m.pts, m.mode === 'area') <= near || (m.mode === 'area' && inside(p, norm(...minmax(m.pts))));
    case 'cloud': return inside(p, bb);
    case 'callout': return inside(p, boxOf(m)) || distSeg(p, m.pts[0], calloutJoin(m)) <= near;
    default: return inside(p, [bb[0] - tol, bb[1] - tol, bb[2] + tol, bb[3] + tol]);
  }
}

function minmax(pts) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of pts) { b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y); }
  return [[b[0], b[1]], [b[2], b[3]]];
}

/** Grip points: the ends/vertices, or the four corners of a box (pen: corners of its extent). */
export function handlesOf(m) {
  if (BOXED.has(m.type)) return boxPolygon(boxOf(m));
  if (m.type === 'callout') return [m.pts[0], ...boxPolygon(boxOf(m))];
  if (m.type === 'pen') return boxPolygon(norm(...minmax(m.pts)));
  return m.pts.map((q) => [...q]);
}

export function moveMarkup(m, dx, dy) {
  m.pts = m.pts.map(([x, y]) => [x + dx, y + dy]);
  return m;
}

/** Moves grip `i` (from handlesOf(orig)) to `p`; returns the changed copy of `orig`. */
export function dragHandle(orig, i, p) {
  const m = clone(orig);
  const resizeBox = (b, k) => {
    // Corner k of boxPolygon moves; the opposite corner stays.
    const opp = boxPolygon(b)[(k + 2) % 4];
    return [opp, [p[0], p[1]]];
  };
  if (BOXED.has(m.type)) { m.pts = resizeBox(boxOf(orig), i); return m; }
  if (m.type === 'callout') {
    if (i === 0) m.pts[0] = [...p];
    else { const [a, b] = resizeBox(boxOf(orig), i - 1); m.pts[1] = a; m.pts[2] = b; }
    return m;
  }
  if (m.type === 'pen') {
    const [lo, hi] = minmax(orig.pts);
    const b = [lo[0], lo[1], hi[0], hi[1]];
    const [opp] = resizeBox(b, i);
    const c = boxPolygon(b)[i];
    const sx = Math.abs(c[0] - opp[0]) > 1e-9 ? (p[0] - opp[0]) / (c[0] - opp[0]) : 1;
    const sy = Math.abs(c[1] - opp[1]) > 1e-9 ? (p[1] - opp[1]) / (c[1] - opp[1]) : 1;
    m.pts = orig.pts.map(([x, y]) => [opp[0] + (x - opp[0]) * sx, opp[1] + (y - opp[1]) * sy]);
    return m;
  }
  m.pts[i] = [...p];
  return m;
}

// ---------------------------------------------------------------- canvas drawing
const FONT = 'Helvetica, Arial, sans-serif';

function canvasMeasure(ctx, bold) {
  return (s, fs) => {
    ctx.font = `${bold ? 'bold ' : ''}100px ${FONT}`;
    return (ctx.measureText(s).width / 100) * fs;
  };
}

function rgba(hex, a = 1) {
  const n = parseInt(String(hex || '#ff0000').slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Writes text upright in a y-up context, baseline at (x, y). */
function textAt(ctx, s, x, y, fs, bold = false, align = 'left') {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(1, -1);
  ctx.font = `${bold ? 'bold ' : ''}${fs}px ${FONT}`;
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(s, 0, 0);
  ctx.restore();
}

function polyPath(ctx, pts, closed) {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  if (closed) ctx.closePath();
}

/** Draws a markup on a canvas whose transform maps page coordinates (y up) to pixels. */
export function drawMarkup(ctx, m) {
  const w = m.width || 1;
  ctx.save();
  ctx.globalAlpha = m.opacity ?? 1;
  ctx.strokeStyle = rgba(m.color);
  ctx.fillStyle = m.fill ? rgba(m.fill) : 'transparent';
  ctx.lineWidth = w;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const fillStroke = () => { if (m.fill) ctx.fill(); if (w > 0) ctx.stroke(); };
  const measure = canvasMeasure(ctx, false);
  switch (m.type) {
    case 'pen': polyPath(ctx, m.pts, false); ctx.stroke(); break;
    case 'line': polyPath(ctx, m.pts, false); ctx.stroke(); break;
    case 'arrow':
      polyPath(ctx, m.pts, false); ctx.stroke();
      polyPath(ctx, arrowHead(m.pts[0], m.pts[1], headLen(m)), false); ctx.stroke();
      break;
    case 'rect': case 'highlight': {
      const b = boxOf(m);
      ctx.beginPath(); ctx.rect(b[0], b[1], b[2] - b[0], b[3] - b[1]);
      if (m.type === 'highlight') { ctx.fillStyle = rgba(m.fill || m.color); ctx.fill(); } else fillStroke();
      break;
    }
    case 'ellipse': {
      const b = boxOf(m);
      ctx.beginPath();
      ctx.ellipse((b[0] + b[2]) / 2, (b[1] + b[3]) / 2, Math.max(1e-6, (b[2] - b[0]) / 2), Math.max(1e-6, (b[3] - b[1]) / 2), 0, 0, Math.PI * 2);
      fillStroke();
      break;
    }
    case 'cloud': polyPath(ctx, cloudOutline(m), true); fillStroke(); break;
    case 'text': case 'callout': {
      const L = textLayout(m, measure);
      const b = L.b;
      if (m.type === 'callout') {
        const j = calloutJoin(m);
        polyPath(ctx, [j, m.pts[0]], false); ctx.stroke();
        polyPath(ctx, arrowHead(j, m.pts[0], headLen(m)), false); ctx.stroke();
      }
      ctx.beginPath(); ctx.rect(b[0], b[1], b[2] - b[0], b[3] - b[1]);
      ctx.fillStyle = m.fill ? rgba(m.fill) : 'rgba(255,255,255,0.85)';
      ctx.fill();
      if (w > 0) ctx.stroke();
      ctx.fillStyle = rgba(m.color);
      L.lines.forEach((s, i) => textAt(ctx, s, b[0] + L.pad, b[3] - L.pad - L.fs * 0.9 - i * L.lh, L.fs));
      break;
    }
    case 'stamp': {
      const S = stampLayout(m, measure, canvasMeasure(ctx, true));
      const b = S.b, inset = Math.min(b[2] - b[0], b[3] - b[1]) * 0.06;
      ctx.lineWidth = Math.max(w, (b[3] - b[1]) * 0.04);
      ctx.beginPath(); ctx.roundRect(b[0], b[1], b[2] - b[0], b[3] - b[1], inset * 1.5); ctx.stroke();
      ctx.fillStyle = rgba(m.color);
      const cx = (b[0] + b[2]) / 2;
      textAt(ctx, S.label, cx, b[1] + (b[3] - b[1]) * (S.sub ? 0.42 : 0.33), S.fs, true, 'center');
      if (S.sub) textAt(ctx, S.sub, cx, b[1] + (b[3] - b[1]) * 0.14, S.fs2, false, 'center');
      break;
    }
    case 'measure': {
      polyPath(ctx, m.pts, m.mode === 'area');
      if (m.mode === 'area' && m.fill) ctx.fill();
      ctx.stroke();
      const t = (m.fontSize || 12) * 0.4;
      for (const q of [m.pts[0], m.pts[m.pts.length - 1]]) { ctx.beginPath(); ctx.arc(q[0], q[1], t, 0, Math.PI * 2); ctx.fillStyle = rgba(m.color); ctx.fill(); }
      const [lx, ly] = measureLabelAt(m);
      const fs = m.fontSize || 12, tw = measure(m.text || '', fs);
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.fillRect(lx - tw / 2 - fs * 0.3, ly - fs * 0.45, tw + fs * 0.6, fs * 1.3);
      ctx.fillStyle = rgba(m.color);
      textAt(ctx, m.text || '', lx, ly, fs, false, 'center');
      break;
    }
    default: break;
  }
  ctx.restore();
}

/** Quick check (no parsing, no pdf-lib) whether a PDF may hold this app's markups. */
export function mayHaveMarkups(bytes) {
  const u = new Uint8Array(bytes);
  const pat = [80, 67, 77, 97, 114, 107, 117, 112]; // "PCMarkup"
  outer: for (let i = 0; i + pat.length <= u.length; i++) {
    for (let j = 0; j < pat.length; j++) if (u[i + j] !== pat[j]) continue outer;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- list / CSV
export function markupSummary(m) {
  return m.type === 'stamp' || m.type === 'text' || m.type === 'callout' || m.type === 'measure' ? (m.text || '') : '';
}

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function markupsCsv(list) {
  const rows = [['Page', 'Type', 'Text', 'Author', 'Date', 'Colour']];
  for (const m of list) rows.push([m.page, m.type === 'measure' ? `Measurement (${m.mode})` : TYPE_LABEL[m.type] || m.type, markupSummary(m), m.author, m.date, m.color]);
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------- store with undo
/** All markups of the open document, with snapshot undo/redo and a saved mark. */
export class MarkupStore {
  constructor(initial = []) {
    this.items = initial.map(clone);
    this.undoStack = [];
    this.redoStack = [];
    this.savedAt = 0;
    this.version = 0;
    this.listeners = [];
  }

  get modified() { return this.version !== this.savedAt; }
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  onChange(fn) { this.listeners.push(fn); }
  emit() { for (const fn of this.listeners) fn(); }

  page(n) { return this.items.filter((m) => m.page === n); }
  get(id) { return this.items.find((m) => m.id === id) || null; }
  all() { return [...this.items].sort((a, b) => a.page - b.page); }

  /** Runs `fn(items)` (it changes the list in place) as one undo step. */
  change(label, fn) {
    const before = { items: clone(this.items), version: this.version, label };
    fn(this.items);
    this.undoStack.push(before);
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    this.version = ++MarkupStore.counter;
    this.emit();
  }

  add(m, label = `Add ${TYPE_LABEL[m.type] || 'markup'}`) { this.change(label, (it) => it.push(clone(m))); }
  replace(m, label = 'Edit markup') { this.change(label, (it) => { const i = it.findIndex((x) => x.id === m.id); if (i >= 0) it[i] = clone(m); }); }
  remove(ids, label = 'Delete markup') { const s = new Set(ids); this.change(label, (it) => { for (let i = it.length - 1; i >= 0; i--) if (s.has(it[i].id)) it.splice(i, 1); }); }

  undo() {
    const s = this.undoStack.pop();
    if (!s) return null;
    this.redoStack.push({ items: clone(this.items), version: this.version, label: s.label });
    this.items = s.items;
    this.version = s.version;
    this.emit();
    return s.label;
  }

  redo() {
    const s = this.redoStack.pop();
    if (!s) return null;
    this.undoStack.push({ items: clone(this.items), version: this.version, label: s.label });
    this.items = s.items;
    this.version = s.version;
    this.emit();
    return s.label;
  }

  markSaved() { this.savedAt = this.version; this.emit(); }
}
MarkupStore.counter = 0;
