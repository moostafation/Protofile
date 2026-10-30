// Canvas 2D renderer for a CAD scene. Primitives are grouped into spatial tiles
// and, inside a tile, into Path2D batches that share layer and style.
import { FOREGROUND } from '../cad/aci.js';
import { LW_DEFAULT } from '../cad/drawing.js';
import { STROKE, FILL, TEXT, HATCH, POINT, VPORT } from '../cad/scene.js';

const GRID = 12;
export const FONT_FAMILY = 'Arial, "Segoe UI", Tahoma, sans-serif';
/** Cap height / font size ratio used to map CAD text height to a CSS font size. */
export const CAP_RATIO = 0.72;

let measureCtx = null;
/** Width of `s` for a text of cap height 1, using the same font as the renderer. */
export function measureText(s) {
  if (!measureCtx) {
    const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(4, 4) : document.createElement('canvas');
    measureCtx = c.getContext('2d');
    measureCtx.font = `${100 / CAP_RATIO}px ${FONT_FAMILY}`;
    measureCtx.direction = 'ltr';
  }
  return measureCtx.measureText(s).width / 100;
}

export function colorCss(rgb, theme) {
  if (theme.mono) return theme.fg;
  if (rgb === FOREGROUND) return theme.fg;
  return '#' + rgb.toString(16).padStart(6, '0');
}

function lwPx(lw) {
  const mm = lw === LW_DEFAULT || lw < 0 ? 0.25 : lw;
  return Math.max(1, mm * 96 / 25.4);
}

export class CadRenderer {
  constructor(scene) {
    this.scene = scene;
    this.tiles = [];
    this.build();
  }

  build() {
    const { prims, bbox } = this.scene;
    const [x0, y0, x1, y1] = bbox;
    const w = Math.max(x1 - x0, 1e-9), h = Math.max(y1 - y0, 1e-9);
    const cells = new Map();
    const global = this.newTile();
    const tileOf = (p) => {
      if (p.infinite || p.k === VPORT) return global;
      const bw = p.bb[2] - p.bb[0], bh = p.bb[3] - p.bb[1];
      if (bw > w / 3 || bh > h / 3) return global;
      const cx = (p.bb[0] + p.bb[2]) / 2, cy = (p.bb[1] + p.bb[3]) / 2;
      const i = Math.min(GRID - 1, Math.max(0, Math.floor(((cx - x0) / w) * GRID)));
      const j = Math.min(GRID - 1, Math.max(0, Math.floor(((cy - y0) / h) * GRID)));
      const key = j * GRID + i;
      let t = cells.get(key);
      if (!t) { t = this.newTile(); cells.set(key, t); }
      return t;
    };
    for (let idx = 0; idx < prims.length; idx++) {
      const p = prims[idx];
      const t = tileOf(p);
      if (!p.infinite) {
        t.bb[0] = Math.min(t.bb[0], p.bb[0]); t.bb[1] = Math.min(t.bb[1], p.bb[1]);
        t.bb[2] = Math.max(t.bb[2], p.bb[2]); t.bb[3] = Math.max(t.bb[3], p.bb[3]);
      } else {
        t.bb = [-Infinity, -Infinity, Infinity, Infinity];
      }
      const top = this.scene.items[p.item]?.layer ?? p.layer;
      if (p.k === STROKE) {
        const bkey = `${p.layer}|${top}|${p.rgb}|${p.lw}|${p.ww || 0}|${p.dash ? p.dash.join(',') : ''}`;
        let b = t.strokes.get(bkey);
        if (!b) { b = { layer: p.layer, top, rgb: p.rgb, lw: p.lw, ww: p.ww || 0, dash: p.dash, path: new Path2D() }; t.strokes.set(bkey, b); }
        addPolyline(b.path, p.pts, p.closed);
      } else if (p.k === FILL && p.rings.length === 1 && !p.bg) {
        const bkey = `${p.layer}|${top}|${p.rgb}|${p.alpha || 1}`;
        let b = t.fills.get(bkey);
        if (!b) { b = { layer: p.layer, top, rgb: p.rgb, alpha: p.alpha || 1, path: new Path2D() }; t.fills.set(bkey, b); }
        addPolyline(b.path, p.rings[0], true);
      } else if (p.k === TEXT) {
        t.texts.push(idx);
      } else {
        t.others.push(idx);
      }
    }
    this.tiles = [global, ...cells.values()];
  }

  newTile() {
    return { bb: [Infinity, Infinity, -Infinity, -Infinity], strokes: new Map(), fills: new Map(), texts: [], others: [] };
  }

  /**
   * @param ctx CanvasRenderingContext2D, already transformed so that 1 unit = 1 world unit (scene coordinates)
   * @param view { scale (css px per unit), bounds: [x0,y0,x1,y1] visible scene rect, dpr }
   * @param o { theme, hidden: (layer) => bool, showLw, model? (renderer for viewports) }
   */
  draw(ctx, view, o) {
    const px = 1 / view.scale; // one CSS pixel in world units
    const vb = view.bounds;
    const visible = (bb) => bb[2] >= vb[0] && bb[0] <= vb[2] && bb[3] >= vb[1] && bb[1] <= vb[3];
    const itemHidden = this.itemHiddenFn(o);
    const tiles = this.tiles.filter((t) => visible(t.bb));
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // 1. Fills, wipeouts and hatch patterns (behind linework).
    for (const t of tiles) {
      for (const b of t.fills.values()) {
        if (o.hidden(b.layer) || o.hidden(b.top)) continue;
        ctx.globalAlpha = b.alpha;
        ctx.fillStyle = colorCss(b.rgb, o.theme);
        ctx.fill(b.path, 'nonzero');
      }
      ctx.globalAlpha = 1;
      for (const idx of t.others) {
        const p = this.scene.prims[idx];
        if (o.hidden(p.layer) || itemHidden(p.item) || !visible(p.bb)) continue;
        if (p.k === FILL) this.drawFill(ctx, p, o.theme);
        else if (p.k === HATCH) this.drawHatch(ctx, p, o, px);
      }
    }

    // 2. Linework.
    for (const t of tiles) {
      for (const b of t.strokes.values()) {
        if (o.hidden(b.layer) || o.hidden(b.top)) continue;
        ctx.strokeStyle = colorCss(b.rgb, o.theme);
        const cssW = b.ww > 0 ? Math.max(b.ww / px, 1) : o.showLw ? lwPx(b.lw) : 1;
        ctx.lineWidth = cssW * px;
        if (b.dash && b.dash.reduce((a, v) => a + v, 0) / px > 4) ctx.setLineDash(b.dash);
        else ctx.setLineDash([]);
        ctx.stroke(b.path);
      }
    }
    ctx.setLineDash([]);

    // 3. Points, viewports, text.
    for (const t of tiles) {
      for (const idx of t.others) {
        const p = this.scene.prims[idx];
        if (o.hidden(p.layer) || itemHidden(p.item) || !visible(p.bb)) continue;
        if (p.k === POINT) {
          ctx.fillStyle = colorCss(p.rgb, o.theme);
          ctx.fillRect(p.x - px, p.y - px, 2 * px, 2 * px);
        } else if (p.k === VPORT) this.drawViewport(ctx, p, view, o, px);
      }
      for (const idx of t.texts) {
        const p = this.scene.prims[idx];
        if (o.hidden(p.layer) || itemHidden(p.item) || !visible(p.bb)) continue;
        drawText(ctx, p, px, colorCss(p.rgb, o.theme));
      }
    }
  }

  itemHiddenFn(o) {
    // A whole block reference disappears when the layer of the INSERT itself is hidden.
    const items = this.scene.items;
    return (i) => o.hidden(items[i]?.layer);
  }

  drawFill(ctx, p, theme) {
    const path = p._path || (p._path = ringsPath(p.rings));
    ctx.globalAlpha = p.alpha || 1;
    ctx.fillStyle = p.bg ? theme.bg : colorCss(p.rgb, theme);
    ctx.fill(path, 'evenodd');
    ctx.globalAlpha = 1;
  }

  drawHatch(ctx, p, o, px) {
    const clip = p._path || (p._path = ringsPath(p.rings));
    const w = p.bb[2] - p.bb[0], h = p.bb[3] - p.bb[1];
    // Too dense to read at this zoom: draw a translucent fill instead of thousands of lines.
    const density = (p.segs.length / 4) / Math.max(1, (w / px) * (h / px) / 400);
    ctx.save();
    ctx.clip(clip, 'evenodd');
    if (density > 6) {
      ctx.globalAlpha = 0.3;
      ctx.fillStyle = colorCss(p.rgb, o.theme);
      ctx.fill(clip, 'evenodd');
    } else {
      if (!p._segs) {
        p._segs = new Path2D();
        const s = p.segs;
        for (let i = 0; i < s.length; i += 4) { p._segs.moveTo(s[i], s[i + 1]); p._segs.lineTo(s[i + 2], s[i + 3]); }
      }
      ctx.strokeStyle = colorCss(p.rgb, o.theme);
      ctx.lineWidth = px;
      ctx.stroke(p._segs);
    }
    ctx.restore();
  }

  drawViewport(ctx, p, view, o, px) {
    ctx.strokeStyle = colorCss(p.rgb, o.theme);
    ctx.lineWidth = px;
    ctx.strokeRect(p.x - p.w / 2, p.y - p.h / 2, p.w, p.h);
    const model = o.model;
    if (!model) return;
    // Map model space into the viewport rectangle.
    const k = p.h / p.viewH;
    const mo = model.scene.origin;
    ctx.save();
    ctx.beginPath();
    ctx.rect(p.x - p.w / 2, p.y - p.h / 2, p.w, p.h);
    ctx.clip();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.twist);
    ctx.scale(k, k);
    ctx.translate(-(p.viewX - mo.x), -(p.viewY - mo.y));
    const inv = (x, y) => [(x - p.x) / k + (p.viewX - mo.x), (y - p.y) / k + (p.viewY - mo.y)];
    const [a0, a1] = inv(Math.max(view.bounds[0], p.x - p.w / 2), Math.max(view.bounds[1], p.y - p.h / 2));
    const [b0, b1] = inv(Math.min(view.bounds[2], p.x + p.w / 2), Math.min(view.bounds[3], p.y + p.h / 2));
    const r = Math.hypot(b0 - a0, b1 - a1);
    const cx = (a0 + b0) / 2, cy = (a1 + b1) / 2;
    model.draw(ctx, { scale: view.scale * k, bounds: [cx - r, cy - r, cx + r, cy + r], dpr: view.dpr }, { ...o, model: null });
    ctx.restore();
  }

  /** Draws the given items in a highlight colour (selection / search hits). */
  drawItems(ctx, view, items, color, widthPx = 3) {
    const px = 1 / view.scale;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = widthPx * px;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const i of items) {
      const it = this.scene.items[i];
      if (!it) continue;
      for (let k = it.first; k < it.last; k++) {
        const p = this.scene.prims[k];
        if (p.k === STROKE) {
          const path = new Path2D();
          addPolyline(path, p.pts, p.closed);
          ctx.stroke(path);
        } else if (p.k === FILL || p.k === HATCH) {
          ctx.globalAlpha = 0.35;
          ctx.fill(ringsPath(p.rings), 'evenodd');
          ctx.globalAlpha = 1;
        } else if (p.k === TEXT) {
          drawText(ctx, p, px, color);
        } else if (p.k === POINT) {
          ctx.fillRect(p.x - 3 * px, p.y - 3 * px, 6 * px, 6 * px);
        }
      }
      if (it.bb && Number.isFinite(it.bb[0])) {
        ctx.save();
        ctx.setLineDash([4 * px, 3 * px]);
        ctx.lineWidth = px;
        ctx.strokeRect(it.bb[0] - 4 * px, it.bb[1] - 4 * px, it.bb[2] - it.bb[0] + 8 * px, it.bb[3] - it.bb[1] + 8 * px);
        ctx.restore();
      }
    }
    ctx.restore();
  }
}

export function addPolyline(path, pts, closed) {
  path.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) path.lineTo(pts[i], pts[i + 1]);
  if (closed) path.closePath();
}

export function ringsPath(rings) {
  const path = new Path2D();
  for (const r of rings) addPolyline(path, r, true);
  return path;
}

export function drawText(ctx, p, px, color) {
  const hpx = p.h / px;
  if (hpx < 0.7) return;
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(p.rot);
  if (hpx < 3) {
    // Too small to read: draw a faint bar so the layout is still visible.
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = color;
    for (const l of p.lines) ctx.fillRect(l.dx, l.dy, l.w, p.h * 0.6);
    ctx.restore();
    return;
  }
  // Canvas y grows downwards in our flipped world transform, so flip back for glyphs.
  ctx.scale(1, -1);
  if (p.obl) ctx.transform(1, 0, -Math.tan(p.obl), 1, 0, 0);
  // Fonts are laid out at a comfortable pixel size, then scaled to world units.
  const fontPx = 64;
  const k = p.h / CAP_RATIO / fontPx;
  ctx.scale(k * (p.wf || 1), k);
  ctx.font = `${fontPx}px ${FONT_FAMILY}`;
  ctx.fillStyle = color;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  // The page may be right-to-left; drawing text always starts at its insertion point.
  ctx.direction = 'ltr';
  for (const l of p.lines) {
    if (!l.s) continue;
    ctx.fillText(l.s, l.dx / k / (p.wf || 1), -l.dy / k);
  }
  ctx.restore();
}
