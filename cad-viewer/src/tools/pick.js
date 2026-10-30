// Spatial index over scene primitives for picking entities and snapping to geometry.
import { STROKE, FILL, TEXT, HATCH, POINT } from '../cad/scene.js';
import { distToSegment } from '../cad/geometry.js';

const CELLS = 64;

export class PickIndex {
  constructor(scene) {
    this.scene = scene;
    const [x0, y0, x1, y1] = scene.bbox;
    this.x0 = x0; this.y0 = y0;
    this.cw = Math.max(x1 - x0, 1e-9) / CELLS;
    this.ch = Math.max(y1 - y0, 1e-9) / CELLS;
    this.grid = new Map();
    this.big = [];
    scene.prims.forEach((p, i) => {
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
    });
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

  /** Nearest entity (item index) to (x, y) within radius r, honouring hidden layers. */
  pick(x, y, r, hidden) {
    let best = null, bestD = r * r;
    const items = this.scene.items;
    for (const i of this.candidates(x, y, r)) {
      const p = this.scene.prims[i];
      if (hidden(p.layer) || hidden(items[p.item]?.layer)) continue;
      const b = p.bb;
      if (x < b[0] - r || x > b[2] + r || y < b[1] - r || y > b[3] + r) continue;
      const d = primDistance(p, x, y, r);
      if (d < bestD) { bestD = d; best = p.item; }
    }
    return best;
  }

  /**
   * Snap point near (x, y): endpoint > center > midpoint > nearest point on a line.
   * Returns { x, y, kind } or null.
   */
  snap(x, y, r, hidden) {
    let best = null;
    const rank = { end: 0, center: 1, mid: 2, ins: 2, near: 3 };
    const consider = (px, py, kind) => {
      const d = Math.hypot(px - x, py - y);
      if (d > r) return;
      if (!best || rank[kind] < rank[best.kind] || (rank[kind] === rank[best.kind] && d < best.d)) best = { x: px, y: py, kind, d };
    };
    const items = this.scene.items;
    for (const i of this.candidates(x, y, r)) {
      const p = this.scene.prims[i];
      if (hidden(p.layer) || hidden(items[p.item]?.layer)) continue;
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
        for (let k = 2; k < n; k += 2) {
          const s = distToSegment(x, y, pts[k - 2], pts[k - 1], pts[k], pts[k + 1]);
          if (s.d2 < r * r) consider(s.x, s.y, 'near');
        }
      } else if (p.k === POINT) {
        consider(p.x, p.y, 'end');
      } else if (p.k === TEXT) {
        consider(p.x, p.y, 'ins');
      } else if (p.k === FILL || p.k === HATCH) {
        for (const ring of p.rings) if (ring.length <= 64) for (let k = 0; k < ring.length; k += 2) consider(ring[k], ring[k + 1], 'end');
      }
    }
    return best;
  }
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

export function pointInRing(r, x, y) {
  let inside = false;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    const xi = r[i], yi = r[i + 1], xj = r[j], yj = r[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
