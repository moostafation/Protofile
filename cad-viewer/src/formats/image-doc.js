// Raster images (PNG, JPEG, GIF, BMP, WebP, TIFF) and SVG drawings shown in the viewer.
// World units are image pixels with y pointing up, like PDF points in pdf-doc.js.
// Rasters keep a few pre-scaled copies so zoomed-out views stay smooth; the full-size
// copy of a decoded TIFF is split into tiles because browsers (iOS Safari especially)
// refuse canvases over ~16.7 megapixels. SVG is re-rasterised for the visible region
// at screen resolution so it stays sharp.
import { FormatError } from './errors.js';
import { imageDpi } from './image-meta.js';

const MAX_PIXELS = 32e6; // decoded TIFF pages larger than this are reduced
const MAX_RAW_BYTES = 600e6; // TIFF pages whose raw samples exceed this are refused
const MAX_CANVAS = 4096 * 4096; // iOS Safari's canvas area limit
const TILE = 4096;
const LEVEL_STEP = 4;
const MIN_LEVEL = 1024;

const MIME = { PNG: 'image/png', JPEG: 'image/jpeg', GIF: 'image/gif', BMP: 'image/bmp', WEBP: 'image/webp', SVG: 'image/svg+xml', TIFF: 'image/tiff' };

export async function openImage(buffer, fileName, format) {
  const doc = new ImageDocument(buffer, fileName, format);
  await doc.init();
  return doc;
}

/** A canvas of about w × h pixels, reduced proportionally to stay under the canvas area limit. */
function canvas(w, h) {
  const k = Math.min(1, Math.sqrt(MAX_CANVAS / Math.max(1, w * h)));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.floor(w * k));
  c.height = Math.max(1, Math.floor(h * k));
  return c;
}

/** One resolution of a picture: tiles (each ≤ TILE²) covering width × height level pixels. */
function singleLevel(img) {
  return { width: img.width, height: img.height, tiles: [{ img, x: 0, y: 0, w: img.width, h: img.height }] };
}

/** Draws the level-pixel rect [sx0,sy0]-[sx1,sy1] of `level` with its top-left at (dx, dy), kx/ky dest units per level pixel. */
function drawLevel(ctx, level, sx0, sy0, sx1, sy1, dx, dy, kx, ky) {
  for (const t of level.tiles) {
    const ix0 = Math.max(sx0, t.x), iy0 = Math.max(sy0, t.y), ix1 = Math.min(sx1, t.x + t.w), iy1 = Math.min(sy1, t.y + t.h);
    if (ix1 <= ix0 || iy1 <= iy0) continue;
    const sw = t.img.width / t.w, sh = t.img.height / t.h; // tile canvases may be smaller than their area
    ctx.drawImage(t.img, (ix0 - t.x) * sw, (iy0 - t.y) * sh, (ix1 - ix0) * sw, (iy1 - iy0) * sh,
      dx + (ix0 - sx0) * kx, dy + (iy0 - sy0) * ky, (ix1 - ix0) * kx, (iy1 - iy0) * ky);
  }
}

/** Smaller single-canvas copy of a level (high-quality downscale). */
function downscale(level, w, h) {
  const c = canvas(w, h);
  const ctx = c.getContext('2d');
  if (!ctx) throw new FormatError('Not enough memory to display this image.');
  ctx.imageSmoothingQuality = 'high';
  drawLevel(ctx, level, 0, 0, level.width, level.height, 0, 0, c.width / level.width, c.height / level.height);
  return singleLevel(c);
}

/** Splits RGBA pixels (w × h) into tile canvases. */
function tilesFromRgba(rgba, w, h) {
  const tiles = [];
  for (let y = 0; y < h; y += TILE) {
    for (let x = 0; x < w; x += TILE) {
      const tw = Math.min(TILE, w - x), th = Math.min(TILE, h - y);
      const part = new Uint8ClampedArray(tw * th * 4);
      for (let r = 0; r < th; r++) part.set(rgba.subarray(((y + r) * w + x) * 4, ((y + r) * w + x + tw) * 4), r * tw * 4);
      const c = document.createElement('canvas');
      c.width = tw;
      c.height = th;
      const ctx = c.getContext('2d');
      if (!ctx) throw new FormatError('Not enough memory to display this image.');
      ctx.putImageData(new ImageData(part, tw, th), 0, 0);
      tiles.push({ img: c, x, y, w: tw, h: th });
    }
  }
  return { width: w, height: h, tiles };
}

/** SVG length in CSS pixels and whether it used a physical unit, or null. */
function svgLength(v) {
  const m = /^\s*([0-9.]+(?:e[+-]?\d+)?)\s*(px|pt|pc|mm|cm|in)?\s*$/i.exec(v || '');
  if (!m) return null;
  const unit = (m[2] || 'px').toLowerCase();
  const k = { px: 1, pt: 96 / 72, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96 }[unit];
  const n = parseFloat(m[1]) * k;
  return n > 0 && Number.isFinite(n) ? { px: n, physical: unit !== 'px' } : null;
}

/** Converts decoded 8-bit TIFF samples to RGBA, averaging f × f blocks (for pages above the pixel budget). */
function reduceSamples(ifd, f) {
  const w = ifd.width, h = ifd.height, data = ifd.data;
  const spp = ifd.t277 ? ifd.t277[0] : 1;
  const photometric = ifd.t262 ? ifd.t262[0] : 1;
  const map = ifd.t320;
  const bpl = w * spp;
  const rw = Math.ceil(w / f), rh = Math.ceil(h / f);
  const out = new Uint8ClampedArray(rw * rh * 4);
  const acc = new Float64Array(rw * 4);
  for (let oy = 0; oy < rh; oy++) {
    acc.fill(0);
    const y1 = Math.min(h, (oy + 1) * f);
    for (let y = oy * f; y < y1; y++) {
      const off = y * bpl;
      for (let x = 0; x < w; x++) {
        const p = off + x * spp, a = ((x / f) | 0) * 4;
        let r, g, b, al = 255;
        if (photometric === 2) { r = data[p]; g = data[p + 1]; b = data[p + 2]; if (spp >= 4) al = data[p + 3]; }
        else if (photometric === 3) { const i = data[p]; r = map[i] >> 8; g = map[i + 256] >> 8; b = map[i + 512] >> 8; }
        else { r = g = b = photometric === 0 ? 255 - data[p] : data[p]; }
        acc[a] += r; acc[a + 1] += g; acc[a + 2] += b; acc[a + 3] += al;
      }
    }
    const rows = y1 - oy * f;
    for (let ox = 0; ox < rw; ox++) {
      const n = rows * (Math.min(w, (ox + 1) * f) - ox * f), q = (oy * rw + ox) * 4, a = ox * 4;
      out[q] = acc[a] / n; out[q + 1] = acc[a + 1] / n; out[q + 2] = acc[a + 2] / n; out[q + 3] = acc[a + 3] / n;
    }
  }
  return { rgba: out, rw, rh };
}

/** Converts packed 1-bit samples to grey RGBA, averaging f × f blocks. */
function reduceBits(ifd, f) {
  const w = ifd.width, h = ifd.height, data = ifd.data;
  const whiteIsZero = !ifd.t262 || ifd.t262[0] === 0;
  const rw = Math.ceil(w / f), rh = Math.ceil(h / f);
  const out = new Uint8ClampedArray(rw * rh * 4);
  const bpl = Math.ceil(w / 8);
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
      const v = (acc[ox] / (rows * (Math.min(w, (ox + 1) * f) - ox * f))) * 255;
      const q = (oy * rw + ox) * 4;
      out[q] = out[q + 1] = out[q + 2] = v;
      out[q + 3] = 255;
    }
  }
  return { rgba: out, rw, rh };
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
    this.mmPerUnit = null; // paper size of a pixel when the file says (DPI or SVG units)
    this.dpi = null;
    this.pageCount = 1;
    this.pageNo = 1;
    this.bbox = [0, 0, 1, 1];
    this.levels = []; // finest first; f = image pixels per level pixel
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
    this.setDpi(imageDpi(this.format, new Uint8Array(this.buffer)));
    this.setRaster(singleLevel(bmp), bmp.width, bmp.height);
  }

  setDpi(dpi) {
    if (dpi && Math.abs(dpi - Math.round(dpi)) < 0.05) dpi = Math.round(dpi);
    this.dpi = dpi && dpi >= 50 && dpi <= 20000 ? dpi : null;
    this.mmPerUnit = this.dpi ? 25.4 / this.dpi : null;
  }

  // ---------- raster ----------
  /** Uses `level` (the finest copy) for a page of `w` × `h` image pixels. */
  setRaster(level, w, h) {
    this.bbox = [0, 0, w, h];
    level.f = w / level.width;
    this.levels = [level];
    let cur = level;
    while (Math.max(cur.width, cur.height) > MIN_LEVEL * LEVEL_STEP / 2) {
      cur = downscale(cur, Math.ceil(cur.width / LEVEL_STEP), Math.ceil(cur.height / LEVEL_STEP));
      cur.f = w / cur.width;
      this.levels.push(cur);
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

  /**
   * Decodes TIFF page `n` into a level reduced to at most `maxPixels`.
   * Very large pages are averaged straight from the decoded samples (never expanded to
   * full-size RGBA); layouts that cannot be reduced that way are refused when too large.
   */
  decodeTiffPage(n, maxPixels = MAX_PIXELS) {
    const ifd = this.ifds[n - 1];
    const w = ifd.t256[0], h = ifd.t257[0];
    const bps = ifd.t258 ? ifd.t258[0] : 1, spp = ifd.t277 ? ifd.t277[0] : 1;
    const mp = Math.round((w * h) / 1e6);
    if ((w * h * spp * bps) / 8 > MAX_RAW_BYTES) throw new FormatError(`This TIFF page is too large to open in the browser (${mp} megapixels). Save a reduced copy and open that.`);
    const f = Math.max(1, Math.ceil(Math.sqrt((w * h) / maxPixels)));
    const planar = ifd.t284 ? ifd.t284[0] : 1;
    const reducible = bps === 1 ? spp === 1 : bps === 8 && planar === 1 && [0, 1, 2, 3].includes(ifd.t262 ? ifd.t262[0] : 1);
    if (f > 1 && !reducible) throw new FormatError(`This TIFF page is too large to open in the browser (${mp} megapixels, ${bps}-bit). Save a reduced copy and open that.`);
    let rgba, rw, rh;
    try {
      this.utif.decodeImage(this.buffer, ifd, this.ifds);
      if (!(ifd.width > 0 && ifd.height > 0) || !ifd.data) throw new Error('no image data');
      if (f === 1) ({ rgba, rw, rh } = { rgba: new Uint8ClampedArray(this.utif.toRGBA8(ifd).buffer), rw: w, rh: h });
      else ({ rgba, rw, rh } = bps === 1 ? reduceBits(ifd, f) : reduceSamples(ifd, f));
    } catch (err) {
      // UTIF throws bare strings for unsupported variants.
      if (err instanceof FormatError) throw err;
      throw new FormatError(`This TIFF page could not be decoded (${typeof err === 'string' ? err : err?.message || 'unsupported variant'}).`);
    } finally {
      ifd.data = null; // keep memory low: pages are decoded again when revisited
    }
    const r = ifd.t282?.[0], unit = ifd.t296 ? ifd.t296[0] : 2;
    const res = Array.isArray(r) ? r[0] / (r[1] || 1) : r; // rationals come as [numerator, denominator]
    return { level: tilesFromRgba(rgba, rw, rh), w, h, dpi: res > 0 && unit !== 1 ? (unit === 3 ? res * 2.54 : res) : null };
  }

  async setPage(n) {
    this.pageNo = Math.min(Math.max(1, n), this.pageCount);
    if (this.format !== 'TIFF') return;
    const { level, w, h, dpi } = this.decodeTiffPage(this.pageNo);
    this.setDpi(dpi);
    this.setRaster(level, w, h);
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
    const lw = svgLength(root.getAttribute('width')), lh = svgLength(root.getAttribute('height'));
    let w = lw?.px, h = lh?.px;
    if (hasVb) {
      if (!w && !h) { w = vb[2]; h = vb[3]; }
      else if (!w) w = (h * vb[2]) / vb[3];
      else if (!h) h = (w * vb[3]) / vb[2];
    }
    w ||= 1000;
    h ||= 1000;
    // mm / cm / in sizes give the drawing a real paper size (1 CSS px = 1/96 inch).
    if (lw?.physical || lh?.physical) this.setDpi(96);
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

  /** Rasterises a world rect of the SVG at about `s` device pixels per unit. */
  renderRegion(rect, s) {
    const H = this.height;
    const c = canvas((rect[2] - rect[0]) * s, (rect[3] - rect[1]) * s);
    const k = c.width / ((rect[2] - rect[0]) * s); // < 1 when the canvas had to be reduced
    s *= k;
    const left = rect[0] * s, top = (H - rect[3]) * s;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(this.svg, -left, -top, this.width * s, H * s);
    c._rect = [rect[0], H - (top + c.height) / s, rect[0] + c.width / s, rect[3]];
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
      this.cache = { canvas: this.renderRegion(rect, s), scale: s };
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
    const level = this.levelFor(s);
    const fx = W / level.width, fy = H / level.height;
    // Only the visible part of the image (level pixel aligned).
    const vb = view.bounds;
    const lx0 = Math.max(0, Math.floor(vb[0] / fx)), lx1 = Math.min(level.width, Math.ceil(vb[2] / fx));
    const ly0 = Math.max(0, Math.floor((H - vb[3]) / fy)), ly1 = Math.min(level.height, Math.ceil((H - vb[1]) / fy));
    if (lx1 <= lx0 || ly1 <= ly0) return;
    ctx.save();
    ctx.translate(0, H);
    ctx.scale(1, -1);
    // Smooth when scaled down, crisp pixels when zoomed in on a scan.
    ctx.imageSmoothingEnabled = s * level.f < 2;
    ctx.imageSmoothingQuality = 'high';
    drawLevel(ctx, level, lx0, ly0, lx1, ly1, lx0 * fx, ly0 * fy, fx, fy);
    ctx.restore();
  }

  /** Canvas with the image area `rect` (world units) at about `w` × `h` pixels, on white. */
  renderArea(rect, w, h) {
    const c = canvas(w, h);
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('Not enough memory for this image size.');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    const H = this.height;
    const kx = c.width / (rect[2] - rect[0]), ky = c.height / (rect[3] - rect[1]);
    ctx.imageSmoothingQuality = 'high';
    if (this.svg) {
      ctx.drawImage(this.svg, -rect[0] * kx, -(H - rect[3]) * ky, this.width * kx, H * ky);
    } else {
      const level = this.levelFor(Math.max(kx, ky));
      const fx = this.width / level.width, fy = H / level.height;
      drawLevel(ctx, level, rect[0] / fx, (H - rect[3]) / fy, rect[2] / fx, (H - rect[1]) / fy, 0, 0, kx * fx, ky * fy);
    }
    return c;
  }

  /** Whole current page fitted in `maxSide` pixels. */
  pageImage(maxSide) {
    const k = Math.min(1, maxSide / Math.max(this.width, this.height)) || 1;
    return this.renderArea(this.bbox, Math.max(1, this.width * k), Math.max(1, this.height * k));
  }

  /** Page `n` as a canvas of at most `maxPixels`, with its size in image pixels (for printing all pages). */
  pageCanvas(n, maxPixels) {
    if (n === this.pageNo || this.format !== 'TIFF') {
      const k = Math.min(1, Math.sqrt(maxPixels / (this.width * this.height)));
      return { canvas: this.renderArea(this.bbox, this.width * k, this.height * k), w: this.width, h: this.height };
    }
    const { level, w, h } = this.decodeTiffPage(n, maxPixels);
    return { canvas: downscale(level, level.width, level.height).tiles[0].img, w, h };
  }

  async thumbnail(n, width = 140) {
    if (this.format === 'TIFF' && n !== this.pageNo) {
      const { level, w, h } = this.decodeTiffPage(n, 1e6);
      return downscale(level, width * 2, (width * 2 * h) / w).tiles[0].img;
    }
    return this.pageImage(width * 2);
  }

  async search() { return []; }

  async fullText() { return { text: '', pagesIncluded: this.pageCount }; }

  dispose() {
    clearTimeout(this.timer);
    if (this.svgUrl) URL.revokeObjectURL(this.svgUrl);
  }
}
