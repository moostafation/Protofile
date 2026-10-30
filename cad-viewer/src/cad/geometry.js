// 2D geometry helpers. Matrices are affine [a, b, c, d, e, f] mapping
// (x, y) -> (a*x + c*y + e, b*x + d*y + f), the same layout as DOMMatrix.

export const IDENTITY = [1, 0, 0, 1, 0, 0];
const TAU = Math.PI * 2;

export function mul(m, n) {
  // m * n (apply n first, then m)
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export const translate = (x, y) => [1, 0, 0, 1, x, y];
export const scale = (sx, sy) => [sx, 0, 0, sy, 0, 0];
export function rotate(a) {
  const c = Math.cos(a), s = Math.sin(a);
  return [c, s, -s, c, 0, 0];
}

export function apply(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function det(m) {
  return m[0] * m[3] - m[1] * m[2];
}

/** Average scale factor of a matrix (used for text heights, dash lengths, tolerances). */
export function matScale(m) {
  return Math.sqrt(Math.abs(det(m))) || Math.hypot(m[0], m[1]) || 1;
}

export function invert(m) {
  const d = det(m) || 1e-12;
  return [
    m[3] / d, -m[1] / d, -m[2] / d, m[0] / d,
    (m[2] * m[5] - m[3] * m[4]) / d,
    (m[1] * m[4] - m[0] * m[5]) / d,
  ];
}

/**
 * Matrix taking OCS (object coordinate system) XY coordinates to WCS XY,
 * following AutoCAD's arbitrary axis algorithm. Z is dropped (plan view).
 */
export function ocsMatrix(ext) {
  if (!ext) return IDENTITY;
  let { x: nx = 0, y: ny = 0, z: nz = 1 } = ext;
  const len = Math.hypot(nx, ny, nz);
  if (len < 1e-9) return IDENTITY;
  nx /= len; ny /= len; nz /= len;
  if (Math.abs(nx) < 1e-9 && Math.abs(ny) < 1e-9 && nz > 0) return IDENTITY;
  let ax, ay, az;
  if (Math.abs(nx) < 1 / 64 && Math.abs(ny) < 1 / 64) {
    // Wy x N
    ax = nz; ay = 0; az = -nx;
  } else {
    // Wz x N
    ax = -ny; ay = nx; az = 0;
  }
  const al = Math.hypot(ax, ay, az);
  ax /= al; ay /= al; az /= al;
  // Ay = N x Ax
  const bx = ny * az - nz * ay;
  const by = nz * ax - nx * az;
  return [ax, ay, bx, by, 0, 0];
}

/** Number of segments for an arc of radius r (world units) and sweep (radians). */
export function arcSegments(r, sweep, tol) {
  if (!(r > 0)) return 1;
  const t = Math.min(Math.max(tol, r * 1e-4), r * 0.5);
  const step = 2 * Math.acos(1 - t / r);
  const n = Math.ceil(Math.abs(sweep) / (step || 0.1));
  return Math.min(Math.max(n, Math.ceil(Math.abs(sweep) / TAU * 12), 2), 1024);
}

/** Pushes points of an arc (center, radius, start/end angle, ccw) into out (flat x,y list). */
export function pushArc(out, cx, cy, r, a0, a1, ccw, tol, skipFirst = false) {
  let sweep;
  if (ccw) {
    sweep = a1 - a0;
    while (sweep <= 0) sweep += TAU;
  } else {
    sweep = a1 - a0;
    while (sweep >= 0) sweep -= TAU;
  }
  if (Math.abs(sweep) > TAU) sweep = ccw ? TAU : -TAU;
  const n = arcSegments(r, sweep, tol);
  for (let i = skipFirst ? 1 : 0; i <= n; i++) {
    const a = a0 + (sweep * i) / n;
    out.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
}

/** Arc between two points defined by a polyline bulge (tan(sweep/4)). Pushes points excluding the start. */
export function pushBulge(out, x0, y0, x1, y1, bulge, tol) {
  const dx = x1 - x0, dy = y1 - y0;
  const chord = Math.hypot(dx, dy);
  if (chord < 1e-12 || Math.abs(bulge) < 1e-9) {
    out.push(x1, y1);
    return;
  }
  const sweep = 4 * Math.atan(bulge);
  const r = chord / (2 * Math.sin(Math.abs(sweep) / 2));
  // Distance from chord midpoint to center (signed).
  const sagitta = (r * Math.cos(sweep / 2));
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  const nx = -dy / chord, ny = dx / chord;
  const sign = bulge > 0 ? 1 : -1;
  const cx = mx + nx * sagitta * sign;
  const cy = my + ny * sagitta * sign;
  const a0 = Math.atan2(y0 - cy, x0 - cx);
  const n = arcSegments(Math.abs(r), sweep, tol);
  for (let i = 1; i <= n; i++) {
    const a = a0 + (sweep * i) / n;
    out.push(cx + Math.abs(r) * Math.cos(a), cy + Math.abs(r) * Math.sin(a));
  }
  // Snap the last point exactly to the vertex.
  out[out.length - 2] = x1;
  out[out.length - 1] = y1;
}

/** Ellipse given center, major axis vector, ratio and parameter range. */
export function pushEllipse(out, cx, cy, mx, my, ratio, t0, t1, tol, ccw = true, skipFirst = false) {
  const a = Math.hypot(mx, my);
  const b = a * ratio;
  const rot = Math.atan2(my, mx);
  const cr = Math.cos(rot), sr = Math.sin(rot);
  let sweep = t1 - t0;
  if (ccw) { while (sweep <= 1e-12) sweep += TAU; } else { while (sweep >= -1e-12) sweep -= TAU; }
  if (Math.abs(sweep) > TAU + 1e-9) sweep = ccw ? TAU : -TAU;
  const n = arcSegments(a, sweep, tol);
  for (let i = skipFirst ? 1 : 0; i <= n; i++) {
    const t = t0 + (sweep * i) / n;
    const x = a * Math.cos(t), y = b * Math.sin(t);
    out.push(cx + x * cr - y * sr, cy + x * sr + y * cr);
  }
}

/** Evaluates a (rational) B-spline with de Boor's algorithm. Points are {x, y}. */
export function sampleNurbs(degree, knots, ctrl, weights, segments) {
  const n = ctrl.length;
  if (n < 2) return ctrl.flatMap((p) => [p.x, p.y]);
  const p = Math.min(degree, n - 1);
  let U = knots;
  if (!U || U.length !== n + p + 1) {
    // Clamped uniform knot vector.
    U = [];
    for (let i = 0; i <= n + p; i++) U.push(i <= p ? 0 : i >= n ? n - p : i - p);
  }
  const w = weights && weights.length === n ? weights : null;
  const lo = U[p], hi = U[n];
  const out = [];
  for (let s = 0; s <= segments; s++) {
    let u = lo + ((hi - lo) * s) / segments;
    if (s === segments) u = hi - 1e-10 * (hi - lo || 1);
    let k = p;
    while (k < n - 1 && u >= U[k + 1]) k++;
    const d = [];
    for (let j = 0; j <= p; j++) {
      const c = ctrl[k - p + j];
      const wt = w ? w[k - p + j] : 1;
      d.push([c.x * wt, c.y * wt, wt]);
    }
    for (let r = 1; r <= p; r++) {
      for (let j = p; j >= r; j--) {
        const i = k - p + j;
        const denom = U[i + p - r + 1] - U[i];
        const a = denom === 0 ? 0 : (u - U[i]) / denom;
        d[j] = [
          (1 - a) * d[j - 1][0] + a * d[j][0],
          (1 - a) * d[j - 1][1] + a * d[j][1],
          (1 - a) * d[j - 1][2] + a * d[j][2],
        ];
      }
    }
    const [x, y, wt] = d[p];
    out.push(x / (wt || 1), y / (wt || 1));
  }
  return out;
}

/** Smooth curve through fit points (centripetal Catmull-Rom), used when a spline has no control points. */
export function sampleThrough(points, perSegment = 12) {
  const out = [];
  const n = points.length;
  if (n < 3) return points.flatMap((p) => [p.x, p.y]);
  const P = (i) => points[Math.max(0, Math.min(n - 1, i))];
  for (let i = 0; i < n - 1; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    for (let s = i === 0 ? 0 : 1; s <= perSegment; s++) {
      const t = s / perSegment, t2 = t * t, t3 = t2 * t;
      const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push(f(p0.x, p1.x, p2.x, p3.x), f(p0.y, p1.y, p2.y, p3.y));
    }
  }
  return out;
}

export function transformFlat(m, pts) {
  const out = new Float64Array(pts.length);
  for (let i = 0; i < pts.length; i += 2) {
    const x = pts[i], y = pts[i + 1];
    out[i] = m[0] * x + m[2] * y + m[4];
    out[i + 1] = m[1] * x + m[3] * y + m[5];
  }
  return out;
}

export function bboxOf(pts, box = [Infinity, Infinity, -Infinity, -Infinity]) {
  for (let i = 0; i < pts.length; i += 2) {
    const x = pts[i], y = pts[i + 1];
    if (x < box[0]) box[0] = x;
    if (y < box[1]) box[1] = y;
    if (x > box[2]) box[2] = x;
    if (y > box[3]) box[3] = y;
  }
  return box;
}

export function polylineLength(pts, closed) {
  let len = 0;
  for (let i = 2; i < pts.length; i += 2) len += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
  if (closed && pts.length >= 4) len += Math.hypot(pts[0] - pts[pts.length - 2], pts[1] - pts[pts.length - 1]);
  return len;
}

export function polygonArea(pts) {
  let a = 0;
  const n = pts.length;
  for (let i = 0; i < n; i += 2) {
    const j = (i + 2) % n;
    a += pts[i] * pts[j + 1] - pts[j] * pts[i + 1];
  }
  return a / 2;
}

/** Squared distance from point to segment, plus the closest point. */
export function distToSegment(px, py, x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - x0) * dx + (py - y0) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = x0 + t * dx, cy = y0 + t * dy;
  return { d2: (px - cx) ** 2 + (py - cy) ** 2, x: cx, y: cy };
}

/** Intersection of two segments, or null. */
export function segIntersect(x1, y1, x2, y2, x3, y3, x4, y4) {
  const d = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(d) < 1e-12) return null;
  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / d;
  const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / d;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return [x1 + t * (x2 - x1), y1 + t * (y2 - y1)];
}
