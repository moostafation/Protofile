// Geometry of editing: new entities, affine transforms of every entity type (move, copy,
// rotate, scale, mirror), grips, offset and explode. Entities use the DwgDatabase-like schema
// of the parsers (angles in radians, OCS points for 2D entities). Points here are WCS.
import { mul, invert, det, apply, ocsMatrix, rotate, translate, scale as scaleM, IDENTITY } from '../cad/geometry.js';
import { lineweightToRaw, LW_BYLAYER } from '../cad/drawing.js';
import { decodeText, decodeMText } from '../cad/text.js';
import { cloneData } from './model.js';

const TAU = Math.PI * 2;
const approxMeasure = (s) => s.length * 0.62;

// ------------------------------------------------------------------ small vector helpers
export const pt = (x, y) => ({ x, y, z: 0 });
const tp = (M, p) => { if (!p) return; const [x, y] = apply(M, p.x ?? 0, p.y ?? 0); p.x = x; p.y = y; };
const tv = (M, v) => { if (!v) return; const x = v.x ?? 0, y = v.y ?? 0; v.x = M[0] * x + M[2] * y; v.y = M[1] * x + M[3] * y; };
const tvn = (M, v) => { if (!v) return; tv(M, v); const l = Math.hypot(v.x, v.y); if (l > 1e-12) { v.x /= l; v.y /= l; } };
const normAngle = (a) => ((a % TAU) + TAU) % TAU;

/** Similarity decomposition of an affine matrix: scale, rotation, reflection, and whether it is one. */
export function similarity(M) {
  const d = det(M);
  const refl = d < 0;
  const s = Math.sqrt(Math.abs(d));
  const theta = Math.atan2(M[1], M[0]);
  const tol = 1e-9 * Math.max(1, s);
  const ok = refl
    ? Math.abs(M[0] + M[3]) < tol && Math.abs(M[1] - M[2]) < tol
    : Math.abs(M[0] - M[3]) < tol && Math.abs(M[1] + M[2]) < tol;
  return { s, theta, refl, ok };
}

/** Maps a direction angle through a similarity. */
const mapAngle = (sim, a) => (sim.refl ? sim.theta - a : a + sim.theta);

/** Matrices for the modify tools (world coordinates). */
export const moveMatrix = (dx, dy) => translate(dx, dy);
export const rotateMatrix = (cx, cy, a) => mul(translate(cx, cy), mul(rotate(a), translate(-cx, -cy)));
export const scaleMatrix = (cx, cy, k) => mul(translate(cx, cy), mul(scaleM(k, k), translate(-cx, -cy)));
export function mirrorMatrix(x1, y1, x2, y2) {
  const a = Math.atan2(y2 - y1, x2 - x1);
  const c = Math.cos(2 * a), s = Math.sin(2 * a);
  return mul(translate(x1, y1), mul([c, s, s, -c, 0, 0], translate(-x1, -y1)));
}

/** OCS -> WCS matrix of an entity, or null for orientations that are not plan views (tilted 3D). */
function ocsOf(e, ext = e.extrusionDirection) {
  const O = ocsMatrix(ext);
  return Math.abs(Math.abs(det(O)) - 1) < 1e-9 ? O : null;
}

// ------------------------------------------------------------------ new entities
/**
 * Base properties of a new entity: current layer, ByLayer colour, linetype and lineweight
 * (encoded for the drawing's source format).
 */
export function baseEntity(env, type) {
  return {
    type, handle: env.doc.newHandle(), layer: env.layer ?? '0', colorIndex: 256,
    lineweight: lineweightToRaw(LW_BYLAYER, env.drawing.source), lineTypeScale: 1, isVisible: true,
  };
}

export function makeLine(env, a, b) {
  return { ...baseEntity(env, 'LINE'), startPoint: pt(a[0], a[1]), endPoint: pt(b[0], b[1]) };
}

/** `verts`: [{ x, y, bulge }] */
export function makeLwPolyline(env, verts, closed) {
  return { ...baseEntity(env, 'LWPOLYLINE'), flag: closed ? 1 : 0, constantWidth: 0, elevation: 0, vertices: verts.map((v) => ({ x: v.x, y: v.y, bulge: v.bulge || 0 })) };
}

export function makeRectangle(env, a, b) {
  const [x0, x1] = [Math.min(a[0], b[0]), Math.max(a[0], b[0])];
  const [y0, y1] = [Math.min(a[1], b[1]), Math.max(a[1], b[1])];
  return makeLwPolyline(env, [pt(x0, y0), pt(x1, y0), pt(x1, y1), pt(x0, y1)], true);
}

export function makeCircle(env, c, r) {
  return { ...baseEntity(env, 'CIRCLE'), center: pt(c[0], c[1]), radius: r };
}

export function makeArc(env, c, r, a0, a1) {
  return { ...baseEntity(env, 'ARC'), center: pt(c[0], c[1]), radius: r, startAngle: normAngle(a0), endAngle: normAngle(a1) };
}

export function makeText(env, p, height, rotation, text) {
  return {
    ...baseEntity(env, 'TEXT'), text, textHeight: height, rotation, xScale: 1, obliqueAngle: 0, styleName: env.textStyle || 'Standard',
    halign: 0, valign: 0, generationFlag: 0, startPoint: pt(p[0], p[1]), endPoint: pt(0, 0),
  };
}

/** Circle through three points: [cx, cy, r] or null when they are on one line. */
export function circleFrom3(a, b, c) {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a[0] ** 2 + a[1] ** 2, b2 = b[0] ** 2 + b[1] ** 2, c2 = c[0] ** 2 + c[1] ** 2;
  const cx = (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d;
  const cy = (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d;
  return [cx, cy, Math.hypot(a[0] - cx, a[1] - cy)];
}

/** Arc from p1 through p2 to p3: { center, radius, startAngle, endAngle } (counter-clockwise), or null. */
export function arcFrom3(p1, p2, p3) {
  const c = circleFrom3(p1, p2, p3);
  if (!c) return null;
  const [cx, cy, r] = c;
  const ang = (p) => Math.atan2(p[1] - cy, p[0] - cx);
  const a1 = ang(p1), a2 = ang(p2), a3 = ang(p3);
  // Counter-clockwise from p1 to p3 must pass p2; otherwise the arc runs p3 -> p1.
  const ccw = normAngle(a2 - a1) < normAngle(a3 - a1);
  return ccw ? { center: [cx, cy], radius: r, startAngle: a1, endAngle: a3 } : { center: [cx, cy], radius: r, startAngle: a3, endAngle: a1 };
}

/**
 * Revision cloud around a rectangle: a closed polyline of arcs bulging outwards.
 * `arc`: approximate arc length (chord); defaults to a tenth of the longer side.
 */
export function makeRevisionCloud(env, a, b, arc) {
  const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]);
  const y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
  const w = x1 - x0, h = y1 - y0;
  const chord = arc > 0 ? arc : Math.max(w, h) / 10;
  const verts = [];
  const side = (ax, ay, bx, by) => {
    const len = Math.hypot(bx - ax, by - ay);
    const n = Math.max(1, Math.round(len / chord));
    for (let i = 0; i < n; i++) verts.push({ x: ax + ((bx - ax) * i) / n, y: ay + ((by - ay) * i) / n, bulge: 0.5 });
  };
  // Counter-clockwise, so a positive bulge points outwards.
  side(x0, y0, x1, y0); side(x1, y0, x1, y1); side(x1, y1, x0, y1); side(x0, y1, x0, y0);
  return makeLwPolyline(env, verts, true);
}

/** Center, radius and angles of a polyline bulge segment (a -> b), or null when straight. */
export function bulgeArc(a, b, bulge) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const chord = Math.hypot(dx, dy);
  if (chord < 1e-12 || Math.abs(bulge) < 1e-9) return null;
  const sweep = 4 * Math.atan(bulge);
  const r = chord / (2 * Math.sin(Math.abs(sweep) / 2));
  const sag = r * Math.cos(sweep / 2) * (bulge > 0 ? 1 : -1);
  const cx = (a.x + b.x) / 2 - (dy / chord) * sag, cy = (a.y + b.y) / 2 + (dx / chord) * sag;
  return { cx, cy, r: Math.abs(r), a0: Math.atan2(a.y - cy, a.x - cx), a1: Math.atan2(b.y - cy, b.x - cx), ccw: bulge > 0, sweep };
}

/** Bulge of the arc a -> b passing through m. */
export function bulgeThrough(a, m, b) {
  const arc = arcFrom3([a.x, a.y], [m.x, m.y], [b.x, b.y]);
  if (!arc) return 0;
  const [cx, cy] = arc.center;
  const s = Math.atan2(a.y - cy, a.x - cx), e = Math.atan2(b.y - cy, b.x - cx);
  // Which way round passes m: the side of m relative to the chord.
  const cross = (b.x - a.x) * (m.y - a.y) - (b.y - a.y) * (m.x - a.x);
  const sweep = cross < 0 ? normAngle(e - s) : -normAngle(s - e);
  return Math.tan(sweep / 4);
}

// ------------------------------------------------------------------ transforms
/**
 * Transforms an entity in place by the affine matrix M (world coordinates).
 * Returns true when done, false when the entity type cannot be transformed, or
 * { replace } with a new entity (circles and arcs under a non-uniform scale become ellipses).
 * env: { measure (text width for height 1), blockXform(name, M) for dimension/table blocks }.
 */
export function transformEntity(e, M, env = {}) {
  const sim = similarity(M);
  const ocs = () => {
    const O = ocsOf(e);
    if (!O) return null;
    return O === IDENTITY || (O[0] === 1 && O[3] === 1 && !O[1] && !O[2]) ? M : mul(invert(O), mul(M, O));
  };
  const scaleOf = (Mx) => similarity(Mx).s;
  switch (e.type) {
    case 'LINE': tp(M, e.startPoint); tp(M, e.endPoint); return true;
    case 'POINT': tp(M, e.position); return true;
    case 'XLINE': case 'RAY': tp(M, e.firstPoint); tvn(M, e.unitDirection); return true;
    case 'CIRCLE': case 'ARC': {
      const Mo = ocs();
      if (!Mo) return false;
      const so = similarity(Mo);
      if (!so.ok) return { replace: circleToEllipse(e, mul(M, ocsOf(e))) };
      tp(Mo, e.center);
      e.radius *= so.s;
      if (e.type === 'ARC') {
        const a0 = mapAngle(so, e.startAngle), a1 = mapAngle(so, e.endAngle);
        [e.startAngle, e.endAngle] = so.refl ? [normAngle(a1), normAngle(a0)] : [normAngle(a0), normAngle(a1)];
      }
      return true;
    }
    case 'ELLIPSE': {
      if ((e.extrusionDirection?.z ?? 1) < 0) {
        // Normalise to a +Z ellipse: parameters run the other way round.
        [e.startAngle, e.endAngle] = [-(e.endAngle ?? TAU), -(e.startAngle ?? 0)];
        e.extrusionDirection = { x: 0, y: 0, z: 1 };
      }
      if (!sim.ok) {
        const repl = conjugateEllipse(e, M);
        Object.assign(e, repl);
        return true;
      }
      tp(M, e.center);
      tv(M, e.majorAxisEndPoint);
      if (sim.refl) {
        const full = Math.abs(Math.abs((e.endAngle ?? TAU) - (e.startAngle ?? 0)) - TAU) < 1e-9;
        if (!full) [e.startAngle, e.endAngle] = [-(e.endAngle ?? TAU), -(e.startAngle ?? 0)];
      }
      return true;
    }
    case 'LWPOLYLINE': case 'POLYLINE2D': {
      const Mo = ocs();
      if (!Mo) return false;
      const so = similarity(Mo);
      const verts = e.vertices ?? [];
      if (!so.ok && verts.some((v) => v.bulge)) flattenBulges(e);
      for (const v of e.vertices) {
        if (e.type === 'POLYLINE2D' && (v.flag ?? 0) & 16) continue;
        tp(Mo, v);
        if (so.refl && v.bulge) v.bulge = -v.bulge;
        if (v.startWidth) v.startWidth *= so.s;
        if (v.endWidth) v.endWidth *= so.s;
      }
      if (e.constantWidth) e.constantWidth *= so.s;
      if (e.startWidth) e.startWidth *= so.s;
      if (e.endWidth) e.endWidth *= so.s;
      return true;
    }
    case 'POLYLINE3D': case 'POLYGONMESH':
      for (const v of e.vertices ?? []) tp(M, v);
      return true;
    case 'POLYFACE':
      for (const v of e.vertices ?? []) if ((v.flag ?? 0) & 64) tp(M, v);
      return true;
    case 'SPLINE':
      for (const p of e.controlPoints ?? []) tp(M, p);
      for (const p of e.fitPoints ?? []) tp(M, p);
      tv(M, e.startTangent); tv(M, e.endTangent);
      return true;
    case 'SOLID': case 'TRACE': {
      const Mo = ocs();
      if (!Mo) return false;
      for (const k of ['corner1', 'corner2', 'corner3', 'corner4']) tp(Mo, e[k]);
      return true;
    }
    case '3DFACE':
      for (const k of ['corner1', 'corner2', 'corner3', 'corner4']) tp(M, e[k]);
      return true;
    case 'TEXT': return transformText(e, e, M, env);
    case 'ATTRIB': case 'ATTDEF': return e.text ? transformText(e, e.text, M, env) : true;
    case 'MTEXT': return transformMText(e, M, env);
    case 'INSERT': {
      const Mo = ocs();
      if (!Mo) return false;
      const so = similarity(Mo);
      tp(Mo, e.insertionPoint);
      if (so.ok) {
        if (so.refl) {
          e.rotation = normAngle(so.theta - (e.rotation || 0) + Math.PI);
          e.xScale = -(e.xScale ?? 1) * so.s;
          e.yScale = (e.yScale ?? 1) * so.s;
          if (e.columnSpacing) e.columnSpacing *= -so.s;
          if (e.rowSpacing) e.rowSpacing *= so.s;
        } else {
          e.rotation = normAngle((e.rotation || 0) + so.theta);
          e.xScale = (e.xScale ?? 1) * so.s;
          e.yScale = (e.yScale ?? 1) * so.s;
          if (e.columnSpacing) e.columnSpacing *= so.s;
          if (e.rowSpacing) e.rowSpacing *= so.s;
        }
        if (e.zScale !== undefined) e.zScale *= so.s;
      } else {
        // Non-uniform: keep the axes' lengths (shear cannot be represented).
        const r = e.rotation || 0;
        const ex = [Math.cos(r), Math.sin(r)], ey = [-Math.sin(r), Math.cos(r)];
        const mx = [Mo[0] * ex[0] + Mo[2] * ex[1], Mo[1] * ex[0] + Mo[3] * ex[1]];
        const my = [Mo[0] * ey[0] + Mo[2] * ey[1], Mo[1] * ey[0] + Mo[3] * ey[1]];
        e.rotation = normAngle(Math.atan2(mx[1], mx[0]));
        const flip = mx[0] * my[1] - mx[1] * my[0] < 0 ? -1 : 1;
        e.xScale = (e.xScale ?? 1) * Math.hypot(...mx);
        e.yScale = (e.yScale ?? 1) * Math.hypot(...my) * flip;
      }
      for (const a of e.attribs ?? []) transformEntity(a, M, env);
      return true;
    }
    case 'DIMENSION': case 'ARC_DIMENSION': case 'LARGE_RADIAL_DIMENSION': {
      const measured = Number.isFinite(e.measurement) ? e.measurement : dimMeasure(e);
      for (const k of ['definitionPoint', 'textPoint', 'subDefinitionPoint1', 'subDefinitionPoint2', 'centerPoint', 'arcPoint', 'insertionPoint']) tp(M, e[k]);
      if (e.textRotation) e.textRotation = mapAngle(sim, e.textRotation);
      if (e.rotationAngle !== undefined && ((e.dimensionType ?? 0) & 7) === 0) e.rotationAngle = normAngle(mapAngle(sim, e.rotationAngle));
      const kind = (e.dimensionType ?? 0) & 7;
      const linear = [0, 1, 3, 4, 6].includes(kind);
      if (Number.isFinite(e.measurement) && linear) e.measurement *= sim.s;
      if (e.leaderLength) e.leaderLength *= sim.s;
      const retext = linear && Number.isFinite(measured) && Math.abs(sim.s - 1) > 1e-12 && (!e.text || e.text.includes('<>'));
      if (e.name) env.blockXform?.(e.name, M, e, retext ? { from: measured, to: measured * sim.s } : null);
      return true;
    }
    case 'ACAD_TABLE':
      tp(M, e.startPoint); tvn(M, e.directionVector);
      env.blockXform?.(env.tableBlock?.(e), M, e);
      return true;
    case 'TOLERANCE': tp(M, e.insertionPoint); tvn(M, e.xAxisDirection); return true;
    case 'LEADER':
      for (const v of e.vertices ?? []) tp(M, v);
      return true;
    case 'MULTILEADER': {
      for (const sec of e.leaderSections ?? []) {
        tp(M, sec.lastLeaderLinePoint); tvn(M, sec.doglegVector);
        if (sec.doglegLength) sec.doglegLength *= sim.s;
        for (const line of sec.leaderLines ?? []) {
          for (const v of line.vertices ?? []) tp(M, v);
          for (const b of line.breaks ?? []) { tp(M, b.start); tp(M, b.end); }
        }
      }
      for (const k of ['textAnchor', 'contentBasePosition', 'planeOrigin']) tp(M, e[k]);
      if (e.blockContent) tp(M, e.blockContent.position);
      for (const k of ['textDirection', 'planeXAxisDirection', 'planeYAxisDirection']) tvn(M, e[k]);
      if (sim.refl && e.textDirection && e.textDirection.x < -1e-9) { e.textDirection.x = -e.textDirection.x; e.textDirection.y = -e.textDirection.y; }
      for (const k of ['textHeight', 'textWidth', 'arrowheadSize', 'doglegLength', 'landingGap', 'contentScale']) if (e[k]) e[k] *= sim.s;
      return true;
    }
    case 'HATCH': {
      const Mo = ocs();
      if (!Mo) return false;
      const so = similarity(Mo);
      if (!so.ok) return false;
      transformHatch(e, Mo, so);
      return true;
    }
    case 'MLINE':
      for (const v of e.vertices ?? []) {
        tp(M, v.vertex); tvn(M, v.vertexDirection); tvn(M, v.miterDirection);
        for (const l of v.lines ?? []) {
          if (l.segmentParams) l.segmentParams = l.segmentParams.map((x) => x * sim.s);
          if (l.areaFillParams) l.areaFillParams = l.areaFillParams.map((x) => x * sim.s);
        }
      }
      if (e.scale) e.scale *= sim.s;
      return true;
    case 'WIPEOUT': case 'IMAGE':
      tp(M, e.position); tv(M, e.uPixel); tv(M, e.vPixel);
      return true;
    case 'VIEWPORT':
      tp(M, e.viewportCenter);
      if (sim.s !== 1) { e.width *= scaleOf(M); e.height *= scaleOf(M); }
      return true;
    default:
      return false;
  }
}

/** Measured value of a dimension from its definition points (when the file does not store it). */
function dimMeasure(e) {
  const p1 = e.subDefinitionPoint1, p2 = e.subDefinitionPoint2, c = e.centerPoint, d = e.definitionPoint;
  switch ((e.dimensionType ?? 0) & 7) {
    case 0: {
      if (!p1 || !p2) return NaN;
      const a = e.rotationAngle ?? 0;
      return Math.abs((p2.x - p1.x) * Math.cos(a) + (p2.y - p1.y) * Math.sin(a));
    }
    case 1: return p1 && p2 ? Math.hypot(p2.x - p1.x, p2.y - p1.y) : NaN;
    case 3: case 4: return c && d ? Math.hypot(c.x - d.x, c.y - d.y) : NaN;
    default: return NaN;
  }
}

/** Ellipse equivalent of a circle/arc under a non-uniform transform (Mw: OCS -> new WCS). */
function circleToEllipse(e, Mw) {
  const out = { ...cloneData(e), type: 'ELLIPSE' };
  delete out.radius;
  const r = e.radius;
  const c = apply(Mw, e.center.x, e.center.y);
  const u = [Mw[0] * r, Mw[1] * r], v = [Mw[2] * r, Mw[3] * r];
  const el = principalAxes(u, v);
  out.center = pt(c[0], c[1]);
  out.majorAxisEndPoint = pt(el.major[0], el.major[1]);
  out.axisRatio = el.ratio;
  out.extrusionDirection = { x: 0, y: 0, z: 1 };
  if (e.type === 'ARC') {
    let t0 = e.startAngle - el.t0, t1 = e.endAngle - el.t0;
    if (el.flip) [t0, t1] = [-t1, -t0];
    out.startAngle = normAngle(t0); out.endAngle = normAngle(t1);
    if (Math.abs(out.endAngle - out.startAngle) < 1e-12) out.endAngle = out.startAngle + TAU;
  } else { out.startAngle = 0; out.endAngle = TAU; }
  delete out.center.z;
  out.center.z = 0;
  return out;
}

/**
 * Principal axes of the ellipse p(t) = u cos t + v sin t: the major axis vector, the ratio,
 * the parameter offset t0 (new t = t - t0) and whether the orientation flipped.
 */
function principalAxes(u, v) {
  const uu = u[0] * u[0] + u[1] * u[1], vv = v[0] * v[0] + v[1] * v[1], uv = u[0] * v[0] + u[1] * v[1];
  let t0 = 0.5 * Math.atan2(2 * uv, uu - vv);
  let major = [u[0] * Math.cos(t0) + v[0] * Math.sin(t0), u[1] * Math.cos(t0) + v[1] * Math.sin(t0)];
  let minor = [-u[0] * Math.sin(t0) + v[0] * Math.cos(t0), -u[1] * Math.sin(t0) + v[1] * Math.cos(t0)];
  if (Math.hypot(...minor) > Math.hypot(...major)) {
    t0 += Math.PI / 2;
    [major, minor] = [minor, [-major[0], -major[1]]];
  }
  const ratio = Math.min(1, Math.hypot(...minor) / (Math.hypot(...major) || 1)) || 1e-6;
  const flip = major[0] * minor[1] - major[1] * minor[0] < 0;
  return { major, ratio, t0, flip };
}

/** An ELLIPSE under a non-uniform transform: new axes from the conjugate diameters. */
function conjugateEllipse(e, M) {
  const m = e.majorAxisEndPoint, k = e.axisRatio ?? 1;
  const u0 = [m.x, m.y], v0 = [-m.y * k, m.x * k];
  const u = [M[0] * u0[0] + M[2] * u0[1], M[1] * u0[0] + M[3] * u0[1]];
  const v = [M[0] * v0[0] + M[2] * v0[1], M[1] * v0[0] + M[3] * v0[1]];
  const el = principalAxes(u, v);
  const c = apply(M, e.center.x, e.center.y);
  let t0 = (e.startAngle ?? 0) - el.t0, t1 = (e.endAngle ?? TAU) - el.t0;
  if (el.flip) [t0, t1] = [-t1, -t0];
  const full = Math.abs(Math.abs((e.endAngle ?? TAU) - (e.startAngle ?? 0)) - TAU) < 1e-9;
  return {
    center: pt(c[0], c[1]), majorAxisEndPoint: pt(el.major[0], el.major[1]), axisRatio: el.ratio,
    startAngle: full ? 0 : t0, endAngle: full ? TAU : t1,
  };
}

/** Replaces bulge segments by straight segments (for non-uniform transforms). */
function flattenBulges(e) {
  const verts = e.vertices;
  const closed = !!(e.flag & 1);
  const out = [];
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i], b = verts[(i + 1) % verts.length];
    out.push({ ...a, bulge: 0 });
    if (!a.bulge || (i === verts.length - 1 && !closed)) continue;
    const arc = bulgeArc(a, b, a.bulge);
    if (!arc) continue;
    const n = Math.max(2, Math.ceil(Math.abs(arc.sweep) / (Math.PI / 16)));
    for (let k = 1; k < n; k++) {
      const t = arc.a0 + (arc.sweep * k) / n;
      out.push({ x: arc.cx + arc.r * Math.cos(t), y: arc.cy + arc.r * Math.sin(t), bulge: 0 });
    }
  }
  e.vertices = out;
}

function transformHatch(e, M, so) {
  // Arc and ellipse edges store "mirrored" angles when clockwise: work with the real angles.
  const edgeAngles = (edge, isEllipse) => {
    const ccw = edge.isCCW !== false;
    const a0 = ccw ? edge.startAngle : -edge.startAngle, a1 = ccw ? edge.endAngle : -edge.endAngle;
    let n0, n1, nccw = ccw;
    if (isEllipse) {
      // Ellipse parameters: unchanged by a rotation, negated by a reflection.
      if (so.refl) { n0 = -a0; n1 = -a1; nccw = !ccw; } else { n0 = a0; n1 = a1; }
    } else if (so.refl) { n0 = so.theta - a0; n1 = so.theta - a1; nccw = !ccw; } else { n0 = a0 + so.theta; n1 = a1 + so.theta; }
    const full = Math.abs(Math.abs(edge.endAngle - edge.startAngle) - TAU) < 1e-9;
    if (nccw) { edge.startAngle = n0; edge.endAngle = full ? n0 + TAU : n1; } else { edge.startAngle = -n0; edge.endAngle = full ? -n0 + TAU : -n1; }
    edge.isCCW = nccw;
  };
  for (const path of e.boundaryPaths ?? []) {
    if (path.vertices) {
      for (const v of path.vertices) { tp(M, v); if (so.refl && v.bulge) v.bulge = -v.bulge; }
      continue;
    }
    for (const edge of path.edges ?? []) {
      if (edge.type === 1) { tp(M, edge.start); tp(M, edge.end); }
      else if (edge.type === 2) { tp(M, edge.center); edge.radius *= so.s; edgeAngles(edge, false); }
      else if (edge.type === 3) { tp(M, edge.center); tv(M, edge.end); edgeAngles(edge, true); }
      else if (edge.type === 4) {
        for (const p of edge.controlPoints ?? []) tp(M, p);
        for (const p of edge.fitDatum ?? []) tp(M, p);
        tv(M, edge.startTangent); tv(M, edge.endTangent);
      }
    }
  }
  for (const d of e.definitionLines ?? []) {
    d.angle = mapAngle(so, d.angle);
    tp(M, d.base);
    tv(M, d.offset);
    d.dashLengths = (d.dashLengths ?? []).map((v) => v * so.s);
  }
  if (e.patternAngle !== undefined) e.patternAngle = normAngle(mapAngle(so, e.patternAngle));
  if (e.patternScale) e.patternScale *= so.s;
  for (const p of e.seedPoints ?? []) tp(M, p);
}

/** Box centre offset of a TEXT relative to its reference point (local, unrotated). */
function textBox(t, env) {
  const h = t.textHeight || 1;
  const wf = t.xScale || 1;
  const ha = t.halign ?? 0, va = t.valign ?? 0;
  const measure = env.measure || approxMeasure;
  let w = measure(decodeText(t.text ?? '')) * h * wf;
  if (ha === 3 || ha === 5) w = Math.hypot((t.endPoint?.x ?? 0) - (t.startPoint?.x ?? 0), (t.endPoint?.y ?? 0) - (t.startPoint?.y ?? 0)) || w;
  const cx = ha === 1 || ha === 4 ? 0 : ha === 2 ? -w / 2 : w / 2;
  const cy = ha === 4 || va === 2 ? 0 : va === 3 ? -h / 2 : h / 2;
  return { w, h, cx, cy };
}

const usesEnd = (t) => {
  const ha = t.halign ?? 0, va = t.valign ?? 0;
  return (ha !== 0 || va !== 0) && t.endPoint && (t.endPoint.x !== 0 || t.endPoint.y !== 0);
};

/** Picks the readable one of the two orientations a mirrored text can take (MIRRTEXT = 0). */
function readableRotation(sim, rot) {
  const r1 = normAngle(sim.theta - rot), r2 = normAngle(sim.theta - rot + Math.PI);
  return Math.cos(r1 - rot) >= Math.cos(r2 - rot) - 1e-9 ? r1 : r2;
}

/** TEXT / ATTRIB / ATTDEF: `t` holds the text fields (the entity itself, or its .text). */
function transformText(e, t, M, env) {
  const O = ocsOf(e, t.extrusionDirection ?? e.extrusionDirection);
  if (!O) return false;
  const Mo = O[0] === 1 && O[3] === 1 ? M : mul(invert(O), mul(M, O));
  const so = similarity(Mo);
  const rot = t.rotation || 0;
  if (!so.ok) {
    // Non-uniform (explode of a stretched block): new height and width factor from the axes.
    const d = [Mo[0] * Math.cos(rot) + Mo[2] * Math.sin(rot), Mo[1] * Math.cos(rot) + Mo[3] * Math.sin(rot)];
    const up = [-Mo[0] * Math.sin(rot) + Mo[2] * Math.cos(rot), -Mo[1] * Math.sin(rot) + Mo[3] * Math.cos(rot)];
    const ld = Math.hypot(...d) || 1;
    const hk = Math.abs(d[0] * up[1] - d[1] * up[0]) / ld;
    tp(Mo, t.startPoint); if (usesEnd(t)) tp(Mo, t.endPoint);
    t.rotation = normAngle(Math.atan2(d[1], d[0]));
    t.textHeight = (t.textHeight || 1) * hk;
    t.xScale = (t.xScale || 1) * ld / (hk || 1);
    return true;
  }
  const h = (t.textHeight || 1);
  if (!so.refl) {
    tp(Mo, t.startPoint);
    if (usesEnd(t) || t.halign === 3 || t.halign === 5) tp(Mo, t.endPoint);
    t.rotation = normAngle(rot + so.theta);
    t.textHeight = h * so.s;
    return true;
  }
  // Mirror: the text box moves to the mirrored place but stays readable.
  const box = textBox(t, env);
  const ref = usesEnd(t) && t.halign !== 3 && t.halign !== 5 ? t.endPoint : t.startPoint;
  const c = Math.cos(rot), s = Math.sin(rot);
  const center = [ref.x + box.cx * c - box.cy * s, ref.y + box.cx * s + box.cy * c];
  const [mx, my] = apply(Mo, center[0], center[1]);
  const nr = readableRotation(so, rot);
  const k = so.s;
  const nc = Math.cos(nr), ns = Math.sin(nr);
  const lx = box.cx * k, ly = box.cy * k;
  const nref = { x: mx - (lx * nc - ly * ns), y: my - (lx * ns + ly * nc) };
  t.rotation = nr;
  t.textHeight = h * k;
  if (t.halign === 3 || t.halign === 5) {
    const w = box.w * k;
    t.startPoint = { ...t.startPoint, x: nref.x, y: nref.y };
    t.endPoint = { ...t.endPoint, x: nref.x + w * nc, y: nref.y + w * ns };
  } else if (usesEnd(t)) {
    t.endPoint = { ...t.endPoint, x: nref.x, y: nref.y };
    t.startPoint = { ...t.startPoint, x: nref.x, y: nref.y };
  } else {
    t.startPoint = { ...t.startPoint, x: nref.x, y: nref.y };
  }
  return true;
}

function transformMText(e, M, env) {
  const sim = similarity(M);
  if (!sim.ok) {
    tp(M, e.insertionPoint);
    const k = Math.sqrt(Math.abs(det(M)));
    e.textHeight = (e.textHeight || 1) * k;
    if (e.rectWidth) e.rectWidth *= k;
    if (e.direction) tvn(M, e.direction);
    return true;
  }
  const rot = e.direction && (e.direction.x || e.direction.y) ? Math.atan2(e.direction.y, e.direction.x) : e.rotation || 0;
  const h = e.textHeight || 1;
  if (!sim.refl) {
    tp(M, e.insertionPoint);
    const nr = normAngle(rot + sim.theta);
    e.rotation = nr;
    if (e.direction) e.direction = { x: Math.cos(nr), y: Math.sin(nr), z: 0 };
    e.textHeight = h * sim.s;
    if (e.rectWidth) e.rectWidth *= sim.s;
    if (e.rectHeight) e.rectHeight *= sim.s;
    return true;
  }
  const measure = env.measure || approxMeasure;
  const lines = decodeMText(e.text ?? '');
  const w = e.rectWidth || Math.max(...lines.map((l) => measure(l) * h), h);
  const H = (lines.length - 1) * h * 1.667 * (e.lineSpacing || 1) + h;
  const ap = e.attachmentPoint || 1;
  const ha = (ap - 1) % 3, vr = Math.floor((ap - 1) / 3);
  const cx = ha === 0 ? w / 2 : ha === 1 ? 0 : -w / 2;
  const cy = vr === 0 ? -H / 2 : vr === 1 ? 0 : H / 2;
  const c = Math.cos(rot), s = Math.sin(rot);
  const ip = e.insertionPoint;
  const [mx, my] = apply(M, ip.x + cx * c - cy * s, ip.y + cx * s + cy * c);
  const nr = readableRotation(sim, rot);
  const k = sim.s, nc = Math.cos(nr), ns = Math.sin(nr);
  e.insertionPoint = { ...ip, x: mx - (cx * k * nc - cy * k * ns), y: my - (cx * k * ns + cy * k * nc) };
  e.rotation = nr;
  if (e.direction) e.direction = { x: nc, y: ns, z: 0 };
  e.textHeight = h * k;
  if (e.rectWidth) e.rectWidth *= k;
  if (e.rectHeight) e.rectHeight *= k;
  return true;
}

// ------------------------------------------------------------------ grips
/**
 * Grips of an entity: [{ x, y, kind, apply(e, x, y) }] in world coordinates. `apply` mutates
 * the entity for the grip dragged to (x, y). kind: 'move' moves the whole entity.
 */
export function gripsOf(e, env = {}) {
  const g = [];
  const add = (x, y, fn, kind = 'stretch') => { if (Number.isFinite(x) && Number.isFinite(y)) g.push({ x, y, kind, apply: fn }); };
  const O = ocsOf(e) ?? IDENTITY;
  const Oi = invert(O);
  const w = (p) => apply(O, p.x, p.y);
  const local = (x, y) => apply(Oi, x, y);
  const moveBy = (x0, y0) => (en, x, y) => transformEntity(en, translate(x - x0, y - y0), env);
  switch (e.type) {
    case 'LINE': {
      const a = e.startPoint, b = e.endPoint;
      add(a.x, a.y, (en, x, y) => { en.startPoint.x = x; en.startPoint.y = y; });
      add(b.x, b.y, (en, x, y) => { en.endPoint.x = x; en.endPoint.y = y; });
      add((a.x + b.x) / 2, (a.y + b.y) / 2, moveBy((a.x + b.x) / 2, (a.y + b.y) / 2), 'move');
      break;
    }
    case 'LWPOLYLINE': case 'POLYLINE2D': case 'POLYLINE3D': {
      const verts = (e.vertices ?? []).filter((v) => !((v.flag ?? 0) & 16));
      const closed = !!(e.flag & 1);
      const W = e.type === 'POLYLINE3D' ? (p) => [p.x, p.y] : w;
      const L = e.type === 'POLYLINE3D' ? (x, y) => [x, y] : local;
      if (verts.length > 400) { add(...W(verts[0]), moveBy(...W(verts[0])), 'move'); break; }
      verts.forEach((v, i) => {
        add(...W(v), (en, x, y) => {
          const vv = (en.vertices ?? []).filter((q) => !((q.flag ?? 0) & 16))[i];
          [vv.x, vv.y] = L(x, y);
        });
      });
      // Segment midpoints: straight segments move with both ends, arcs change their bulge.
      if (e.type === 'LWPOLYLINE') {
        const n = verts.length, segs = closed ? n : n - 1;
        for (let i = 0; i < segs; i++) {
          const a = verts[i], b = verts[(i + 1) % n];
          const arc = bulgeArc(a, b, a.bulge || 0);
          let m;
          if (arc) {
            const t = arc.a0 + arc.sweep / 2;
            m = { x: arc.cx + arc.r * Math.cos(t), y: arc.cy + arc.r * Math.sin(t) };
          } else m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          add(...w(m), (en, x, y) => {
            const va = en.vertices[i], vb = en.vertices[(i + 1) % n];
            const [lx, ly] = local(x, y);
            if (arc) va.bulge = bulgeThrough(va, { x: lx, y: ly }, vb);
            else { const dx = lx - m.x, dy = ly - m.y; va.x += dx; va.y += dy; vb.x += dx; vb.y += dy; }
          }, 'mid');
        }
      }
      break;
    }
    case 'CIRCLE': case 'ARC': {
      const c = e.center, r = e.radius;
      add(...w(c), moveBy(...w(c)), 'move');
      const setRadius = (en, x, y) => { const [lx, ly] = local(x, y); en.radius = Math.max(1e-9, Math.hypot(lx - en.center.x, ly - en.center.y)); };
      if (e.type === 'CIRCLE') {
        for (const a of [0, Math.PI / 2, Math.PI, 1.5 * Math.PI]) add(...w({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) }), setRadius);
      } else {
        const P = (a) => ({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) });
        const sweep = normAngle(e.endAngle - e.startAngle) || TAU;
        const p0 = P(e.startAngle), p1 = P(e.endAngle), pm = P(e.startAngle + sweep / 2);
        const through = (which) => (en, x, y) => {
          const [lx, ly] = local(x, y);
          const pts = { s: [p0.x, p0.y], m: [pm.x, pm.y], e: [p1.x, p1.y] };
          pts[which] = [lx, ly];
          const arc = arcFrom3(pts.s, pts.m, pts.e);
          if (!arc) return;
          en.center.x = arc.center[0]; en.center.y = arc.center[1]; en.radius = arc.radius;
          en.startAngle = normAngle(arc.startAngle); en.endAngle = normAngle(arc.endAngle);
        };
        add(...w(p0), through('s')); add(...w(p1), through('e')); add(...w(pm), through('m'), 'mid');
      }
      break;
    }
    case 'ELLIPSE': {
      const c = e.center, m = e.majorAxisEndPoint, k = e.axisRatio ?? 1;
      add(c.x, c.y, moveBy(c.x, c.y), 'move');
      add(c.x + m.x, c.y + m.y, (en, x, y) => { en.majorAxisEndPoint.x = x - en.center.x; en.majorAxisEndPoint.y = y - en.center.y; });
      add(c.x - m.y * k, c.y + m.x * k, (en, x, y) => {
        const L = Math.hypot(en.majorAxisEndPoint.x, en.majorAxisEndPoint.y) || 1;
        const d = Math.hypot(x - en.center.x, y - en.center.y);
        if (d <= L) en.axisRatio = Math.max(1e-6, d / L);
      });
      break;
    }
    case 'TEXT': {
      const ref = usesEnd(e) && e.halign !== 3 && e.halign !== 5 ? e.endPoint : e.startPoint;
      add(...w(ref), moveBy(...w(ref)), 'move');
      break;
    }
    case 'MTEXT': add(e.insertionPoint.x, e.insertionPoint.y, moveBy(e.insertionPoint.x, e.insertionPoint.y), 'move'); break;
    case 'INSERT': {
      const ip = w(e.insertionPoint);
      add(ip[0], ip[1], moveBy(ip[0], ip[1]), 'move');
      (e.attribs ?? []).forEach((a, i) => {
        if (!a.text || ((a.flags ?? 0) & 1)) return;
        const t = a.text;
        const ref = usesEnd(t) && t.halign !== 3 && t.halign !== 5 ? t.endPoint : t.startPoint;
        const Oa = ocsOf(a, t.extrusionDirection) ?? IDENTITY;
        const [rx, ry] = apply(Oa, ref.x, ref.y);
        add(rx, ry, (en, x, y) => transformEntity(en.attribs[i], translate(x - rx, y - ry), env));
      });
      break;
    }
    case 'POINT': add(e.position.x, e.position.y, moveBy(e.position.x, e.position.y), 'move'); break;
    case 'SPLINE': {
      const list = e.controlPoints?.length ? 'controlPoints' : 'fitPoints';
      const pts = e[list] ?? [];
      if (pts.length > 200) break;
      pts.forEach((p, i) => add(p.x, p.y, (en, x, y) => { en[list][i].x = x; en[list][i].y = y; }));
      break;
    }
    case 'LEADER':
      (e.vertices ?? []).forEach((p, i) => add(p.x, p.y, (en, x, y) => { en.vertices[i].x = x; en.vertices[i].y = y; }));
      break;
    case 'SOLID': case 'TRACE': case '3DFACE':
      ['corner1', 'corner2', 'corner3', 'corner4'].forEach((k) => {
        if (!e[k] || (k === 'corner4' && e.corner3 && e[k].x === e.corner3.x && e[k].y === e.corner3.y)) return;
        const W = e.type === '3DFACE' ? [e[k].x, e[k].y] : w(e[k]);
        add(W[0], W[1], (en, x, y) => { [en[k].x, en[k].y] = e.type === '3DFACE' ? [x, y] : local(x, y); });
      });
      break;
    default: {
      // Everything else gets one grip that moves it (dimensions, hatches, tables...).
      const c = env.center?.(e);
      if (c) add(c[0], c[1], moveBy(c[0], c[1]), 'move');
    }
  }
  return g;
}

// ------------------------------------------------------------------ offset
/**
 * Offset copy of a LINE, LWPOLYLINE, POLYLINE2D, CIRCLE or ARC at `dist` towards the side of
 * world point `side`. Returns the new entity data (without handle), or null.
 */
export function offsetEntity(e, dist, side) {
  const O = ocsOf(e);
  if (!O || !(dist > 0)) return null;
  const [sx, sy] = apply(invert(O), side[0], side[1]);
  const copy = cloneData(e);
  delete copy.handle;
  switch (e.type) {
    case 'LINE': {
      const a = e.startPoint, b = e.endPoint;
      const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy);
      if (L < 1e-12) return null;
      const nx = -dy / L, ny = dx / L;
      const sgn = (side[0] - a.x) * nx + (side[1] - a.y) * ny >= 0 ? 1 : -1;
      copy.startPoint = { ...a, x: a.x + nx * dist * sgn, y: a.y + ny * dist * sgn };
      copy.endPoint = { ...b, x: b.x + nx * dist * sgn, y: b.y + ny * dist * sgn };
      return copy;
    }
    case 'CIRCLE': case 'ARC': {
      const d = Math.hypot(sx - e.center.x, sy - e.center.y);
      const r = d > e.radius ? e.radius + dist : e.radius - dist;
      if (!(r > 1e-9)) return null;
      copy.radius = r;
      return copy;
    }
    case 'LWPOLYLINE': case 'POLYLINE2D': {
      const verts = (e.vertices ?? []).filter((v) => !((v.flag ?? 0) & 16)).map((v) => ({ x: v.x, y: v.y, bulge: v.bulge || 0 }));
      if (verts.length < 2) return null;
      const closed = !!(e.flag & 1);
      const sgn = polySide(verts, closed, sx, sy);
      const out = offsetPolyline(verts, closed, dist * sgn);
      if (!out || out.length < 2) return null;
      const res = {
        type: 'LWPOLYLINE', layer: e.layer, colorIndex: e.colorIndex, lineweight: e.lineweight, lineType: e.lineType,
        lineTypeScale: e.lineTypeScale, isVisible: true, flag: closed ? 1 : 0, constantWidth: e.constantWidth || 0,
        elevation: e.elevation || 0, vertices: out,
      };
      if (typeof e.color === 'number') res.color = e.color;
      if (e.extrusionDirection) res.extrusionDirection = { ...e.extrusionDirection };
      return res;
    }
    default:
      return null;
  }
}

/** +1 when (x, y) lies left of the polyline's nearest segment, -1 when right. */
function polySide(verts, closed, x, y) {
  const n = verts.length, segs = closed ? n : n - 1;
  let best = Infinity, sgn = 1;
  for (let i = 0; i < segs; i++) {
    const a = verts[i], b = verts[(i + 1) % n];
    const arc = bulgeArc(a, b, a.bulge);
    let d, s;
    if (arc) {
      const r = Math.hypot(x - arc.cx, y - arc.cy);
      d = Math.abs(r - arc.r);
      // Left of a counter-clockwise arc is its inside.
      s = (r < arc.r) === arc.ccw ? 1 : -1;
    } else {
      const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / L2));
      d = Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy));
      s = dx * (y - a.y) - dy * (x - a.x) >= 0 ? 1 : -1;
    }
    if (d < best) { best = d; sgn = s; }
  }
  return sgn;
}

/** Offsets a polyline (positive d = to the left). Joins straight segments at their intersections. */
function offsetPolyline(verts, closed, d) {
  const n = verts.length, segCount = closed ? n : n - 1;
  const segs = [];
  for (let i = 0; i < segCount; i++) {
    const a = verts[i], b = verts[(i + 1) % n];
    const arc = bulgeArc(a, b, a.bulge);
    if (arc) {
      // Left of a CCW arc is the inside: the radius shrinks.
      const r = arc.r + (arc.ccw ? -d : d);
      if (!(r > 1e-9)) return null;
      segs.push({ arc: true, bulge: a.bulge, p0: { x: arc.cx + r * Math.cos(arc.a0), y: arc.cy + r * Math.sin(arc.a0) }, p1: { x: arc.cx + r * Math.cos(arc.a1), y: arc.cy + r * Math.sin(arc.a1) } });
    } else {
      const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy);
      if (L < 1e-12) continue;
      const nx = -dy / L * d, ny = dx / L * d;
      segs.push({ arc: false, bulge: 0, p0: { x: a.x + nx, y: a.y + ny }, p1: { x: b.x + nx, y: b.y + ny } });
    }
  }
  if (!segs.length) return null;
  const join = (s, t) => {
    if (!s.arc && !t.arc) {
      const q = lineIntersection(s.p0, s.p1, t.p0, t.p1);
      if (q) return [q];
    }
    if (Math.hypot(s.p1.x - t.p0.x, s.p1.y - t.p0.y) < 1e-9) return [s.p1];
    return [s.p1, t.p0];
  };
  const out = [];
  const m = segs.length;
  for (let i = 0; i < m; i++) {
    const s = segs[i];
    if (i === 0) {
      if (closed) {
        const j = join(segs[m - 1], s);
        out.push({ ...j[j.length - 1], bulge: s.bulge });
      } else out.push({ ...s.p0, bulge: s.bulge });
    }
    if (i < m - 1) {
      const j = join(s, segs[i + 1]);
      if (j.length === 2) { out.push({ ...j[0], bulge: 0 }); out.push({ ...j[1], bulge: segs[i + 1].bulge }); } else out.push({ ...j[0], bulge: segs[i + 1].bulge });
    } else if (closed) {
      const j = join(s, segs[0]);
      if (j.length === 2) out.push({ ...j[0], bulge: 0 });
    } else out.push({ ...s.p1, bulge: 0 });
  }
  return out.map((v) => ({ x: v.x, y: v.y, bulge: v.bulge }));
}

function lineIntersection(a, b, c, d) {
  const den = (a.x - b.x) * (c.y - d.y) - (a.y - b.y) * (c.x - d.x);
  if (Math.abs(den) < 1e-12) return null;
  const t = ((a.x - c.x) * (c.y - d.y) - (a.y - c.y) * (c.x - d.x)) / den;
  return { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
}

// ------------------------------------------------------------------ explode
/**
 * Explodes an entity into simpler ones (one level, like AutoCAD's EXPLODE). Block contents
 * inherit the reference's layer (for objects on layer 0) and its ByBlock colour, linetype and
 * lineweight, so the result looks the same. Returns new entities without handles, or null.
 * env: { drawing, tableBlock(e) }
 */
export function explodeEntity(e, env) {
  const d = env.drawing;
  switch (e.type) {
    case 'INSERT': {
      const blockName = e.blockName ?? e.name;
      const block = d.blocks.get(blockName);
      if (!block) return null;
      const base = block.base ?? { x: 0, y: 0 };
      const ocs = ocsMatrix(e.extrusionDirection);
      const out = [];
      const cols = Math.max(1, e.columnCount || 1), rows = Math.max(1, e.rowCount || 1);
      if (cols * rows > 1000) return null;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          let local = mul(rotate(e.rotation || 0), translate(c * (e.columnSpacing || 0), r * (e.rowSpacing || 0)));
          local = mul(local, scaleM(e.xScale ?? 1, e.yScale ?? 1));
          local = mul(local, translate(-base.x, -base.y));
          local = mul(translate(e.insertionPoint.x, e.insertionPoint.y), local);
          const M = mul(ocs, local);
          for (const sub of block.entities) {
            if (sub.type === 'ATTDEF') {
              // Constant attributes become text; the others are the references' attributes.
              if (!((sub.flags ?? 0) & 2)) continue;
              const t = attribToText(sub);
              if (t && place(t, M, e, env)) out.push(t);
              continue;
            }
            const copy = cloneData(sub);
            const placed = place(copy, M, e, env);
            if (placed) out.push(placed === true ? copy : placed);
          }
        }
      }
      for (const a of e.attribs ?? []) {
        if ((a.flags ?? 0) & 1) continue;
        const t = attribToText(a);
        if (t) { inherit(t, e); out.push(t); }
      }
      return out;
    }
    case 'DIMENSION': case 'ACAD_TABLE': case 'ARC_DIMENSION': case 'LARGE_RADIAL_DIMENSION': {
      const name = e.type === 'ACAD_TABLE' ? env.tableBlock?.(e) : e.name;
      const block = name && d.blocks.get(name);
      if (!block) return null;
      return block.entities.map((sub) => { const c = cloneData(sub); inherit(c, e); return c; });
    }
    case 'LWPOLYLINE': case 'POLYLINE2D': {
      const O = ocsOf(e);
      if (!O) return null;
      const verts = (e.vertices ?? []).filter((v) => !((v.flag ?? 0) & 16));
      const closed = !!(e.flag & 1);
      const out = [];
      const n = verts.length, segs = closed ? n : n - 1;
      for (let i = 0; i < segs; i++) {
        const a = verts[i], b = verts[(i + 1) % n];
        const arc = bulgeArc(a, b, a.bulge || 0);
        const props = { layer: e.layer, colorIndex: e.colorIndex, lineweight: e.lineweight, lineType: e.lineType, lineTypeScale: e.lineTypeScale, isVisible: true };
        if (typeof e.color === 'number') props.color = e.color;
        if (arc) {
          const [s0, s1] = arc.ccw ? [arc.a0, arc.a1] : [arc.a1, arc.a0];
          const ent = { type: 'ARC', ...props, center: pt(arc.cx, arc.cy), radius: arc.r, startAngle: normAngle(s0), endAngle: normAngle(s1) };
          if (e.extrusionDirection) ent.extrusionDirection = { ...e.extrusionDirection };
          out.push(ent);
        } else {
          const [ax, ay] = apply(O, a.x, a.y), [bx, by] = apply(O, b.x, b.y);
          if (Math.hypot(bx - ax, by - ay) < 1e-12) continue;
          out.push({ type: 'LINE', ...props, startPoint: pt(ax, ay), endPoint: pt(bx, by) });
        }
      }
      return out;
    }
    case 'POLYLINE3D': {
      const verts = (e.vertices ?? []).filter((v) => !((v.flag ?? 0) & 16));
      const closed = !!(e.flag & 1);
      const out = [];
      for (let i = 0; i < (closed ? verts.length : verts.length - 1); i++) {
        const a = verts[i], b = verts[(i + 1) % verts.length];
        out.push({ type: 'LINE', layer: e.layer, colorIndex: e.colorIndex, lineweight: e.lineweight, lineType: e.lineType, isVisible: true, startPoint: { x: a.x, y: a.y, z: a.z ?? 0 }, endPoint: { x: b.x, y: b.y, z: b.z ?? 0 } });
      }
      return out;
    }
    case 'MLINE': return mlineToPolylines(e);
    case 'MULTILEADER': return multileaderParts(e, env);
    default:
      return null;
  }
}

/** Places a block entity: transform by M, then inherit from the reference. Returns true, a replacement, or false. */
function place(ent, M, ref, env) {
  const r = transformEntity(ent, M, { measure: env.measure });
  if (!r) return false;
  const out = r === true ? ent : r.replace;
  inherit(out, ref);
  if (out.type === 'INSERT') for (const a of out.attribs ?? []) inherit(a, ref);
  return r === true ? true : out;
}

/** Layer 0 and ByBlock properties come from the block reference. */
function inherit(ent, ref) {
  if ((ent.layer ?? '0') === '0') ent.layer = ref.layer ?? '0';
  if (ent.colorIndex === 0 && typeof ent.color !== 'number') {
    ent.colorIndex = ref.colorIndex ?? 256;
    if (typeof ref.color === 'number') ent.color = ref.color;
  }
  if (ent.lineType && /^byblock$/i.test(ent.lineType)) ent.lineType = ref.lineType || 'ByLayer';
  if (ent.lineweight === -2 || ent.lineweight === 30) ent.lineweight = ref.lineweight;
}

function attribToText(a) {
  const t = a.text;
  if (!t || !(t.text ?? '').trim()) return null;
  const out = {
    type: 'TEXT', layer: a.layer ?? '0', colorIndex: a.colorIndex ?? 256, lineweight: a.lineweight, lineType: a.lineType,
    lineTypeScale: a.lineTypeScale ?? 1, isVisible: true,
    text: t.text, textHeight: t.textHeight || 1, rotation: t.rotation || 0, xScale: t.xScale || 1, obliqueAngle: t.obliqueAngle || 0,
    styleName: t.styleName || 'Standard', halign: t.halign ?? 0, valign: t.valign ?? 0, generationFlag: t.generationFlag ?? 0,
    startPoint: { ...(t.startPoint ?? pt(0, 0)) }, endPoint: { ...(t.endPoint ?? pt(0, 0)) },
  };
  if (typeof a.color === 'number') out.color = a.color;
  if (t.extrusionDirection) out.extrusionDirection = { ...t.extrusionDirection };
  return out;
}

/** MLINE elements as polylines (also used when saving: DXF MLINE needs MLINESTYLE objects). */
export function mlineToPolylines(e) {
  const verts = e.vertices ?? [];
  if (verts.length < 2) return [];
  const lines = Math.max(...verts.map((v) => v.lines?.length ?? 0));
  const closed = !!((e.flags ?? 0) & 2);
  const out = [];
  for (let j = 0; j < lines; j++) {
    const vs = verts.map((v) => {
      const off = v.lines?.[j]?.segmentParams?.[0] ?? 0;
      return { x: v.vertex.x + v.miterDirection.x * off, y: v.vertex.y + v.miterDirection.y * off, bulge: 0 };
    });
    const p = { type: 'LWPOLYLINE', layer: e.layer, colorIndex: e.colorIndex ?? 256, lineweight: e.lineweight, lineType: e.lineType, isVisible: true, flag: closed ? 1 : 0, constantWidth: 0, elevation: 0, vertices: vs };
    if (typeof e.color === 'number') p.color = e.color;
    out.push(p);
  }
  return out;
}

/** MULTILEADER as leader polylines, arrowheads (SOLID), dogleg lines and its MTEXT. */
export function multileaderParts(e, env = {}) {
  const props = { layer: e.layer, colorIndex: e.colorIndex ?? 256, lineweight: e.lineweight, lineType: e.lineType, isVisible: true };
  if (typeof e.color === 'number') props.color = e.color;
  const out = [];
  const size = e.arrowheadSize || env.arrowSize || 2.5;
  for (const sec of e.leaderSections ?? []) {
    for (const line of sec.leaderLines ?? []) {
      const pts = [...(line.vertices ?? [])];
      if (sec.lastLeaderLinePoint) pts.push(sec.lastLeaderLinePoint);
      if (pts.length < 2) continue;
      out.push({ type: 'LWPOLYLINE', ...props, flag: 0, constantWidth: 0, elevation: 0, vertices: pts.map((p) => ({ x: p.x, y: p.y, bulge: 0 })) });
      const tip = pts[0], from = pts[1];
      const dx = tip.x - from.x, dy = tip.y - from.y, len = Math.hypot(dx, dy);
      if (len > 1e-12) {
        const ux = dx / len, uy = dy / len, bx = tip.x - ux * size, by = tip.y - uy * size, w = size / 6;
        out.push({ type: 'SOLID', ...props, corner1: pt(tip.x, tip.y), corner2: pt(bx - uy * w, by + ux * w), corner3: pt(bx + uy * w, by - ux * w), corner4: pt(bx + uy * w, by - ux * w) });
      }
    }
    if (sec.lastLeaderLinePoint && sec.doglegVector && (sec.doglegLength || e.doglegLength)) {
      const L = sec.doglegLength || e.doglegLength, p = sec.lastLeaderLinePoint, v = sec.doglegVector;
      out.push({ type: 'LINE', ...props, startPoint: pt(p.x, p.y), endPoint: pt(p.x + v.x * L, p.y + v.y * L) });
    }
  }
  if (e.textContent && e.textAnchor) {
    out.push({
      type: 'MTEXT', ...props, text: e.textContent, textHeight: e.textHeight || 2.5, insertionPoint: pt(e.textAnchor.x, e.textAnchor.y),
      attachmentPoint: e.textAttachmentPoint || 1, rectWidth: e.textWidth || 0, rotation: e.textRotation || 0, lineSpacing: e.textLineSpacingFactor || 1,
      direction: e.textDirection ? { x: e.textDirection.x, y: e.textDirection.y, z: 0 } : undefined, styleName: 'Standard',
    });
  }
  return out;
}

/**
 * After a dimension was scaled, its graphics block still shows the old value: numbers in its
 * texts that equal the old measurement (at the precision they are written with) get the new one.
 */
export function retextDimension(t, from, to) {
  return String(t ?? '').replace(/\d+(?:[.,]\d+)?/g, (m) => {
    const sep = m.includes(',') ? ',' : '.';
    const dec = m.includes(sep) ? m.split(sep)[1].length : 0;
    const v = parseFloat(m.replace(',', '.'));
    if (Math.abs(v - +from.toFixed(dec)) > 1e-9) return m;
    return to.toFixed(dec).replace('.', sep);
  });
}

/** Gives an entity (and its attributes) new handles. */
export function assignHandles(e, doc) {
  e.handle = doc.newHandle();
  for (const a of e.attribs ?? []) a.handle = doc.newHandle();
  for (const v of e.vertices ?? []) if (v.handle) v.handle = doc.newHandle();
  return e;
}
