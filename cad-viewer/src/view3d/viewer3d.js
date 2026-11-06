// Interactive 3D viewport (three.js, WebGL). Z is up (engineering convention); renders on demand.
// Mouse: left-drag orbits around the point under the cursor, middle/right-drag (or Shift+left, or
// the Pan tool) pans, the wheel zooms towards the cursor, double-click zooms to an element (or to
// extents). Touch: one finger orbits, two fingers pinch-zoom and pan. Standard views, perspective /
// orthographic, a section box or plane (clipping), wireframe and X-ray, a view cube, point-to-point
// measuring with vertex/edge/face snapping, and high-resolution snapshots for printing.
import * as THREE from 'three';

const DEG = Math.PI / 180;
const FOV = 45;
const VIEWS = {
  top: [-90, 90], bottom: [-90, -90], front: [-90, 0], back: [90, 0], left: [180, 0], right: [0, 0],
  iso: [-45, 35.264], isoSW: [-135, 35.264], isoNE: [45, 35.264], isoNW: [135, 35.264],
};

/** Camera axes for azimuth/elevation (degrees): right, up, and the viewing direction. */
function axes(az, el) {
  const a = az * DEG, e = el * DEG;
  const back = new THREE.Vector3(Math.cos(e) * Math.cos(a), Math.cos(e) * Math.sin(a), Math.sin(e));
  const right = new THREE.Vector3(-Math.sin(a), Math.cos(a), 0);
  const dir = back.clone().negate();
  const up = new THREE.Vector3().crossVectors(right, dir);
  return { right, up, dir, back };
}

const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

export class Viewer3D {
  /**
   * @param {HTMLElement} host
   * @param {{ onSelect?(id: number|null, ev), onCursor?(point: THREE.Vector3|null), onMeasure?(), onView?() }} events
   */
  constructor(host, events = {}) {
    this.host = host;
    this.events = events;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.canvas = this.renderer.domElement;
    this.canvas.className = 'view3d-canvas';
    this.overlay = document.createElement('canvas');
    this.overlay.className = 'view3d-overlay';
    host.append(this.canvas, this.overlay);
    this.octx = this.overlay.getContext('2d');
    this.scene = new THREE.Scene();
    this.helpers = new THREE.Scene();
    this.persp = new THREE.PerspectiveCamera(FOV, 1, 0.1, 1000);
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
    this.camera = this.persp;
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x7d828c, 1.6);
    this.hemi.position.set(0, 0, 1);
    this.head = new THREE.DirectionalLight(0xffffff, 1.6);
    this.fill = new THREE.DirectionalLight(0xffffff, 0.35);
    this.fill.position.set(-0.4, 0.6, -1);
    this.scene.add(this.hemi, this.head, this.head.target, this.fill);
    this.theme = { bg: '#1d2127', fg: '#ffffff' };
    this.cam = { target: new THREE.Vector3(), az: -45, el: 35.264, dist: 10, size: 5, ortho: false };
    this.model = null;
    this.radius = 1;
    this.center = new THREE.Vector3();
    this.tool = 'select';
    this.measures = [];
    this.pending = null;
    this.snapOn = true;
    this.hover = null;
    this.pointers = new Map();
    this.clip = { mode: 'off', box: null, axis: 'z', offset: 0.5, flip: false };
    this.planes = [];
    this.frame = 0;
    this.anim = null;
    this.units = '';
    this.buildViewCube();
    this.bindInput();
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(host);
    this.resize();
  }

  get width() { return Math.max(1, this.host.clientWidth); }
  get height() { return Math.max(1, this.host.clientHeight); }

  resize() {
    const w = this.width, h = this.height;
    this.renderer.setSize(w, h, false);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.overlay.width = Math.round(w * dpr);
    this.overlay.height = Math.round(h * dpr);
    this.overlay.style.width = `${w}px`;
    this.overlay.style.height = `${h}px`;
    this.dpr = dpr;
    this.updateCamera();
    this.requestRender();
  }

  setTheme(theme) {
    this.theme = theme;
    this.scene.background = new THREE.Color(theme.bg);
    this.host.style.background = theme.bg;
    this.cube.classList.toggle('light', theme.bg.toLowerCase() === '#ffffff');
    this.requestRender();
  }

  /** Shows a SceneModel (null clears). The previous one is not disposed here. */
  setModel(sm, units = '') {
    if (this.model) this.scene.remove(this.model.group);
    this.model = sm;
    this.units = units;
    this.measures = [];
    this.pending = null;
    this.hover = null;
    this.clip = { mode: 'off', box: null, axis: 'z', offset: 0.5, flip: false };
    this.updateClipping();
    if (!sm) { this.requestRender(); return; }
    this.scene.add(sm.group);
    const b = sm.bbox() ?? [-1, -1, -1, 1, 1, 1];
    this.center.set((b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2);
    this.radius = Math.max(1e-6, Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]) / 2);
    this.cam.az = VIEWS.iso[0];
    this.cam.el = VIEWS.iso[1];
    this.zoomToBox(b, false);
  }

  // ------------------------------------------------------------------ camera
  /** Applies the camera state to the three.js cameras (and near/far planes from the model size). */
  updateCamera() {
    const { right, up, dir } = axes(this.cam.az, this.cam.el);
    const m = new THREE.Matrix4().makeBasis(right, up, dir.clone().negate());
    const R = this.radius;
    const aspect = this.width / this.height;
    const c = this.cam;
    this.persp.aspect = aspect;
    if (!c.ortho) {
      const pos = c.target.clone().addScaledVector(dir, -c.dist);
      this.persp.position.copy(pos);
      this.persp.quaternion.setFromRotationMatrix(m);
      const dc = pos.distanceTo(this.center);
      const far = dc + R * 1.6;
      this.persp.near = Math.max(dc - R * 1.3, far / 50000, R * 1e-5);
      this.persp.far = far;
      this.persp.updateProjectionMatrix();
      this.camera = this.persp;
    } else {
      // In front of everything along the view direction.
      const along = this.center.clone().sub(c.target).dot(dir) - R * 2;
      this.ortho.position.copy(c.target).addScaledVector(dir, along);
      this.ortho.quaternion.setFromRotationMatrix(m);
      this.ortho.near = R * 0.01;
      this.ortho.far = R * 4.2 + Math.abs(along) * 0.01;
      this.ortho.top = c.size; this.ortho.bottom = -c.size;
      this.ortho.left = -c.size * aspect; this.ortho.right = c.size * aspect;
      this.ortho.updateProjectionMatrix();
      this.camera = this.ortho;
    }
    this.camera.updateMatrixWorld();
    // Headlight from over the viewer's shoulder.
    this.head.position.copy(this.camera.position).addScaledVector(up, R * 0.6).addScaledVector(right, -R * 0.4);
    this.head.target.position.copy(c.target);
    this.head.target.updateMatrixWorld();
  }

  get isOrtho() { return this.cam.ortho; }

  setProjection(ortho) {
    const c = this.cam;
    if (ortho === c.ortho) return;
    const k = Math.tan((FOV / 2) * DEG);
    if (ortho) c.size = c.dist * k;
    else c.dist = c.size / k;
    c.ortho = ortho;
    this.requestRender();
    this.events.onView?.();
  }

  /** Distance (perspective) and half height (orthographic) that frame box b seen from az/el. */
  fit(b, az, el, pad = 1.08) {
    const { right, up, dir } = axes(az, el);
    const center = new THREE.Vector3((b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2);
    const minR = this.radius * 0.004;
    const aspect = this.width / this.height;
    const tanV = Math.tan((FOV / 2) * DEG), tanH = tanV * aspect;
    let dist = 0, size = 0;
    const c = new THREE.Vector3();
    for (let k = 0; k < 8; k++) {
      c.set(k & 1 ? b[3] : b[0], k & 2 ? b[4] : b[1], k & 4 ? b[5] : b[2]).sub(center);
      const x = Math.abs(c.dot(right)) * pad, y = Math.abs(c.dot(up)) * pad, z = -c.dot(dir);
      dist = Math.max(dist, Math.max(x / tanH, y / tanV) + z);
      size = Math.max(size, x / aspect, y);
    }
    return { target: center, dist: Math.max(dist, minR / tanV), size: Math.max(size, minR) };
  }

  /** Fits a box (shifted coordinates) keeping the view direction. */
  zoomToBox(b, animate = true, pad = 1.08) {
    if (!b) return;
    this.animateTo(this.fit(b, this.cam.az, this.cam.el, pad), animate);
  }

  zoomExtents(animate = true) {
    if (!this.model) return;
    this.zoomToBox(this.model.bbox(null, true) ?? this.model.bbox(), animate);
  }

  setView(name, animate = true) {
    const v = VIEWS[name];
    if (!v || !this.model) return;
    const b = this.model.bbox(null, true) ?? this.model.bbox();
    let az = v[0];
    // Shortest way round.
    while (az - this.cam.az > 180) az -= 360;
    while (az - this.cam.az < -180) az += 360;
    this.animateTo({ az, el: v[1], ...this.fit(b, az, v[1]) }, animate);
  }

  animateTo(to, animate = true) {
    const from = { az: this.cam.az, el: this.cam.el, target: this.cam.target.clone(), dist: this.cam.dist, size: this.cam.size };
    const end = { az: to.az ?? from.az, el: to.el ?? from.el, target: to.target ?? from.target, dist: to.dist ?? from.dist, size: to.size ?? from.size };
    const apply = (t) => {
      const k = ease(t);
      this.cam.az = from.az + (end.az - from.az) * k;
      this.cam.el = from.el + (end.el - from.el) * k;
      this.cam.target.lerpVectors(from.target, end.target, k);
      // Distances interpolate geometrically (zooming feels even).
      this.cam.dist = from.dist * (end.dist / from.dist) ** k;
      this.cam.size = from.size * (end.size / from.size) ** k;
    };
    cancelAnimationFrame(this.anim);
    if (!animate || matchMedia?.('(prefers-reduced-motion: reduce)').matches) { apply(1); this.requestRender(); this.events.onView?.(); return; }
    const t0 = performance.now();
    const step = () => {
      const t = Math.min(1, (performance.now() - t0) / 320);
      apply(t);
      this.renderNow();
      if (t < 1) this.anim = requestAnimationFrame(step);
      else { this.anim = 0; this.events.onView?.(); }
    };
    this.anim = requestAnimationFrame(step);
  }

  /** Zooms by `factor` (< 1 closer) towards a point (shifted coordinates; default the target). */
  zoomAt(factor, toward = null) {
    const c = this.cam;
    const q = toward ?? c.target;
    const minDist = this.radius * 2e-5;
    if (!c.ortho && c.dist * factor < minDist) factor = minDist / c.dist;
    c.target.sub(q).multiplyScalar(factor).add(q);
    if (c.ortho) {
      // Keep only the in-plane part: the target stays on its depth.
      c.size *= factor;
      c.dist = c.size / Math.tan((FOV / 2) * DEG);
    } else c.dist *= factor;
    this.requestRender();
    this.events.onView?.();
  }

  /** Orbit by screen deltas (pixels) around a pivot point. */
  orbit(dx, dy, pivot) {
    const c = this.cam;
    const before = axes(c.az, c.el);
    c.az -= dx * 0.35;
    c.el = Math.max(-90, Math.min(90, c.el + dy * 0.35));
    const after = axes(c.az, c.el);
    const mOld = new THREE.Matrix4().makeBasis(before.right, before.up, before.back);
    const mNew = new THREE.Matrix4().makeBasis(after.right, after.up, after.back);
    const rot = mNew.multiply(mOld.transpose());
    if (pivot) {
      const off = c.target.clone().sub(pivot).applyMatrix4(rot);
      c.target.copy(pivot).add(off);
    }
    this.requestRender();
  }

  /** World units per screen pixel at a depth (distance along the view direction). */
  pixelSize(depth = this.cam.dist) {
    if (this.cam.ortho) return (2 * this.cam.size) / this.height;
    return (2 * depth * Math.tan((FOV / 2) * DEG)) / this.height;
  }

  pan(dx, dy, depth) {
    const { right, up } = axes(this.cam.az, this.cam.el);
    const s = this.pixelSize(depth);
    this.cam.target.addScaledVector(right, -dx * s).addScaledVector(up, dy * s);
    this.requestRender();
  }

  /** Ray through a screen point (CSS pixels in the viewport). */
  rayAt(x, y) {
    this.updateCamera();
    const ndc = new THREE.Vector2((x / this.width) * 2 - 1, -(y / this.height) * 2 + 1);
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, this.camera);
    return rc.ray;
  }

  /** Point on the model under a screen point, honouring hidden elements and the section. */
  pick(x, y) {
    if (!this.model) return null;
    const ray = this.rayAt(x, y);
    const keep = this.planes.length ? (px, py, pz) => this.planes.every((p) => p.normal.x * px + p.normal.y * py + p.normal.z * pz + p.constant >= -1e-9) : null;
    return this.model.raycast(ray.origin, ray.direction, keep);
  }

  /** The pick point, or the point on the target plane under the cursor. */
  pointAt(x, y) {
    const hit = this.pick(x, y);
    if (hit) return hit.point;
    const ray = this.rayAt(x, y);
    const { dir } = axes(this.cam.az, this.cam.el);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(dir, this.cam.target);
    return ray.intersectPlane(plane, new THREE.Vector3()) ?? this.cam.target.clone();
  }

  project(p, w = this.width, h = this.height) {
    // The viewport may have been resized since the last frame (panels opening).
    if (Math.abs(this.persp.aspect - this.width / this.height) > 1e-9) this.updateCamera();
    const v = p.clone().project(this.camera);
    return { x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * h, behind: v.z > 1 || v.z < -1 };
  }

  // ------------------------------------------------------------------ section
  /**
   * @param {{ mode?: 'off'|'box'|'plane', box?: number[], axis?: 'x'|'y'|'z', offset?: number, flip?: boolean }} s
   *   box in shifted coordinates; offset 0–1 across the model along the axis.
   */
  setSection(s) {
    Object.assign(this.clip, s);
    if (this.clip.mode === 'box' && !this.clip.box && this.model) this.clip.box = this.model.bbox().slice();
    this.updateClipping();
    this.requestRender();
  }

  /** The model box enlarged a little (the range of the section sliders). */
  sectionRange() {
    const b = this.model?.bbox() ?? [-1, -1, -1, 1, 1, 1];
    const pad = this.radius * 0.02;
    return [b[0] - pad, b[1] - pad, b[2] - pad, b[3] + pad, b[4] + pad, b[5] + pad];
  }

  updateClipping() {
    for (const o of [...this.helpers.children]) { this.helpers.remove(o); o.geometry?.dispose(); o.material?.dispose(); }
    this.planes = [];
    const c = this.clip;
    const lineMat = () => new THREE.LineBasicMaterial({ color: 0xff9f1c, transparent: true, opacity: 0.9, depthTest: false });
    if (c.mode === 'box' && c.box) {
      const b = c.box;
      this.planes = [
        new THREE.Plane(new THREE.Vector3(1, 0, 0), -b[0]), new THREE.Plane(new THREE.Vector3(-1, 0, 0), b[3]),
        new THREE.Plane(new THREE.Vector3(0, 1, 0), -b[1]), new THREE.Plane(new THREE.Vector3(0, -1, 0), b[4]),
        new THREE.Plane(new THREE.Vector3(0, 0, 1), -b[2]), new THREE.Plane(new THREE.Vector3(0, 0, -1), b[5]),
      ];
      const box = new THREE.Box3(new THREE.Vector3(b[0], b[1], b[2]), new THREE.Vector3(b[3], b[4], b[5]));
      const helper = new THREE.Box3Helper(box, 0xff9f1c);
      helper.material.depthTest = false;
      helper.material.transparent = true;
      this.helpers.add(helper);
    } else if (c.mode === 'plane') {
      const r = this.sectionRange();
      const k = { x: 0, y: 1, z: 2 }[c.axis] ?? 2;
      const pos = r[k] + (r[k + 3] - r[k]) * c.offset;
      const n = new THREE.Vector3();
      n.setComponent(k, c.flip ? 1 : -1);
      this.planes = [new THREE.Plane(n, c.flip ? -pos : pos)];
      // Outline of the cut across the model.
      const u = (k + 1) % 3, v = (k + 2) % 3;
      const corners = [[r[u], r[v]], [r[u + 3], r[v]], [r[u + 3], r[v + 3]], [r[u], r[v + 3]]].map(([a, bb]) => {
        const p = new THREE.Vector3();
        p.setComponent(k, pos); p.setComponent(u, a); p.setComponent(v, bb);
        return p;
      });
      const geo = new THREE.BufferGeometry().setFromPoints([...corners, corners[0]]);
      this.helpers.add(new THREE.Line(geo, lineMat()));
    }
    this.renderer.clippingPlanes = this.planes;
  }

  // ------------------------------------------------------------------ rendering
  requestRender() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.renderNow(); });
  }

  renderNow() {
    this.updateCamera();
    const r = this.renderer;
    r.clippingPlanes = this.planes;
    r.render(this.scene, this.camera);
    if (this.helpers.children.length) {
      r.autoClear = false;
      r.clippingPlanes = [];
      r.render(this.helpers, this.camera);
      r.autoClear = true;
      r.clippingPlanes = this.planes;
    }
    this.updateViewCube();
    this.drawOverlay(this.octx, this.width, this.height, this.dpr);
  }

  /** Measurements, snap marker, orbit pivot and axis tripod (CSS pixel coordinates scaled by dpr). */
  drawOverlay(o, w, h, dpr, forPrint = false) {
    o.setTransform(1, 0, 0, 1, 0, 0);
    if (!forPrint) o.clearRect(0, 0, o.canvas.width, o.canvas.height);
    o.setTransform(dpr, 0, 0, dpr, 0, 0);
    const pr = (p) => this.project(p, w, h);
    const fg = forPrint ? '#000000' : '#ffffff';
    const lineCol = '#22d3ee';
    o.font = '12px system-ui, sans-serif';
    o.lineJoin = 'round';
    const label = (x, y, lines) => {
      const pad = 4, lh = 15;
      const wMax = Math.max(...lines.map((s) => o.measureText(s).width));
      o.fillStyle = forPrint ? 'rgba(255,255,255,0.9)' : 'rgba(20,23,28,0.85)';
      o.fillRect(x - wMax / 2 - pad, y - pad - 2, wMax + pad * 2, lines.length * lh + pad);
      o.fillStyle = forPrint ? '#0e7490' : '#e7f9fd';
      lines.forEach((s, i) => o.fillText(s, x - o.measureText(s).width / 2, y + 9 + i * lh));
    };
    const all = [...this.measures];
    if (this.pending && this.hover && !forPrint) all.push({ a: this.pending, b: this.hover.point, live: true });
    for (const m of all) {
      const A = pr(m.a), B = pr(m.b);
      if (A.behind || B.behind) continue;
      o.strokeStyle = lineCol;
      o.lineWidth = 2;
      o.setLineDash(m.live ? [6, 4] : []);
      o.beginPath(); o.moveTo(A.x, A.y); o.lineTo(B.x, B.y); o.stroke();
      o.setLineDash([]);
      for (const P of [A, B]) { o.fillStyle = lineCol; o.beginPath(); o.arc(P.x, P.y, 3.5, 0, Math.PI * 2); o.fill(); }
      const d = m.b.clone().sub(m.a);
      const f = (v) => formatValue(v);
      label((A.x + B.x) / 2, (A.y + B.y) / 2 + 6, [`${f(d.length())} ${this.units}`.trim(), `ΔX ${f(d.x)}  ΔY ${f(d.y)}  ΔZ ${f(d.z)}`]);
    }
    if (this.pending && !forPrint) {
      const A = pr(this.pending);
      if (!A.behind) { o.fillStyle = lineCol; o.beginPath(); o.arc(A.x, A.y, 4, 0, Math.PI * 2); o.fill(); }
    }
    if (this.tool === 'measure' && this.hover && !forPrint) {
      const S = pr(this.hover.point);
      o.strokeStyle = '#22c55e';
      o.lineWidth = 2;
      o.beginPath();
      const s = 6;
      if (this.hover.kind === 'vertex') o.rect(S.x - s, S.y - s, s * 2, s * 2);
      else if (this.hover.kind === 'mid') { o.moveTo(S.x, S.y - s - 1); o.lineTo(S.x + s + 1, S.y + s); o.lineTo(S.x - s - 1, S.y + s); o.closePath(); }
      else if (this.hover.kind === 'edge') { o.moveTo(S.x - s, S.y - s); o.lineTo(S.x + s, S.y + s); o.moveTo(S.x + s, S.y - s); o.lineTo(S.x - s, S.y + s); }
      else o.arc(S.x, S.y, s - 1, 0, Math.PI * 2);
      o.stroke();
    }
    if (this.pivot && !forPrint) {
      const P = pr(this.pivot);
      if (!P.behind) { o.strokeStyle = '#ff9f1c'; o.lineWidth = 2; o.beginPath(); o.arc(P.x, P.y, 5, 0, Math.PI * 2); o.stroke(); }
    }
    if (!forPrint) {
      // Axis tripod, bottom left.
      const { right, up } = axes(this.cam.az, this.cam.el);
      const cx = 34, cy = h - 34, L = 22;
      for (const [v, col, name] of [[new THREE.Vector3(1, 0, 0), '#ef4444', 'X'], [new THREE.Vector3(0, 1, 0), '#22c55e', 'Y'], [new THREE.Vector3(0, 0, 1), '#3b82f6', 'Z']]) {
        const x = cx + v.dot(right) * L, y = cy - v.dot(up) * L;
        o.strokeStyle = col; o.lineWidth = 2.5;
        o.beginPath(); o.moveTo(cx, cy); o.lineTo(x, y); o.stroke();
        o.fillStyle = col; o.font = 'bold 11px system-ui, sans-serif';
        o.fillText(name, x + (x - cx) * 0.25 - 3, y + (y - cy) * 0.25 + 4);
      }
      void fg;
    }
  }

  // ------------------------------------------------------------------ view cube
  buildViewCube() {
    const wrap = document.createElement('div');
    wrap.className = 'viewcube';
    const faces = [
      ['top', 'TOP', [1, 0, 0], [0, -1, 0], [0, 0, 1]], ['bottom', 'BOTTOM', [1, 0, 0], [0, 1, 0], [0, 0, -1]],
      ['front', 'FRONT', [1, 0, 0], [0, 0, -1], [0, -1, 0]], ['back', 'BACK', [-1, 0, 0], [0, 0, -1], [0, 1, 0]],
      ['right', 'RIGHT', [0, 1, 0], [0, 0, -1], [1, 0, 0]], ['left', 'LEFT', [0, -1, 0], [0, 0, -1], [-1, 0, 0]],
    ];
    this.cubeFaces = faces.map(([view, text, u, v, n]) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'vc-face';
      el.textContent = text;
      el.title = `${text[0]}${text.slice(1).toLowerCase()} view`;
      el.addEventListener('click', (ev) => { ev.stopPropagation(); this.setView(view); });
      wrap.append(el);
      return { el, u: new THREE.Vector3(...u), v: new THREE.Vector3(...v), n: new THREE.Vector3(...n) };
    });
    const home = document.createElement('button');
    home.type = 'button';
    home.className = 'vc-home';
    home.title = 'Isometric view';
    home.textContent = 'ISO';
    home.addEventListener('click', (ev) => { ev.stopPropagation(); this.setView('iso'); });
    wrap.append(home);
    this.cube = wrap;
    this.host.append(wrap);
  }

  updateViewCube() {
    const { right, up, back } = axes(this.cam.az, this.cam.el);
    const s = 56, h = s / 2;
    for (const f of this.cubeFaces) {
      // face (u right, v down, n out) -> world -> screen (x right, y down, z towards the viewer)
      const col = (w) => [w.dot(right), -w.dot(up), w.dot(back)];
      const U = col(f.u), V = col(f.v), N = col(f.n);
      const T = N.map((x) => x * h);
      f.el.style.transform = `matrix3d(${U[0]},${U[1]},${U[2]},0,${V[0]},${V[1]},${V[2]},0,${N[0]},${N[1]},${N[2]},0,${T[0]},${T[1]},${T[2]},1)`;
      f.el.style.zIndex = String(Math.round(50 + N[2] * 40));
      f.el.style.visibility = N[2] > 0.02 ? 'visible' : 'hidden';
    }
  }

  // ------------------------------------------------------------------ tools & input
  setTool(tool) {
    this.tool = tool;
    if (tool !== 'measure') { this.pending = null; this.hover = null; }
    this.overlay.style.cursor = tool === 'pan' ? 'grab' : tool === 'measure' ? 'crosshair' : 'default';
    this.requestRender();
  }

  /** Snapped point under the cursor for measuring: vertex, edge midpoint, edge or face. */
  snapAt(x, y) {
    const hit = this.pick(x, y);
    if (!hit) return null;
    if (!this.snapOn) return { point: hit.point, kind: 'face', id: hit.id };
    const S = (p) => this.project(p);
    const near = 10;
    let best = null;
    for (const v of hit.tri) {
      const s = S(v);
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < near && (!best || d < best.d)) best = { d, point: v.clone(), kind: 'vertex' };
    }
    if (best) return { ...best, id: hit.id };
    for (let i = 0; i < 3; i++) {
      const p = hit.tri[i], q = hit.tri[(i + 1) % 3];
      const sp = S(p), sq = S(q);
      const ex = sq.x - sp.x, ey = sq.y - sp.y;
      const L2 = ex * ex + ey * ey;
      if (L2 < 1) continue;
      const t = Math.max(0, Math.min(1, ((x - sp.x) * ex + (y - sp.y) * ey) / L2));
      const d = Math.hypot(sp.x + ex * t - x, sp.y + ey * t - y);
      if (d > near - 2 || (best && d >= best.d)) continue;
      if (!this.model.isFeatureEdge(hit, p, q, hit.normal)) continue;
      const mid = Math.hypot((sp.x + sq.x) / 2 - x, (sp.y + sq.y) / 2 - y) < near;
      best = { d, point: mid ? p.clone().lerp(q, 0.5) : p.clone().lerp(q, t), kind: mid ? 'mid' : 'edge' };
    }
    return best ? { ...best, id: hit.id } : { point: hit.point, kind: 'face', id: hit.id };
  }

  clearMeasures() {
    this.measures = [];
    this.pending = null;
    this.requestRender();
    this.events.onMeasure?.();
  }

  /** Esc: drops the measurement in progress. Returns true when something was cancelled. */
  cancel() {
    if (this.pending) { this.pending = null; this.requestRender(); return true; }
    return false;
  }

  bindInput() {
    const el = this.overlay;
    el.style.touchAction = 'none';
    const local = (ev) => { const r = el.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top]; };
    el.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      if (!this.model) return;
      const [x, y] = local(ev);
      const dy = ev.deltaMode === 1 ? ev.deltaY * 33 : ev.deltaY;
      const now = performance.now();
      // The point under the cursor is looked up again only when the cursor moved or after a pause.
      if (!this.wheelAt || Math.hypot(this.wheelAt.x - x, this.wheelAt.y - y) > 3 || now - this.wheelAt.time > 400) this.wheelAt = { x, y, p: this.pointAt(x, y) };
      this.wheelAt.time = now;
      this.zoomAt(Math.pow(1.0015, Math.max(-300, Math.min(300, dy))), this.wheelAt.p);
    }, { passive: false });
    el.addEventListener('pointerdown', (ev) => {
      if (!this.model) return;
      el.setPointerCapture(ev.pointerId);
      const [x, y] = local(ev);
      this.pointers.set(ev.pointerId, { x, y, sx: x, sy: y, button: ev.button, type: ev.pointerType, shift: ev.shiftKey, moved: false, mode: null });
      if (ev.button === 1) ev.preventDefault();
      if (this.pointers.size === 2) {
        for (const p of this.pointers.values()) p.mode = 'pinch';
        this.pinch = this.pinchState();
        this.pivot = null;
      }
    });
    el.addEventListener('pointermove', (ev) => {
      const [x, y] = local(ev);
      const p = this.pointers.get(ev.pointerId);
      if (!p) { this.onHover(x, y); return; }
      if (this.pointers.size === 2 && this.pinch) {
        p.x = x; p.y = y;
        const now = this.pinchState();
        const q = this.pinch.point ?? (this.pinch.point = this.pointAt(now.x, now.y));
        this.zoomAt(this.pinch.d / now.d, q);
        this.pan(now.x - this.pinch.x, now.y - this.pinch.y, this.depthOf(q));
        this.pinch = { ...now, point: q };
        return;
      }
      const dx = x - p.x, dy = y - p.y;
      p.x = x; p.y = y;
      if (!p.moved && Math.hypot(x - p.sx, y - p.sy) > (p.type === 'touch' ? 8 : 4)) {
        p.moved = true;
        const panning = p.button === 1 || p.button === 2 || p.shift || (p.button === 0 && this.tool === 'pan' && p.type !== 'touch');
        p.mode = panning ? 'pan' : 'orbit';
        const hitPoint = this.pick(p.sx, p.sy)?.point ?? null;
        if (p.mode === 'orbit') this.pivot = hitPoint ?? this.cam.target.clone();
        else p.depth = hitPoint ? this.depthOf(hitPoint) : this.cam.dist;
        if (p.mode === 'pan') el.style.cursor = 'grabbing';
      }
      if (!p.moved) return;
      if (p.mode === 'orbit') this.orbit(dx, dy, this.pivot);
      else if (p.mode === 'pan') this.pan(dx, dy, p.depth);
    });
    const end = (ev) => {
      const p = this.pointers.get(ev.pointerId);
      this.pointers.delete(ev.pointerId);
      if (this.pointers.size < 2) this.pinch = null;
      if (!p) return;
      if (p.moved || p.mode === 'pinch') {
        this.pivot = null;
        this.setTool(this.tool); // cursor
        this.events.onView?.();
        return;
      }
      if (ev.type !== 'pointerup' || !(p.button === 0 || p.type === 'touch')) return;
      this.onClick(p.x, p.y, ev);
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('pointerleave', () => { if (!this.pointers.size) { this.hover = null; this.events.onCursor?.(null); this.requestRender(); } });
    el.addEventListener('dblclick', (ev) => {
      if (!this.model || this.tool === 'measure') return;
      const [x, y] = local(ev);
      const hit = this.pick(x, y);
      if (hit) this.zoomToElements([hit.id]);
      else this.zoomExtents();
    });
    el.addEventListener('contextmenu', (ev) => ev.preventDefault());
  }

  depthOf(p) {
    const { dir } = axes(this.cam.az, this.cam.el);
    return Math.max(this.radius * 1e-4, p.clone().sub(this.camera.position).dot(dir));
  }

  pinchState() {
    const [a, b] = [...this.pointers.values()];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) };
  }

  onHover(x, y) {
    if (!this.model) return;
    const now = performance.now();
    this.hoverAt = [x, y];
    if (this.hoverTimer) return;
    const run = () => {
      this.hoverTimer = 0;
      const [hx, hy] = this.hoverAt;
      this.lastHover = performance.now();
      if (this.tool === 'measure') {
        this.hover = this.snapAt(hx, hy);
        this.events.onCursor?.(this.hover?.point ?? null);
        this.requestRender();
      } else {
        this.events.onCursor?.(this.pick(hx, hy)?.point ?? null);
      }
    };
    // At most every 40 ms (large models).
    const wait = Math.max(0, 40 - (now - (this.lastHover ?? 0)));
    this.hoverTimer = setTimeout(run, wait);
  }

  onClick(x, y, ev) {
    if (this.tool === 'measure') {
      const s = this.snapAt(x, y);
      if (!s) return;
      if (!this.pending) this.pending = s.point.clone();
      else {
        this.measures.push({ a: this.pending, b: s.point.clone() });
        this.pending = null;
        this.events.onMeasure?.();
      }
      this.hover = s;
      this.requestRender();
      return;
    }
    const hit = this.pick(x, y);
    this.events.onSelect?.(hit ? hit.id : null, ev, hit);
  }

  zoomToElements(ids) {
    if (!this.model) return;
    const b = this.model.bbox(ids);
    if (b) this.zoomToBox(b, true, 1.25);
  }

  // ------------------------------------------------------------------ images
  /** PNG data URL of the current view (for the AI assistant). */
  captureView(maxSide = 1568) {
    this.renderNow();
    const w = this.canvas.width, h = this.canvas.height;
    const k = Math.min(1, maxSide / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.round(w * k);
    c.height = Math.round(h * k);
    const ctx = c.getContext('2d');
    ctx.drawImage(this.canvas, 0, 0, c.width, c.height);
    ctx.drawImage(this.overlay, 0, 0, c.width, c.height);
    return c.toDataURL('image/png');
  }

  /**
   * The current view rendered off screen at `scale` times the viewport size (at most `maxSide`
   * pixels), on white, with the measurements; for printing and PNG export.
   */
  snapshot(scale = 3, maxSide = 4096, background = '#ffffff') {
    const r = this.renderer;
    const limit = Math.min(maxSide, r.capabilities.maxTextureSize || 4096, r.capabilities.maxRenderbufferSize || 4096);
    const k = Math.min(scale, limit / this.width, limit / this.height);
    const W = Math.max(1, Math.round(this.width * k)), H = Math.max(1, Math.round(this.height * k));
    this.updateCamera();
    const target = new THREE.WebGLRenderTarget(W, H, { samples: 4, colorSpace: THREE.SRGBColorSpace });
    const bg = this.scene.background;
    this.scene.background = new THREE.Color(background);
    try {
      r.setRenderTarget(target);
      r.clippingPlanes = this.planes;
      r.render(this.scene, this.camera);
      const px = new Uint8Array(W * H * 4);
      r.readRenderTargetPixels(target, 0, 0, W, H, px);
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const ctx = c.getContext('2d');
      const img = ctx.createImageData(W, H);
      // WebGL rows go bottom-up.
      for (let y = 0; y < H; y++) img.data.set(px.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
      ctx.putImageData(img, 0, 0);
      this.drawOverlay(ctx, this.width, this.height, k, true);
      return c;
    } finally {
      r.setRenderTarget(null);
      this.scene.background = bg;
      target.dispose();
      this.requestRender();
    }
  }

  dispose() {
    cancelAnimationFrame(this.frame);
    cancelAnimationFrame(this.anim);
    clearTimeout(this.hoverTimer);
    this.resizeObs.disconnect();
    this.renderer.dispose();
  }
}

/** Number for measurement labels: up to 3 decimals, thousands separated. */
export function formatValue(v) {
  const a = Math.abs(v);
  const d = a >= 1000 ? 1 : a >= 10 ? 2 : 3;
  return v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: d });
}
