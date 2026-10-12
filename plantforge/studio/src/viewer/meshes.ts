// Engine primitives (mm) -> three.js geometry (metres). Shapes of one component that share a finish are
// merged into one mesh, so a plant of thousands of parts stays light to draw and to pick.

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { Shape } from "../engine/shapes";
import { torCenterline, torRadius } from "../engine/shapes";
import type { V3 } from "../engine/vec";

export const MM = 0.001;
const UP = new THREE.Vector3(0, 1, 0);

export const v = (p: V3) => new THREE.Vector3(p[0] * MM, p[1] * MM, p[2] * MM);

/** Round things look round at any zoom: more facets for bigger radii. */
const segs = (r: number) => Math.max(18, Math.min(64, Math.round(r * MM * 220)));

function placeAlong(g: THREE.BufferGeometry, a: THREE.Vector3, b: THREE.Vector3) {
  const d = new THREE.Vector3().subVectors(b, a);
  const m = new THREE.Matrix4().compose(a.clone().addScaledVector(d, 0.5), new THREE.Quaternion().setFromUnitVectors(UP, d.clone().normalize()), new THREE.Vector3(1, 1, 1));
  return g.applyMatrix4(m);
}

function basisMatrix(ax: readonly [V3, V3, V3], c: V3) {
  return new THREE.Matrix4().makeBasis(new THREE.Vector3(...ax[0]), new THREE.Vector3(...ax[1]), new THREE.Vector3(...ax[2])).setPosition(v(c));
}

class PolyCurve extends THREE.Curve<THREE.Vector3> {
  constructor(private pts: THREE.Vector3[]) {
    super();
  }
  getPoint(t: number, target = new THREE.Vector3()) {
    const f = t * (this.pts.length - 1);
    const i = Math.min(Math.floor(f), this.pts.length - 2);
    return target.lerpVectors(this.pts[i], this.pts[i + 1], f - i);
  }
}

/** Rolled I-section (flanges along local x, web along local y), extruded along local z and centred. */
function iSection(b: number, d: number, length: number): THREE.BufferGeometry {
  const tf = Math.max(d * 0.055, 0.006);
  const tw = Math.max(d * 0.035, 0.005);
  const s = new THREE.Shape();
  const x = b / 2;
  const y = d / 2;
  s.moveTo(-x, -y);
  s.lineTo(x, -y);
  s.lineTo(x, -y + tf);
  s.lineTo(tw / 2, -y + tf);
  s.lineTo(tw / 2, y - tf);
  s.lineTo(x, y - tf);
  s.lineTo(x, y);
  s.lineTo(-x, y);
  s.lineTo(-x, y - tf);
  s.lineTo(-tw / 2, y - tf);
  s.lineTo(-tw / 2, -y + tf);
  s.lineTo(-x, -y + tf);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: length, bevelEnabled: false, steps: 1 });
  g.translate(0, 0, -length / 2);
  g.clearGroups();
  return g;
}

/** World-space geometry of one shape (metres), ready to merge. */
export function shapeGeometry(s: Shape): THREE.BufferGeometry {
  switch (s.t) {
    case "cyl":
    case "fru": {
      const a = v(s.a);
      const b = v(s.b);
      const h = a.distanceTo(b);
      const facets = s.m === "concrete8" ? 8 : s.m === "nut" ? 6 : s.m === "bolt" ? 8 : segs(s.t === "cyl" ? s.r : Math.max(s.ra, s.rb));
      const g = s.t === "cyl" ? new THREE.CylinderGeometry(s.r * MM, s.r * MM, h, facets) : new THREE.CylinderGeometry(s.rb * MM, s.ra * MM, h, facets);
      if (facets === 8 && s.m === "concrete8") g.rotateY(Math.PI / 8);
      return placeAlong(g, a, b);
    }
    case "cap": {
      const a = v(s.a);
      const b = v(s.b);
      return placeAlong(new THREE.CapsuleGeometry(s.r * MM, a.distanceTo(b), 6, 16), a, b);
    }
    case "box": {
      if (s.m === "ibeam") return iSection(s.h[0] * 2 * MM, s.h[1] * 2 * MM, s.h[2] * 2 * MM).applyMatrix4(basisMatrix(s.ax, s.c));
      return new THREE.BoxGeometry(s.h[0] * 2 * MM, s.h[1] * 2 * MM, s.h[2] * 2 * MM).applyMatrix4(basisMatrix(s.ax, s.c));
    }
    case "sph":
      return new THREE.SphereGeometry(s.r * MM, 32, 20).translate(s.c[0] * MM, s.c[1] * MM, s.c[2] * MM);
    case "ell": {
      const g = new THREE.SphereGeometry(1, 48, 28);
      g.scale(s.r[0] * MM, s.r[1] * MM, s.r[2] * MM);
      return g.applyMatrix4(basisMatrix(s.ax, s.c));
    }
    case "tor": {
      const full = s.ang >= Math.PI * 2 - 1e-6;
      const R = torRadius(s);
      if (full) {
        const g = new THREE.TorusGeometry(R * MM, s.r * MM, Math.min(12, segs(s.r)), Math.max(24, Math.min(96, Math.round(R * MM * 40))));
        const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(...s.n));
        return g.applyMatrix4(new THREE.Matrix4().compose(v(s.c), q, new THREE.Vector3(1, 1, 1)));
      }
      const steps = Math.max(10, Math.round((s.ang / (Math.PI / 2)) * Math.max(16, Math.min(48, R * MM * 30))));
      const pts = torCenterline(s, steps).map(v);
      return new THREE.TubeGeometry(new PolyCurve(pts), steps, s.r * MM, segs(s.r), false);
    }
  }
}

/** Merge geometries (all converted to non-indexed with position, normal and uv). */
export function mergeAll(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const flat = list.map((g) => {
    const n = g.index ? g.toNonIndexed() : g;
    if (n !== g) g.dispose();
    for (const k of Object.keys(n.attributes)) if (k !== "position" && k !== "normal" && k !== "uv") n.deleteAttribute(k);
    if (!n.attributes.uv) n.setAttribute("uv", new THREE.BufferAttribute(new Float32Array((n.attributes.position.count * 2)), 2));
    return n;
  });
  const merged = flat.length === 1 ? flat[0] : mergeGeometries(flat, false)!;
  if (flat.length > 1) flat.forEach((g) => g.dispose());
  merged.computeBoundingSphere();
  merged.computeBoundingBox();
  return merged;
}

/** One mesh per shape (tool previews). */
export function shapeMesh(s: Shape, mat: THREE.Material): THREE.Mesh {
  return new THREE.Mesh(shapeGeometry(s), mat);
}
