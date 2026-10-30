// Turns drawing entities into flat, renderable primitives in world coordinates
// (shifted by `scene.origin` to keep float precision on large coordinates).
//
// Primitive kinds:
//   STROKE  { pts: Float64Array, closed, ww? (world width), dash? }
//   FILL    { rings: Float64Array[], alpha?, bg? (wipeout) }
//   TEXT    { x, y, rot, h, wf, lines: [{ s, dx, dy }] }
//   HATCH   { rings, segs: Float64Array (x0,y0,x1,y1,...) }
//   POINT   { x, y }
//   VPORT   { x, y, w, h, viewX, viewY, viewH, twist } (paper space viewports)
// Every primitive also has rgb, lw (mm or LW_* marker), layer, item, bb.

import { FOREGROUND, aciToRgb } from './aci.js';
import {
  IDENTITY, mul, translate, scale, rotate, apply, matScale, ocsMatrix,
  pushArc, pushBulge, pushEllipse, sampleNurbs, sampleThrough, transformFlat, bboxOf, polylineLength, polygonArea,
} from './geometry.js';
import { LW_BYBLOCK, LW_BYLAYER, LW_DEFAULT, lineweightToMm } from './drawing.js';
import { decodeMText, decodeText } from './text.js';

export const STROKE = 0, FILL = 1, TEXT = 2, HATCH = 3, POINT = 4, VPORT = 5;

const MAX_DEPTH = 16;
const MAX_PATTERN_SEGMENTS = 60000;
const MAX_ARRAY = 10000;
const TAU = Math.PI * 2;

/** Default text width estimate (for height 1) when no canvas is available. */
function approxMeasure(s) {
  return s.length * 0.62;
}

class SceneBuilder {
  constructor(drawing, opts) {
    this.d = drawing;
    this.measure = opts.measure || approxMeasure;
    this.prims = [];
    this.items = [];
    this.origin = opts.origin || { x: 0, y: 0 };
    this.shift = translate(-this.origin.x, -this.origin.y);
    this.infinite = opts.infiniteLength || 1e6;
    this.insertCounts = new Map();
    this.warnings = new Set();
    this.dimArrow = (drawing.header.DIMASZ || 2.5) * (drawing.header.DIMSCALE || 1);
  }

  // ---------- property resolution ----------
  layerOf(e, ctx) {
    const name = e.layer ?? '0';
    if (name === '0' && ctx.layer) return ctx.layer;
    return name;
  }

  colorOf(e, layer, ctx) {
    if (typeof e.color === 'number' && e.color >= 0) return e.color === 0xffffff ? FOREGROUND : e.color;
    const ci = e.colorIndex ?? 256;
    if (ci === 256) {
      const l = this.d.layers.get(layer);
      return l ? l.rgb : FOREGROUND;
    }
    if (ci === 0) return ctx.rgb ?? FOREGROUND;
    return aciToRgb(Math.abs(ci));
  }

  lwOf(e, layer, ctx) {
    const lw = lineweightToMm(e.lineweight, this.d.source);
    if (lw === LW_BYLAYER) return this.d.layers.get(layer)?.lw ?? LW_DEFAULT;
    if (lw === LW_BYBLOCK) return ctx.lw ?? LW_DEFAULT;
    return lw;
  }

  ltypeOf(e, layer, ctx) {
    const lt = e.lineType;
    if (!lt || /^bylayer$/i.test(lt)) return this.d.layers.get(layer)?.ltype || 'Continuous';
    if (/^byblock$/i.test(lt)) return ctx.ltype || 'Continuous';
    return lt;
  }

  dashOf(ltypeName, e, m) {
    if (!ltypeName || /^continuous$/i.test(ltypeName)) return null;
    const lt = this.d.ltypes.get(ltypeName.toUpperCase());
    if (!lt || lt.pattern.length < 2) return null;
    const k = this.d.ltscale * (e.lineTypeScale || 1) * matScale(m);
    // Canvas-style dash array: [on, off, on, off...], dots become very short dashes.
    const out = [];
    for (const v of lt.pattern) {
      const len = Math.abs(v) * k;
      out.push(v === 0 ? 0.01 * k : len);
    }
    if (out.length % 2) out.push(...out);
    // Patterns from the file always start with a dash; a leading gap is folded in.
    if (lt.pattern[0] < 0) out.push(out.shift());
    return out.every((v) => v > 0) ? out : null;
  }

  style(e, ctx, m) {
    const layer = this.layerOf(e, ctx);
    const rgb = this.colorOf(e, layer, ctx);
    const lw = this.lwOf(e, layer, ctx);
    const ltype = this.ltypeOf(e, layer, ctx);
    return { layer, rgb, lw, ltype, dash: this.dashOf(ltype, e, m) };
  }

  // ---------- primitive emitters ----------
  stroke(ctx, st, localPts, closed, m, extra) {
    if (localPts.length < 4) return;
    const pts = transformFlat(mul(this.shift, m), localPts);
    const p = { k: STROKE, pts, closed: !!closed, rgb: st.rgb, lw: st.lw, dash: st.dash, layer: st.layer, item: ctx.item, bb: bboxOf(pts) };
    if (extra) Object.assign(p, extra);
    this.prims.push(p);
    return p;
  }

  fill(ctx, st, rings, m, extra) {
    const mm = mul(this.shift, m);
    const out = rings.filter((r) => r.length >= 6).map((r) => transformFlat(mm, r));
    if (!out.length) return;
    const bb = [Infinity, Infinity, -Infinity, -Infinity];
    for (const r of out) bboxOf(r, bb);
    const p = { k: FILL, rings: out, rgb: st.rgb, lw: st.lw, layer: st.layer, item: ctx.item, bb };
    if (extra) Object.assign(p, extra);
    this.prims.push(p);
    return p;
  }

  text(ctx, st, x, y, rot, h, wf, lines, m, oblique = 0) {
    if (!(h > 0) || !lines.length) return;
    const [wx, wy] = apply(mul(this.shift, m), x, y);
    const s = matScale(m);
    const mrot = Math.atan2(m[1], m[0]);
    const H = h * s;
    const R = rot + mrot;
    // Bounding box of all lines.
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const ln of lines) {
      x0 = Math.min(x0, ln.dx); x1 = Math.max(x1, ln.dx + ln.w);
      y0 = Math.min(y0, ln.dy - 0.25 * h); y1 = Math.max(y1, ln.dy + h);
    }
    const c = Math.cos(R), sn = Math.sin(R);
    const bb = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [lx, ly] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]) {
      const px = wx + (lx * c - ly * sn) * s, py = wy + (lx * sn + ly * c) * s;
      bb[0] = Math.min(bb[0], px); bb[1] = Math.min(bb[1], py); bb[2] = Math.max(bb[2], px); bb[3] = Math.max(bb[3], py);
    }
    const p = {
      k: TEXT, x: wx, y: wy, rot: R, h: H, wf, obl: oblique,
      lines: lines.map((l) => ({ s: l.s, dx: l.dx * s, dy: l.dy * s, w: l.w * s })),
      rgb: st.rgb, lw: st.lw, layer: st.layer, item: ctx.item, bb,
    };
    this.prims.push(p);
    return p;
  }

  point(ctx, st, x, y, m) {
    const [wx, wy] = apply(mul(this.shift, m), x, y);
    this.prims.push({ k: POINT, x: wx, y: wy, rgb: st.rgb, lw: st.lw, layer: st.layer, item: ctx.item, bb: [wx, wy, wx, wy] });
  }

  // ---------- entities ----------
  entity(e, ctx) {
    if (e.isVisible === false) return;
    const h = this.handlers[e.type] || (e.type?.includes('DIMENSION') ? this.handlers.DIMENSION : null);
    if (!h) {
      this.warnings.add(e.type);
      return;
    }
    try {
      h.call(this, e, ctx);
    } catch (err) {
      this.warnings.add(`${e.type}: ${err.message}`);
    }
  }

  textLines(rawLines, h, wf, ha, widthLimit) {
    const lines = [];
    for (const raw of rawLines) {
      if (widthLimit > 0) {
        const words = raw.split(/(\s+)/);
        let cur = '';
        for (const w of words) {
          const next = cur + w;
          if (cur && this.measure(next.trimEnd()) * h * wf > widthLimit * 1.001) {
            lines.push(cur.trimEnd());
            cur = w.trimStart();
          } else cur = next;
        }
        lines.push(cur);
      } else lines.push(raw);
    }
    return lines.map((s) => {
      const w = this.measure(s) * h * wf;
      return { s, w, dx: ha === 1 ? -w / 2 : ha === 2 ? -w : 0, dy: 0 };
    });
  }

  emitText(e, ctx, base, st) {
    // `base` is a DwgTextBase (TEXT entity, or the .text part of ATTRIB).
    const str = decodeText(base.text ?? '');
    if (!str.trim()) return;
    const h = base.textHeight || 1;
    let wf = base.xScale || 1;
    let rot = base.rotation || 0;
    const ocs = ocsMatrix(base.extrusionDirection ?? e.extrusionDirection);
    const m = mul(ctx.m, ocs);
    const ha = base.halign ?? 0, va = base.valign ?? 0;
    let px = base.startPoint?.x ?? 0, py = base.startPoint?.y ?? 0;
    const hasAlign = (ha !== 0 || va !== 0) && base.endPoint && (base.endPoint.x !== 0 || base.endPoint.y !== 0);
    let hAlign = ha;
    let vOffset = 0;
    if (ha === 3 || ha === 5) {
      // Aligned / Fit: the text spans start -> end.
      const ex = base.endPoint?.x ?? px, ey = base.endPoint?.y ?? py;
      const dist = Math.hypot(ex - px, ey - py);
      const natural = this.measure(str) * h;
      if (dist > 0 && natural > 0) {
        rot = Math.atan2(ey - py, ex - px);
        wf = dist / natural;
      }
      hAlign = 0;
    } else {
      if (hasAlign) { px = base.endPoint.x; py = base.endPoint.y; }
      if (ha === 4) { hAlign = 1; vOffset = -h / 2; }
      else if (va === 1) vOffset = h * 0.25;
      else if (va === 2) vOffset = -h / 2;
      else if (va === 3) vOffset = -h;
    }
    const lines = this.textLines([str], h, wf, hAlign, 0);
    for (const l of lines) l.dy = vOffset;
    this.text(ctx, st, px, py, rot, h, wf, lines, m, base.obliqueAngle || 0);
  }

  emitMText(e, ctx, st, content, ip, h, attach, rot, width, spacing, dir, ocsExt) {
    const raw = decodeMText(content);
    if (!raw.some((l) => l.trim())) return;
    const ap = attach || 1;
    const ha = (ap - 1) % 3; // 0 left, 1 center, 2 right
    const vrow = Math.floor((ap - 1) / 3); // 0 top, 1 middle, 2 bottom
    const lines = this.textLines(raw, h, 1, ha, width || 0);
    const gap = h * 1.667 * (spacing || 1);
    const total = (lines.length - 1) * gap + h;
    const top = vrow === 0 ? 0 : vrow === 1 ? total / 2 : total;
    lines.forEach((l, i) => { l.dy = top - h - i * gap; });
    let r = rot || 0;
    if (dir && (dir.x || dir.y)) r = Math.atan2(dir.y, dir.x);
    // MTEXT insertion points are WCS; the direction vector too.
    const m = ocsExt ? mul(ctx.m, ocsMatrix(ocsExt)) : ctx.m;
    this.text(ctx, st, ip.x, ip.y, r, h, 1, lines, m);
  }

  polyFromVertices(verts, closed, tol) {
    const out = [];
    const n = verts.length;
    if (!n) return out;
    out.push(verts[0].x, verts[0].y);
    const segs = closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const a = verts[i], b = verts[(i + 1) % n];
      pushBulge(out, a.x, a.y, b.x, b.y, a.bulge || 0, tol);
    }
    if (closed) { out.length -= 2; }
    return out;
  }

  widePolyline(e, ctx, st, verts, closed, m) {
    // Variable-width polylines are drawn as one filled quad per straight segment.
    const n = verts.length;
    const segs = closed ? n : n - 1;
    const rings = [];
    for (let i = 0; i < segs; i++) {
      const a = verts[i], b = verts[(i + 1) % n];
      const w0 = (a.startWidth ?? e.constantWidth ?? 0) / 2, w1 = (a.endWidth ?? e.constantWidth ?? 0) / 2;
      const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
      if (len < 1e-12) continue;
      const nx = -dy / len, ny = dx / len;
      rings.push([a.x + nx * w0, a.y + ny * w0, b.x + nx * w1, b.y + ny * w1, b.x - nx * w1, b.y - ny * w1, a.x - nx * w0, a.y - ny * w0]);
    }
    if (rings.length) this.fill(ctx, st, rings, m);
  }

  hatchRings(e) {
    const rings = [];
    for (const path of e.boundaryPaths ?? []) {
      const out = [];
      if (path.vertices) {
        const verts = path.vertices;
        if (verts.length < 2) continue;
        out.push(verts[0].x, verts[0].y);
        for (let i = 0; i < verts.length; i++) {
          const a = verts[i], b = verts[(i + 1) % verts.length];
          if (i === verts.length - 1 && path.isClosed === false) break;
          pushBulge(out, a.x, a.y, b.x, b.y, a.bulge || 0, 0);
        }
      } else {
        for (const edge of path.edges ?? []) {
          const skip = out.length > 0;
          if (edge.type === 1) {
            if (!skip) out.push(edge.start.x, edge.start.y);
            out.push(edge.end.x, edge.end.y);
          } else if (edge.type === 2) {
            const ccw = edge.isCCW !== false;
            const a0 = ccw ? edge.startAngle : -edge.startAngle;
            const a1 = ccw ? edge.endAngle : -edge.endAngle;
            if (Math.abs(Math.abs(edge.endAngle - edge.startAngle) - TAU) < 1e-9) {
              pushArc(out, edge.center.x, edge.center.y, edge.radius, a0, a0 + (ccw ? TAU : -TAU), ccw, edge.radius * 0.002, false);
            } else {
              pushArc(out, edge.center.x, edge.center.y, edge.radius, a0, a1, ccw, edge.radius * 0.002, skip);
            }
          } else if (edge.type === 3) {
            const ccw = edge.isCCW !== false;
            const t0 = ccw ? edge.startAngle : -edge.startAngle;
            const t1 = ccw ? edge.endAngle : -edge.endAngle;
            const a = Math.hypot(edge.end.x, edge.end.y);
            pushEllipse(out, edge.center.x, edge.center.y, edge.end.x, edge.end.y, edge.lengthOfMinorAxis, t0, t1, a * 0.002, ccw, skip);
          } else if (edge.type === 4) {
            const cps = edge.controlPoints ?? [];
            const pts = cps.length
              ? sampleNurbs(edge.degree || 3, edge.knots, cps, cps.some((p) => p.weight !== undefined) ? cps.map((p) => p.weight ?? 1) : null, Math.min(cps.length * 8, 400))
              : sampleThrough(edge.fitDatum ?? []);
            for (let i = skip ? 2 : 0; i < pts.length; i++) out.push(pts[i]);
          }
        }
      }
      if (out.length >= 6) rings.push(out);
    }
    return rings;
  }

  patternSegments(e, rings, m) {
    // Pattern definition lines are stored already scaled and rotated, in hatch (OCS) coordinates.
    const defs = e.definitionLines ?? [];
    if (!defs.length) return null;
    const bb = [Infinity, Infinity, -Infinity, -Infinity];
    for (const r of rings) bboxOf(r, bb);
    const corners = [[bb[0], bb[1]], [bb[2], bb[1]], [bb[2], bb[3]], [bb[0], bb[3]]];
    const segs = [];
    for (const d of defs) {
      const dx = Math.cos(d.angle), dy = Math.sin(d.angle);
      const nx = -dy, ny = dx;
      const ox = d.offset?.x ?? 0, oy = d.offset?.y ?? 0;
      const spacing = ox * nx + oy * ny;
      if (Math.abs(spacing) < 1e-9) continue;
      const bx = d.base?.x ?? 0, by = d.base?.y ?? 0;
      let smin = Infinity, smax = -Infinity;
      for (const [cx, cy] of corners) {
        const s = (cx - bx) * nx + (cy - by) * ny;
        smin = Math.min(smin, s); smax = Math.max(smax, s);
      }
      let k0 = Math.floor(smin / spacing), k1 = Math.ceil(smax / spacing);
      if (k0 > k1) [k0, k1] = [k1, k0];
      if ((k1 - k0) > MAX_PATTERN_SEGMENTS) return null;
      const dashes = (d.dashLengths ?? []).filter((v) => Number.isFinite(v));
      const period = dashes.reduce((a, v) => a + Math.abs(v), 0);
      for (let k = k0; k <= k1; k++) {
        const lx = bx + ox * k, ly = by + oy * k;
        let tmin = Infinity, tmax = -Infinity;
        for (const [cx, cy] of corners) {
          const t = (cx - lx) * dx + (cy - ly) * dy;
          tmin = Math.min(tmin, t); tmax = Math.max(tmax, t);
        }
        if (!dashes.length || period <= 0) {
          segs.push(lx + dx * tmin, ly + dy * tmin, lx + dx * tmax, ly + dy * tmax);
        } else {
          let t = Math.floor(tmin / period) * period;
          while (t < tmax) {
            for (const v of dashes) {
              const len = Math.abs(v);
              if (v >= 0 && t + len >= tmin) {
                const a = t, b = t + (v === 0 ? period * 0.001 : len);
                segs.push(lx + dx * a, ly + dy * a, lx + dx * b, ly + dy * b);
              }
              t += len;
              if (t >= tmax) break;
            }
            if (segs.length / 4 > MAX_PATTERN_SEGMENTS) return null;
          }
        }
        if (segs.length / 4 > MAX_PATTERN_SEGMENTS) return null;
      }
    }
    return transformFlat(mul(this.shift, m), segs);
  }

  insertBlock(blockName, m, ctx, st, depth) {
    const block = this.d.blocks.get(blockName);
    if (!block) {
      this.warnings.add(`missing block ${blockName}`);
      return;
    }
    if (depth > MAX_DEPTH) return;
    const child = { ...ctx, m, layer: st.layer, rgb: st.rgb, lw: st.lw, ltype: st.ltype, depth: depth + 1 };
    for (const sub of block.entities) {
      if (sub.type === 'ATTDEF' && !((sub.flags ?? 0) & 2)) continue;
      this.entity(sub, child);
    }
  }

  get handlers() {
    return HANDLERS;
  }

  addItem(e, extra) {
    const id = this.items.length;
    this.items.push({ id, type: e.type, handle: e.handle, layer: e.layer ?? '0', ent: e, ...extra });
    return id;
  }

  build(entities) {
    for (const e of entities) {
      if (e.type === 'VIEWPORT' && e.viewportId === 1) continue;
      const first = this.prims.length;
      const item = this.addItem(e);
      this.entity(e, { m: IDENTITY, item, depth: 0, layer: null, rgb: null, lw: null, ltype: null });
      const it = this.items[item];
      it.first = first;
      it.last = this.prims.length;
      const bb = [Infinity, Infinity, -Infinity, -Infinity];
      for (let i = first; i < this.prims.length; i++) {
        const p = this.prims[i];
        if (p.infinite) continue;
        if (p.bb[0] < bb[0]) bb[0] = p.bb[0];
        if (p.bb[1] < bb[1]) bb[1] = p.bb[1];
        if (p.bb[2] > bb[2]) bb[2] = p.bb[2];
        if (p.bb[3] > bb[3]) bb[3] = p.bb[3];
      }
      it.bb = bb;
      if (e.type === 'INSERT') this.insertCounts.set(e.name, (this.insertCounts.get(e.name) || 0) + 1);
    }
  }
}

const HANDLERS = {
  LINE(e, ctx) {
    const st = this.style(e, ctx, ctx.m);
    this.stroke(ctx, st, [e.startPoint.x, e.startPoint.y, e.endPoint.x, e.endPoint.y], false, ctx.m);
  },
  CIRCLE(e, ctx) {
    const m = mul(ctx.m, ocsMatrix(e.extrusionDirection));
    const st = this.style(e, ctx, m);
    const out = [];
    pushArc(out, e.center.x, e.center.y, e.radius, 0, TAU, true, e.radius * 0.002);
    out.length -= 2;
    this.stroke(ctx, st, out, true, m, { circle: { cx: e.center.x, cy: e.center.y, r: e.radius } });
  },
  ARC(e, ctx) {
    const m = mul(ctx.m, ocsMatrix(e.extrusionDirection));
    const st = this.style(e, ctx, m);
    const out = [];
    pushArc(out, e.center.x, e.center.y, e.radius, e.startAngle, e.endAngle, true, e.radius * 0.002);
    this.stroke(ctx, st, out, false, m);
  },
  ELLIPSE(e, ctx) {
    const st = this.style(e, ctx, ctx.m);
    const out = [];
    const ccw = (e.extrusionDirection?.z ?? 1) >= 0;
    const a = Math.hypot(e.majorAxisEndPoint.x, e.majorAxisEndPoint.y);
    let { startAngle: t0 = 0, endAngle: t1 = TAU } = e;
    const full = Math.abs(Math.abs(t1 - t0) - TAU) < 1e-6 || (t0 === 0 && t1 === 0);
    if (full) { t0 = 0; t1 = TAU; }
    if (ccw) pushEllipse(out, e.center.x, e.center.y, e.majorAxisEndPoint.x, e.majorAxisEndPoint.y, e.axisRatio, t0, t1, a * 0.002, true);
    else pushEllipse(out, e.center.x, e.center.y, e.majorAxisEndPoint.x, e.majorAxisEndPoint.y, e.axisRatio, -t0, -t1, a * 0.002, false);
    if (full) out.length -= 2;
    this.stroke(ctx, st, out, full, ctx.m);
  },
  LWPOLYLINE(e, ctx) {
    const m = mul(ctx.m, ocsMatrix(e.extrusionDirection));
    const st = this.style(e, ctx, m);
    const verts = e.vertices ?? [];
    if (verts.length < 2) return;
    const closed = !!(e.flag & 1);
    const varying = verts.some((v) => (v.startWidth || 0) !== (v.endWidth || 0) || ((v.startWidth || 0) > 0 && (v.startWidth || 0) !== (e.constantWidth || 0)));
    if (varying && !verts.some((v) => v.bulge)) {
      this.widePolyline(e, ctx, st, verts, closed, m);
      return;
    }
    const pts = this.polyFromVertices(verts, closed, 0);
    const width = e.constantWidth || verts[0].startWidth || 0;
    this.stroke(ctx, st, pts, closed, m, width > 0 ? { ww: width * matScale(m) } : undefined);
  },
  POLYLINE2D(e, ctx) {
    const m = mul(ctx.m, ocsMatrix(e.extrusionDirection));
    const st = this.style(e, ctx, m);
    const verts = (e.vertices ?? []).filter((v) => !((v.flag ?? 0) & 16));
    if (verts.length < 2) return;
    const closed = !!(e.flag & 1);
    const pts = this.polyFromVertices(verts, closed, 0);
    const width = e.startWidth || verts[0].startWidth || 0;
    this.stroke(ctx, st, pts, closed, m, width > 0 && width === (e.endWidth ?? width) ? { ww: width * matScale(m) } : undefined);
  },
  POLYLINE3D(e, ctx) {
    const st = this.style(e, ctx, ctx.m);
    const verts = (e.vertices ?? []).filter((v) => !((v.flag ?? 0) & 16));
    const pts = verts.flatMap((v) => [v.x, v.y]);
    this.stroke(ctx, st, pts, !!(e.flag & 1), ctx.m);
  },
  POLYFACE(e, ctx) {
    const st = this.style(e, ctx, ctx.m);
    const verts = e.vertices ?? [];
    const positions = verts.filter((v) => (v.flag & 64));
    const faces = verts.filter((v) => (v.flag & 128) && !(v.flag & 64));
    for (const f of faces) {
      const idx = [f.polyfaceIndex0, f.polyfaceIndex1, f.polyfaceIndex2, f.polyfaceIndex3].filter((i) => i);
      for (let i = 0; i < idx.length; i++) {
        const a = idx[i], b = idx[(i + 1) % idx.length];
        if (a < 0) continue;
        const pa = positions[Math.abs(a) - 1], pb = positions[Math.abs(b) - 1];
        if (pa && pb) this.stroke(ctx, st, [pa.x, pa.y, pb.x, pb.y], false, ctx.m);
      }
    }
  },
  POLYGONMESH(e, ctx) {
    HANDLERS.POLYLINE3D.call(this, e, ctx);
  },
  SPLINE(e, ctx) {
    const st = this.style(e, ctx, ctx.m);
    const cps = e.controlPoints ?? [];
    let pts;
    if (cps.length >= 2) {
      pts = sampleNurbs(e.degree || 3, e.knots, cps, e.weights?.length === cps.length ? e.weights : null, Math.min(Math.max(cps.length * 10, 32), 2000));
    } else {
      pts = sampleThrough(e.fitPoints ?? [], 16);
    }
    this.stroke(ctx, st, pts, false, ctx.m);
  },
  TEXT(e, ctx) {
    const st = this.style(e, ctx, ctx.m);
    this.emitText(e, ctx, e, st);
  },
  ATTRIB(e, ctx) {
    if ((e.flags ?? 0) & 1) return; // invisible attribute
    const st = this.style(e, ctx, ctx.m);
    if (e.text) this.emitText(e, ctx, e.text, st);
  },
  ATTDEF(e, ctx) {
    const st = this.style(e, ctx, ctx.m);
    if (e.text) this.emitText(e, ctx, e.text, st);
  },
  MTEXT(e, ctx) {
    const st = this.style(e, ctx, ctx.m);
    this.emitMText(e, ctx, st, e.text, e.insertionPoint, e.textHeight || 1, e.attachmentPoint, e.rotation, e.rectWidth, e.lineSpacing, e.direction);
  },
  INSERT(e, ctx) {
    const st = this.style(e, ctx, ctx.m);
    const block = this.d.blocks.get(e.name);
    const base = block?.base ?? { x: 0, y: 0 };
    const ocs = ocsMatrix(e.extrusionDirection);
    const cols = Math.max(1, e.columnCount || 1), rows = Math.max(1, e.rowCount || 1);
    if (cols * rows > MAX_ARRAY) this.warnings.add(`large block array ${e.name}`);
    const nc = Math.min(cols, MAX_ARRAY), nr = Math.min(rows, Math.floor(MAX_ARRAY / nc));
    for (let r = 0; r < nr; r++) {
      for (let c = 0; c < nc; c++) {
        let local = mul(rotate(e.rotation || 0), translate(c * (e.columnSpacing || 0), r * (e.rowSpacing || 0)));
        local = mul(local, scale(e.xScale ?? 1, e.yScale ?? 1));
        local = mul(local, translate(-base.x, -base.y));
        local = mul(translate(e.insertionPoint.x, e.insertionPoint.y), local);
        const m = mul(ctx.m, mul(ocs, local));
        this.insertBlock(e.name, m, ctx, st, ctx.depth);
      }
    }
    for (const a of e.attribs ?? []) this.entity(a, { ...ctx, layer: ctx.layer, rgb: st.rgb, lw: st.lw, ltype: st.ltype });
  },
  DIMENSION(e, ctx) {
    const st = this.style(e, ctx, ctx.m);
    if (e.name && this.d.blocks.has(e.name)) {
      this.insertBlock(e.name, ctx.m, ctx, st, ctx.depth);
      return;
    }
    // No pre-rendered block: draw the measured value at the text position.
    const p = e.textPoint ?? e.definitionPoint;
    if (!p) return;
    const value = e.text && e.text !== '<>' ? e.text.replace('<>', fmt(e.measurement)) : fmt(e.measurement);
    if (e.subDefinitionPoint1 && e.subDefinitionPoint2) {
      this.stroke(ctx, st, [e.subDefinitionPoint1.x, e.subDefinitionPoint1.y, e.subDefinitionPoint2.x, e.subDefinitionPoint2.y], false, ctx.m);
    }
    this.emitMText(e, ctx, st, value, p, this.dimArrow, 5, e.textRotation || 0, 0, 1, null);
  },
  LEADER(e, ctx) {
    const st = this.style(e, ctx, ctx.m);
    const v = e.vertices ?? [];
    if (v.length < 2) return;
    this.stroke(ctx, st, v.flatMap((p) => [p.x, p.y]), false, ctx.m);
    if (e.isArrowheadEnabled !== false) arrow(this, ctx, st, v[1], v[0], this.dimArrow);
  },
  MULTILEADER(e, ctx) {
    const st = this.style(e, ctx, ctx.m);
    const size = e.arrowheadSize || this.dimArrow;
    for (const sec of e.leaderSections ?? []) {
      for (const line of sec.leaderLines ?? []) {
        const pts = [...(line.vertices ?? [])];
        if (sec.lastLeaderLinePoint) pts.push(sec.lastLeaderLinePoint);
        if (pts.length >= 2) {
          this.stroke(ctx, st, pts.flatMap((p) => [p.x, p.y]), false, ctx.m);
          arrow(this, ctx, st, pts[1], pts[0], size);
        }
      }
      if (sec.lastLeaderLinePoint && sec.doglegVector && (e.doglegLength || sec.doglegLength)) {
        const L = sec.doglegLength || e.doglegLength;
        const p = sec.lastLeaderLinePoint, d = sec.doglegVector;
        this.stroke(ctx, st, [p.x, p.y, p.x + d.x * L, p.y + d.y * L], false, ctx.m);
      }
    }
    if (e.textContent && e.textAnchor) {
      this.emitMText(e, ctx, st, e.textContent, e.textAnchor, e.textHeight || 2.5, e.textAttachmentPoint || 1, e.textRotation || 0, e.textWidth || 0, e.textLineSpacingFactor, e.textDirection);
    }
  },
  HATCH(e, ctx) {
    const m = mul(ctx.m, ocsMatrix(e.extrusionDirection));
    const st = this.style(e, ctx, m);
    const rings = this.hatchRings(e);
    if (!rings.length) return;
    const solid = e.solidFill === 1 || /^solid$/i.test(e.patternName || '');
    if (solid || e.gradientFlag === 1) {
      const p = this.fill(ctx, st, rings, m);
      if (p && e.gradientFlag === 1 && typeof e.gradientRgb === 'number') p.rgb = e.gradientRgb;
      return;
    }
    const segs = this.patternSegments(e, rings, m);
    const mm = mul(this.shift, m);
    const wr = rings.map((r) => transformFlat(mm, r));
    const bb = [Infinity, Infinity, -Infinity, -Infinity];
    for (const r of wr) bboxOf(r, bb);
    if (!segs) {
      this.prims.push({ k: FILL, rings: wr, alpha: 0.25, rgb: st.rgb, lw: st.lw, layer: st.layer, item: ctx.item, bb });
      return;
    }
    this.prims.push({ k: HATCH, rings: wr, segs, rgb: st.rgb, lw: st.lw, layer: st.layer, item: ctx.item, bb });
  },
  SOLID(e, ctx) {
    const m = mul(ctx.m, ocsMatrix(e.extrusionDirection));
    const st = this.style(e, ctx, m);
    const c1 = e.corner1, c2 = e.corner2, c3 = e.corner3, c4 = e.corner4 ?? e.corner3;
    const ring = [c1.x, c1.y, c2.x, c2.y, c4.x, c4.y, c3.x, c3.y];
    this.fill(ctx, st, [ring], m);
  },
  TRACE(e, ctx) {
    HANDLERS.SOLID.call(this, e, ctx);
  },
  '3DFACE'(e, ctx) {
    const st = this.style(e, ctx, ctx.m);
    const c = [e.corner1, e.corner2, e.corner3, e.corner4 ?? e.corner3];
    const flag = e.flag ?? 0;
    for (let i = 0; i < 4; i++) {
      if (flag & (1 << i)) continue;
      const a = c[i], b = c[(i + 1) % 4];
      if (a && b && (a.x !== b.x || a.y !== b.y)) this.stroke(ctx, st, [a.x, a.y, b.x, b.y], false, ctx.m);
    }
  },
  POINT(e, ctx) {
    const st = this.style(e, ctx, ctx.m);
    if (/^defpoints$/i.test(st.layer)) return;
    this.point(ctx, st, e.position.x, e.position.y, ctx.m);
  },
  XLINE(e, ctx) {
    const st = this.style(e, ctx, ctx.m);
    const L = this.infinite, p = e.firstPoint, d = e.unitDirection;
    this.stroke(ctx, st, [p.x - d.x * L, p.y - d.y * L, p.x + d.x * L, p.y + d.y * L], false, ctx.m, { infinite: true });
  },
  RAY(e, ctx) {
    const st = this.style(e, ctx, ctx.m);
    const L = this.infinite, p = e.firstPoint, d = e.unitDirection;
    this.stroke(ctx, st, [p.x, p.y, p.x + d.x * L, p.y + d.y * L], false, ctx.m, { infinite: true });
  },
  MLINE(e, ctx) {
    const st = this.style(e, ctx, ctx.m);
    const verts = e.vertices ?? [];
    if (verts.length < 2) return;
    const lines = Math.max(...verts.map((v) => v.lines?.length ?? 0));
    const closed = !!((e.flags ?? 0) & 2);
    for (let j = 0; j < lines; j++) {
      const pts = [];
      for (const v of verts) {
        const off = v.lines?.[j]?.segmentParams?.[0] ?? 0;
        pts.push(v.vertex.x + v.miterDirection.x * off, v.vertex.y + v.miterDirection.y * off);
      }
      this.stroke(ctx, st, pts, closed, ctx.m);
    }
  },
  WIPEOUT(e, ctx) {
    const st = this.style(e, ctx, ctx.m);
    const ring = imageBoundary(e);
    if (ring) this.fill(ctx, st, [ring], ctx.m, { bg: true });
  },
  IMAGE(e, ctx) {
    const st = this.style(e, ctx, ctx.m);
    const ring = imageBoundary(e);
    if (ring) this.stroke(ctx, st, ring, true, ctx.m);
  },
  ACAD_TABLE(e, ctx) {
    const st = this.style(e, ctx, ctx.m);
    const name = this.d.tableBlocks?.get(e);
    if (name) this.insertBlock(name, ctx.m, ctx, st, ctx.depth);
  },
  TOLERANCE(e, ctx) {
    const st = this.style(e, ctx, ctx.m);
    if (e.text && e.insertionPoint) this.emitMText(e, ctx, st, e.text.replace(/\{\\Fgdt;[^}]*\}/g, '').replace(/%%v/g, ' | '), e.insertionPoint, this.dimArrow, 4, 0, 0, 1, e.xAxisDirection);
  },
  VIEWPORT(e, ctx) {
    if (!(e.width > 0 && e.height > 0)) return;
    const st = this.style(e, ctx, ctx.m);
    const [x, y] = apply(mul(this.shift, ctx.m), e.viewportCenter.x, e.viewportCenter.y);
    const w = e.width, h = e.height;
    const view = e.viewCenter ?? e.displayCenter ?? { x: 0, y: 0 };
    const target = e.targetPoint ?? { x: 0, y: 0 };
    this.prims.push({
      k: VPORT, x, y, w, h,
      viewX: view.x + (e.viewCenter ? 0 : target.x), viewY: view.y + (e.viewCenter ? 0 : target.y),
      viewH: e.viewHeight || h, twist: e.viewTwistAngle || 0,
      rgb: st.rgb, lw: st.lw, layer: st.layer, item: ctx.item, bb: [x - w / 2, y - h / 2, x + w / 2, y + h / 2],
    });
  },
};

function fmt(v) {
  if (!Number.isFinite(v)) return '';
  return Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2).replace(/\.?0+$/, '');
}

function arrow(b, ctx, st, from, tip, size) {
  const dx = tip.x - from.x, dy = tip.y - from.y, len = Math.hypot(dx, dy);
  if (len < 1e-12 || !(size > 0)) return;
  const ux = dx / len, uy = dy / len;
  const bx = tip.x - ux * size, by = tip.y - uy * size;
  const w = size / 6;
  b.fill(ctx, st, [[tip.x, tip.y, bx - uy * w, by + ux * w, bx + uy * w, by - ux * w]], ctx.m);
}

function imageBoundary(e) {
  const pos = e.position, u = e.uPixel, v = e.vPixel;
  if (!pos || !u || !v) return null;
  const size = e.imageSize ?? { x: 1, y: 1 };
  let pts = e.boundaryPoints ?? e.clippingBoundaryPath ?? e.clipVertices ?? [];
  if (!Array.isArray(pts) || pts.length < 2) {
    pts = [{ x: -0.5, y: -0.5 }, { x: size.x - 0.5, y: -0.5 }, { x: size.x - 0.5, y: size.y - 0.5 }, { x: -0.5, y: size.y - 0.5 }];
  } else if (pts.length === 2) {
    const [a, c] = pts;
    pts = [a, { x: c.x, y: a.y }, c, { x: a.x, y: c.y }];
  }
  const ring = [];
  for (const p of pts) {
    const px = p.x + 0.5, py = size.y - (p.y + 0.5);
    ring.push(pos.x + u.x * px + v.x * py, pos.y + u.y * px + v.y * py);
  }
  if (ring.length >= 4 && ring[0] === ring[ring.length - 2] && ring[1] === ring[ring.length - 1]) ring.length -= 2;
  return ring;
}

/** Picks a coordinate near the drawing to subtract from everything (float precision). */
export function chooseOrigin(drawing, entities) {
  const h = drawing.header;
  const ok = (p) => p && Number.isFinite(p.x) && Number.isFinite(p.y) && Math.abs(p.x) < 1e15 && Math.abs(p.y) < 1e15;
  if (ok(h.EXTMIN) && ok(h.EXTMAX) && h.EXTMIN.x <= h.EXTMAX.x && h.EXTMIN.y <= h.EXTMAX.y) {
    return { x: (h.EXTMIN.x + h.EXTMAX.x) / 2, y: (h.EXTMIN.y + h.EXTMAX.y) / 2 };
  }
  for (const e of entities) {
    const p = e.startPoint || e.center || e.insertionPoint || e.position || e.vertices?.[0];
    if (ok(p)) return { x: p.x, y: p.y };
  }
  return { x: 0, y: 0 };
}

/**
 * Builds a renderable scene.
 * @returns {{ prims, items, origin, bbox, insertCounts, warnings }}
 */
export function buildScene(drawing, entities, opts = {}) {
  const origin = opts.origin ?? chooseOrigin(drawing, entities);
  const b = new SceneBuilder(drawing, { ...opts, origin });
  b.build(entities);
  const bbox = robustExtents(b.prims);
  return { prims: b.prims, items: b.items, origin, bbox, insertCounts: b.insertCounts, warnings: [...b.warnings] };
}

/**
 * Extents that ignore a few far-away stray objects (common in real drawings),
 * so "zoom extents" frames the actual content.
 */
function robustExtents(prims) {
  const finite = prims.filter((p) => !p.infinite && Number.isFinite(p.bb[0]) && Number.isFinite(p.bb[3]));
  if (!finite.length) return [-50, -50, 50, 50];
  const full = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of finite) {
    full[0] = Math.min(full[0], p.bb[0]); full[1] = Math.min(full[1], p.bb[1]);
    full[2] = Math.max(full[2], p.bb[2]); full[3] = Math.max(full[3], p.bb[3]);
  }
  if (finite.length < 50) return full;
  const xs = finite.map((p) => (p.bb[0] + p.bb[2]) / 2).sort((a, b) => a - b);
  const ys = finite.map((p) => (p.bb[1] + p.bb[3]) / 2).sort((a, b) => a - b);
  const q = (arr, f) => arr[Math.floor((arr.length - 1) * f)];
  const x0 = q(xs, 0.005), x1 = q(xs, 0.995), y0 = q(ys, 0.005), y1 = q(ys, 0.995);
  const pad = Math.max(x1 - x0, y1 - y0) * 0.5;
  const inner = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of finite) {
    const cx = (p.bb[0] + p.bb[2]) / 2, cy = (p.bb[1] + p.bb[3]) / 2;
    if (cx < x0 - pad || cx > x1 + pad || cy < y0 - pad || cy > y1 + pad) continue;
    inner[0] = Math.min(inner[0], p.bb[0]); inner[1] = Math.min(inner[1], p.bb[1]);
    inner[2] = Math.max(inner[2], p.bb[2]); inner[3] = Math.max(inner[3], p.bb[3]);
  }
  return Number.isFinite(inner[0]) ? inner : full;
}

export { polylineLength, polygonArea };
