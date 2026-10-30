// AutoCAD Color Index (ACI) palette -> 0xRRGGBB.
// 1-9 are fixed, 10-249 are 24 hues x 10 shades, 250-255 are greys.
const FIXED = [0x000000, 0xff0000, 0xffff00, 0x00ff00, 0x00ffff, 0x0000ff, 0xff00ff, 0xffffff, 0x808080, 0xc0c0c0];
const GREYS = [0x333333, 0x505050, 0x696969, 0x828282, 0xbebebe, 0xffffff];
const SHADES = [1, 0.8, 0.6, 0.5, 0.3];

function hsvToRgb(h, s, v) {
  const c = v * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = v - c;
  const to = (n) => Math.round((n + m) * 255);
  return (to(r) << 16) | (to(g) << 8) | to(b);
}

export const ACI = new Array(256);
for (let i = 0; i < 10; i++) ACI[i] = FIXED[i];
for (let i = 10; i < 250; i++) {
  const hue = Math.floor((i - 10) / 10) * 15;
  const k = (i - 10) % 10;
  const value = SHADES[k >> 1];
  const sat = k % 2 === 0 ? 1 : 0.5;
  ACI[i] = hsvToRgb(hue, sat, value);
}
for (let i = 250; i < 256; i++) ACI[i] = GREYS[i - 250];

/** Special marker for ACI 7: drawn white on dark backgrounds and black on light ones. */
export const FOREGROUND = -1;

export function aciToRgb(index) {
  if (index === 7) return FOREGROUND;
  if (index > 0 && index < 256) return ACI[index];
  return FOREGROUND;
}

export function rgbToCss(rgb) {
  return '#' + rgb.toString(16).padStart(6, '0');
}

export function luminance(rgb) {
  const r = (rgb >> 16) & 255, g = (rgb >> 8) & 255, b = rgb & 255;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}
