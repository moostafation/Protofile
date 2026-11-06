// Interactive editing tools: selection (click, Shift+click, window/crossing, grips), pan,
// drawing (line, polyline, rectangle, circle, arc, text, revision cloud) and modifying
// (move, copy, rotate, scale, mirror, offset, erase, explode). Tools work in scene
// coordinates (world minus the scene origin); `ed` (see main.js) converts and commits.
//
// Every tool may expose `prompt` (shown in the command line) and `input(text)` (typed values:
// points as x,y / @dx,dy / @dist<angle / a distance, numbers, or option letters).
import { parsePoint, parseNumber, orthoPoint } from './cmdline.js';
import { drawSnapMarker } from './tools.js';
import {
  makeLine, makeLwPolyline, makeRectangle, makeCircle, makeArc, makeText, makeRevisionCloud, arcFrom3, gripsOf,
  moveMatrix, rotateMatrix, scaleMatrix, mirrorMatrix, offsetEntity,
} from '../edit/entities.js';
import { cloneData } from '../edit/model.js';

const RUBBER = '#22d3ee';
const GRIP = '#3b82f6';
const GRIP_HOT = '#ef4444';
const GRIP_HOVER = '#f472b6';
const DEG = Math.PI / 180;
const GRIP_LIMIT = 100; // like AutoCAD's GRIPOBJLIMIT

const fmt = (v) => (Math.abs(v) >= 1000 ? v.toFixed(1) : Math.abs(v) >= 10 ? v.toFixed(2) : v.toFixed(3)).replace(/\.?0+$/, '');

function label(o, x, y, text) {
  o.save();
  o.font = '600 12px system-ui, sans-serif';
  o.direction = 'ltr';
  const w = o.measureText(text).width + 10;
  o.fillStyle = 'rgba(15,18,24,0.88)';
  o.strokeStyle = RUBBER;
  o.lineWidth = 1;
  o.beginPath();
  o.roundRect(x + 14, y + 14, w, 20, 4);
  o.fill();
  o.stroke();
  o.fillStyle = '#fff';
  o.fillText(text, x + 19, y + 28);
  o.restore();
}

/** Window (blue, solid: fully inside) or crossing (green, dashed: touching) selection rectangle. */
function drawSelectionRect(o, v, a, b) {
  const [x0, y0] = v.worldToScreen(a[0], a[1]);
  const [x1, y1] = v.worldToScreen(b[0], b[1]);
  const crossing = x1 < x0;
  o.save();
  o.fillStyle = crossing ? 'rgba(74,222,128,0.14)' : 'rgba(59,130,246,0.16)';
  o.strokeStyle = crossing ? '#4ade80' : '#3b82f6';
  o.lineWidth = 1.5;
  o.setLineDash(crossing ? [6, 4] : []);
  const r = [Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0)];
  o.fillRect(...r);
  o.strokeRect(...r);
  o.restore();
}

function rectOf(a, b) {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
}

/** Base of the drawing and modify tools: snapping, ortho, typed points, rubber band label. */
export class EditTool {
  constructor(ed, name) {
    this.ed = ed;
    this.name = name;
    this.cursor = 'crosshair';
    this.pts = []; // placed points (scene coordinates)
    this.hover = null; // current point under the cursor (snapped / ortho)
    this.snap = null;
  }

  /** The point new input is relative to (for ortho, @ coordinates and distances). */
  get base() { return this.pts.at(-1) ?? null; }
  get prompt() { return ''; }

  pointFor(w) {
    const s = this.ed.snapPoint(w, this.base);
    this.snap = s;
    if (s) return [s.x, s.y];
    return this.ed.ortho && this.base ? orthoPoint(this.base, w) : w;
  }

  move(w) { this.hover = this.pointFor(w); }
  click(w) { this.point(this.pointFor(w)); }
  point() {}

  /** Typed point in scene coordinates, or null. */
  typedPoint(text) {
    const o = this.ed.origin;
    const base = this.base ? [this.base[0] + o.x, this.base[1] + o.y] : null;
    const dir = this.hover && this.base ? [this.hover[0] - this.base[0], this.hover[1] - this.base[1]] : null;
    const p = parsePoint(text, { base, dir, ortho: this.ed.ortho });
    return p ? [p[0] - o.x, p[1] - o.y] : null;
  }

  input(text) { return this.pointInput(text); }

  /** Typed point input (x,y / @dx,dy / @dist<angle / distance). */
  pointInput(text) {
    const p = this.typedPoint(text);
    if (p) { this.point(p); return true; }
    return false;
  }

  /** Enter finishes like an empty input; Esc ends the command (the app switches back to Select). */
  key(ev) {
    if (ev.key === 'Enter') { this.input(''); return true; }
    if (ev.key === 'Backspace' && this.undoPoint()) return true;
    return false;
  }

  undoPoint() {
    if (!this.pts.length) return false;
    this.pts.pop();
    return true;
  }

  contextmenu() { this.input(''); this.ed.refresh(); }
  dblclick() { return true; }
  reset() { this.pts = []; }
  cancel() { this.pts = []; this.hover = null; }

  /** Entities to preview (temporary, not in the drawing), in world coordinates. */
  preview() { return []; }

  drawOverlay(o, v) {
    const d = v.dpr;
    const ents = this.preview();
    if (ents.length) this.ed.drawPreview(o, v, ents);
    o.setTransform(d, 0, 0, d, 0, 0);
    if (this.base && this.hover) {
      const [x0, y0] = v.worldToScreen(this.base[0], this.base[1]);
      const [x1, y1] = v.worldToScreen(this.hover[0], this.hover[1]);
      o.save();
      o.strokeStyle = 'rgba(34,211,238,0.45)';
      o.setLineDash([4, 4]);
      o.beginPath(); o.moveTo(x0, y0); o.lineTo(x1, y1); o.stroke();
      o.restore();
      const dx = this.hover[0] - this.base[0], dy = this.hover[1] - this.base[1];
      const ang = ((Math.atan2(dy, dx) / DEG) + 360) % 360;
      const typed = this.ed.typed();
      label(o, x1, y1, typed ? typed : `${fmt(Math.hypot(dx, dy))} < ${ang.toFixed(1)}°`);
    } else if (this.hover && this.ed.typed()) {
      const [x1, y1] = v.worldToScreen(this.hover[0], this.hover[1]);
      label(o, x1, y1, this.ed.typed());
    }
    if (this.hover && this.snap) {
      const [sx, sy] = v.worldToScreen(this.hover[0], this.hover[1]);
      drawSnapMarker(o, sx, sy, this.snap.kind);
    }
  }

  /** World point (drawing coordinates) of a scene point. */
  w(p) { const o = this.ed.origin; return [p[0] + o.x, p[1] + o.y]; }
}

// ------------------------------------------------------------------ selection and grips
export class SelectTool {
  constructor(ed) {
    this.ed = ed;
    this.cursor = 'default';
    this.hover = null;
    this.drag0 = null; // window selection start
    this.drag1 = null;
    this.hot = null; // grip being edited { grip, item, from }
    this.hotPt = null;
    this.gripHover = null;
    this.snap = null;
    this.gripCache = null;
  }

  get prompt() { return this.hot ? 'Specify stretch point (or type coordinates):' : ''; }

  /** Grips of the selection (cached per selection and scene version). */
  grips() {
    const sel = this.ed.selection;
    const scene = this.ed.space?.scene;
    if (!scene || !sel.length || sel.length > GRIP_LIMIT) return [];
    const key = `${scene.version}|${sel.join(',')}`;
    if (this.gripCache?.key === key) return this.gripCache.grips;
    const o = scene.origin;
    const out = [];
    for (const id of sel) {
      const it = scene.items[id];
      if (!it || it.deleted || this.ed.isLocked(id)) continue;
      for (const g of gripsOf(it.ent, this.ed.gripEnv(it))) out.push({ ...g, item: id, sx: g.x - o.x, sy: g.y - o.y });
    }
    this.gripCache = { key, grips: out };
    return out;
  }

  gripAt(w, v) {
    const r = 7 / v.view.scale;
    let best = null, bd = r;
    for (const g of this.grips()) {
      const d = Math.max(Math.abs(g.sx - w[0]), Math.abs(g.sy - w[1]));
      if (d <= bd) { bd = d; best = g; }
    }
    return best;
  }

  pointFor(w) {
    const from = this.hot ? [this.hot.grip.sx, this.hot.grip.sy] : null;
    const s = this.ed.snapPoint(w, from, this.hot ? (id) => id === this.hot.grip.item && this.hot.grip.kind === 'move' : null);
    this.snap = s;
    if (s) return [s.x, s.y];
    return this.ed.ortho && from ? orthoPoint(from, w) : w;
  }

  move(w, s, v) {
    if (this.hot) { this.hotPt = this.pointFor(w); return; }
    this.gripHover = this.gripAt(w, v);
    this.hover = this.gripHover ? null : this.ed.pickAt(w[0], w[1], 6 / v.view.scale);
  }

  click(w, s, v, ev) {
    if (this.hot) {
      this.applyGrip(this.pointFor(w));
      return;
    }
    const g = this.gripAt(w, v);
    if (g) {
      this.hot = { grip: g };
      this.hotPt = [g.sx, g.sy];
      this.ed.refresh();
      return;
    }
    const id = this.ed.pickAt(w[0], w[1], 8 / v.view.scale);
    const sel = this.ed.selection;
    if (ev?.shiftKey) {
      if (id === null || id === undefined) return;
      this.ed.setSelection(sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]);
    } else this.ed.setSelection(id === null || id === undefined ? [] : [id]);
  }

  /** Left-drag selects (window/crossing) or drags a grip in CAD drawings; PDFs and images pan. */
  wantsDrag() { return !!this.ed.space; }

  drag(a, b, v) {
    if (!this.drag0 && !this.dragGrip) {
      const g = this.hot ? null : this.gripAt(a, v);
      if (g) { this.dragGrip = g; this.hot = { grip: g }; } else this.drag0 = a;
    }
    if (this.dragGrip) this.hotPt = this.pointFor(b);
    else this.drag1 = b;
  }

  dragEnd(a, b, v, p) {
    if (this.dragGrip) {
      this.dragGrip = null;
      this.applyGrip(this.pointFor(b));
      return;
    }
    const start = this.drag0;
    this.drag0 = this.drag1 = null;
    if (!start) return;
    // Left to right: window (fully inside); right to left: crossing (touching).
    const crossing = b[0] < start[0];
    const ids = this.ed.itemsInRect(rectOf(start, b), crossing);
    const sel = this.ed.selection;
    if (p?.shift) this.ed.setSelection([...new Set([...sel, ...ids])]);
    else this.ed.setSelection(ids);
  }

  applyGrip(pt) {
    const { grip } = this.hot;
    this.hot = null;
    this.hotPt = null;
    const o = this.ed.origin;
    this.ed.applyGrip(grip, pt[0] + o.x, pt[1] + o.y);
  }

  input(text) {
    if (!this.hot) return false;
    const o = this.ed.origin;
    const g = this.hot.grip;
    const dir = this.hotPt ? [this.hotPt[0] - g.sx, this.hotPt[1] - g.sy] : null;
    const p = parsePoint(text, { base: [g.x, g.y], dir, ortho: this.ed.ortho });
    if (!p) return false;
    this.applyGrip([p[0] - o.x, p[1] - o.y]);
    return true;
  }

  key(ev) {
    if (ev.key === 'Escape' && (this.hot || this.drag0)) { this.hot = null; this.hotPt = null; this.drag0 = this.drag1 = null; return true; }
    return false;
  }

  cancel() { this.hover = null; this.hot = null; this.drag0 = this.drag1 = null; this.dragGrip = null; }

  drawOverlay(o, v) {
    const d = v.dpr;
    if (this.hover !== null && this.hover !== undefined && !this.ed.selection.includes(this.hover)) {
      this.ed.drawItems(o, v, [this.hover], 'rgba(255,159,28,0.65)', 2);
    }
    if (this.hot && this.hotPt) {
      // Live preview of the grip edit.
      const it = this.ed.space?.scene.items[this.hot.grip.item];
      if (it) {
        const copy = cloneData(it.ent);
        const og = this.ed.origin;
        try {
          const g = gripsOf(copy, this.ed.gripEnv(it)).find((x) => Math.abs(x.x - this.hot.grip.x) < 1e-9 && Math.abs(x.y - this.hot.grip.y) < 1e-9);
          g?.apply(copy, this.hotPt[0] + og.x, this.hotPt[1] + og.y);
          this.ed.drawPreview(o, v, [copy]);
        } catch { /* preview only */ }
      }
    }
    o.setTransform(d, 0, 0, d, 0, 0);
    for (const g of this.grips()) {
      const [x, y] = v.worldToScreen(g.sx, g.sy);
      const hot = this.hot?.grip === g;
      o.fillStyle = hot ? GRIP_HOT : this.gripHover === g ? GRIP_HOVER : GRIP;
      o.strokeStyle = '#fff';
      o.lineWidth = 1;
      o.fillRect(x - 4.5, y - 4.5, 9, 9);
      o.strokeRect(x - 4.5, y - 4.5, 9, 9);
    }
    if (this.hot && this.hotPt) {
      const [x0, y0] = v.worldToScreen(this.hot.grip.sx, this.hot.grip.sy);
      const [x1, y1] = v.worldToScreen(this.hotPt[0], this.hotPt[1]);
      o.save(); o.strokeStyle = RUBBER; o.setLineDash([4, 4]); o.beginPath(); o.moveTo(x0, y0); o.lineTo(x1, y1); o.stroke(); o.restore();
      if (this.snap) drawSnapMarker(o, x1, y1, this.snap.kind);
      label(o, x1, y1, this.ed.typed() || `${fmt(Math.hypot(this.hotPt[0] - this.hot.grip.sx, this.hotPt[1] - this.hot.grip.sy))}`);
    }
    if (this.drag0 && this.drag1) drawSelectionRect(o, v, this.drag0, this.drag1);
  }
}

/** Pan tool: left-drag pans (for touchpads without a middle button). */
export class PanTool {
  constructor() { this.cursor = 'grab'; }
}

// ------------------------------------------------------------------ drawing tools
export class LineTool extends EditTool {
  constructor(ed) { super(ed, 'Line'); this.made = []; }
  get prompt() {
    if (!this.pts.length) return 'LINE  Specify first point:';
    return `LINE  Specify next point or [${this.pts.length >= 3 ? 'Close/' : ''}Undo]:`;
  }
  point(p) {
    if (this.pts.length) {
      const a = this.base;
      if (Math.hypot(p[0] - a[0], p[1] - a[1]) < 1e-12) return;
      this.made.push(this.ed.add([makeLine(this.ed.env(), this.w(a), this.w(p))], 'Line'));
    }
    this.pts.push(p);
  }
  input(text) {
    const t = text.trim().toUpperCase();
    if (t === '') { this.ed.done(); return true; }
    if (t === 'U') { this.undoPoint(); return true; }
    if (t === 'C' && this.pts.length >= 3) { this.point(this.pts[0]); this.ed.done(); return true; }
    return super.input(text);
  }
  undoPoint() {
    if (!this.pts.length) return false;
    this.pts.pop();
    if (this.made.length && this.pts.length) this.ed.undoIfLast(this.made.pop());
    return true;
  }
  reset() { this.pts = []; this.made = []; }
  preview() { return this.base && this.hover ? [makeLine(this.ed.previewEnv(), this.w(this.base), this.w(this.hover))] : []; }
}

export class PolylineTool extends EditTool {
  constructor(ed) { super(ed, 'Polyline'); }
  get prompt() {
    if (!this.pts.length) return 'PLINE  Specify start point:';
    return `PLINE  Specify next point or [${this.pts.length >= 2 ? 'Close/' : ''}Undo], Enter to finish:`;
  }
  point(p) {
    const b = this.base;
    if (b && Math.hypot(p[0] - b[0], p[1] - b[1]) < 1e-12) return;
    this.pts.push(p);
  }
  finish(closed) {
    if (this.pts.length >= 2) {
      const verts = this.pts.map((p) => { const [x, y] = this.w(p); return { x, y, bulge: 0 }; });
      this.ed.add([makeLwPolyline(this.ed.env(), verts, closed && this.pts.length >= 3)], 'Polyline');
    }
    this.reset();
  }
  input(text) {
    const t = text.trim().toUpperCase();
    if (t === '') { this.finish(false); this.ed.done(); return true; }
    if (t === 'C') { this.finish(true); this.ed.done(); return true; }
    if (t === 'U') { this.undoPoint(); return true; }
    return super.input(text);
  }
  dblclick() { this.finish(false); this.ed.done(); return true; }
  /** Esc or another tool keeps the polyline drawn so far (like AutoCAD). */
  cancel() { if (this.pts.length >= 2) this.finish(false); super.cancel(); }
  preview() {
    const pts = this.hover ? [...this.pts, this.hover] : this.pts;
    if (pts.length < 2) return [];
    return [makeLwPolyline(this.ed.previewEnv(), pts.map((p) => { const [x, y] = this.w(p); return { x, y, bulge: 0 }; }), false)];
  }
}

export class RectangleTool extends EditTool {
  constructor(ed) { super(ed, 'Rectangle'); }
  get prompt() { return this.pts.length ? 'RECTANG  Specify other corner (e.g. @2000,1000):' : 'RECTANG  Specify first corner:'; }
  point(p) {
    if (!this.pts.length) { this.pts.push(p); return; }
    const a = this.pts[0];
    if (Math.abs(p[0] - a[0]) > 1e-12 && Math.abs(p[1] - a[1]) > 1e-12) this.ed.add([makeRectangle(this.ed.env(), this.w(a), this.w(p))], 'Rectangle');
    this.ed.done();
  }
  input(text) { if (!text.trim()) { this.ed.done(); return true; } return super.input(text); }
  preview() { return this.base && this.hover ? [makeRectangle(this.ed.previewEnv(), this.w(this.base), this.w(this.hover))] : []; }
}

export class CircleTool extends EditTool {
  constructor(ed) { super(ed, 'Circle'); }
  get prompt() { return this.pts.length ? 'CIRCLE  Specify radius (or click a point on the circle):' : 'CIRCLE  Specify center point:'; }
  point(p) {
    if (!this.pts.length) { this.pts.push(p); return; }
    this.make(Math.hypot(p[0] - this.base[0], p[1] - this.base[1]));
  }
  make(r) {
    if (!(r > 0)) return false;
    this.ed.add([makeCircle(this.ed.env(), this.w(this.base), r)], 'Circle');
    this.ed.done();
    return true;
  }
  input(text) {
    if (!text.trim()) { this.ed.done(); return true; }
    const n = parseNumber(text);
    if (n !== null && this.pts.length) return this.make(n);
    return super.input(text);
  }
  preview() {
    if (!this.base || !this.hover) return [];
    const r = Math.hypot(this.hover[0] - this.base[0], this.hover[1] - this.base[1]);
    return r > 0 ? [makeCircle(this.ed.previewEnv(), this.w(this.base), r)] : [];
  }
}

export class ArcTool extends EditTool {
  constructor(ed) { super(ed, 'Arc'); }
  get prompt() { return ['ARC  Specify start point:', 'ARC  Specify second point:', 'ARC  Specify end point:'][this.pts.length] ?? ''; }
  arcOf(p3) {
    const [a, b] = this.pts;
    const arc = arcFrom3(this.w(a), this.w(b), this.w(p3));
    return arc ? makeArc(this.pts.length === 2 ? this.ed.env() : this.ed.previewEnv(), arc.center, arc.radius, arc.startAngle, arc.endAngle) : null;
  }
  point(p) {
    if (this.pts.length < 2) { this.pts.push(p); return; }
    const arc = this.arcOf(p);
    if (!arc) { this.ed.message('The three points are on one line.'); return; }
    this.ed.add([arc], 'Arc');
    this.ed.done();
  }
  input(text) { if (!text.trim()) { this.ed.done(); return true; } return super.input(text); }
  preview() {
    if (!this.hover || !this.pts.length) return [];
    if (this.pts.length === 1) return [makeLine(this.ed.previewEnv(), this.w(this.pts[0]), this.w(this.hover))];
    const [a, b] = this.pts;
    const arc = arcFrom3(this.w(a), this.w(b), this.w(this.hover));
    return arc ? [makeArc(this.ed.previewEnv(), arc.center, arc.radius, arc.startAngle, arc.endAngle)] : [];
  }
}

/** Single-line text: insertion point, height, rotation, then the text (Enter on an empty line ends). */
export class TextTool extends EditTool {
  constructor(ed) {
    super(ed, 'Text');
    this.stage = 'point';
    this.height = ed.textHeight();
    this.rotation = 0;
  }
  get inputKind() { return this.stage === 'text' ? 'text' : 'value'; }
  get prompt() {
    switch (this.stage) {
      case 'point': return 'TEXT  Specify start point of text:';
      case 'height': return `TEXT  Specify height <${fmt(this.height)}>:`;
      case 'rotation': return `TEXT  Specify rotation angle of text <${fmt(this.rotation / DEG)}>:`;
      default: return 'TEXT  Enter text (Enter on an empty line to finish):';
    }
  }
  get base() { return this.stage === 'point' ? null : this.pts[0] ?? null; }
  point(p) {
    if (this.stage === 'point') { this.pts = [p]; this.stage = 'height'; return; }
    const d = Math.hypot(p[0] - this.pts[0][0], p[1] - this.pts[0][1]);
    if (this.stage === 'height' && d > 0) { this.height = d; this.stage = 'rotation'; return; }
    if (this.stage === 'rotation') { this.rotation = Math.atan2(p[1] - this.pts[0][1], p[0] - this.pts[0][0]); this.stage = 'text'; }
  }
  input(text) {
    if (this.stage === 'text') {
      if (!text.length) { this.ed.done(); return true; }
      this.ed.add([makeText(this.ed.env(), this.w(this.pts[0]), this.height, this.rotation, text)], 'Text');
      this.ed.setTextHeight(this.height);
      // The next line goes below, like AutoCAD's TEXT command.
      const gap = this.height * 1.667;
      this.pts[0] = [this.pts[0][0] + Math.sin(this.rotation) * gap, this.pts[0][1] - Math.cos(this.rotation) * gap];
      return true;
    }
    if (this.stage === 'height' || this.stage === 'rotation') {
      if (!text.trim()) { this.stage = this.stage === 'height' ? 'rotation' : 'text'; return true; }
      const n = parseNumber(text);
      if (n === null) return false;
      if (this.stage === 'height') { if (!(n > 0)) return false; this.height = n; this.stage = 'rotation'; } else { this.rotation = n * DEG; this.stage = 'text'; }
      return true;
    }
    if (!text.trim()) { this.ed.done(); return true; }
    return super.input(text);
  }
  undoPoint() { return false; }
  preview() {
    const at = this.stage === 'point' ? this.hover : this.pts[0];
    if (!at) return [];
    const typed = this.stage === 'text' ? this.ed.typed() : '';
    let rot = this.rotation;
    if (this.stage === 'rotation' && this.hover) rot = Math.atan2(this.hover[1] - at[1], this.hover[0] - at[0]);
    let h = this.height;
    if (this.stage === 'height' && this.hover) h = Math.hypot(this.hover[0] - at[0], this.hover[1] - at[1]) || h;
    return [makeText(this.ed.previewEnv(), this.w(at), h, rot, typed || 'Text')];
  }
}

/** Revision cloud around a rectangle; type A to set the arc length first. */
export class RevCloudTool extends EditTool {
  constructor(ed) { super(ed, 'Revision cloud'); this.arc = 0; this.askArc = false; }
  get prompt() {
    if (this.askArc) return 'REVCLOUD  Specify arc length:';
    return this.pts.length ? 'REVCLOUD  Specify opposite corner:' : `REVCLOUD  Specify first corner or [Arc length${this.arc ? ' <' + fmt(this.arc) + '>' : ''}]:`;
  }
  point(p) {
    if (!this.pts.length) { this.pts.push(p); return; }
    const a = this.pts[0];
    if (Math.abs(p[0] - a[0]) > 1e-12 && Math.abs(p[1] - a[1]) > 1e-12) this.ed.add([makeRevisionCloud(this.ed.env(), this.w(a), this.w(p), this.arc)], 'Revision cloud');
    this.ed.done();
  }
  input(text) {
    const t = text.trim().toUpperCase();
    if (this.askArc) {
      const n = parseNumber(text);
      if (n === null || !(n > 0)) return false;
      this.arc = n; this.askArc = false;
      return true;
    }
    if (t === 'A' && !this.pts.length) { this.askArc = true; return true; }
    if (!t) { this.ed.done(); return true; }
    return super.input(text);
  }
  preview() { return this.base && this.hover ? [makeRevisionCloud(this.ed.previewEnv(), this.w(this.base), this.w(this.hover), this.arc)] : []; }
}

// ------------------------------------------------------------------ modify tools
/**
 * Base of the tools that act on a selection. Without a selection they first ask for one:
 * click objects (Shift+click removes), click two corners for a window/crossing, Enter to go on.
 */
class ModifyTool extends EditTool {
  constructor(ed, name) {
    super(ed, name);
    this.selecting = !ed.selection.length;
    this.win = null;
  }
  get selectPrompt() { return `${this.name.toUpperCase()}  Select objects (${this.ed.selection.length} selected), Enter when done:`; }
  get prompt() { return this.selecting ? this.selectPrompt : this.stepPrompt; }
  wantsDrag() { return this.selecting; }
  drag(a, b) { if (this.selecting) { this.win = [a, b]; } }
  dragEnd(a, b, v, p) { if (this.selecting) { this.win = null; this.addWindow(a, b, p?.shift); } }
  addWindow(a, b, remove) {
    const ids = this.ed.itemsInRect(rectOf(a, b), b[0] < a[0]);
    const sel = this.ed.selection;
    this.ed.setSelection(remove ? sel.filter((x) => !ids.includes(x)) : [...new Set([...sel, ...ids])]);
  }
  move(w, s, v) {
    if (this.selecting) { this.hover = w; if (this.win0) this.win = [this.win0, w]; return; }
    super.move(w, s, v);
  }
  click(w, s, v, ev) {
    if (!this.selecting) { super.click(w, s, v, ev); return; }
    if (this.win0) { const a = this.win0; this.win0 = null; this.win = null; this.addWindow(a, w, ev?.shiftKey); return; }
    const id = this.ed.pickAt(w[0], w[1], 8 / v.view.scale);
    if (id === null || id === undefined) { this.win0 = w; return; }
    const sel = this.ed.selection;
    this.ed.setSelection(ev?.shiftKey ? sel.filter((x) => x !== id) : sel.includes(id) ? sel : [...sel, id]);
  }
  input(text) {
    if (this.selecting) {
      if (text.trim()) return false;
      if (!this.ed.selection.length) { this.ed.done(); return true; }
      this.selecting = false;
      this.started();
      return true;
    }
    return this.step(text);
  }
  started() {}
  step(text) { return this.pointInput(text); }
  contextmenu() { this.input(''); this.ed.refresh(); }
  get ents() { return this.ed.selectedEntities(); }
  drawOverlay(o, v) {
    super.drawOverlay(o, v);
    if (this.win) { o.setTransform(v.dpr, 0, 0, v.dpr, 0, 0); drawSelectionRect(o, v, this.win[0], this.win[1]); }
  }
}

/** Move and copy: base point, then second point(s). */
export class MoveTool extends ModifyTool {
  constructor(ed, copy = false) { super(ed, copy ? 'Copy' : 'Move'); this.copy = copy; if (!this.selecting) this.started(); }
  get stepPrompt() {
    return this.pts.length ? `${this.name.toUpperCase()}  Specify second point${this.copy ? ' (Enter to finish)' : ''}:` : `${this.name.toUpperCase()}  Specify base point:`;
  }
  point(p) {
    if (!this.pts.length) { this.pts.push(p); return; }
    const b = this.pts[0];
    const M = moveMatrix(p[0] - b[0], p[1] - b[1]);
    if (this.copy) this.ed.copySelection(M);
    else { this.ed.transformSelection(M, 'Move'); this.ed.done(); }
  }
  step(text) {
    if (!text.trim()) { this.ed.done(); return true; }
    return this.pointInput(text);
  }
  undoPoint() { return false; }
  drawOverlay(o, v) {
    if (!this.selecting && this.pts.length && this.hover) {
      const b = this.pts[0];
      this.ed.drawSelectionMoved(o, v, moveMatrix(this.hover[0] - b[0], this.hover[1] - b[1]));
    }
    super.drawOverlay(o, v);
  }
}

/** Rotate: base point, then angle (click or type degrees). */
export class RotateTool extends ModifyTool {
  constructor(ed) { super(ed, 'Rotate'); }
  get stepPrompt() { return this.pts.length ? 'ROTATE  Specify rotation angle (degrees, counter-clockwise):' : 'ROTATE  Specify base point:'; }
  angleTo(p) { const b = this.pts[0]; return Math.atan2(p[1] - b[1], p[0] - b[0]); }
  point(p) {
    if (!this.pts.length) { this.pts.push(p); return; }
    this.apply(this.angleTo(p));
  }
  apply(a) {
    const [bx, by] = this.w(this.pts[0]);
    this.ed.transformSelection(rotateMatrix(bx, by, a), 'Rotate');
    this.ed.done();
  }
  step(text) {
    if (!text.trim()) { this.ed.done(); return true; }
    const n = parseNumber(text);
    if (n !== null && this.pts.length) { this.apply(n * DEG); return true; }
    return this.pointInput(text);
  }
  pointFor(w) { return this.pts.length ? (this.ed.ortho ? orthoPoint(this.pts[0], w) : w) : super.pointFor(w); }
  drawOverlay(o, v) {
    if (!this.selecting && this.pts.length && this.hover) {
      const b = this.pts[0];
      const typed = parseNumber(this.ed.typed());
      this.ed.drawSelectionMoved(o, v, rotateMatrix(b[0], b[1], typed !== null ? typed * DEG : this.angleTo(this.hover)));
    }
    super.drawOverlay(o, v);
  }
}

/** Scale: base point, then factor (typed, or the distance from the base point). */
export class ScaleTool extends ModifyTool {
  constructor(ed) { super(ed, 'Scale'); }
  get stepPrompt() { return this.pts.length ? 'SCALE  Specify scale factor:' : 'SCALE  Specify base point:'; }
  point(p) {
    if (!this.pts.length) { this.pts.push(p); return; }
    const k = Math.hypot(p[0] - this.pts[0][0], p[1] - this.pts[0][1]);
    if (k > 0) this.apply(k);
  }
  apply(k) {
    const [bx, by] = this.w(this.pts[0]);
    this.ed.transformSelection(scaleMatrix(bx, by, k), 'Scale');
    this.ed.done();
  }
  step(text) {
    if (!text.trim()) { this.ed.done(); return true; }
    const n = parseNumber(text);
    if (n !== null && this.pts.length) { if (!(n > 0)) return false; this.apply(n); return true; }
    return this.pointInput(text);
  }
  drawOverlay(o, v) {
    if (!this.selecting && this.pts.length && this.hover) {
      const b = this.pts[0];
      const typed = parseNumber(this.ed.typed());
      const k = typed > 0 ? typed : Math.hypot(this.hover[0] - b[0], this.hover[1] - b[1]);
      if (k > 0) this.ed.drawSelectionMoved(o, v, scaleMatrix(b[0], b[1], k));
    }
    super.drawOverlay(o, v);
  }
}

/** Mirror: two points of the mirror line, then whether to erase the source objects. */
export class MirrorTool extends ModifyTool {
  constructor(ed) { super(ed, 'Mirror'); this.ask = false; }
  get stepPrompt() {
    if (this.ask) return 'MIRROR  Erase source objects? [Yes/No] <No>:';
    return this.pts.length ? 'MIRROR  Specify second point of mirror line:' : 'MIRROR  Specify first point of mirror line:';
  }
  point(p) {
    if (this.ask) return;
    if (!this.pts.length) { this.pts.push(p); return; }
    if (Math.hypot(p[0] - this.pts[0][0], p[1] - this.pts[0][1]) < 1e-12) return;
    this.pts.push(p);
    this.ask = true;
  }
  step(text) {
    if (this.ask) {
      const t = text.trim().toUpperCase();
      if (t && t !== 'Y' && t !== 'YES' && t !== 'N' && t !== 'NO') return false;
      const [a, b] = this.pts;
      const M = mirrorMatrix(...this.w(a), ...this.w(b));
      if (t.startsWith('Y')) this.ed.transformSelection(M, 'Mirror');
      else this.ed.copySelection(M, 'Mirror');
      this.ed.done();
      return true;
    }
    if (!text.trim()) { this.ed.done(); return true; }
    return this.pointInput(text);
  }
  get base() { return this.ask ? null : this.pts.at(-1) ?? null; }
  drawOverlay(o, v) {
    if (!this.selecting && this.pts.length && (this.hover || this.ask)) {
      const a = this.pts[0], b = this.ask ? this.pts[1] : this.hover;
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 1e-12) this.ed.drawSelectionMoved(o, v, mirrorMatrix(a[0], a[1], b[0], b[1]));
    }
    super.drawOverlay(o, v);
  }
}

/** Offset: distance (typed or two clicks), then repeatedly an object and a side. */
export class OffsetTool extends EditTool {
  constructor(ed) {
    super(ed, 'Offset');
    this.dist = ed.lastOffset();
    this.stage = 'dist';
    this.target = null;
  }
  get prompt() {
    if (this.stage === 'dist') return `OFFSET  Specify offset distance${this.dist ? ` <${fmt(this.dist)}>` : ''}:`;
    if (this.stage === 'pick') return 'OFFSET  Select line, polyline, circle or arc to offset (Enter to finish):';
    return 'OFFSET  Specify point on side to offset:';
  }
  get base() { return this.stage === 'dist' ? this.pts.at(-1) ?? null : null; }
  click(w, s, v) {
    if (this.stage === 'pick') {
      const id = this.ed.pickAt(w[0], w[1], 8 / v.view.scale);
      const it = id !== null && id !== undefined ? this.ed.space.scene.items[id] : null;
      if (!it) return;
      if (!['LINE', 'LWPOLYLINE', 'POLYLINE2D', 'CIRCLE', 'ARC'].includes(it.ent.type)) { this.ed.message(`${it.ent.type} cannot be offset (lines, polylines, circles and arcs can).`); return; }
      this.target = it;
      this.ed.setSelection([id]);
      this.stage = 'side';
      return;
    }
    if (this.stage === 'side') { this.side(w); return; }
    super.click(w, s, v);
  }
  move(w) {
    if (this.stage === 'dist') super.move(w);
    else { this.hover = w; this.snap = null; }
  }
  point(p) {
    if (this.stage !== 'dist') return;
    if (!this.pts.length) { this.pts.push(p); return; }
    const d = Math.hypot(p[0] - this.pts[0][0], p[1] - this.pts[0][1]);
    if (d > 0) { this.dist = d; this.stage = 'pick'; this.pts = []; }
  }
  side(w) {
    const n = this.ed.offset(this.target.ent, this.dist, this.w(w));
    if (!n) this.ed.message('The offset is not possible at this distance.');
    this.stage = 'pick';
    this.target = null;
    this.ed.setSelection([]);
  }
  input(text) {
    if (this.stage === 'dist') {
      if (!text.trim() && this.dist > 0) { this.stage = 'pick'; return true; }
      const n = parseNumber(text);
      if (n !== null && n > 0) { this.dist = n; this.ed.setLastOffset(n); this.stage = 'pick'; this.pts = []; return true; }
      return super.input(text);
    }
    if (!text.trim()) { this.ed.done(); return true; }
    return false;
  }
  preview() {
    if (this.stage !== 'side' || !this.hover || !this.target) return [];
    const n = offsetEntity(this.target.ent, this.dist, this.w(this.hover));
    return n ? [{ ...n, colorIndex: 256 }] : [];
  }
}

/** Erase and Explode act at once on the selection (or ask for one first). */
export class ImmediateTool extends ModifyTool {
  constructor(ed, name, run) { super(ed, name); this.run = run; if (!this.selecting) queueMicrotask(() => this.started()); }
  get stepPrompt() { return ''; }
  started() { this.run(); this.ed.done(); }
}
