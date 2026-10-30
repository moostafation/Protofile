// Interactive tools: select, zoom window, rectangle pick, and measurements with snapping.
import { polygonArea } from '../cad/geometry.js';
import { t } from '../i18n.js';

const ACCENT = '#ff9f1c';
const MEASURE = '#22d3ee';

export function formatLength(v, unit) {
  const abs = Math.abs(v);
  const digits = abs >= 1000 ? 1 : abs >= 10 ? 2 : 3;
  let s = `${v.toLocaleString('en-US', { maximumFractionDigits: digits })}${unit ? ' ' + unit : ''}`;
  if (unit === 'mm' && abs >= 1000) s += ` (${(v / 1000).toLocaleString('en-US', { maximumFractionDigits: 3 })} m)`;
  return s;
}

export function formatArea(v, unit) {
  if (unit === 'mm') return `${(v / 1e6).toLocaleString('en-US', { maximumFractionDigits: 3 })} m²`;
  if (unit === 'cm') return `${(v / 1e4).toLocaleString('en-US', { maximumFractionDigits: 3 })} m²`;
  return `${v.toLocaleString('en-US', { maximumFractionDigits: 3 })}${unit ? ' ' + unit + '²' : ''}`;
}

function label(o, x, y, text, color = MEASURE) {
  o.font = '600 12px system-ui, sans-serif';
  o.direction = 'ltr';
  const lines = text.split('\n');
  const w = Math.max(...lines.map((l) => o.measureText(l).width)) + 10;
  const h = lines.length * 16 + 6;
  o.fillStyle = 'rgba(15,18,24,0.88)';
  o.strokeStyle = color;
  o.lineWidth = 1;
  o.beginPath();
  o.roundRect(x + 8, y - h - 6, w, h, 4);
  o.fill();
  o.stroke();
  o.fillStyle = '#fff';
  lines.forEach((l, i) => o.fillText(l, x + 13, y - h + 9 + i * 16));
}

export function drawSnapMarker(o, sx, sy, kind) {
  o.save();
  o.strokeStyle = ACCENT;
  o.lineWidth = 2;
  o.beginPath();
  if (kind === 'end' || kind === 'ins') o.rect(sx - 6, sy - 6, 12, 12);
  else if (kind === 'center') o.arc(sx, sy, 7, 0, Math.PI * 2);
  else if (kind === 'mid') { o.moveTo(sx, sy - 7); o.lineTo(sx + 7, sy + 6); o.lineTo(sx - 7, sy + 6); o.closePath(); }
  else { o.moveTo(sx - 6, sy - 6); o.lineTo(sx + 6, sy + 6); o.moveTo(sx + 6, sy - 6); o.lineTo(sx - 6, sy + 6); }
  o.stroke();
  o.restore();
}

/** Select tool: click picks an entity, hover highlights it. */
export class SelectTool {
  constructor(app) {
    this.app = app;
    this.cursor = 'default';
    this.hover = null;
  }
  move(w, s, viewer) {
    const r = 6 / viewer.view.scale;
    this.hover = this.app.pickAt(w[0], w[1], r);
  }
  click(w, s, viewer) {
    const r = 8 / viewer.view.scale;
    this.app.select(this.app.pickAt(w[0], w[1], r));
  }
  drawOverlay(o, viewer) {
    if (this.hover !== null && this.hover !== undefined && !this.app.selection.includes(this.hover)) {
      this.app.drawItemsOverlay(o, viewer, [this.hover], 'rgba(255,159,28,0.65)', 2);
    }
  }
  cancel() { this.hover = null; }
}

/** Drag (or click twice) to define a rectangle. Used for zoom window and plot window. */
export class RectTool {
  constructor(onRect, hint) {
    this.onRect = onRect;
    this.hint = hint;
    this.cursor = 'crosshair';
    this.a = null;
    this.b = null;
    this.first = null;
  }
  drag(a, b) { this.a = a; this.b = b; }
  dragEnd(a, b) { this.finish(a, b); }
  click(w) {
    if (!this.first) { this.first = w; this.a = w; this.b = w; return; }
    this.finish(this.first, w);
  }
  move(w) { if (this.first) this.b = w; }
  finish(a, b) {
    this.a = this.b = this.first = null;
    const bb = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
    if (bb[2] - bb[0] > 0 && bb[3] - bb[1] > 0) this.onRect(bb);
  }
  drawOverlay(o, viewer) {
    const d = viewer.dpr;
    o.setTransform(d, 0, 0, d, 0, 0);
    if (this.a && this.b) {
      const [x0, y0] = viewer.worldToScreen(this.a[0], this.a[1]);
      const [x1, y1] = viewer.worldToScreen(this.b[0], this.b[1]);
      o.fillStyle = 'rgba(34,211,238,0.12)';
      o.strokeStyle = MEASURE;
      o.setLineDash([6, 4]);
      o.lineWidth = 1.5;
      o.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      o.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      o.setLineDash([]);
    }
    if (this.hint && viewer.cursor) label(o, viewer.cursor[0], viewer.cursor[1], this.hint);
  }
  cancel() { this.a = this.b = this.first = null; }
}

/**
 * Measurement tool. `mode`: 'dist' | 'path' | 'area' | 'calibrate'.
 * `env` = { snap(world, viewer) -> {x,y,kind}|null, units() -> { factor, unit }, store: [] (finished measurements), onDone(m) }
 */
export class MeasureTool {
  constructor(mode, env) {
    this.mode = mode;
    this.env = env;
    this.cursor = 'crosshair';
    this.points = [];
    this.hoverPt = null;
    this.snapKind = null;
  }

  pointFor(w, viewer) {
    const s = this.env.snap(w, viewer);
    this.snapKind = s?.kind || null;
    return s ? [s.x, s.y] : w;
  }

  move(w, s, viewer) {
    this.hoverPt = this.pointFor(w, viewer);
  }

  click(w, s, viewer) {
    const p = this.pointFor(w, viewer);
    this.points.push(p);
    if ((this.mode === 'dist' || this.mode === 'calibrate') && this.points.length === 2) this.finish();
  }

  contextmenu() { this.finish(); }
  dblclick() { this.finish(); return true; }

  key(ev) {
    if (ev.key === 'Enter') { this.finish(); return true; }
    if (ev.key === 'Backspace') { this.points.pop(); return true; }
    if (ev.key === 'Escape') { this.points = []; return true; }
    return false;
  }

  finish() {
    const pts = this.points;
    this.points = [];
    const min = this.mode === 'area' ? 3 : 2;
    if (pts.length < min) return;
    const m = { mode: this.mode, pts };
    if (this.mode === 'calibrate') { this.env.onCalibrate?.(pts); return; }
    this.env.store.push(m);
    this.env.onDone?.(m);
  }

  cancel() { this.points = []; this.hoverPt = null; }

  describe(mode, pts) {
    const { factor, unit } = this.env.units();
    const segs = [];
    for (let i = 1; i < pts.length; i++) segs.push(Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]) * factor);
    const total = segs.reduce((a, v) => a + v, 0);
    if (mode === 'dist' || mode === 'calibrate') {
      const dx = (pts[1][0] - pts[0][0]) * factor, dy = (pts[1][1] - pts[0][1]) * factor;
      const ang = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
      return `${formatLength(total, unit)}\nΔX ${formatLength(dx, unit)}  ΔY ${formatLength(dy, unit)}  ∠ ${ang.toFixed(1)}°`;
    }
    if (mode === 'path') return `${t('length')}: ${formatLength(total, unit)}\n${pts.length - 1} seg`;
    const flat = pts.flat();
    const area = Math.abs(polygonArea(flat)) * factor * factor;
    const closing = Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) * factor;
    return `${t('area')}: ${formatArea(area, unit)}\n${t('perimeter')}: ${formatLength(total + closing, unit)}`;
  }

  drawShape(o, viewer, mode, pts, live) {
    const scr = pts.map((p) => viewer.worldToScreen(p[0], p[1]));
    o.strokeStyle = MEASURE;
    o.fillStyle = 'rgba(34,211,238,0.15)';
    o.lineWidth = 2;
    o.setLineDash(live ? [6, 4] : []);
    o.beginPath();
    scr.forEach(([x, y], i) => (i ? o.lineTo(x, y) : o.moveTo(x, y)));
    if (mode === 'area' && scr.length > 2) { o.closePath(); o.fill(); }
    o.stroke();
    o.setLineDash([]);
    o.fillStyle = MEASURE;
    for (const [x, y] of scr) { o.beginPath(); o.arc(x, y, 3, 0, Math.PI * 2); o.fill(); }
    if (pts.length >= 2 && !(mode === 'area' && pts.length < 3)) {
      const [lx, ly] = scr[scr.length - 1];
      label(o, lx, ly, this.describe(mode, pts));
    }
  }

  drawOverlay(o, viewer) {
    const d = viewer.dpr;
    o.setTransform(d, 0, 0, d, 0, 0);
    const pts = this.hoverPt ? [...this.points, this.hoverPt] : this.points;
    if (pts.length) this.drawShape(o, viewer, this.mode, pts, true);
    if (this.hoverPt && this.snapKind) {
      const [sx, sy] = viewer.worldToScreen(this.hoverPt[0], this.hoverPt[1]);
      drawSnapMarker(o, sx, sy, this.snapKind);
    }
    if (!this.points.length && viewer.cursor) label(o, viewer.cursor[0], viewer.cursor[1] + 40, t(this.mode === 'calibrate' ? 'calibrateHint' : 'measureHint'));
  }
}

/** Draws finished measurements (kept until cleared). */
export function drawMeasurements(o, viewer, store, env) {
  const tool = new MeasureTool('dist', env);
  const d = viewer.dpr;
  o.setTransform(d, 0, 0, d, 0, 0);
  for (const m of store) tool.drawShape(o, viewer, m.mode, m.pts, false);
}
