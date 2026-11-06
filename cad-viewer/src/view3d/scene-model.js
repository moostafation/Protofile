// three.js objects of a loaded 3D model: one mesh per merged chunk, instanced meshes, element
// visibility (by rebuilding chunk indices), highlight overlays, display modes (wireframe, X-ray),
// a fast ray picker over the chunks' cells, and disposal of every GPU resource.
import * as THREE from 'three';

const tmpM = new THREE.Matrix4();

/** Ray / axis-aligned box: entry distance or Infinity. */
function rayBox(o, inv, b, k = 0) {
  let t0 = -Infinity, t1 = Infinity;
  for (let a = 0; a < 3; a++) {
    const lo = (b[k + a] - o[a]) * inv[a], hi = (b[k + a + 3] - o[a]) * inv[a];
    t0 = Math.max(t0, Math.min(lo, hi));
    t1 = Math.min(t1, Math.max(lo, hi));
  }
  return t1 >= Math.max(t0, 0) ? Math.max(t0, 0) : Infinity;
}

/** Möller–Trumbore; returns t or Infinity. */
function rayTri(o, d, P, a, b, c) {
  const ax = P[a], ay = P[a + 1], az = P[a + 2];
  const e1x = P[b] - ax, e1y = P[b + 1] - ay, e1z = P[b + 2] - az;
  const e2x = P[c] - ax, e2y = P[c + 1] - ay, e2z = P[c + 2] - az;
  const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-14) return Infinity;
  const inv = 1 / det;
  const tx = o[0] - ax, ty = o[1] - ay, tz = o[2] - az;
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < 0 || u > 1) return Infinity;
  const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
  const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
  if (v < 0 || u + v > 1) return Infinity;
  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return t > 0 ? t : Infinity;
}

export class SceneModel {
  /** @param model the format adapter's model ({ geometry, materials, elements, … }) */
  constructor(model) {
    this.model = model;
    const g = model.geometry;
    this.group = new THREE.Group();
    this.group.matrixAutoUpdate = false;
    this.boxes = g.boxes;
    this.hidden = new Set();
    this.materials = new Map();
    this.textures = new Set();
    this.parts = Array.from({ length: Math.max(model.elements.length, g.elementCount) }, () => []);
    this.chunks = g.chunks.map((c, ci) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(c.positions, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(c.normals, 3));
      if (c.colors) geo.setAttribute('color', new THREE.BufferAttribute(c.colors, 3));
      if (c.uvs) geo.setAttribute('uv', new THREE.BufferAttribute(c.uvs, 2));
      geo.setIndex(new THREE.BufferAttribute(c.index, 1));
      geo.computeBoundingBox();
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, this.material(c.matKey, !!c.colors));
      mesh.matrixAutoUpdate = false;
      this.group.add(mesh);
      for (let r = 0; r < c.ranges.length; r += 3) this.parts[c.ranges[r]]?.push({ chunk: ci, start: c.ranges[r + 1], count: c.ranges[r + 2] });
      return { ...c, mesh, filtered: false };
    });
    this.inst = g.instanced.map((ig, gi) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(ig.positions, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(ig.normals, 3));
      geo.setIndex(new THREE.BufferAttribute(ig.index, 1));
      geo.computeBoundingBox();
      const n = ig.ids.length;
      const mesh = new THREE.InstancedMesh(geo, this.material(ig.key, false), n);
      mesh.instanceMatrix.array.set(ig.matrices);
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.matrixAutoUpdate = false;
      this.group.add(mesh);
      ig.ids.forEach((id, k) => this.parts[id]?.push({ inst: gi, k }));
      const inv = [];
      return { ...ig, mesh, inv };
    });
    this.overlays = { selection: null, highlight: null };
    this.mode = { wireframe: false, xray: false };
    this.triangles = g.triangles;
  }

  /** Material for a key: the format's three.js material, or a lit colour material. */
  material(key, vertexColors) {
    const id = `${key}|${vertexColors}`;
    let m = this.materials.get(id);
    if (m) return m;
    const spec = this.model.materials[key] ?? { color: [0.7, 0.7, 0.7], opacity: 1 };
    if (spec.material) {
      m = spec.material;
      m.side = THREE.DoubleSide;
      for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap', 'bumpMap', 'specularMap']) if (m[k]) this.textures.add(m[k]);
    } else {
      const [r, gg, b] = spec.color;
      const opacity = spec.opacity ?? 1;
      m = new THREE.MeshPhongMaterial({
        color: new THREE.Color().setRGB(r, gg, b, THREE.SRGBColorSpace), vertexColors, shininess: 28, specular: 0x262626,
        side: THREE.DoubleSide, transparent: opacity < 0.999, opacity, depthWrite: opacity >= 0.999,
        // Pushed back a little so highlights and section lines draw on top without flicker.
        polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
      });
    }
    m.userData.base = { transparent: m.transparent, opacity: m.opacity, depthWrite: m.depthWrite };
    this.materials.set(id, m);
    return m;
  }

  /** Model box in shifted coordinates [x0,y0,z0,x1,y1,z1] of the visible (or all) elements. */
  bbox(ids = null, visibleOnly = false) {
    const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    const B = this.boxes;
    const n = B.length / 6;
    const each = (id) => {
      const o = id * 6;
      if (!(B[o] <= B[o + 3]) || (visibleOnly && this.hidden.has(id))) return;
      for (let k = 0; k < 3; k++) { if (B[o + k] < b[k]) b[k] = B[o + k]; if (B[o + k + 3] > b[k + 3]) b[k + 3] = B[o + k + 3]; }
    };
    if (ids) for (const id of ids) { if (id < n) each(id); } else for (let id = 0; id < n; id++) each(id);
    return Number.isFinite(b[0]) ? b : null;
  }

  hasGeometry(id) { return !!this.parts[id]?.length; }

  /** Hides exactly the given element ids. */
  setHidden(ids) {
    const prev = this.hidden;
    this.hidden = new Set(ids);
    const touched = new Set();
    for (const id of new Set([...prev, ...this.hidden])) {
      if (prev.has(id) === this.hidden.has(id)) continue;
      for (const p of this.parts[id] ?? []) touched.add(p.inst !== undefined ? `i${p.inst}` : `c${p.chunk}`);
    }
    for (const t of touched) {
      const k = Number(t.slice(1));
      if (t[0] === 'c') this.refreshChunk(this.chunks[k]);
      else this.refreshInstances(this.inst[k]);
    }
  }

  refreshChunk(c) {
    const R = c.ranges;
    let any = false, kept = 0;
    for (let r = 0; r < R.length; r += 3) { if (this.hidden.has(R[r])) any = true; else kept += R[r + 2]; }
    const geo = c.mesh.geometry;
    if (!any) {
      if (c.filtered) { geo.setIndex(new THREE.BufferAttribute(c.index, 1)); c.filtered = false; }
      c.mesh.visible = true;
      return;
    }
    const out = new Uint32Array(kept);
    let o = 0;
    for (let r = 0; r < R.length; r += 3) {
      if (this.hidden.has(R[r])) continue;
      out.set(c.index.subarray(R[r + 1], R[r + 1] + R[r + 2]), o);
      o += R[r + 2];
    }
    geo.setIndex(new THREE.BufferAttribute(out, 1));
    c.filtered = true;
    c.mesh.visible = kept > 0;
  }

  refreshInstances(g) {
    const arr = g.mesh.instanceMatrix.array;
    for (let k = 0; k < g.ids.length; k++) {
      if (this.hidden.has(g.ids[k])) arr.fill(0, k * 16, k * 16 + 16);
      else arr.set(g.matrices.subarray(k * 16, k * 16 + 16), k * 16);
    }
    g.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Triangles of elements as one non-indexed geometry (for highlight overlays). */
  geometryOf(ids, limit = 4e6) {
    let tris = 0;
    for (const id of ids) for (const p of this.parts[id] ?? []) tris += p.inst !== undefined ? this.inst[p.inst].index.length / 3 : p.count / 3;
    tris = Math.min(tris, limit);
    const pos = new Float32Array(tris * 9), nrm = new Float32Array(tris * 9);
    let o = 0;
    const v = new THREE.Vector3(), n = new THREE.Vector3(), nm = new THREE.Matrix3();
    outer: for (const id of ids) {
      for (const p of this.parts[id] ?? []) {
        if (p.inst !== undefined) {
          const g = this.inst[p.inst];
          tmpM.fromArray(g.matrices, p.k * 16);
          nm.getNormalMatrix(tmpM);
          for (let i = 0; i < g.index.length; i++) {
            if (o >= pos.length) break outer;
            const vi = g.index[i] * 3;
            v.fromArray(g.positions, vi).applyMatrix4(tmpM);
            n.fromArray(g.normals, vi).applyMatrix3(nm).normalize();
            v.toArray(pos, o); n.toArray(nrm, o); o += 3;
          }
        } else {
          const c = this.chunks[p.chunk];
          for (let i = p.start; i < p.start + p.count; i++) {
            if (o >= pos.length) break outer;
            const vi = c.index[i] * 3;
            pos[o] = c.positions[vi]; pos[o + 1] = c.positions[vi + 1]; pos[o + 2] = c.positions[vi + 2];
            nrm[o] = c.normals[vi]; nrm[o + 1] = c.normals[vi + 1]; nrm[o + 2] = c.normals[vi + 2];
            o += 3;
          }
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, o), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm.subarray(0, o), 3));
    return geo;
  }

  /** Shows `ids` in a highlight colour (kind: 'selection' orange, 'highlight' cyan). */
  setOverlay(kind, ids) {
    const old = this.overlays[kind];
    if (old) { this.group.remove(old); old.geometry.dispose(); old.material.dispose(); this.overlays[kind] = null; }
    const list = (ids ?? []).filter((id) => this.hasGeometry(id));
    if (!list.length) return;
    const mat = new THREE.MeshPhongMaterial({
      color: kind === 'selection' ? 0xff9f1c : 0x22d3ee, emissive: kind === 'selection' ? 0x5a3000 : 0x00363f, shininess: 20,
      side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    });
    const mesh = new THREE.Mesh(this.geometryOf(list), mat);
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = kind === 'selection' ? 3 : 2;
    this.overlays[kind] = mesh;
    this.group.add(mesh);
    this.applyOverlayMode();
  }

  applyOverlayMode() {
    for (const o of Object.values(this.overlays)) {
      if (!o) continue;
      // In X-ray the selection shows through everything.
      o.material.depthTest = !this.mode.xray;
      o.material.transparent = this.mode.xray;
      o.material.opacity = this.mode.xray ? 0.9 : 1;
      o.material.wireframe = this.mode.wireframe && !this.mode.xray;
      o.material.needsUpdate = true;
    }
  }

  setMode(mode) {
    Object.assign(this.mode, mode);
    for (const m of this.materials.values()) {
      const b = m.userData.base;
      m.wireframe = this.mode.wireframe;
      if (this.mode.xray) { m.transparent = true; m.opacity = Math.min(b.opacity, 0.14); m.depthWrite = false; }
      else { m.transparent = b.transparent; m.opacity = b.opacity; m.depthWrite = b.depthWrite; }
      m.needsUpdate = true;
    }
    this.applyOverlayMode();
  }

  /**
   * Nearest visible triangle hit by a ray (shifted coordinates), skipping hidden elements and points
   * cut away by `keep(x,y,z) === false`. Returns { id, t, point, tri: [a,b,c] (vertex positions), normal } or null.
   */
  raycast(origin, dir, keep = null) {
    const o = [origin.x, origin.y, origin.z], d = [dir.x, dir.y, dir.z];
    const inv = d.map((x) => (Math.abs(x) < 1e-30 ? 1e30 : 1 / x));
    const cand = [];
    this.chunks.forEach((c, ci) => {
      if (!c.mesh.visible) return;
      const C = c.cells, R = c.cellRefs;
      for (let k = 0, n = R.length / 3; k < n; k++) {
        if (this.hidden.has(R[k * 3 + 2])) continue;
        const t = rayBox(o, inv, C, k * 6);
        if (t < Infinity) cand.push({ t, ci, k });
      }
    });
    this.inst.forEach((g, gi) => {
      for (let k = 0; k < g.ids.length; k++) {
        if (this.hidden.has(g.ids[k])) continue;
        const t = rayBox(o, inv, g.boxes, k * 6);
        if (t < Infinity) cand.push({ t, gi, k });
      }
    });
    cand.sort((a, b) => a.t - b.t);
    let best = null;
    const lo = [0, 0, 0], ld = [0, 0, 0];
    for (const cd of cand) {
      if (best && cd.t > best.t) break;
      if (cd.ci !== undefined) {
        const c = this.chunks[cd.ci];
        const start = c.cellRefs[cd.k * 3], count = c.cellRefs[cd.k * 3 + 1], id = c.cellRefs[cd.k * 3 + 2];
        const I = c.index, P = c.positions;
        for (let i = start; i < start + count; i += 3) {
          const a = I[i] * 3, b = I[i + 1] * 3, cc = I[i + 2] * 3;
          const t = rayTri(o, d, P, a, b, cc);
          if (t < (best?.t ?? Infinity)) {
            const x = o[0] + d[0] * t, y = o[1] + d[1] * t, z = o[2] + d[2] * t;
            if (keep && !keep(x, y, z)) continue;
            best = { t, id, point: [x, y, z], P, a, b, c: cc, chunk: cd.ci, start: i };
          }
        }
      } else {
        const g = this.inst[cd.gi];
        const M = g.inv[cd.k] ??= new THREE.Matrix4().fromArray(g.matrices, cd.k * 16).invert().toArray();
        // Ray in the instance's own coordinates (t stays comparable: the direction is not normalised).
        lo[0] = M[0] * o[0] + M[4] * o[1] + M[8] * o[2] + M[12]; lo[1] = M[1] * o[0] + M[5] * o[1] + M[9] * o[2] + M[13]; lo[2] = M[2] * o[0] + M[6] * o[1] + M[10] * o[2] + M[14];
        ld[0] = M[0] * d[0] + M[4] * d[1] + M[8] * d[2]; ld[1] = M[1] * d[0] + M[5] * d[1] + M[9] * d[2]; ld[2] = M[2] * d[0] + M[6] * d[1] + M[10] * d[2];
        const I = g.index, P = g.positions;
        for (let i = 0; i < I.length; i += 3) {
          const t = rayTri(lo, ld, P, I[i] * 3, I[i + 1] * 3, I[i + 2] * 3);
          if (t < (best?.t ?? Infinity)) {
            const x = o[0] + d[0] * t, y = o[1] + d[1] * t, z = o[2] + d[2] * t;
            if (keep && !keep(x, y, z)) continue;
            best = { t, id: g.ids[cd.k], point: [x, y, z], inst: cd.gi, k: cd.k, P, a: I[i] * 3, b: I[i + 1] * 3, c: I[i + 2] * 3 };
          }
        }
      }
    }
    if (!best) return null;
    // Triangle corners in model (shifted) coordinates.
    const corner = (vi) => {
      const v = new THREE.Vector3().fromArray(best.P, vi);
      if (best.inst !== undefined) v.applyMatrix4(tmpM.fromArray(this.inst[best.inst].matrices, best.k * 16));
      return v;
    };
    const tri = [corner(best.a), corner(best.b), corner(best.c)];
    const normal = new THREE.Vector3().subVectors(tri[1], tri[0]).cross(new THREE.Vector3().subVectors(tri[2], tri[0])).normalize();
    return { id: best.id, t: best.t, point: new THREE.Vector3(...best.point), tri, normal, hit: best };
  }

  /**
   * Whether the edge p-q of a hit triangle is a real (feature) edge: false when the neighbouring
   * triangle of the same element across it lies in the same plane (a diagonal of a flat face).
   */
  isFeatureEdge(hit, p, q, normal) {
    const h = hit.hit;
    if (h.inst !== undefined) return true;
    const c = this.chunks[h.chunk];
    const part = this.parts[hit.id]?.find((r) => r.chunk === h.chunk && h.start >= r.start && h.start < r.start + r.count);
    if (!part || part.count > 180000) return true;
    const P = c.positions, I = c.index;
    const eq = (vi, v) => Math.abs(P[vi] - v.x) < 1e-6 * (1 + Math.abs(v.x)) && Math.abs(P[vi + 1] - v.y) < 1e-6 * (1 + Math.abs(v.y)) && Math.abs(P[vi + 2] - v.z) < 1e-6 * (1 + Math.abs(v.z));
    const a = new THREE.Vector3(), b = new THREE.Vector3(), n = new THREE.Vector3();
    for (let i = part.start; i < part.start + part.count; i += 3) {
      if (i === h.start) continue;
      const vs = [I[i] * 3, I[i + 1] * 3, I[i + 2] * 3];
      const hp = vs.some((vi) => eq(vi, p)), hq = vs.some((vi) => eq(vi, q));
      if (!hp || !hq) continue;
      a.fromArray(P, vs[1]).sub(b.fromArray(P, vs[0]));
      n.fromArray(P, vs[2]).sub(b);
      n.crossVectors(a, n).normalize();
      return Math.abs(n.dot(normal)) < 0.9995;
    }
    return true; // open boundary
  }

  dispose() {
    for (const kind of Object.keys(this.overlays)) this.setOverlay(kind, null);
    for (const c of this.chunks) c.mesh.geometry.dispose();
    for (const g of this.inst) { g.mesh.geometry.dispose(); g.mesh.dispose(); }
    for (const m of this.materials.values()) m.dispose();
    for (const t of this.textures) t.dispose();
    this.group.clear();
    this.chunks = [];
    this.inst = [];
  }
}
