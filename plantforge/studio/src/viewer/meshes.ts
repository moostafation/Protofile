// Engine primitives (mm) -> three.js meshes (metres).

import * as THREE from "three";
import type { Shape } from "../engine/shapes";
import { torCenterline, torRadius } from "../engine/shapes";
import type { V3 } from "../engine/vec";

export const MM = 0.001;
const UP = new THREE.Vector3(0, 1, 0);

export const v = (p: V3) => new THREE.Vector3(p[0] * MM, p[1] * MM, p[2] * MM);

const segs = (r: number) => Math.max(12, Math.min(40, Math.round(r * MM * 120)));

function along(mesh: THREE.Object3D, a: THREE.Vector3, b: THREE.Vector3) {
  const d = new THREE.Vector3().subVectors(b, a);
  mesh.position.copy(a).addScaledVector(d, 0.5);
  mesh.quaternion.setFromUnitVectors(UP, d.normalize());
}

function basisQuat(ax: readonly [V3, V3, V3]) {
  const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(...ax[0]), new THREE.Vector3(...ax[1]), new THREE.Vector3(...ax[2]));
  return new THREE.Quaternion().setFromRotationMatrix(m);
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

export function shapeMesh(s: Shape, mat: THREE.Material): THREE.Mesh {
  switch (s.t) {
    case "cyl":
    case "fru": {
      const a = v(s.a);
      const b = v(s.b);
      const h = a.distanceTo(b);
      const g = s.t === "cyl" ? new THREE.CylinderGeometry(s.r * MM, s.r * MM, h, segs(s.r)) : new THREE.CylinderGeometry(s.rb * MM, s.ra * MM, h, segs(Math.max(s.ra, s.rb)));
      const m = new THREE.Mesh(g, mat);
      along(m, a, b);
      return m;
    }
    case "cap": {
      const a = v(s.a);
      const b = v(s.b);
      const m = new THREE.Mesh(new THREE.CapsuleGeometry(s.r * MM, a.distanceTo(b), 6, 16), mat);
      along(m, a, b);
      return m;
    }
    case "box": {
      const m = new THREE.Mesh(new THREE.BoxGeometry(s.h[0] * 2 * MM, s.h[1] * 2 * MM, s.h[2] * 2 * MM), mat);
      m.position.copy(v(s.c));
      m.quaternion.copy(basisQuat(s.ax));
      return m;
    }
    case "sph": {
      const m = new THREE.Mesh(new THREE.SphereGeometry(s.r * MM, 24, 16), mat);
      m.position.copy(v(s.c));
      return m;
    }
    case "ell": {
      const m = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 20), mat);
      m.position.copy(v(s.c));
      m.quaternion.copy(basisQuat(s.ax));
      m.scale.set(s.r[0] * MM, s.r[1] * MM, s.r[2] * MM);
      return m;
    }
    case "tor": {
      const full = s.ang >= Math.PI * 2 - 1e-6;
      const R = torRadius(s);
      if (full) {
        const m = new THREE.Mesh(new THREE.TorusGeometry(R * MM, s.r * MM, 10, 36), mat);
        m.position.copy(v(s.c));
        m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(...s.n));
        return m;
      }
      const pts = torCenterline(s, Math.max(8, Math.round((s.ang / (Math.PI / 2)) * 16))).map(v);
      return new THREE.Mesh(new THREE.TubeGeometry(new PolyCurve(pts), pts.length * 2, s.r * MM, segs(s.r), false), mat);
    }
  }
}
