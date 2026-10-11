// three.js scene manager: model meshes, selection, ghosts for tools, view cube, section box, labels.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { CSS2DObject, CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type { Clash } from "../engine/clash";
import type { Model } from "../engine/compute";
import type { Comp } from "../engine/model";
import type { V3 } from "../engine/vec";
import { MM, shapeMesh, v } from "./meshes";

export interface Hit {
  uid: string;
  point: V3;
}

export const LINE_COLORS = ["#3a78c4", "#2f9a63", "#b5602f", "#16999a", "#8a5cc4", "#c4507a", "#8f9a2e", "#d18a12"];
const EQUIP_COLORS: Record<string, string> = { pump: "#5d8db0", vvessel: "#c6cfd6", hdrum: "#c6cfd6", exchanger: "#a9bccb", tank: "#d4dbe0" };
const STEEL = "#c39a3a";
const SUPPORT = "#6f7b85";

export type ViewName = "iso" | "iso-sw" | "iso-nw" | "plan" | "north" | "south" | "east" | "west";
const VIEW_DIRS: Record<ViewName, [number, number, number]> = {
  iso: [1, -1, 0.82],
  "iso-sw": [-1, -1, 0.78],
  "iso-nw": [-1, 1, 0.82],
  plan: [0, -0.0001, 1],
  north: [0, -1, 0.0001], // looking north (camera on the south side)
  south: [0, 1, 0.0001],
  east: [-1, 0, 0.0001],
  west: [1, 0, 0.0001],
};

export interface InputHandler {
  move?(ev: PointerEvent): void;
  down?(ev: PointerEvent): boolean | void; // return true to stop orbit
  click?(ev: PointerEvent): void;
  dblclick?(ev: MouseEvent): void;
  key?(ev: KeyboardEvent): boolean | void;
}

const ownerKey = (c: Comp) => `${c.owner.type}:${c.owner.id}`;

export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(40, 1, 0.05, 4000);
  readonly controls: OrbitControls;
  readonly gizmo: TransformControls;
  readonly gizmoProxy = new THREE.Object3D();
  private labels = new CSS2DRenderer();
  private root = new THREE.Group();
  private ghost = new THREE.Group();
  private overlay = new THREE.Group();
  private labelGroup = new THREE.Group();
  private grid = new THREE.Group();
  private sun = new THREE.DirectionalLight(0xffffff, 2.2);
  private owners = new Map<string, { sig: string; group: THREE.Group }>();
  private meshesByUid = new Map<string, THREE.Mesh[]>();
  private compsByUid = new Map<string, Comp>();
  private baseMat = new Map<THREE.Mesh, THREE.Material>();
  private mats = new Map<string, THREE.MeshStandardMaterial>();
  private selectMat = new THREE.MeshStandardMaterial({ color: "#ffb21a", emissive: "#ff9a00", emissiveIntensity: 0.45, metalness: 0.2, roughness: 0.4 });
  private hoverMat = new THREE.MeshStandardMaterial({ color: "#9fd3ff", emissive: "#2f8fe0", emissiveIntensity: 0.35, metalness: 0.2, roughness: 0.45 });
  private clashMat = new THREE.MeshStandardMaterial({ color: "#ff4b3e", emissive: "#d01a10", emissiveIntensity: 0.55, metalness: 0.1, roughness: 0.5 });
  private ghostMat = new THREE.MeshStandardMaterial({ color: "#46c1ff", transparent: true, opacity: 0.55, depthWrite: false, emissive: "#1a7fc0", emissiveIntensity: 0.4 });
  private ghostBadMat = new THREE.MeshStandardMaterial({ color: "#ff6a5a", transparent: true, opacity: 0.5, depthWrite: false, emissive: "#c0261a", emissiveIntensity: 0.4 });
  private selected = new Set<string>();
  private hovered: string | null = null;
  private clashUids = new Set<string>();
  private showClashes = true;
  private ray = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private downAt: [number, number] | null = null;
  private anim: number | null = null;
  private cube: ViewCube;
  private section: THREE.Box3 | null = null;
  handler: InputHandler | null = null;
  onHover: ((h: Hit | null) => void) | null = null;
  onCursor: ((p: V3 | null) => void) | null = null;
  onSelectClick: ((h: Hit | null, ev: PointerEvent) => void) | null = null;
  onGizmoDrag: ((pos: V3, done: boolean) => void) | null = null;
  workingZ = 0;
  labelsOn = true;

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.localClippingEnabled = true;
    host.appendChild(this.renderer.domElement);
    this.renderer.domElement.className = "vp-canvas";
    this.labels.domElement.className = "vp-labels";
    host.appendChild(this.labels.domElement);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.add(new THREE.HemisphereLight(0xdfe9f3, 0x5a5048, 0.9));
    this.sun.position.set(40, -60, 90);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.02;
    this.scene.add(this.sun, this.sun.target);

    this.camera.up.set(0, 0, 1);
    this.camera.position.set(60, -60, 50);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.screenSpacePanning = true;
    this.controls.zoomToCursor = true;
    this.controls.maxPolarAngle = Math.PI;

    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.gizmo.setTranslationSnap(0.05);
    this.gizmo.setSize(0.9);
    this.scene.add(this.gizmoProxy);
    this.gizmo.addEventListener("dragging-changed", (e) => {
      this.controls.enabled = !(e as unknown as { value: boolean }).value;
      if (!(e as unknown as { value: boolean }).value) this.emitGizmo(true);
    });
    this.gizmo.addEventListener("objectChange", () => this.emitGizmo(false));
    this.scene.add(this.gizmo);

    this.root.name = "model";
    this.scene.add(this.root, this.ghost, this.overlay, this.labelGroup, this.grid);
    this.cube = new ViewCube(host, (dir) => this.setView(dir));

    const el = this.renderer.domElement;
    el.addEventListener("pointerdown", (e) => this.onDown(e));
    el.addEventListener("pointermove", (e) => this.onMove(e));
    el.addEventListener("pointerup", (e) => this.onUp(e));
    el.addEventListener("dblclick", (e) => this.handler?.dblclick?.(e));
    el.addEventListener("pointerleave", () => {
      this.setHover(null);
      this.onCursor?.(null);
    });
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  // ---------------------------------------------------------------- materials
  private mat(key: string, color: string, opts: Partial<THREE.MeshStandardMaterialParameters> = {}) {
    let m = this.mats.get(key);
    if (!m) {
      m = new THREE.MeshStandardMaterial({ color, metalness: 0.35, roughness: 0.42, ...opts });
      this.mats.set(key, m);
    }
    return m;
  }

  private materialFor(c: Comp, model: Model): THREE.Material {
    if (c.owner.type === "structure") return this.mat("steel", STEEL, { metalness: 0.25, roughness: 0.6 });
    if (c.owner.type === "equipment") {
      const t = model.equipment.get(c.owner.id)?.doc.template ?? "vvessel";
      return this.mat(`eq:${t}`, EQUIP_COLORS[t] ?? "#c6cfd6", { metalness: 0.3, roughness: 0.5 });
    }
    const line = model.lines.get(c.owner.id);
    const col = LINE_COLORS[(line?.doc.color ?? 0) % LINE_COLORS.length];
    if (c.kind === "SUPPORT") return this.mat("support", SUPPORT, { metalness: 0.3, roughness: 0.6 });
    if (c.kind === "VALVE") return this.mat(`valve:${col}`, new THREE.Color(col).multiplyScalar(0.55).getStyle(), { metalness: 0.45, roughness: 0.35 });
    if (c.kind === "FLANGE" || c.kind === "GASKET") return this.mat(`fl:${col}`, new THREE.Color(col).lerp(new THREE.Color("#c9d2d9"), 0.35).getStyle(), { metalness: 0.55, roughness: 0.3 });
    return this.mat(`line:${col}`, col);
  }

  // ---------------------------------------------------------------- model sync
  private lastModel: Model | null = null;

  setModel(model: Model) {
    this.lastModel = model;
    const byOwner = new Map<string, Comp[]>();
    for (const c of model.comps) {
      const k = ownerKey(c);
      if (!byOwner.has(k)) byOwner.set(k, []);
      byOwner.get(k)!.push(c);
    }
    for (const [k, rec] of this.owners) {
      if (!byOwner.has(k)) {
        this.disposeGroup(rec.group);
        this.owners.delete(k);
      }
    }
    for (const [k, comps] of byOwner) {
      const line = comps[0].owner.type === "line" ? model.lines.get(comps[0].owner.id) : undefined;
      const sig = JSON.stringify(comps.map((c) => [c.uid, c.shapes])) + (line ? `|${line.doc.color}` : "");
      const rec = this.owners.get(k);
      if (rec && rec.sig === sig) continue;
      if (rec) this.disposeGroup(rec.group);
      const group = new THREE.Group();
      for (const c of comps) {
        const mat = this.materialFor(c, model);
        const list: THREE.Mesh[] = [];
        for (const s of c.shapes) {
          const m = shapeMesh(s, mat);
          m.castShadow = true;
          m.receiveShadow = true;
          m.userData.uid = c.uid;
          this.baseMat.set(m, mat);
          group.add(m);
          list.push(m);
        }
        this.meshesByUid.set(c.uid, list);
      }
      this.root.add(group);
      this.owners.set(k, { sig, group });
    }
    this.compsByUid = new Map(model.comps.map((c) => [c.uid, c]));
    for (const uid of [...this.meshesByUid.keys()]) if (!this.compsByUid.has(uid)) this.meshesByUid.delete(uid);
    this.drawErrors(model);
    this.buildLabels(model);
    this.updateGridAndShadow();
    this.repaint();
  }

  private disposeGroup(g: THREE.Group) {
    g.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        (o as THREE.Mesh).geometry.dispose();
        this.baseMat.delete(o as THREE.Mesh);
      }
    });
    g.removeFromParent();
  }

  private errorGroup = new THREE.Group();
  private drawErrors(model: Model) {
    this.errorGroup.removeFromParent();
    this.errorGroup = new THREE.Group();
    for (const l of model.lines.values()) {
      if (!l.error || l.path.length < 2) continue;
      const g = new THREE.BufferGeometry().setFromPoints(l.path.map(v));
      const line = new THREE.Line(g, new THREE.LineDashedMaterial({ color: "#ff4b3e", dashSize: 0.25, gapSize: 0.15, depthTest: false }));
      line.computeLineDistances();
      line.renderOrder = 5;
      this.errorGroup.add(line);
    }
    this.overlay.add(this.errorGroup);
  }

  private buildLabels(model: Model) {
    for (const o of [...this.labelGroup.children]) {
      o.removeFromParent();
      (o as CSS2DObject).element?.remove();
    }
    if (!this.labelsOn) return;
    const add = (text: string, at: V3, cls: string) => {
      const el = document.createElement("div");
      el.className = `lbl ${cls}`;
      el.textContent = text;
      const o = new CSS2DObject(el);
      o.position.copy(v(at));
      this.labelGroup.add(o);
    };
    for (const e of model.equipment.values()) {
      const box = new THREE.Box3();
      for (const m of this.meshesByUid.get(e.body.uid) ?? []) box.expandByObject(m);
      if (!box.isEmpty()) add(e.doc.tag, [((box.min.x + box.max.x) / 2) / MM, ((box.min.y + box.max.y) / 2) / MM, box.max.z / MM + 400], "lbl-eq");
    }
    for (const s of model.structures.values()) add(s.doc.tag, [s.rack.start[0] - 1200 * s.rack.axis[0], s.rack.start[1] - 1200 * s.rack.axis[1], Math.max(...s.rack.levels) + 600], "lbl-eq");
    for (const l of model.lines.values()) {
      if (!l.comps.some((c) => this.selected.has(c.uid))) continue; // line numbers only for the selected line
      const pipes = l.comps.filter((c) => c.kind === "PIPE");
      if (!pipes.length) continue;
      const p = pipes.reduce((a, b) => (b.props.length > a.props.length ? b : a));
      const mid: V3 = [(p.ports[0].pos[0] + p.ports[1].pos[0]) / 2, (p.ports[0].pos[1] + p.ports[1].pos[1]) / 2, (p.ports[0].pos[2] + p.ports[1].pos[2]) / 2 + p.props.od / 2 + 120];
      add(l.doc.number, mid, "lbl-line");
    }
  }

  setLabels(on: boolean, model: Model) {
    this.labelsOn = on;
    this.buildLabels(model);
  }

  private updateGridAndShadow() {
    const box = new THREE.Box3().setFromObject(this.root);
    for (const o of [...this.grid.children]) o.removeFromParent();
    if (box.isEmpty()) box.set(new THREE.Vector3(-10, -10, 0), new THREE.Vector3(10, 10, 5));
    const size = Math.ceil((Math.max(box.max.x - box.min.x, box.max.y - box.min.y) + 20) / 10) * 10;
    const cx = Math.round((box.min.x + box.max.x) / 2);
    const cy = Math.round((box.min.y + box.max.y) / 2);
    const fine = new THREE.GridHelper(size, size, 0x8a99a6, 0x8a99a6);
    (fine.material as THREE.Material).transparent = true;
    (fine.material as THREE.Material).opacity = 0.18;
    const major = new THREE.GridHelper(size, size / 5, 0x6f8090, 0x6f8090);
    (major.material as THREE.Material).transparent = true;
    (major.material as THREE.Material).opacity = 0.35;
    for (const g of [fine, major]) {
      g.rotation.x = Math.PI / 2;
      g.position.set(cx, cy, 0.001);
      this.grid.add(g);
    }
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.ShadowMaterial({ opacity: 0.22 }));
    ground.position.set(cx, cy, 0);
    ground.receiveShadow = true;
    this.grid.add(ground);
    const r = Math.max(size / 2, 10);
    const cam = this.sun.shadow.camera;
    cam.left = -r;
    cam.right = r;
    cam.top = r;
    cam.bottom = -r;
    cam.near = 1;
    cam.far = 400;
    cam.updateProjectionMatrix();
    this.sun.target.position.set(cx, cy, 0);
    this.sun.position.set(cx + 40, cy - 60, 90);
  }

  // ---------------------------------------------------------------- highlight
  setSelection(uids: string[]) {
    this.selected = new Set(uids);
    if (this.lastModel) this.buildLabels(this.lastModel);
    this.repaint();
  }

  setHover(uid: string | null) {
    if (uid === this.hovered) return;
    this.hovered = uid;
    this.repaint();
  }

  setClashes(clashes: Clash[] | null, show: boolean) {
    this.clashUids = new Set((clashes ?? []).filter((c) => c.hard).flatMap((c) => [c.a, c.b]));
    this.showClashes = show;
    this.overlay.children.filter((o) => o.userData.clashMarker).forEach((o) => o.removeFromParent());
    if (show)
      for (const c of clashes ?? []) {
        const m = new THREE.Mesh(new THREE.SphereGeometry(0.28, 16, 10), new THREE.MeshBasicMaterial({ color: c.hard ? "#ff3b30" : "#ffb020", wireframe: true, depthTest: false, transparent: true, opacity: 0.9 }));
        m.position.copy(v(c.point));
        m.renderOrder = 10;
        m.userData.clashMarker = true;
        this.overlay.add(m);
      }
    this.repaint();
  }

  private repaint() {
    for (const [uid, meshes] of this.meshesByUid) {
      let mat: THREE.Material | undefined;
      if (this.selected.has(uid)) mat = this.selectMat;
      else if (this.hovered === uid) mat = this.hoverMat;
      else if (this.showClashes && this.clashUids.has(uid)) mat = this.clashMat;
      for (const m of meshes) m.material = mat ?? this.baseMat.get(m) ?? m.material;
    }
  }

  // ---------------------------------------------------------------- ghosts and guides
  setGhost(comps: Comp[] | null, ok = true) {
    for (const o of [...this.ghost.children]) {
      o.removeFromParent();
      (o as THREE.Mesh).geometry?.dispose();
    }
    if (!comps) return;
    for (const c of comps) for (const s of c.shapes) this.ghost.add(shapeMesh(s, ok ? this.ghostMat : this.ghostBadMat));
  }

  private guideGroup = new THREE.Group();
  setGuides(segments: [V3, V3][], color = "#46c1ff", points: V3[] = []) {
    this.guideGroup.removeFromParent();
    this.guideGroup = new THREE.Group();
    for (const [a, b] of segments) {
      const g = new THREE.BufferGeometry().setFromPoints([v(a), v(b)]);
      const l = new THREE.Line(g, new THREE.LineDashedMaterial({ color, dashSize: 0.18, gapSize: 0.1, depthTest: false, transparent: true, opacity: 0.95 }));
      l.computeLineDistances();
      l.renderOrder = 8;
      this.guideGroup.add(l);
    }
    for (const p of points) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(0.09, 12, 8), new THREE.MeshBasicMaterial({ color, depthTest: false }));
      m.position.copy(v(p));
      m.renderOrder = 9;
      this.guideGroup.add(m);
    }
    this.overlay.add(this.guideGroup);
  }

  // ---------------------------------------------------------------- picking
  private setRay(ev: { clientX: number; clientY: number }) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.ndc, this.camera);
  }

  pick(ev: { clientX: number; clientY: number }, filter?: (c: Comp) => boolean): Hit | null {
    this.setRay(ev);
    const hits = this.ray.intersectObjects(this.root.children, true);
    for (const h of hits) {
      if (this.section && !this.section.containsPoint(h.point)) continue;
      const uid = h.object.userData.uid as string | undefined;
      if (!uid) continue;
      const c = this.compsByUid.get(uid);
      if (c && filter && !filter(c)) continue;
      return { uid, point: [h.point.x / MM, h.point.y / MM, h.point.z / MM] };
    }
    return null;
  }

  /** World ray in millimetres. */
  rayMM(ev: { clientX: number; clientY: number }): { o: V3; d: V3 } {
    this.setRay(ev);
    const o = this.ray.ray.origin;
    const d = this.ray.ray.direction;
    return { o: [o.x / MM, o.y / MM, o.z / MM], d: [d.x, d.y, d.z] };
  }

  planePoint(ev: { clientX: number; clientY: number }, z: number): V3 | null {
    this.setRay(ev);
    const p = new THREE.Vector3();
    const hit = this.ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -z * MM), p);
    return hit ? [p.x / MM, p.y / MM, p.z / MM] : null;
  }

  /** Screen position (CSS px relative to the canvas) of a world point in mm. */
  toScreen(p: V3): [number, number] {
    const q = v(p).project(this.camera);
    const r = this.renderer.domElement.getBoundingClientRect();
    return [((q.x + 1) / 2) * r.width, ((1 - q.y) / 2) * r.height];
  }

  // ---------------------------------------------------------------- input
  private onDown(ev: PointerEvent) {
    this.downAt = [ev.clientX, ev.clientY];
    if (this.handler?.down?.(ev)) this.controls.enabled = false;
  }

  private onMove(ev: PointerEvent) {
    if (ev.buttons === 0) {
      this.handler?.move?.(ev);
      const z = this.planePoint(ev, this.workingZ);
      this.onCursor?.(z);
    }
  }

  private onUp(ev: PointerEvent) {
    this.controls.enabled = true;
    if (!this.downAt) return;
    const moved = Math.hypot(ev.clientX - this.downAt[0], ev.clientY - this.downAt[1]);
    this.downAt = null;
    if (moved > 5 || ev.button !== 0) return;
    if (this.handler?.click) this.handler.click(ev);
  }

  // ---------------------------------------------------------------- transform gizmo
  private emitGizmo(done: boolean) {
    const p = this.gizmoProxy.position;
    this.onGizmoDrag?.([Math.round(p.x / MM), Math.round(p.y / MM), Math.round(p.z / MM)], done);
  }

  attachGizmo(at: V3 | null) {
    if (!at) {
      this.gizmo.detach();
      return;
    }
    this.gizmoProxy.position.copy(v(at));
    this.gizmo.attach(this.gizmoProxy);
  }

  // ---------------------------------------------------------------- camera
  boundsOf(uids?: string[]): THREE.Box3 {
    const box = new THREE.Box3();
    if (uids?.length) for (const u of uids) for (const m of this.meshesByUid.get(u) ?? []) box.expandByObject(m);
    else box.setFromObject(this.root);
    return box;
  }

  fit(uids?: string[], dir?: [number, number, number]) {
    const box = this.boundsOf(uids);
    if (box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const r = Math.max(sphere.radius, 1.2);
    const d = (r / Math.sin((this.camera.fov * Math.PI) / 360)) * (uids?.length ? 1.15 : 0.82);
    const v3 = dir ? new THREE.Vector3(...dir).normalize() : this.camera.position.clone().sub(this.controls.target).normalize();
    this.animateTo(sphere.center, sphere.center.clone().addScaledVector(v3, d));
  }

  setView(name: ViewName | [number, number, number]) {
    this.fit(undefined, typeof name === "string" ? VIEW_DIRS[name] : name);
  }

  focusPoint(p: V3, distance = 9) {
    const t = v(p);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.animateTo(t, t.clone().addScaledVector(dir, distance));
  }

  private animateTo(target: THREE.Vector3, pos: THREE.Vector3) {
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const t0 = this.controls.target.clone();
    const p0 = this.camera.position.clone();
    if (this.anim) cancelAnimationFrame(this.anim);
    if (reduce) {
      this.controls.target.copy(target);
      this.camera.position.copy(pos);
      return;
    }
    const start = performance.now();
    const step = () => {
      const k = Math.min(1, (performance.now() - start) / 480);
      const e = 1 - Math.pow(1 - k, 3);
      this.controls.target.lerpVectors(t0, target, e);
      this.camera.position.lerpVectors(p0, pos, e);
      if (k < 1) this.anim = requestAnimationFrame(step);
      else this.anim = null;
    };
    this.anim = requestAnimationFrame(step);
  }

  // ---------------------------------------------------------------- section box
  setSection(box: { lo: V3; hi: V3 } | null) {
    if (!box) {
      this.section = null;
      this.renderer.clippingPlanes = [];
      return;
    }
    const lo = v(box.lo);
    const hi = v(box.hi);
    this.section = new THREE.Box3(lo, hi);
    this.renderer.clippingPlanes = [
      new THREE.Plane(new THREE.Vector3(1, 0, 0), -lo.x),
      new THREE.Plane(new THREE.Vector3(-1, 0, 0), hi.x),
      new THREE.Plane(new THREE.Vector3(0, 1, 0), -lo.y),
      new THREE.Plane(new THREE.Vector3(0, -1, 0), hi.y),
      new THREE.Plane(new THREE.Vector3(0, 0, 1), -lo.z),
      new THREE.Plane(new THREE.Vector3(0, 0, -1), hi.z),
    ];
  }

  modelBoundsMM(): { lo: V3; hi: V3 } | null {
    const b = new THREE.Box3().setFromObject(this.root);
    if (b.isEmpty()) return null;
    return { lo: [b.min.x / MM, b.min.y / MM, b.min.z / MM], hi: [b.max.x / MM, b.max.y / MM, b.max.z / MM] };
  }

  /** PNG of the current view (read back right after rendering, so no preserved drawing buffer is needed). */
  snapshot(): Blob {
    this.renderer.render(this.scene, this.camera);
    const url = this.renderer.domElement.toDataURL("image/png");
    const bin = atob(url.split(",")[1]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: "image/png" });
  }

  // ---------------------------------------------------------------- loop
  private resize() {
    const w = Math.max(this.host.clientWidth, 1);
    const h = Math.max(this.host.clientHeight, 1);
    this.renderer.setSize(w, h, false);
    this.labels.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private frame() {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
    this.cube.sync(this.camera, this.controls.target);
  }
}

// -------------------------------------------------------------------- view cube
class ViewCube {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1.6, 1.6, 1.6, -1.6, 0.1, 20);
  private cube: THREE.Mesh;
  private ray = new THREE.Raycaster();
  private hovered = -1;
  private mats: THREE.MeshBasicMaterial[];

  constructor(host: HTMLElement, private onPick: (dir: [number, number, number]) => void) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(104, 104);
    this.renderer.domElement.className = "viewcube";
    this.renderer.domElement.title = "Click a face to look from that side";
    host.appendChild(this.renderer.domElement);
    // Box UVs assume Y-up; rotating the geometry makes every side label read upright with Z up.
    // Material order after the rotation: +X, -X, +Z, -Z, -Y, +Y.
    this.mats = FACE_LABELS.map((t) => new THREE.MeshBasicMaterial({ map: faceTexture(t, false) }));
    this.cube = new THREE.Mesh(new THREE.BoxGeometry(1.7, 1.7, 1.7).rotateX(Math.PI / 2), this.mats);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(this.cube.geometry), new THREE.LineBasicMaterial({ color: 0x4d5d6a }));
    this.cube.add(edges);
    this.scene.add(this.cube);
    this.camera.up.set(0, 0, 1);
    const el = this.renderer.domElement;
    el.addEventListener("pointermove", (e) => this.hover(e));
    el.addEventListener("pointerleave", () => this.setHovered(-1));
    el.addEventListener("click", (e) => {
      const f = this.faceAt(e);
      const dirs: [number, number, number][] = [
        [1, 0, 0.0001],
        [-1, 0, 0.0001],
        [0, -0.0001, 1],
        [0, 0.0001, -1],
        [0, -1, 0.0001],
        [0, 1, 0.0001],
      ];
      if (f >= 0) this.onPick(dirs[f]);
    });
  }

  private faceAt(e: MouseEvent): number {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(ndc, this.camera);
    const hit = this.ray.intersectObject(this.cube, false)[0];
    return hit?.face ? hit.face.materialIndex : -1;
  }

  private hover(e: MouseEvent) {
    this.setHovered(this.faceAt(e));
  }

  private setHovered(i: number) {
    if (i === this.hovered) return;
    if (this.hovered >= 0) this.mats[this.hovered].map = faceTexture(FACE_LABELS[this.hovered], false);
    if (i >= 0) this.mats[i].map = faceTexture(FACE_LABELS[i], true);
    this.mats.forEach((m) => (m.needsUpdate = true));
    this.hovered = i;
  }

  sync(main: THREE.PerspectiveCamera, target: THREE.Vector3) {
    const dir = main.position.clone().sub(target).normalize();
    this.camera.position.copy(dir.multiplyScalar(6));
    this.camera.lookAt(0, 0, 0);
    this.renderer.render(this.scene, this.camera);
  }
}

const FACE_LABELS = ["E", "W", "TOP", "BTM", "S", "N"];
const textureCache = new Map<string, THREE.CanvasTexture>();
function faceTexture(label: string, hot: boolean): THREE.CanvasTexture {
  const key = `${label}:${hot}`;
  const hit = textureCache.get(key);
  if (hit) return hit;
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  g.fillStyle = hot ? "#2f8fe0" : "#e7edf2";
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = hot ? "#ffffff" : "#26323b";
  g.font = `600 ${label.length > 1 ? 34 : 54}px "Barlow Condensed", "Arial Narrow", sans-serif`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(label, 64, 68);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  textureCache.set(key, t);
  return t;
}
