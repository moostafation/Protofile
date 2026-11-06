// Spatial index over scene primitives for picking entities, window/crossing selection and
// snapping to geometry. Edits add new primitive indices (add) and flag old ones dead.
import { STROKE, FILL, TEXT, HATCH, POINT } from '../cad/scene.js';
import { distToSegment } from '../cad/geometry.js';

const CELLS = 64;
const RANK = { end: 0, center: 1, int: 1.5, mid: 2, ins: 2, perp: 2.5, near: 3 };

export class PickIndex {
  constructor(scene) {
    this.scene = scene;
    const [x0, y0, x1, y1] = scene.bbox;
    this.x0 = x0; this.y0 = y0;
    this.cw = Math.max(x1 - x0, 1e-9) / CELLS;
    this.ch = Math.max(y1 - y0, 1e-9) / CELLS;
    this.grid = new Map();
    this.big = [];
    scene.prims.forEach((p, i) => { if (!p.dead) this.add(i); });
  }

  /** Adds a primitive (by index) to the grid. */
  add(i) {
    const p = this.scene.prims[i];
    if (p.infinite) { this.big.push(i); return; }
    const [i0, j0] = this.cell(p.bb[0], p.bb[1]);
    const [i1, j1] = this.cell(p.bb[2], p.bb[3]);
    if ((i1 - i0 + 1) * (j1 - j0 + 1) > 64) { this.big.push(i); return; }
    for (let j = j0; j <= j1; j++) for (let ii = i0; ii <= i1; ii++) {
      const k = j * CELLS + ii;
      let arr = this.grid.get(k);
      if (!arr) this.grid.set(k, (arr = []));
      arr.push(i);
    }
  }

  /** Applies an edit (see updateScene); dead primitives are skipped by every query. */
  update({ added = [] }) {
    for (const i of added) this.add(i);
  }

  cell(x, y) {
    return [
      Math.min(CELLS - 1, Math.max(0, Math.floor((x - this.x0) / this.cw))),
      Math.min(CELLS - 1, Math.max(0, Math.floor((y - this.y0) / this.ch))),
    ];
  }

  candidates(x, y, r) {
    const out = new Set(this.big);
    const [i0, j0] = this.cell(x - r, y - r);
    const [i1, j1] = this.cell(x + r, y + r);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const arr = this.grid.get(j * CELLS + i);
      if (arr) for (const k of arr) out.add(k);
    }
    return out;
  }

  /**
   * Nearest entity (item index) to (x, y) within radius r, honouring hidden layers.
   * `skip(item)` excludes items (e.g. on locked layers).
   */
  pick(x, y, r, hidden, skip) {
    let best = null, bestD = r * r;
    const items = this.scene.items;
    for (const i of this.candidates(x, y, r)) {
      const p = this.scene.prims[i];
      if (p.dead || hidden(p.layer) || hidden(items[p.item]?.layer)) continue;
      const b = p.bb;
      if (x < b[0] - r || x > b[2] + r || y < b[1] - r || y > b[3] + r) continue;
      if (skip?.(p.item)) continue;
      const d = primDistance(p, x, y, r);
      if (d < bestD) { bestD = d; best = p.item; }
    }
    return best;
  }

  /**
   * Items in a rectangle [x0, y0, x1, y1]. Window (`crossing` false): items entirely inside.
   * Crossing: items inside or touching the rectangle.
   */
  inRect(rect, crossing, hidden, skip) {
    const [x0, y0, x1, y1] = rect;
    const items = this.scene.items;
    const out = [];
    for (const it of items) {
      if (it.deleted || it.last <= it.first || hidden(it.layer) || skip?.(it.id)) continue;
      const bb = it.bb;
      const finite = Number.isFinite(bb[0]);
      if (!crossing) {
        if (finite && bb[0] >= x0 && bb[2] <= x1 && bb[1] >= y0 && bb[3] <= y1 && !this.hasInfinite(it)) out.push(it.id);
        continue;
      }
      if (finite && bb[0] >= x0 && bb[2] <= x1 && bb[1] >= y0 && bb[3] <= y1) { out.push(it.id); continue; }
      if (finite && (bb[2] < x0 || bb[0] > x1 || bb[3] < y0 || bb[1] > y1) && !this.hasInfinite(it)) continue;
      for (let k = it.first; k < it.last; k++) {
        const p = this.scene.prims[k];
        if (!p.dead && !hidden(p.layer) && primTouchesRect(p, x0, y0, x1, y1)) { out.push(it.id); break; }
      }
    }
    return out;
  }

  hasInfinite(it) {
    for (let k = it.first; k < it.last; k++) if (this.scene.prims[k].infinite) return true;
    return false;
  }

  /**
   * Snap point near (x, y): endpoint > center > intersection > midpoint/insertion >
   * perpendicular (from `opts.from`) > nearest point on a line (unless `opts.near` is false).
   * `opts.skip(item)` ignores items (e.g. the ones being edited). Returns { x, y, kind } or null.
   */
  snap(x, y, r, hidden, opts = {}) {
    let best = null;
    const near = opts.near !== false;
    const from = opts.from;
    const consider = (px, py, kind) => {
      const d = Math.hypot(px - x, py - y);
      if (d > r) return;
      if (!best || RANK[kind] < RANK[best.kind] || (RANK[kind] === RANK[best.kind] && d < best.d)) best = { x: px, y: py, kind, d };
    };
    const items = this.scene.items;
    const segs = []; // nearby segments, for intersections
    for (const i of this.candidates(x, y, r)) {
      const p = this.scene.prims[i];
      if (p.dead || hidden(p.layer) || hidden(items[p.item]?.layer)) continue;
      if (opts.skip?.(p.item)) continue;
      const b = p.bb;
      if (x < b[0] - r || x > b[2] + r || y < b[1] - r || y > b[3] + r) continue;
      if (p.k === STROKE) {
        const pts = p.pts;
        const n = pts.length;
        if (p.circle && p.closed) {
          let cx = 0, cy = 0;
          for (let k = 0; k < n; k += 2) { cx += pts[k]; cy += pts[k + 1]; }
          consider(cx / (n / 2), cy / (n / 2), 'center');
        } else {
          // Vertices of short polylines (lines, pipes), skipping dense curve samples.
          const step = n > 400 ? Math.ceil(n / 400) * 2 : 2;
          for (let k = 0; k < n; k += step) consider(pts[k], pts[k + 1], 'end');
          consider(pts[n - 2], pts[n - 1], 'end');
          if (n <= 200) for (let k = 2; k < n; k += 2) consider((pts[k - 2] + pts[k]) / 2, (pts[k - 1] + pts[k + 1]) / 2, 'mid');
        }
        const last = p.closed ? n + 2 : n;
        for (let k = 2; k < last; k += 2) {
          const a = k - 2, c = k % n;
          const s = distToSegment(x, y, pts[a], pts[a + 1], pts[c], pts[c + 1]);
          if (s.d2 < r * r) {
            if (near) consider(s.x, s.y, 'near');
            if (segs.length < 400) segs.push([pts[a], pts[a + 1], pts[c], pts[c + 1], p.item]);
            if (from) {
              const f = footOnSegment(from[0], from[1], pts[a], pts[a + 1], pts[c], pts[c + 1]);
              if (f) consider(f[0], f[1], 'perp');
            }
          }
        }
      } else if (p.k === POINT) {
        consider(p.x, p.y, 'end');
      } else if (p.k === TEXT) {
        consider(p.x, p.y, 'ins');
      } else if (p.k === FILL || p.k === HATCH) {
        for (const ring of p.rings) if (ring.length <= 64) for (let k = 0; k < ring.length; k += 2) consider(ring[k], ring[k + 1], 'end');
      }
    }
    // Intersections of nearby segments (of different objects or non-adjacent segments).
    for (let i = 0; i < segs.length; i++) {
      for (let j = i + 1; j < segs.length; j++) {
        const a = segs[i], b = segs[j];
        const q = intersect(a, b);
        if (q) consider(q[0], q[1], 'int');
      }
    }
    return best;
  }
}

function intersect(a, b) {
  const [x1, y1, x2, y2] = a, [x3, y3, x4, y4] = b;
  const d = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(d) < 1e-12) return null;
  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / d;
  const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / d;
  const eps = 1e-9;
  if (t < -eps || t > 1 + eps || u < -eps || u > 1 + eps) return null;
  // Shared vertices of one polyline are already endpoints.
  if (a[4] === b[4] && (t < eps || t > 1 - eps) && (u < eps || u > 1 - eps)) return null;
  return [x1 + t * (x2 - x1), y1 + t * (y2 - y1)];
}

/** Foot of the perpendicular from (px, py) on the segment, or null when it falls outside. */
function footOnSegment(px, py, x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0;
  const l2 = dx * dx + dy * dy;
  if (!l2) return null;
  const t = ((px - x0) * dx + (py - y0) * dy) / l2;
  if (t < 0 || t > 1) return null;
  return [x0 + t * dx, y0 + t * dy];
}

function primDistance(p, x, y, r) {
  if (p.k === STROKE) {
    let best = Infinity;
    const pts = p.pts;
    for (let k = 2; k < pts.length; k += 2) {
      const d = distToSegment(x, y, pts[k - 2], pts[k - 1], pts[k], pts[k + 1]).d2;
      if (d < best) best = d;
    }
    if (p.closed && pts.length >= 4) {
      const d = distToSegment(x, y, pts[pts.length - 2], pts[pts.length - 1], pts[0], pts[1]).d2;
      if (d < best) best = d;
    }
    return best;
  }
  if (p.k === POINT) return (p.x - x) ** 2 + (p.y - y) ** 2;
  if (p.k === TEXT) {
    // Inside the rotated text box counts as a direct hit.
    const c = Math.cos(-p.rot), s = Math.sin(-p.rot);
    const lx = (x - p.x) * c - (y - p.y) * s, ly = (x - p.x) * s + (y - p.y) * c;
    for (const l of p.lines) {
      if (lx >= l.dx && lx <= l.dx + l.w && ly >= l.dy - p.h * 0.25 && ly <= l.dy + p.h) return 0;
    }
    return Infinity;
  }
  if (p.k === FILL || p.k === HATCH) {
    let inside = false;
    for (const r of p.rings) if (pointInRing(r, x, y)) inside = !inside;
    // Inside a filled area: a hit, but nearby linework wins.
    return inside ? r * r * 0.81 : Infinity;
  }
  return Infinity;
}

const inRect = (x, y, x0, y0, x1, y1) => x >= x0 && x <= x1 && y >= y0 && y <= y1;

function segTouchesRect(ax, ay, bx, by, x0, y0, x1, y1) {
  if (inRect(ax, ay, x0, y0, x1, y1) || inRect(bx, by, x0, y0, x1, y1)) return true;
  if (Math.max(ax, bx) < x0 || Math.min(ax, bx) > x1 || Math.max(ay, by) < y0 || Math.min(ay, by) > y1) return false;
  const edges = [[x0, y0, x1, y0], [x1, y0, x1, y1], [x1, y1, x0, y1], [x0, y1, x0, y0]];
  return edges.some((e) => intersect([ax, ay, bx, by, 0], [...e, 1]));
}

function polyTouchesRect(pts, closed, x0, y0, x1, y1) {
  const n = pts.length;
  if (n === 2) return inRect(pts[0], pts[1], x0, y0, x1, y1);
  const last = closed ? n + 2 : n;
  for (let k = 2; k < last; k += 2) {
    const a = k - 2, c = k % n;
    if (segTouchesRect(pts[a], pts[a + 1], pts[c], pts[c + 1], x0, y0, x1, y1)) return true;
  }
  return false;
}

/** Whether a primitive is inside or crosses the rectangle (crossing selection). */
function primTouchesRect(p, x0, y0, x1, y1) {
  const b = p.bb;
  if (!p.infinite && (b[2] < x0 || b[0] > x1 || b[3] < y0 || b[1] > y1)) return false;
  if (p.k === STROKE) return polyTouchesRect(p.pts, p.closed, x0, y0, x1, y1);
  if (p.k === POINT) return inRect(p.x, p.y, x0, y0, x1, y1);
  if (p.k === FILL || p.k === HATCH) {
    for (const r of p.rings) if (polyTouchesRect(r, true, x0, y0, x1, y1)) return true;
    // The rectangle may lie inside the area.
    return p.rings.some((r) => pointInRing(r, (x0 + x1) / 2, (y0 + y1) / 2));
  }
  // Text, viewports: their box.
  return true;
}

export function pointInRing(r, x, y) {
  let inside = false;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    const xi = r[i], yi = r[i + 1], xj = r[j], yj = r[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
