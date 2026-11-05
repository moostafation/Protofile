// Print resolution stored in image files, so scans measure in real millimetres by default.

const u16be = (b, o) => (b[o] << 8) | b[o + 1];
const u32be = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

/**
 * Dots per inch from PNG pHYs, JPEG JFIF/EXIF or BMP headers: { x, y } (they differ for
 * non-square pixels, e.g. fax scans), or null.
 */
export function imageDpi(format, b) {
  try {
    if (format === 'PNG') return pngDpi(b);
    if (format === 'JPEG') return jpegDpi(b);
    if (format === 'BMP' && b.length >= 46) {
      const i32 = (o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);
      return dpi(i32(38) * 0.0254, i32(42) * 0.0254);
    }
  } catch { /* malformed metadata: no DPI */ }
  return null;
}

/** { x, y } when at least one axis has a resolution (a missing one takes the other's value). */
export function dpi(x, y) {
  x = x > 0 && Number.isFinite(x) ? x : null;
  y = y > 0 && Number.isFinite(y) ? y : null;
  return x || y ? { x: x || y, y: y || x } : null;
}

function pngDpi(b) {
  for (let o = 8; o + 8 <= b.length;) {
    const len = u32be(b, o);
    const type = String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]);
    if (type === 'pHYs' && len >= 9) return b[o + 16] === 1 ? dpi(u32be(b, o + 8) * 0.0254, u32be(b, o + 12) * 0.0254) : null; // unit 1 = per metre
    if (type === 'IDAT' || type === 'IEND') return null;
    o += 12 + len;
  }
  return null;
}

function jpegDpi(b) {
  for (let o = 2; o + 4 <= b.length && b[o] === 0xff;) {
    const marker = b[o + 1], len = u16be(b, o + 2);
    if (marker === 0xe0 && String.fromCharCode(...b.subarray(o + 4, o + 9)) === 'JFIF\0') {
      const unit = b[o + 11], x = u16be(b, o + 12), y = u16be(b, o + 14);
      if (unit === 1 && x > 1) return dpi(x, y);
      if (unit === 2 && x > 1) return dpi(x * 2.54, y * 2.54);
    }
    if (marker === 0xe1 && String.fromCharCode(...b.subarray(o + 4, o + 10)) === 'Exif\0\0') {
      const dpi = exifDpi(b, o + 10, len - 8);
      if (dpi) return dpi;
    }
    if (marker === 0xda) break; // image data starts
    o += 2 + len;
  }
  return null;
}

/** X/YResolution and ResolutionUnit from the first EXIF (TIFF) directory. */
function exifDpi(b, start, size) {
  const le = b[start] === 0x49;
  const u16 = (o) => (le ? b[start + o] | (b[start + o + 1] << 8) : u16be(b, start + o));
  const u32 = (o) => (le ? (b[start + o] | (b[start + o + 1] << 8) | (b[start + o + 2] << 16) | (b[start + o + 3] << 24)) >>> 0 : u32be(b, start + o));
  const ifd = u32(4);
  if (ifd + 2 > size) return null;
  let rx = null, ry = null, unit = 2;
  for (let i = 0, n = u16(ifd); i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > size) break;
    const tag = u16(e);
    const rational = () => { const off = u32(e + 8); return off + 8 <= size ? u32(off) / (u32(off + 4) || 1) : null; };
    if (tag === 282) rx = rational();
    if (tag === 283) ry = rational();
    if (tag === 296) unit = u16(e + 8);
  }
  if (!(rx > 1) || unit === 1) return null;
  const k = unit === 3 ? 2.54 : 1;
  return dpi(rx * k, ry > 1 ? ry * k : null);
}
