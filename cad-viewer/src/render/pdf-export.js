// Vector PDF output of a CAD scene (plot / print to PDF) using jsPDF.
import { jsPDF } from 'jspdf';
import { FOREGROUND, luminance } from '../cad/aci.js';
import { LW_DEFAULT, UNIT_TO_MM } from '../cad/drawing.js';
import { STROKE, FILL, TEXT, HATCH, POINT, VPORT } from '../cad/scene.js';
import { CAP_RATIO, FONT_FAMILY } from './cad-renderer.js';

export const PAPERS = {
  A4: [210, 297], A3: [297, 420], A2: [420, 594], A1: [594, 841], A0: [841, 1189],
  Letter: [215.9, 279.4], Legal: [215.9, 355.6], Tabloid: [279.4, 431.8],
  'ANSI C': [431.8, 558.8], 'ANSI D': [558.8, 863.6], 'ARCH D': [609.6, 914.4],
};

const PT_PER_MM = 72 / 25.4;
const DEFAULT_LW = 0.2;

function rgbOf(rgb, mode) {
  if (mode === 'mono' || rgb === FOREGROUND) return [0, 0, 0];
  const r = (rgb >> 16) & 255, g = (rgb >> 8) & 255, b = rgb & 255;
  if (mode === 'gray') {
    // Darken so light CAD colours (yellow, cyan) stay visible on white paper.
    const v = Math.round(Math.min(luminance(rgb), 0.75) * 255 * 0.8);
    return [v, v, v];
  }
  // Pure white entities would vanish on paper.
  if (r > 245 && g > 245 && b > 245) return [0, 0, 0];
  return [r, g, b];
}

/**
 * Computes paper layout: which drawing area maps where on the sheet.
 * @returns {{ pageW, pageH, k, area, ox, oy, scaleLabel }}
 */
export function planPlot(scene, units, o) {
  const area = o.area;
  const [pw, ph] = PAPERS[o.paper] || PAPERS.A3;
  const aw = Math.max(area[2] - area[0], 1e-9), ah = Math.max(area[3] - area[1], 1e-9);
  let landscape = o.orientation === 'landscape' || (o.orientation === 'auto' && aw >= ah);
  if (o.orientation === 'portrait') landscape = false;
  const pageW = landscape ? Math.max(pw, ph) : Math.min(pw, ph);
  const pageH = landscape ? Math.min(pw, ph) : Math.max(pw, ph);
  const m = o.margin ?? 10;
  const stamp = o.stamp ? 6 : 0;
  const availW = pageW - 2 * m, availH = pageH - 2 * m - stamp;
  let k; // paper mm per drawing unit
  let scaleLabel;
  const unitMm = UNIT_TO_MM[units] || 1;
  if (o.scaleMode === 'ratio' && o.ratio > 0) {
    k = unitMm / o.ratio;
    scaleLabel = `1:${o.ratio}`;
  } else {
    k = Math.min(availW / aw, availH / ah);
    const ratio = unitMm / k;
    scaleLabel = ratio >= 1 ? `1:${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(2)} (fit)` : `${(1 / ratio).toFixed(2)}:1 (fit)`;
  }
  // Centre the area on the printable region.
  const ox = m + (availW - aw * k) / 2;
  const oy = m + (availH - ah * k) / 2;
  return { pageW, pageH, k, area, ox, oy, margin: m, stampH: stamp, scaleLabel, landscape };
}

class PdfPainter {
  constructor(doc, o) {
    this.doc = doc;
    this.mode = o.colorMode || 'mono';
    this.lineweights = o.lineweights !== false;
    this.hidden = o.hidden || (() => false);
    this.state = {};
  }

  setStroke(rgb, widthMm, dashMm) {
    const c = rgbOf(rgb, this.mode).join(',');
    if (this.state.stroke !== c) { this.doc.setDrawColor(...rgbOf(rgb, this.mode)); this.state.stroke = c; }
    const w = Math.max(widthMm, 0.05).toFixed(3);
    if (this.state.width !== w) { this.doc.setLineWidth(+w); this.state.width = w; }
    const d = dashMm ? dashMm.map((v) => +v.toFixed(3)).join(',') : '';
    if (this.state.dash !== d) { this.doc.setLineDashPattern(dashMm ? dashMm.map((v) => +v.toFixed(3)) : [], 0); this.state.dash = d; }
  }

  setFill(rgb) {
    const c = rgbOf(rgb, this.mode).join(',');
    if (this.state.fill !== c) { this.doc.setFillColor(...rgbOf(rgb, this.mode)); this.state.fill = c; }
  }

  lw(p) {
    if (!this.lineweights) return 0.1;
    return p.lw === LW_DEFAULT || p.lw < 0 ? DEFAULT_LW : Math.max(p.lw, 0.05);
  }

  path(pts, closed, T) {
    const doc = this.doc;
    let [x, y] = T(pts[0], pts[1]);
    doc.moveTo(x, y);
    for (let i = 2; i < pts.length; i += 2) {
      [x, y] = T(pts[i], pts[i + 1]);
      doc.lineTo(x, y);
    }
    if (closed) doc.close();
  }

  /** Paints a scene. `T` maps scene coords -> paper mm, `k` is mm per unit, `bounds` culls in scene coords. */
  scene(scene, T, k, bounds, rot = 0, model = null) {
    const doc = this.doc;
    const items = scene.items;
    const inView = (bb) => bb[2] >= bounds[0] && bb[0] <= bounds[2] && bb[3] >= bounds[1] && bb[1] <= bounds[3];
    const visible = (p) => !this.hidden(p.layer) && !this.hidden(items[p.item]?.layer) && (p.infinite || inView(p.bb));
    const order = [FILL, HATCH, STROKE, POINT, VPORT, TEXT];
    for (const kind of order) {
      for (const p of scene.prims) {
        if (p.k !== kind || !visible(p)) continue;
        if (kind === FILL) {
          if (p.bg) { doc.setFillColor(255, 255, 255); this.state.fill = null; } else this.setFill(p.rgb);
          if (p.alpha && p.alpha < 1) doc.setGState(new doc.GState({ opacity: p.alpha, 'stroke-opacity': 1 }));
          for (const r of p.rings) this.path(r, true, T);
          doc.fillEvenOdd();
          if (p.alpha && p.alpha < 1) doc.setGState(new doc.GState({ opacity: 1 }));
        } else if (kind === HATCH) {
          doc.saveGraphicsState();
          for (const r of p.rings) this.path(r, true, T);
          doc.clipEvenOdd();
          doc.discardPath();
          this.state = {};
          this.setStroke(p.rgb, 0.08, null);
          const s = p.segs;
          for (let i = 0; i < s.length; i += 4) {
            const [x0, y0] = T(s[i], s[i + 1]);
            const [x1, y1] = T(s[i + 2], s[i + 3]);
            doc.moveTo(x0, y0);
            doc.lineTo(x1, y1);
          }
          doc.stroke();
          doc.restoreGraphicsState();
          this.state = {};
        } else if (kind === STROKE) {
          const width = p.ww ? Math.max(p.ww * k, this.lw(p)) : this.lw(p);
          const dash = p.dash ? p.dash.map((v) => v * k) : null;
          this.setStroke(p.rgb, width, dash && dash.reduce((a, v) => a + v, 0) > 0.5 ? dash : null);
          this.path(p.pts, p.closed, T);
          doc.stroke();
        } else if (kind === POINT) {
          this.setFill(p.rgb);
          const [x, y] = T(p.x, p.y);
          doc.circle(x, y, 0.15, 'F');
        } else if (kind === TEXT) {
          this.text(p, T, k, rot);
        } else if (kind === VPORT) {
          this.viewport(p, T, k, model);
        }
      }
    }
  }

  text(p, T, k, rot) {
    const doc = this.doc;
    const hmm = p.h * k;
    if (hmm < 0.4) return;
    const [r, g, b] = rgbOf(p.rgb, this.mode);
    doc.setTextColor(r, g, b);
    const fontPt = (hmm / CAP_RATIO) * PT_PER_MM;
    doc.setFontSize(fontPt);
    const angle = p.rot + rot;
    const c = Math.cos(p.rot), s = Math.sin(p.rot);
    for (const l of p.lines) {
      if (!l.s.trim()) continue;
      const wx = p.x + l.dx * c - l.dy * s, wy = p.y + l.dx * s + l.dy * c;
      const [x, y] = T(wx, wy);
      if (/[^\u0000-ÿ]/.test(l.s)) {
        this.rasterText(l.s, x, y, hmm, angle, [r, g, b]);
      } else {
        doc.text(l.s, x, y, { angle: (angle * 180) / Math.PI, baseline: 'alphabetic', horizontalScale: p.wf && p.wf !== 1 ? p.wf : undefined });
      }
    }
  }

  /** Non-Latin text (Arabic, CJK…) is embedded as a high-resolution image so it shapes correctly. */
  rasterText(str, x, y, hmm, angle, rgb) {
    const px = 48;
    const font = `${px / CAP_RATIO}px ${FONT_FAMILY}`;
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    ctx.font = font;
    ctx.direction = 'ltr';
    const w = Math.ceil(ctx.measureText(str).width) + 4;
    const asc = Math.ceil(px * 1.25), desc = Math.ceil(px * 0.45);
    c.width = w;
    c.height = asc + desc;
    ctx.font = font;
    ctx.fillStyle = `rgb(${rgb.join(',')})`;
    ctx.textBaseline = 'alphabetic';
    ctx.direction = 'ltr';
    ctx.fillText(str, 2, asc);
    const mmPerPx = hmm / px;
    const W = c.width * mmPerPx, H = c.height * mmPerPx;
    // Position the image so its baseline-left lands on (x, y), then rotate about that point.
    const ca = Math.cos(angle), sa = Math.sin(angle);
    const upX = -sa * asc * mmPerPx, upY = -ca * asc * mmPerPx; // paper y grows downwards
    const left = x + upX - 2 * mmPerPx * ca, top = y + upY + 2 * mmPerPx * sa;
    this.doc.addImage(c.toDataURL('image/png'), 'PNG', left, top, W, H, undefined, 'FAST', (angle * 180) / Math.PI);
  }

  viewport(p, T, k, model) {
    const doc = this.doc;
    const [x0, y0] = T(p.x - p.w / 2, p.y + p.h / 2);
    const [x1, y1] = T(p.x + p.w / 2, p.y - p.h / 2);
    this.setStroke(p.rgb, 0.15, null);
    doc.rect(x0, y0, x1 - x0, y1 - y0, 'S');
    if (!model) return;
    doc.saveGraphicsState();
    doc.rect(x0, y0, x1 - x0, y1 - y0, null);
    doc.clip();
    doc.discardPath();
    this.state = {};
    const s = p.h / p.viewH;
    const mo = model.origin;
    const c = Math.cos(p.twist), sn = Math.sin(p.twist);
    const TM = (mx, my) => {
      const dx = (mx + mo.x - p.viewX) * s, dy = (my + mo.y - p.viewY) * s;
      return T(p.x + dx * c - dy * sn, p.y + dx * sn + dy * c);
    };
    const r = Math.hypot(p.w, p.h) / s;
    const cx = p.viewX - mo.x, cy = p.viewY - mo.y;
    this.scene(model, TM, k * s, [cx - r, cy - r, cx + r, cy + r], p.twist, null);
    doc.restoreGraphicsState();
    this.state = {};
  }
}

/**
 * Creates the PDF.
 * @param scene scene to plot (model space or a layout)
 * @param o options: paper, orientation, area, scaleMode, ratio, colorMode, lineweights, hidden, stamp, title, units, model
 * @returns {jsPDF}
 */
export function exportPdf(scene, o) {
  const plan = planPlot(scene, o.units, o);
  const doc = new jsPDF({ unit: 'mm', format: [plan.pageW, plan.pageH], orientation: plan.landscape ? 'landscape' : 'portrait', compress: true });
  doc.setProperties({ title: o.title || 'Drawing', creator: 'ProtoCAD Viewer' });
  doc.setFont('helvetica', 'normal');
  const { k, area, ox, oy } = plan;
  const T = (x, y) => [ox + (x - area[0]) * k, oy + (area[3] - y) * k];
  doc.saveGraphicsState();
  doc.rect(plan.margin, plan.margin, plan.pageW - 2 * plan.margin, plan.pageH - 2 * plan.margin - plan.stampH, null);
  doc.clip();
  doc.discardPath();
  const painter = new PdfPainter(doc, o);
  painter.scene(scene, T, k, area, 0, o.model || null);
  doc.restoreGraphicsState();
  if (o.stamp) titleStrip(doc, plan, o, `Scale ${plan.scaleLabel}   ${o.paper}`);
  return doc;
}

function titleStrip(doc, plan, o, info) {
  doc.setLineDashPattern([], 0);
  doc.setDrawColor(0, 0, 0);
  doc.setLineWidth(0.2);
  const y = plan.pageH - plan.margin - plan.stampH + 1;
  doc.line(plan.margin, y, plan.pageW - plan.margin, y);
  doc.setFontSize(8);
  doc.setTextColor(0, 0, 0);
  const date = new Date().toISOString().slice(0, 10);
  doc.text(asciiOnly(o.title || ''), plan.margin, y + 4);
  doc.text(`${info}   ${date}`, plan.pageW - plan.margin, y + 4, { align: 'right' });
}

/**
 * PDF of an image (or part of it) fitted on the paper.
 * @param sheet ImageDocument; o: paper, orientation, area (image units), stamp, title
 * @returns {jsPDF}
 */
export function exportImagePdf(sheet, o) {
  const plan = planPlot(null, 0, { ...o, scaleMode: 'fit' });
  const doc = new jsPDF({ unit: 'mm', format: [plan.pageW, plan.pageH], orientation: plan.landscape ? 'landscape' : 'portrait', compress: true });
  doc.setProperties({ title: o.title || 'Image', creator: 'ProtoCAD Viewer' });
  const a = plan.area;
  const wmm = (a[2] - a[0]) * plan.k, hmm = (a[3] - a[1]) * plan.k;
  // About 300 dpi on paper; rasters are never enlarged beyond their own pixels.
  let pw = (wmm / 25.4) * 300, ph = (hmm / 25.4) * 300;
  let k = Math.min(1, Math.sqrt(36e6 / (pw * ph)), 12000 / Math.max(pw, ph));
  if (sheet.format !== 'SVG') k = Math.min(k, (a[2] - a[0]) / pw);
  pw = Math.max(1, Math.round(pw * k));
  ph = Math.max(1, Math.round(ph * k));
  const canvas = sheet.renderArea(a, pw, ph);
  const photo = sheet.format === 'JPEG' || sheet.format === 'WEBP';
  doc.addImage(canvas, photo ? 'JPEG' : 'PNG', plan.ox, plan.oy, wmm, hmm, undefined, 'FAST');
  if (o.stamp) titleStrip(doc, plan, o, `${sheet.format} ${Math.round(a[2] - a[0])}×${Math.round(a[3] - a[1])} px   ${o.paper}`);
  return doc;
}

function asciiOnly(s) {
  return s.replace(/[^\u0000-ÿ]/g, '?');
}
