// PDF documents shown in the viewer through pdf.js. World coordinates are PDF
// points with y pointing up; only the visible region is rasterised at screen resolution.
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { buildLines, findInLines } from './text-lines.js';
import { mayHaveMarkups } from '../markup/markup.js';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const MAX_PIXELS = 24e6;

export async function openPdf(buffer, fileName) {
  // Markups this app saved come back as editable markups (their annotations are taken out of
  // the copy shown, so they are not drawn twice).
  let markups = null;
  if (mayHaveMarkups(buffer)) {
    try {
      const { extractMarkups } = await import('../markup/pdf-annots.js');
      const r = await extractMarkups(buffer);
      if (r) {
        markups = r.markups;
        buffer = r.bytes.buffer.slice(r.bytes.byteOffset, r.bytes.byteOffset + r.bytes.byteLength);
      }
    } catch (err) {
      console.warn('Markups could not be read; the annotations are shown as they are.', err);
    }
  }
  const data = new Uint8Array(buffer.slice(0));
  const pdf = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  const doc = new PdfDocument(pdf, fileName, buffer);
  doc.loadedMarkups = markups;
  await doc.setPage(1);
  return doc;
}

export class PdfDocument {
  constructor(pdf, fileName, buffer) {
    this.kind = 'pdf';
    this.unit = 'pt';
    this.pxPerUnit = 96 / 72; // CSS px per point at 100 %
    this.pdf = pdf;
    this.fileName = fileName;
    this.buffer = buffer;
    this.pageCount = pdf.numPages;
    this.pageNo = 1;
    this.texts = new Map();
    this.base = null; // low-res whole page
    this.cache = null; // hi-res visible region
    this.task = null;
    this.timer = 0;
  }

  /** Frees pdf.js resources when another document is opened. */
  dispose() {
    clearTimeout(this.timer);
    this.task?.cancel();
    this.task = null;
    this.base = this.cache = null;
    // pdf.js frees a document through the task that loaded it (also stops its worker).
    this.pdf.loadingTask?.destroy().catch(() => {});
  }

  /** Maps viewer coordinates of page `n` to PDF user space (for writing annotations). */
  async pdfMapper(n) {
    const page = n === this.pageNo ? this.page : await this.pdf.getPage(n);
    const vp = page.getViewport({ scale: 1 });
    return (x, y) => vp.convertToPdfPoint(x, vp.height - y);
  }

  async setPage(n) {
    this.pageNo = Math.min(Math.max(1, n), this.pageCount);
    this.page = await this.pdf.getPage(this.pageNo);
    this.vp1 = this.page.getViewport({ scale: 1 });
    this.bbox = [0, 0, this.vp1.width, this.vp1.height];
    this.base = null;
    this.cache = null;
    this.task?.cancel();
    this.task = null;
    await this.renderBase();
  }

  async renderBase() {
    const s = Math.min(2, 1600 / Math.max(this.vp1.width, this.vp1.height));
    const c = await this.renderRegion(this.bbox, s);
    if (c) this.base = { canvas: c, rect: this.bbox, scale: s };
  }

  /** Rasterises a world rect at `s` device pixels per point. */
  async renderRegion(rect, s) {
    const vp = this.page.getViewport({ scale: s });
    const left = Math.floor(rect[0] * s), top = Math.floor((this.vp1.height - rect[3]) * s);
    const w = Math.ceil((rect[2] - rect[0]) * s), h = Math.ceil((rect[3] - rect[1]) * s);
    if (w < 1 || h < 1) return null;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    this.task?.cancel();
    const task = this.page.render({ canvasContext: ctx, canvas, viewport: vp, transform: [1, 0, 0, 1, -left, -top] });
    this.task = task;
    try {
      await task.promise;
    } catch (err) {
      if (err?.name === 'RenderingCancelledException') return null;
      throw err;
    } finally {
      if (this.task === task) this.task = null;
    }
    canvas._rect = [left / s, this.vp1.height - (top + h) / s, (left + w) / s, this.vp1.height - top / s];
    return canvas;
  }

  draw(ctx, view) {
    const [x0, y0, x1, y1] = this.bbox;
    // Paper with a soft shadow.
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = 12;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    ctx.restore();
    if (this.base) this.blit(ctx, this.base.canvas);
    if (this.cache && this.cache.page === this.pageNo) this.blit(ctx, this.cache.canvas);
    this.ensureDetail(view);
  }

  blit(ctx, canvas) {
    const r = canvas._rect;
    ctx.save();
    ctx.translate(r[0], r[3]);
    ctx.scale((r[2] - r[0]) / canvas.width, -(r[3] - r[1]) / canvas.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas, 0, 0);
    ctx.restore();
  }

  ensureDetail(view) {
    const s = view.scale * view.dpr;
    const vb = view.bounds;
    const want = [Math.max(vb[0], this.bbox[0]), Math.max(vb[1], this.bbox[1]), Math.min(vb[2], this.bbox[2]), Math.min(vb[3], this.bbox[3])];
    if (want[0] >= want[2] || want[1] >= want[3]) return;
    if (this.base && s <= this.base.scale * 1.05) return;
    const c = this.cache;
    if (c && c.page === this.pageNo && Math.abs(c.scale / s - 1) < 0.15 &&
      c.canvas._rect[0] <= want[0] + 1e-6 && c.canvas._rect[1] <= want[1] + 1e-6 && c.canvas._rect[2] >= want[2] - 1e-6 && c.canvas._rect[3] >= want[3] - 1e-6) return;
    clearTimeout(this.timer);
    const viewer = view.viewer;
    this.timer = setTimeout(async () => {
      // A margin around the visible area keeps small pans sharp.
      const mx = (want[2] - want[0]) * 0.2, my = (want[3] - want[1]) * 0.2;
      const rect = [Math.max(this.bbox[0], want[0] - mx), Math.max(this.bbox[1], want[1] - my), Math.min(this.bbox[2], want[2] + mx), Math.min(this.bbox[3], want[3] + my)];
      let scale = s;
      const px = (rect[2] - rect[0]) * (rect[3] - rect[1]) * scale * scale;
      if (px > MAX_PIXELS) scale *= Math.sqrt(MAX_PIXELS / px);
      const page = this.pageNo;
      const canvas = await this.renderRegion(rect, scale).catch(() => null);
      if (canvas && page === this.pageNo) {
        this.cache = { canvas, scale: s, page };
        viewer?.render(true);
      }
    }, 90);
  }

  async thumbnail(n, width = 140) {
    const page = await this.pdf.getPage(n);
    const vp1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: width / vp1.width });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(vp.width);
    canvas.height = Math.ceil(vp.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, canvas, viewport: vp }).promise;
    return canvas;
  }

  /** Text of a page as readable lines, plus each text item's world-space rectangle. */
  async pageText(n) {
    if (this.texts.has(n)) return this.texts.get(n);
    const page = n === this.pageNo ? this.page : await this.pdf.getPage(n);
    const vp = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const rects = content.items.map((it) => {
      if (!it.str) return null;
      const [a, b, , , e, f] = it.transform;
      const h = it.height || Math.hypot(a, b);
      const ang = Math.atan2(b, a);
      const w = it.width;
      // Corners in PDF user space, converted to viewport (y-down) then to world (y-up).
      const corners = [[e, f], [e + w * Math.cos(ang), f + w * Math.sin(ang)], [e - h * Math.sin(ang), f + h * Math.cos(ang)], [e + w * Math.cos(ang) - h * Math.sin(ang), f + w * Math.sin(ang) + h * Math.cos(ang)]]
        .map(([x, y]) => vp.convertToViewportPoint(x, y))
        .map(([x, y]) => [x, vp.height - y]);
      const xs = corners.map((c) => c[0]), ys = corners.map((c) => c[1]);
      return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    });
    const lines = buildLines(content.items);
    const text = lines.map((l) => l.text.trim()).filter(Boolean).join('\n');
    const result = { lines, rects, text };
    this.texts.set(n, result);
    return result;
  }

  async search(query, limit = 300) {
    if (!query.trim()) return [];
    const hits = [];
    for (let n = 1; n <= this.pageCount && hits.length < limit; n++) {
      const { lines, rects } = await this.pageText(n);
      for (const m of findInLines(lines, query, limit - hits.length)) {
        const rect = [Infinity, Infinity, -Infinity, -Infinity];
        for (const i of m.items) {
          const r = rects[i];
          if (!r) continue;
          rect[0] = Math.min(rect[0], r[0]); rect[1] = Math.min(rect[1], r[1]);
          rect[2] = Math.max(rect[2], r[2]); rect[3] = Math.max(rect[3], r[3]);
        }
        if (Number.isFinite(rect[0])) hits.push({ page: n, text: m.line.text.trim().slice(0, 200), rect });
      }
    }
    return hits;
  }

  /** All text, page by page, for the AI assistant (truncated to maxChars). */
  async fullText(maxChars = 150000) {
    let out = '';
    let pagesIncluded = 0;
    for (let n = 1; n <= this.pageCount; n++) {
      const { text } = await this.pageText(n);
      const chunk = `\n\n=== Page ${n} ===\n${text}`;
      if (out.length + chunk.length > maxChars) {
        out += chunk.slice(0, Math.max(0, maxChars - out.length));
        out += `\n(… text truncated; ${this.pageCount - n} more pages not included)`;
        break;
      }
      out += chunk;
      pagesIncluded = n;
    }
    return { text: out, pagesIncluded };
  }
}
