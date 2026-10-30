// Raster images (PNG, JPEG, GIF, BMP, WebP, TIFF) and SVG drawings shown in the viewer.
// World units are image pixels with y pointing up, like PDF points in pdf-doc.js.
// Rasters keep a few pre-scaled copies so zoomed-out views stay smooth; SVG is
// re-rasterised for the visible region at screen resolution so it stays sharp.
import { FormatError } from './errors.js';

const MAX_PIXELS = 48e6; // larger TIFF scans are reduced when decoded
const MAX_REGION = 24e6;
const LEVEL_STEP = 4;
const MIN_LEVEL = 1024;

const MIME = { PNG: 'image/png', JPEG: 'image/jpeg', GIF: 'image/gif', BMP: 'image/bmp', WEBP: 'image/webp', SVG: 'image/svg+xml', TIFF: 'image/tiff' };

export async function openImage(buffer, fileName, format) {
  const doc = new ImageDocument(buffer, fileName, format);
  await doc.init();
  return doc;
}

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

/** Smaller copy of a drawable (high-quality downscale). */
function downscale(src, w, h) {
  const c = canvas(w, h);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

/** SVG length in CSS pixels, or null. */
function svgLength(v) {
  const m = /^\s*([0-9.]+(?:e[+-]?\d+)?)\s*(px|pt|pc|mm|cm|in)?\s*$/i.exec(v || '');
  if (!m) return null;
  const k = { px: 1, pt: 96 / 72, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96 }[(m[2] || 'px').toLowerCase()];
  const n = parseFloat(m[1]) * k;
  return n > 0 && Number.isFinite(n) ? n : null;
}

export class ImageDocument {
  constructor(buffer, fileName, format) {
    this.kind = 'image';
    this.buffer = buffer;
    this.fileName = fileName;
    this.format = format;
    this.mime = MIME[format] || 'application/octet-stream';
    this.unit = 'px';
    this.pxPerUnit = 1; // CSS px per world unit at 100 %
    this.pageCount = 1;
    this.pageNo = 1;
    this.bbox = [0, 0, 1, 1];
    this.levels = []; // [{ img, f }] f = image pixels per level pixel
    this.svg = null;
    this.base = null;
    this.cache = null;
    this.timer = 0;
  }

  get width() { return this.bbox[2]; }
  get height() { return this.bbox[3]; }

  async init() {
    if (this.format === 'SVG') return this.initSvg();
    if (this.format === 'TIFF') return this.initTiff();
    let bmp;
    try {
      bmp = await createImageBitmap(new Blob([this.buffer], { type: this.mime }));
    } catch {
      throw new FormatError('The image could not be decoded (damaged file or unsupported variant).');
    }
    this.setRaster(bmp, bmp.width, bmp.height);
  }

  // ---------- raster ----------
  /** Uses `img` (any drawable) for a page of `w` × `h` image pixels. */
  setRaster(img, w, h) {
    this.bbox = [0, 0, w, h];
    this.levels = [{ img, f: w / img.width }];
    let cur = img;
    while (Math.max(cur.width, cur.height) > MIN_LEVEL * LEVEL_STEP / 2) {
      cur = downscale(cur, cur.width / LEVEL_STEP, cur.height / LEVEL_STEP);
      this.levels.push({ img: cur, f: w / cur.width });
    }
  }

  /** Coarsest level that still has at least one level pixel per device pixel. */
  levelFor(s) {
    let best = this.levels[0];
    for (const l of this.levels) if (1 / l.f >= s * 0.9) best = l;
    return best;
  }

  // ---------- TIFF ----------
  async initTiff() {
    const mod = await import('utif2');
    this.utif = mod.default || mod;
    let ifds;
    try {
      ifds = this.utif.decode(this.buffer);
    } catch {
      throw new FormatError('This TIFF file could not be read.');
    }
    this.ifds = ifds.filter((ifd) => ifd.t256 && ifd.t257);
    if (!this.ifds.length) throw new FormatError('This TIFF file contains no image.');
    this.pageCount = this.ifds.length;
    await this.setPage(1);
  }

  /** Decodes TIFF page `n` into a drawable, reduced when it is very large. */
  decodeTiffPage(n, maxPixels = MAX_PIXELS) {
    const ifd = this.ifds[n - 1];
    try {
      this.utif.decodeImage(this.buffer, ifd, this.ifds);
    } catch (err) {
      throw new FormatError(`This TIFF page could not be decoded (${err?.message || err}).`);
    }
    const w = ifd.width, h = ifd.height;
    if (!(w > 0 && h > 0) || !ifd.data) throw new FormatError('This TIFF page could not be decoded.');
    const f = Math.max(1, Math.ceil(Math.sqrt((w * h) / maxPixels)));
    const bps = ifd.t258 ? ifd.t258[0] : 1, spp = ifd.t277 ? ifd.t277[0] : 1;
    let rgba, rw = w, rh = h;
    if (f > 1 && bps === 1 && spp === 1) {
      // Large black & white scan: average f×f blocks straight from the packed bits.
      const whiteIsZero = !ifd.t262 || ifd.t262[0] === 0;
      rw = Math.ceil(w / f); rh = Math.ceil(h / f);
      rgba = new Uint8ClampedArray(rw * rh * 4);
      const bpl = Math.ceil(w / 8), data = ifd.data;
      const acc = new Float64Array(rw);
      for (let oy = 0; oy < rh; oy++) {
        acc.fill(0);
        const y1 = Math.min(h, (oy + 1) * f);
        for (let y = oy * f; y < y1; y++) {
          const off = y * bpl;
          for (let x = 0; x < w; x++) {
            const bit = (data[off + (x >> 3)] >> (7 - (x & 7))) & 1;
            if (bit !== (whiteIsZero ? 1 : 0)) acc[(x / f) | 0]++;
          }
        }
        const rows = y1 - oy * f;
        for (let ox = 0; ox < rw; ox++) {
          const cols = Math.min(w, (ox + 1) * f) - ox * f;
          const v = Math.round((acc[ox] / (rows * cols)) * 255);
          const q = (oy * rw + ox) * 4;
          rgba[q] = rgba[q + 1] = rgba[q + 2] = v;
          rgba[q + 3] = 255;
        }
      }
    } else {
      rgba = new Uint8ClampedArray(this.utif.toRGBA8(ifd).buffer);
    }
    ifd.data = null; // keep memory low: pages are decoded again when revisited
    const c = canvas(rw, rh);
    c.getContext('2d').putImageData(new ImageData(rgba, rw, rh), 0, 0);
    let img = c;
    if (f > 1 && rw === w) img = downscale(c, w / f, h / f);
    return { img, w, h };
  }

  async setPage(n) {
    this.pageNo = Math.min(Math.max(1, n), this.pageCount);
    if (this.format !== 'TIFF') return;
    const { img, w, h } = this.decodeTiffPage(this.pageNo);
    this.setRaster(img, w, h);
  }

  // ---------- SVG ----------
  async initSvg() {
    const text = new TextDecoder('utf-8').decode(this.buffer);
    const xml = new DOMParser().parseFromString(text, 'image/svg+xml');
    const root = xml.documentElement;
    if (!root || root.nodeName.toLowerCase() !== 'svg' || xml.getElementsByTagName('parsererror').length) {
      throw new FormatError('This SVG file could not be read.');
    }
    const vb = (root.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
    const hasVb = vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0;
    let w = svgLength(root.getAttribute('width')), h = svgLength(root.getAttribute('height'));
    if (hasVb) {
      if (!w && !h) { w = vb[2]; h = vb[3]; }
      else if (!w) w = (h * vb[2]) / vb[3];
      else if (!h) h = (w * vb[3]) / vb[2];
    }
    w ||= 1000;
    h ||= 1000;
    // Explicit pixel size so the browser rasterises it exactly at the size we ask for.
    root.setAttribute('width', String(w));
    root.setAttribute('height', String(h));
    const blob = new Blob([new XMLSerializer().serializeToString(xml)], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.src = url;
    try {
      await img.decode();
    } catch {
      URL.revokeObjectURL(url);
      throw new FormatError('This SVG file could not be displayed.');
    }
    this.svg = img;
    this.svgUrl = url;
    this.bbox = [0, 0, w, h];
    const s = Math.min(4, 2048 / Math.max(w, h));
    this.base = { canvas: this.renderRegion(this.bbox, s), scale: s };
  }

  /** Rasterises a world rect of the SVG at `s` device pixels per unit. */
  renderRegion(rect, s) {
    const H = this.height;
    const left = Math.floor(rect[0] * s), top = Math.floor((H - rect[3]) * s);
    const w = Math.ceil((rect[2] - rect[0]) * s), h = Math.ceil((rect[3] - rect[1]) * s);
    const c = canvas(w, h);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(this.svg, -left, -top, this.width * s, H * s);
    c._rect = [left / s, H - (top + c.height) / s, (left + c.width) / s, H - top / s];
    return c;
  }

  blit(ctx, c) {
    const r = c._rect;
    ctx.save();
    ctx.translate(r[0], r[3]);
    ctx.scale((r[2] - r[0]) / c.width, -(r[3] - r[1]) / c.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(c, 0, 0);
    ctx.restore();
  }

  ensureDetail(view) {
    const s = view.scale * view.dpr;
    const vb = view.bounds, bb = this.bbox;
    const want = [Math.max(vb[0], bb[0]), Math.max(vb[1], bb[1]), Math.min(vb[2], bb[2]), Math.min(vb[3], bb[3])];
    if (want[0] >= want[2] || want[1] >= want[3]) return;
    if (s <= this.base.scale * 1.05) return;
    const c = this.cache;
    if (c && Math.abs(c.scale / s - 1) < 0.15 && c.canvas._rect[0] <= want[0] + 1e-6 && c.canvas._rect[1] <= want[1] + 1e-6 &&
      c.canvas._rect[2] >= want[2] - 1e-6 && c.canvas._rect[3] >= want[3] - 1e-6) return;
    clearTimeout(this.timer);
    const viewer = view.viewer;
    this.timer = setTimeout(() => {
      const mx = (want[2] - want[0]) * 0.2, my = (want[3] - want[1]) * 0.2;
      const rect = [Math.max(bb[0], want[0] - mx), Math.max(bb[1], want[1] - my), Math.min(bb[2], want[2] + mx), Math.min(bb[3], want[3] + my)];
      let scale = s;
      const px = (rect[2] - rect[0]) * (rect[3] - rect[1]) * scale * scale;
      if (px > MAX_REGION) scale *= Math.sqrt(MAX_REGION / px);
      this.cache = { canvas: this.renderRegion(rect, scale), scale: s };
      viewer?.render(true);
    }, 90);
  }

  // ---------- drawing ----------
  draw(ctx, view) {
    const [, , W, H] = this.bbox;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = 12;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
    if (this.svg) {
      this.blit(ctx, this.base.canvas);
      if (this.cache) this.blit(ctx, this.cache.canvas);
      this.ensureDetail(view);
      return;
    }
    const s = view.scale * view.dpr;
    const { img, f } = this.levelFor(s);
    const fx = W / img.width, fy = H / img.height;
    // Only the visible part of the image (level pixel aligned).
    const vb = view.bounds;
    const lx0 = Math.max(0, Math.floor(vb[0] / fx)), lx1 = Math.min(img.width, Math.ceil(vb[2] / fx));
    const ly0 = Math.max(0, Math.floor((H - vb[3]) / fy)), ly1 = Math.min(img.height, Math.ceil((H - vb[1]) / fy));
    if (lx1 <= lx0 || ly1 <= ly0) return;
    ctx.save();
    ctx.translate(0, H);
    ctx.scale(1, -1);
    // Smooth when scaled down, crisp pixels when zoomed in on a scan.
    ctx.imageSmoothingEnabled = s * f < 2;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, lx0, ly0, lx1 - lx0, ly1 - ly0, lx0 * fx, ly0 * fy, (lx1 - lx0) * fx, (ly1 - ly0) * fy);
    ctx.restore();
  }

  /** Canvas with the image area `rect` (world units) at `w` × `h` pixels, on white. */
  renderArea(rect, w, h) {
    const c = canvas(w, h);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    const H = this.height;
    const kx = c.width / (rect[2] - rect[0]), ky = c.height / (rect[3] - rect[1]);
    ctx.imageSmoothingQuality = 'high';
    if (this.svg) {
      ctx.drawImage(this.svg, -rect[0] * kx, -(H - rect[3]) * ky, this.width * kx, H * ky);
    } else {
      const { img } = this.levelFor(Math.max(kx, ky));
      const fx = this.width / img.width, fy = H / img.height;
      ctx.drawImage(img, rect[0] / fx, (H - rect[3]) / fy, (rect[2] - rect[0]) / fx, (rect[3] - rect[1]) / fy, 0, 0, c.width, c.height);
    }
    return c;
  }

  /** Whole page fitted in `maxSide` pixels. */
  pageImage(maxSide) {
    const k = Math.min(1, maxSide / Math.max(this.width, this.height)) || 1;
    return this.renderArea(this.bbox, Math.max(1, this.width * k), Math.max(1, this.height * k));
  }

  async thumbnail(n, width = 140) {
    if (this.format === 'TIFF' && n !== this.pageNo) {
      const { img, w, h } = this.decodeTiffPage(n, 4e6);
      return downscale(img, width, (width * h) / w);
    }
    return this.pageImage(width * 2);
  }

  async search() { return []; }

  async fullText() { return { text: '', pagesIncluded: this.pageCount }; }

  dispose() {
    if (this.svgUrl) URL.revokeObjectURL(this.svgUrl);
  }
}
