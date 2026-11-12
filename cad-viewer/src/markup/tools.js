// Viewer tools for markups: drawing each markup type, and selecting / moving / resizing.
// `env` = { viewer, store, page(), style(), selected (id | null), select(id), editText(m, isNew), created(m), hide }
import { drawMarkup, hitTest, handlesOf, dragHandle, moveMarkup, clone, newId, HAS_TEXT, boxOf } from './markup.js';

const GRIP = 5; // css px

/** Draws markups being drawn or dragged (world transform) and a selection frame with grips. */
function drawPreview(o, viewer, m) {
  o.save();
  viewer.applyTransform(o);
  drawMarkup(o, m);
  o.restore();
}

export function drawGrips(o, viewer, m) {
  const d = viewer.dpr;
  o.save();
  o.setTransform(d, 0, 0, d, 0, 0);
  o.strokeStyle = '#0ea5e9';
  o.fillStyle = '#ffffff';
  o.lineWidth = 1.5;
  for (const [x, y] of handlesOf(m)) {
    const [sx, sy] = viewer.worldToScreen(x, y);
    o.beginPath();
    o.rect(sx - GRIP, sy - GRIP, GRIP * 2, GRIP * 2);
    o.fill();
    o.stroke();
  }
  o.restore();
}

/** Topmost markup of the current page under world point `w`. */
export function pickMarkup(env, w, viewer) {
  const tol = 5 / viewer.view.scale;
  const list = env.store.page(env.page());
  for (let i = list.length - 1; i >= 0; i--) if (hitTest(list[i], w, tol)) return list[i];
  return null;
}

/** Select tool on sheets: click picks a markup, drag moves it or a grip, double-click edits text. */
export class MarkupSelectTool {
  constructor(env) {
    this.env = env;
    this.cursor = 'default';
    this.action = null; // { kind: 'move' | 'grip', orig, i }
    this.preview = null;
  }

  gripAt(w, viewer) {
    const m = this.env.selected && this.env.store.get(this.env.selected);
    if (!m) return null;
    const [sx, sy] = viewer.worldToScreen(w[0], w[1]);
    const hs = handlesOf(m);
    for (let i = 0; i < hs.length; i++) {
      const [hx, hy] = viewer.worldToScreen(hs[i][0], hs[i][1]);
      if (Math.abs(hx - sx) <= GRIP + 2 && Math.abs(hy - sy) <= GRIP + 2) return { m, i };
    }
    return null;
  }

  // Dragging on a markup (or a grip of the selected one) edits it; anywhere else pans.
  wantsDrag(w) {
    const viewer = this.env.viewer;
    const g = this.gripAt(w, viewer);
    if (g) { this.action = { kind: 'grip', orig: clone(g.m), i: g.i }; return true; }
    const m = pickMarkup(this.env, w, viewer);
    if (m) {
      this.env.select(m.id);
      this.action = { kind: 'move', orig: clone(m) };
      return true;
    }
    this.action = null;
    return false;
  }

  move(w, s, viewer) {
    const over = this.gripAt(w, viewer) ? 'crosshair' : pickMarkup(this.env, w, viewer) ? 'move' : 'default';
    if (over !== this.cursor) { this.cursor = over; viewer.updateCursor(); }
  }

  drag(a, b) {
    const act = this.action;
    if (!act) return;
    this.preview = act.kind === 'move' ? moveMarkup(clone(act.orig), b[0] - a[0], b[1] - a[1]) : dragHandle(act.orig, act.i, b);
    this.env.hide = act.orig.id;
  }

  dragEnd(a, b) {
    this.drag(a, b);
    const p = this.preview;
    this.preview = null;
    this.env.hide = null;
    if (p && this.action) this.env.store.replace(p, this.action.kind === 'move' ? 'Move markup' : 'Resize markup');
    this.action = null;
  }

  click(w, s, viewer) {
    const m = pickMarkup(this.env, w, viewer);
    this.env.select(m ? m.id : null);
  }

  dblclick(viewer, ev) {
    const r = viewer.overlay.getBoundingClientRect();
    const w = viewer.screenToWorld(ev.clientX - r.left, ev.clientY - r.top);
    const m = pickMarkup(this.env, w, viewer);
    if (m && HAS_TEXT.has(m.type)) { this.env.select(m.id); this.env.editText(m, false); return true; }
    return !!m;
  }

  key(ev) {
    const id = this.env.selected;
    if (id && (ev.key === 'Delete' || ev.key === 'Backspace')) {
      this.env.store.remove([id]);
      this.env.select(null);
      return true;
    }
    return false;
  }

  drawOverlay(o, viewer) {
    if (this.preview) { drawPreview(o, viewer, this.preview); drawGrips(o, viewer, this.preview); return; }
    const m = this.env.selected && this.env.store.get(this.env.selected);
    if (m && m.page === this.env.page()) drawGrips(o, viewer, m);
  }

  cancel() { this.preview = null; this.action = null; this.env.hide = null; }
}

/** Default size (world units) of a text box or stamp placed with a click. */
const clickBox = (type, st) => (type === 'stamp' ? [st.fontSize * 15, st.fontSize * 5] : [st.fontSize * 16, st.fontSize * 3]);

/**
 * Draws one markup type. Drag (or click, click) for two-point shapes and boxes, drag for the pen,
 * clicks for a polygon cloud (double-click / Enter / right-click finishes), click to place a stamp
 * or a text box. Text boxes and callouts open the text editor when placed.
 */
export class MarkupDrawTool {
  constructor(type, env, opts = {}) {
    this.type = type;
    this.env = env;
    this.poly = type === 'cloud' && opts.cloud === 'poly';
    this.cursor = 'crosshair';
    this.pts = [];
    this.first = null;
    this.hover = null;
    this.stroke = null;
  }

  make(pts) {
    const st = this.env.style();
    const m = {
      id: newId(), type: this.type, page: this.env.page(), pts,
      color: st.color, width: st.width, fill: st.fill, opacity: st.opacity, fontSize: st.fontSize,
      author: st.author, date: new Date().toISOString(), text: '',
    };
    if (this.type === 'highlight') { m.color = st.highlight; m.fill = st.highlight; m.opacity = 0.35; m.width = 0; }
    if (this.type === 'stamp') { m.text = st.stamp; m.fill = null; }
    if (this.type === 'cloud') m.arc = st.fontSize * 0.8;
    if (this.type === 'text' || this.type === 'callout') m.width = Math.min(m.width, st.fontSize / 8);
    return m;
  }

  wantsDrag() { return !this.poly; }

  drag(a, b) {
    if (this.type === 'pen') {
      if (!this.stroke) this.stroke = [a];
      const last = this.stroke[this.stroke.length - 1];
      if (Math.hypot(b[0] - last[0], b[1] - last[1]) * this.env.viewer.view.scale > 1.5) this.stroke.push(b);
      this.preview = this.make(this.stroke);
      return;
    }
    this.preview = this.shapeFrom(a, b);
  }

  dragEnd(a, b) {
    if (this.type === 'pen') {
      this.drag(a, b);
      const pts = this.stroke;
      this.stroke = null;
      this.preview = null;
      if (pts && pts.length > 1) this.finish(this.make(pts));
      return;
    }
    this.preview = null;
    this.first = null;
    const m = this.shapeFrom(a, b);
    if (m) this.finish(m);
  }

  /** Markup spanning a → b (callout: tip at a, text box at b). */
  shapeFrom(a, b) {
    const st = this.env.style();
    if (this.type === 'callout') {
      const [bw, bh] = clickBox('text', st);
      const right = b[0] >= a[0];
      return this.make([a, [b[0] + (right ? 0 : -bw), b[1] - bh / 2], [b[0] + (right ? bw : 0), b[1] + bh / 2]]);
    }
    if (this.type === 'cloud') return this.make([[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]]);
    return this.make([a, b]);
  }

  click(w, s, viewer) {
    this.scale = viewer.view.scale;
    if (this.poly) { this.pts.push(w); return; }
    if (this.type === 'stamp' || this.type === 'text') {
      const [bw, bh] = clickBox(this.type, this.env.style());
      this.finish(this.make([[w[0] - (this.type === 'stamp' ? bw / 2 : 0), w[1] - bh / 2], [w[0] + (this.type === 'stamp' ? bw / 2 : bw), w[1] + bh / 2]]));
      return;
    }
    if (this.type === 'pen') return;
    if (!this.first) { this.first = w; return; }
    const m = this.shapeFrom(this.first, w);
    this.first = null;
    this.preview = null;
    this.finish(m);
  }

  move(w, s, viewer) {
    this.scale = viewer.view.scale;
    this.hover = w;
    if (this.first) this.preview = this.shapeFrom(this.first, w);
  }

  finishPoly() {
    const pts = this.pts;
    this.pts = [];
    if (pts.length >= 3) this.finish(this.make(pts));
  }

  dblclick() {
    if (!this.poly) return false;
    // The double-click's two clicks added the same point twice.
    if (this.pts.length > 1) {
      const [a, b] = this.pts.slice(-2);
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) * (this.scale || 1) < 4) this.pts.pop();
    }
    this.finishPoly();
    return true;
  }

  contextmenu() { if (this.poly) this.finishPoly(); }

  key(ev) {
    if (ev.key === 'Enter' && this.poly) { this.finishPoly(); return true; }
    if (ev.key === 'Backspace' && this.pts.length) { this.pts.pop(); return true; }
    if (ev.key === 'Escape' && (this.pts.length || this.first)) { this.cancel(); return true; }
    return false;
  }

  finish(m) {
    const b = m.type === 'pen' || m.type === 'cloud' || m.type === 'line' || m.type === 'arrow' ? null : boxOf(m);
    // Ignore accidental zero-size shapes.
    if (b && (b[2] - b[0] <= 0 || b[3] - b[1] <= 0)) return;
    this.env.store.add(m);
    this.env.created(m);
    if (m.type === 'text' || m.type === 'callout') this.env.editText(m, true);
  }

  cancel() { this.pts = []; this.first = null; this.preview = null; this.stroke = null; }

  drawOverlay(o, viewer) {
    this.scale = viewer.view.scale;
    let m = this.preview;
    if (this.poly && this.pts.length) {
      const pts = this.hover ? [...this.pts, this.hover] : this.pts;
      if (pts.length >= 3) m = this.make(pts);
      else {
        const d = viewer.dpr;
        o.save();
        o.setTransform(d, 0, 0, d, 0, 0);
        o.strokeStyle = this.env.style().color;
        o.setLineDash([5, 4]);
        o.beginPath();
        pts.forEach(([x, y], i) => { const [sx, sy] = viewer.worldToScreen(x, y); if (i) o.lineTo(sx, sy); else o.moveTo(sx, sy); });
        o.stroke();
        o.restore();
      }
    }
    if (m) drawPreview(o, viewer, m);
  }
}
