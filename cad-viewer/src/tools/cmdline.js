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

/**
 * Commands of the command window: name (as typed and shown), aliases, the app command it runs and a
 * short description for the autocomplete list. `cad`: CAD drawings only (the window is CAD-only today).
 */
export const COMMANDS = [
  { name: 'LINE', aliases: ['L'], cmd: 'line', desc: 'Draw line segments' },
  { name: 'PLINE', aliases: ['PL', 'POLYLINE'], cmd: 'polyline', desc: 'Draw a polyline' },
  { name: 'RECTANG', aliases: ['REC', 'RECTANGLE'], cmd: 'rectangle', desc: 'Draw a rectangle' },
  { name: 'CIRCLE', aliases: ['C'], cmd: 'circle', desc: 'Draw a circle' },
  { name: 'ARC', aliases: ['A'], cmd: 'arc', desc: 'Draw an arc through 3 points' },
  { name: 'TEXT', aliases: ['T', 'DT', 'DTEXT'], cmd: 'text', desc: 'Write single-line text' },
  { name: 'REVCLOUD', aliases: ['RC', 'CLOUD'], cmd: 'revcloud', desc: 'Draw a revision cloud' },
  { name: 'MOVE', aliases: ['M'], cmd: 'move', desc: 'Move objects' },
  { name: 'COPY', aliases: ['CO', 'CP'], cmd: 'copy', desc: 'Copy objects' },
  { name: 'ROTATE', aliases: ['RO'], cmd: 'rotate', desc: 'Rotate objects' },
  { name: 'SCALE', aliases: ['SC'], cmd: 'scale', desc: 'Scale objects' },
  { name: 'MIRROR', aliases: ['MI'], cmd: 'mirror', desc: 'Mirror objects' },
  { name: 'OFFSET', aliases: ['O'], cmd: 'offset', desc: 'Offset a line, polyline, circle or arc' },
  { name: 'EXPLODE', aliases: ['X'], cmd: 'explode', desc: 'Break blocks and polylines into parts' },
  { name: 'ERASE', aliases: ['E', 'DEL'], cmd: 'erase', desc: 'Erase objects' },
  { name: 'UNDO', aliases: ['U'], cmd: 'undo', desc: 'Undo the last change' },
  { name: 'REDO', aliases: [], cmd: 'redo', desc: 'Redo the last undone change' },
  { name: 'ZOOM', aliases: ['Z'], cmd: 'zoom', desc: 'Zoom: Extents, Window, All, Previous' },
  { name: 'PAN', aliases: ['P'], cmd: 'pan', desc: 'Pan the view by dragging' },
  { name: 'LAYER', aliases: ['LA'], cmd: 'layer', desc: 'Show the layers panel' },
  { name: 'DIST', aliases: ['DI'], cmd: 'dist', desc: 'Measure a distance and angle' },
  { name: 'AREA', aliases: ['AA'], cmd: 'area', desc: 'Measure an area and perimeter' },
  { name: 'PLOT', aliases: ['PRINT'], cmd: 'print', desc: 'Print or export to PDF' },
  { name: 'SAVE', aliases: ['QSAVE'], cmd: 'save', desc: 'Save the drawing (DXF)' },
  { name: 'SAVEAS', aliases: [], cmd: 'saveas', desc: 'Save the drawing under a new name' },
  { name: 'OPEN', aliases: [], cmd: 'open', desc: 'Open a file' },
  { name: 'ORTHO', aliases: [], cmd: 'ortho', desc: 'Toggle ortho mode (F8)' },
  { name: 'OSNAP', aliases: ['OS', 'SNAP'], cmd: 'osnap', desc: 'Toggle object snaps (F3)' },
];

/** Command aliases typed in the command line (Enter or Space runs them). */
export const ALIASES = Object.fromEntries(COMMANDS.flatMap((c) => [c.name, ...c.aliases].map((a) => [a, c.cmd])));

/**
 * Autocomplete: commands whose name or an alias starts with `text` (exact alias matches first, then
 * names, then other aliases), at most `max`. Each entry: { name, alias (the matching alias or ''), cmd, desc }.
 */
export function suggest(text, max = 8) {
  const q = String(text ?? '').trim().toUpperCase();
  if (!q || !/^[A-Z]+$/.test(q)) return [];
  const out = [];
  for (const c of COMMANDS) {
    const words = [c.name, ...c.aliases];
    const exact = words.find((w) => w === q);
    const prefix = words.find((w) => w.startsWith(q));
    if (!prefix) continue;
    const alias = exact && exact !== c.name ? exact : !c.name.startsWith(q) ? prefix : '';
    out.push({ name: c.name, alias, cmd: c.cmd, desc: c.desc, rank: exact ? 0 : c.name.startsWith(q) ? 1 : 2 });
  }
  out.sort((a, b) => a.rank - b.rank || a.name.length - b.name.length || a.name.localeCompare(b.name));
  return out.slice(0, max).map(({ rank, ...r }) => r);
}

/** Splits a prompt into text and [option] parts: "Next point or [Close/Undo]:" -> option keys C and U. */
export function promptParts(prompt) {
  const parts = [];
  const re = /\[([^\]]*)\]/g;
  let last = 0, m;
  while ((m = re.exec(prompt))) {
    if (m.index > last) parts.push({ text: prompt.slice(last, m.index) });
    parts.push({ text: '[' });
    m[1].split('/').forEach((o, i) => {
      if (i) parts.push({ text: '/' });
      const caps = (o.match(/[A-Z]/g) || []).join('');
      parts.push({ text: o, key: caps || o.trim().charAt(0).toUpperCase() });
    });
    parts.push({ text: ']' });
    last = re.lastIndex;
  }
  if (last < prompt.length) parts.push({ text: prompt.slice(last) });
  return parts;
}
