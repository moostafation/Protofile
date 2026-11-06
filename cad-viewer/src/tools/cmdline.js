// Typed input for the drawing and modify tools (the command line), AutoCAD style:
//   x,y        absolute point (drawing coordinates)
//   @dx,dy     relative to the last point
//   @dist<ang  polar, relative to the last point (angle in degrees, counter-clockwise from +X)
//   dist<ang   polar from the origin
//   dist       a distance along the current cursor direction from the last point (ortho-aware)

const NUM = String.raw`[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?`;
const RE_XY = new RegExp(`^(@)?\\s*(${NUM})\\s*,\\s*(${NUM})(?:\\s*,\\s*${NUM})?$`);
const RE_POLAR = new RegExp(`^(@)?\\s*(${NUM})\\s*<\\s*(${NUM})$`);
const RE_NUM = new RegExp(`^${NUM}$`);

/** A plain number ("12.5", "-3", "1e3"), or null. */
export function parseNumber(text) {
  const s = String(text ?? '').trim();
  return RE_NUM.test(s) ? parseFloat(s) : null;
}

/**
 * Parses a typed point. Coordinates are drawing (world) coordinates.
 * ctx: { base: [x, y] | null (last point), dir: [dx, dy] | null (towards the cursor), ortho: bool }
 * Returns [x, y], or null when the text is not a point.
 */
export function parsePoint(text, ctx = {}) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  const base = ctx.base;
  let m = RE_XY.exec(s);
  if (m) {
    const x = parseFloat(m[2]), y = parseFloat(m[3]);
    if (m[1]) return base ? [base[0] + x, base[1] + y] : [x, y];
    return [x, y];
  }
  m = RE_POLAR.exec(s);
  if (m) {
    const d = parseFloat(m[2]), a = (parseFloat(m[3]) * Math.PI) / 180;
    const o = m[1] && base ? base : [0, 0];
    return [o[0] + d * Math.cos(a), o[1] + d * Math.sin(a)];
  }
  const d = parseNumber(s);
  if (d !== null && base) {
    let [dx, dy] = ctx.dir && Math.hypot(ctx.dir[0], ctx.dir[1]) > 1e-12 ? ctx.dir : [1, 0];
    if (ctx.ortho) {
      if (Math.abs(dx) >= Math.abs(dy)) { dx = Math.sign(dx) || 1; dy = 0; } else { dy = Math.sign(dy); dx = 0; }
    }
    const L = Math.hypot(dx, dy);
    return [base[0] + (dx / L) * d, base[1] + (dy / L) * d];
  }
  return null;
}

/** Constrains p to the horizontal or vertical through base (Ortho). */
export function orthoPoint(base, p) {
  if (!base) return p;
  return Math.abs(p[0] - base[0]) >= Math.abs(p[1] - base[1]) ? [p[0], base[1]] : [base[0], p[1]];
}

/** Command aliases typed in the command line (Enter or Space runs them). */
export const ALIASES = {
  L: 'line', LINE: 'line',
  PL: 'polyline', PLINE: 'polyline', POLYLINE: 'polyline',
  REC: 'rectangle', RECTANG: 'rectangle', RECTANGLE: 'rectangle',
  C: 'circle', CIRCLE: 'circle',
  A: 'arc', ARC: 'arc',
  T: 'text', DT: 'text', TEXT: 'text', DTEXT: 'text',
  RC: 'revcloud', REVCLOUD: 'revcloud', CLOUD: 'revcloud',
  M: 'move', MOVE: 'move',
  CO: 'copy', CP: 'copy', COPY: 'copy',
  RO: 'rotate', ROTATE: 'rotate',
  SC: 'scale', SCALE: 'scale',
  MI: 'mirror', MIRROR: 'mirror',
  O: 'offset', OFFSET: 'offset',
  X: 'explode', EXPLODE: 'explode',
  E: 'erase', ERASE: 'erase', DEL: 'erase',
  U: 'undo', UNDO: 'undo', REDO: 'redo',
};
