// Mesh exchange formats read with three.js loaders: STL (ASCII and binary), OBJ (+ MTL), glTF/GLB,
// PLY, FBX, COLLADA (DAE) and 3MF. The loaded scene graph is flattened into the viewer's merged
// model: every mesh node becomes an element, untextured materials become plain colours (merged
// across the model), textured ones keep their three.js material, and instanced meshes stay instanced.
// Files referenced by OBJ/glTF/DAE (MTL, .bin, textures) come from files opened together with the
// model (web) or from the model's folder (desktop).
import * as THREE from 'three';
import { MergeBuilder } from './merge.js';
import { FormatError } from '../formats/errors.js';

const ZUP = new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1); // (x, y, z)_Y-up -> (x, -z, y)
const Y_UP = new Set(['gltf', 'obj', 'fbx', 'dae']);
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

const baseName = (u) => decodeURIComponent(String(u).split(/[?#]/)[0]).split(/[\\/]/).pop().toLowerCase();
const text = (buf) => new TextDecoder().decode(buf);

/** Names of the files a model refers to (to fetch them from the model's folder first). */
function referencedFiles(kind, buffer) {
  try {
    if (kind === 'obj') return [...text(buffer).matchAll(/^\s*mtllib\s+(.+?)\s*$/gm)].map((m) => m[1]);
    if (kind === 'gltf' && !isGlb(buffer)) {
      const j = JSON.parse(text(buffer));
      return [...(j.buffers ?? []), ...(j.images ?? [])].map((x) => x.uri).filter((u) => u && !u.startsWith('data:'));
    }
    if (kind === 'dae') return [...text(buffer).matchAll(/<init_from>\s*([^<]+?\.(?:png|jpe?g|bmp|tga|gif|webp))\s*<\/init_from>/gi)].map((m) => m[1]);
  } catch { /* not readable as text */ }
  return [];
}

const isGlb = (buffer) => buffer.byteLength >= 4 && text(buffer.slice(0, 4)) === 'glTF';

/**
 * Resources for the loaders: files given with the model (`ctx.resources`, name -> Blob) and files
 * read from the model's folder (`ctx.readSibling(name)`, desktop). Missing images become a blank
 * pixel so a model still opens without its textures.
 */
async function resourceManager(kind, buffer, ctx, missing) {
  const files = new Map();
  // Files from the desktop program are not Blobs: read them now.
  for (const [name, f] of ctx.resources ?? []) files.set(baseName(name), f instanceof Blob ? f : new Blob([await f.arrayBuffer()]));
  const want = referencedFiles(kind, buffer);
  // MTL files refer to textures: read those too.
  const fetchOne = async (n) => {
    const k = baseName(n);
    if (files.has(k) || !ctx.readSibling) return;
    try { const b = await ctx.readSibling(n.replace(/^.*[\\/]/, '')); if (b) files.set(k, new Blob([b])); } catch { /* not there */ }
  };
  for (const n of want) await fetchOne(n);
  if (kind === 'obj') {
    for (const [k, blob] of [...files]) {
      if (!k.endsWith('.mtl')) continue;
      const mtl = await blob.text();
      for (const m of mtl.matchAll(/^\s*(?:map_\w+|bump|disp|decal|norm)\s+(?:-\w+\s+\S+\s+)*(.+?)\s*$/gim)) await fetchOne(m[1]);
    }
  }
  const urls = new Map();
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    if (/^(data|blob):/.test(url)) return url;
    const k = baseName(url);
    const blob = files.get(k);
    if (blob) {
      if (!urls.has(k)) urls.set(k, URL.createObjectURL(blob));
      return urls.get(k);
    }
    missing.add(url.split(/[\\/]/).pop());
    return /\.(png|jpe?g|gif|bmp|webp|tga|tiff?|dds|ktx2?)$/i.test(url) ? PIXEL : url;
  });
  return { manager, files, release: () => { for (const u of urls.values()) URL.revokeObjectURL(u); } };
}

async function parse(kind, buffer, name, manager, files) {
  if (kind === 'stl') {
    const { STLLoader } = await import('three/addons/loaders/STLLoader.js');
    const geo = new STLLoader().parse(buffer);
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xb8bec8, vertexColors: !!geo.hasColors }));
    mesh.name = name.replace(/\.[^.]+$/, '');
    return { root: mesh, units: null };
  }
  if (kind === 'ply') {
    const { PLYLoader } = await import('three/addons/loaders/PLYLoader.js');
    const geo = new PLYLoader().parse(buffer);
    const vc = !!geo.getAttribute('color');
    // PLYLoader indexes faces; a PLY without faces is a point cloud (laser scans).
    const obj = geo.index
      ? new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: vc ? 0xffffff : 0xb8bec8, vertexColors: vc }))
      : new THREE.Points(geo, new THREE.PointsMaterial({ size: 2, sizeAttenuation: false, vertexColors: vc, color: vc ? 0xffffff : 0xb8bec8 }));
    obj.name = name.replace(/\.[^.]+$/, '');
    return { root: obj, units: null };
  }
  if (kind === 'obj') {
    const [{ OBJLoader }, { MTLLoader }] = await Promise.all([import('three/addons/loaders/OBJLoader.js'), import('three/addons/loaders/MTLLoader.js')]);
    const loader = new OBJLoader(manager);
    const src = text(buffer);
    const lib = [...src.matchAll(/^\s*mtllib\s+(.+?)\s*$/gm)].map((m) => baseName(m[1]));
    const mtlBlob = lib.map((k) => files.get(k)).find(Boolean) ?? [...files].find(([k]) => k.endsWith('.mtl'))?.[1];
    if (mtlBlob) {
      const mats = new MTLLoader(manager).parse(await mtlBlob.text(), '');
      mats.preload();
      loader.setMaterials(mats);
    }
    return { root: loader.parse(src), units: null, mtl: !!mtlBlob, mtlWanted: lib.length > 0 };
  }
  if (kind === 'gltf') {
    const [{ GLTFLoader }, { MeshoptDecoder }, { DRACOLoader }] = await Promise.all([
      import('three/addons/loaders/GLTFLoader.js'), import('three/addons/libs/meshopt_decoder.module.js'), import('three/addons/loaders/DRACOLoader.js'),
    ]);
    const loader = new GLTFLoader(manager);
    loader.setMeshoptDecoder(MeshoptDecoder);
    // Draco-compressed meshes (KHR_draco_mesh_compression): Google's decoder (Apache-2.0, shipped
    // with three.js and bundled as assets) in a worker.
    const dracoLoader = new DRACOLoader();
    loader.setDRACOLoader(dracoLoader);
    try {
      const gltf = await new Promise((resolve, reject) => loader.parse(buffer, '', resolve, (e) => reject(e instanceof Error ? e : new Error(String(e?.message || e)))));
      return { root: gltf.scene, units: { label: 'm', perMeter: 1 } };
    } finally {
      dracoLoader.dispose();
    }
  }
  if (kind === 'fbx') {
    const { FBXLoader } = await import('three/addons/loaders/FBXLoader.js');
    const root = new FBXLoader(manager).parse(buffer, '');
    const f = Number(root.userData?.unitScaleFactor ?? 1); // centimetres per unit
    const known = [[0.1, 'mm'], [1, 'cm'], [100, 'm'], [2.54, 'in'], [30.48, 'ft']].find(([v]) => Math.abs(v - f) < 1e-6);
    return { root, units: { label: known ? known[1] : `${f} cm`, perMeter: 100 / (f || 1) } };
  }
  if (kind === 'dae') {
    const { ColladaLoader } = await import('three/addons/loaders/ColladaLoader.js');
    const res = new ColladaLoader(manager).parse(text(buffer), '');
    if (!res?.scene) throw new FormatError('This COLLADA file could not be read.');
    return { root: res.scene, units: { label: 'm', perMeter: 1 } };
  }
  if (kind === '3mf') {
    const [{ ThreeMFLoader }, fflate] = await Promise.all([import('three/addons/loaders/3MFLoader.js'), import('three/addons/libs/fflate.module.js')]);
    const root = new ThreeMFLoader(manager).parse(buffer);
    let unit = 'millimeter';
    try {
      const zip = fflate.unzipSync(new Uint8Array(buffer), { filter: (f) => /\.model$/i.test(f.name) });
      const xml = Object.values(zip).map((b) => text(b.slice(0, 4096))).join('');
      unit = /<model[^>]*\sunit="(\w+)"/.exec(xml)?.[1] ?? unit;
    } catch { /* keep the default */ }
    const U = { micron: ['µm', 1e6], millimeter: ['mm', 1000], centimeter: ['cm', 100], meter: ['m', 1], inch: ['in', 39.3701], foot: ['ft', 3.28084] }[unit] ?? ['mm', 1000];
    return { root, units: { label: U[0], perMeter: U[1] } };
  }
  throw new FormatError(`Unknown 3D format ${kind}.`);
}

/** Linear sRGB values of a three.js colour as display (sRGB) 0–1 values. */
function srgb(color) {
  const c = new THREE.Color();
  color.getRGB(c, THREE.SRGBColorSpace);
  return [c.r, c.g, c.b];
}

const TEXTURE_KEYS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap', 'bumpMap', 'specularMap'];

/**
 * Reads a mesh format into the viewer's model.
 * @param {'stl'|'obj'|'gltf'|'ply'|'fbx'|'dae'|'3mf'} kind
 */
export async function loadMeshFormat(kind, buffer, fileName, ctx = {}) {
  const missing = new Set();
  const { manager, files, release } = await resourceManager(kind, buffer, ctx, missing);
  let parsed;
  try {
    parsed = await parse(kind, buffer, fileName, manager, files);
  } catch (err) {
    release();
    if (err instanceof FormatError) throw err;
    const m = /(\S+\.bin)\b/i.exec(String(err?.message || ''));
    if (m || missing.size) throw new FormatError(`This ${kind.toUpperCase()} file refers to ${m ? m[1] : [...missing].join(', ')}, which was not found. Open the model together with its other files (select them all, or drop them together), or use a single-file format such as GLB.`);
    throw new FormatError(`This ${kind.toUpperCase()} file could not be read: ${err?.message || err}`);
  }
  // Textures load asynchronously from blob URLs; they stay valid until the model is closed.
  const root = parsed.root;
  const up = Y_UP.has(kind) ? ZUP : new THREE.Matrix4();
  root.updateMatrixWorld(true);
  // Shift: centre of the world box.
  const box = new THREE.Box3();
  root.traverse((o) => {
    if (!(o.isMesh || o.isPoints || o.isLine) || !o.geometry?.attributes?.position) return;
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    if (o.isInstancedMesh) { o.computeBoundingBox?.(); if (o.boundingBox) box.union(o.boundingBox.clone().applyMatrix4(o.matrixWorld)); return; }
    box.union(o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld));
  });
  box.applyMatrix4(up);
  if (box.isEmpty()) { release(); throw new FormatError('No 3D geometry was found in this file.'); }
  const c = box.getCenter(new THREE.Vector3());
  const span = box.getSize(new THREE.Vector3()).length();
  // Round the shift to a step that keeps the coordinates readable.
  const step = 10 ** Math.floor(Math.log10(Math.max(span, 1e-9)));
  const shift = [c.x, c.y, c.z].map((v) => Math.round(v / step) * step);
  const builder = new MergeBuilder({ shift });
  const materials = {};
  const elements = [];
  const extras = [];
  let triangles = 0, textures = 0;
  const matKey = (m, hasColors) => {
    if (TEXTURE_KEYS.some((k) => m[k])) {
      if (!materials[m.uuid]) { materials[m.uuid] = { material: m }; textures += TEXTURE_KEYS.filter((k) => m[k]).length; }
      return m.uuid;
    }
    const col = m.color ? srgb(m.color) : [0.75, 0.75, 0.75];
    const opacity = m.transparent ? m.opacity ?? 1 : 1;
    const k = `${col.map((v) => Math.round(v * 255)).join(',')},${Math.round(opacity * 255)}${hasColors ? 'v' : ''}`;
    materials[k] ??= { color: col, opacity };
    return k;
  };
  const M = new THREE.Matrix4(), IM = new THREE.Matrix4();
  const node = (o) => {
    const out = { name: o.name || (o.isMesh ? 'Mesh' : o.type === 'Group' || o.type === 'Object3D' ? 'Group' : o.type), children: [] };
    if ((o.isMesh || o.isInstancedMesh) && o.geometry?.attributes?.position) {
      const id = elements.length;
      const g = o.geometry;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      const pos = g.getAttribute('position'), nrm = g.getAttribute('normal'), uv = g.getAttribute('uv'), col = g.getAttribute('color');
      const read = (a, n) => { if (!a) return null; const out2 = new Float32Array(a.count * n); for (let i = 0; i < a.count; i++) for (let k = 0; k < n; k++) out2[i * n + k] = a.getComponent(i, k); return out2; };
      const P = read(pos, 3), N = read(nrm, 3), UV = read(uv, 2), C = col ? read(col, 3) : null;
      const index = g.index ? g.index.array : null;
      const groups = g.groups.length && mats.length > 1 ? g.groups : [{ start: 0, count: index ? index.length : pos.count, materialIndex: 0 }];
      let tri = 0;
      const names = new Set();
      for (const grp of groups) {
        const mat = mats[grp.materialIndex ?? 0] ?? mats[0];
        if (!mat || mat.visible === false) continue;
        if (mat.name) names.add(mat.name);
        const idx = index ? index.slice(grp.start, grp.start + grp.count) : Uint32Array.from({ length: Math.min(grp.count, pos.count - grp.start) }, (_, i) => grp.start + i);
        const textured = TEXTURE_KEYS.some((k) => mat[k]);
        const vc = !!(mat.vertexColors && C);
        const key = matKey(mat, vc);
        const extra = { colors: vc ? C : undefined, uvs: textured && UV ? UV : undefined };
        if (o.isInstancedMesh) {
          for (let k = 0; k < o.count; k++) {
            o.getMatrixAt(k, IM);
            M.multiplyMatrices(up, o.matrixWorld).multiply(IM);
            builder.addPlaced(id, `${g.uuid}|${grp.start}`, { pos: P, nrm: N ?? null, idx }, key, M.elements);
          }
        } else {
          M.multiplyMatrices(up, o.matrixWorld);
          builder.addMesh(id, key, P, N, idx, { matrix: M.elements, ...extra });
        }
        tri += (idx.length / 3) * (o.isInstancedMesh ? o.count : 1);
      }
      triangles += tri;
      const first = mats[0];
      elements.push({
        name: o.name || o.parent?.name || `Mesh ${id + 1}`, type: o.isInstancedMesh ? 'Instanced mesh' : 'Mesh', triangles: Math.round(tri),
        color: first?.color ? srgb(first.color) : null, materialNames: [...names],
        instances: o.isInstancedMesh ? o.count : undefined,
      });
      out.id = id;
      out.name = elements[id].name;
    } else if ((o.isPoints || o.isLine) && o.geometry?.attributes?.position) {
      // Point clouds and lines are shown but not picked.
      const g = o.geometry.clone();
      g.applyMatrix4(M.multiplyMatrices(up, o.matrixWorld));
      g.translate(-shift[0], -shift[1], -shift[2]);
      const obj = o.isPoints ? new THREE.Points(g, o.material) : new THREE.LineSegments(g, o.material);
      extras.push(obj);
      out.name = `${o.name || (o.isPoints ? 'Point cloud' : 'Lines')} (${o.geometry.attributes.position.count.toLocaleString('en-US')} ${o.isPoints ? 'points' : 'vertices'})`;
    }
    for (const ch of o.children) {
      const n = node(ch);
      if (n.id !== undefined || n.children.length || n.extra) out.children.push(n);
    }
    if (o.isPoints || o.isLine) out.extra = true;
    return out;
  };
  const tree = node(root);
  tree.name = fileName;
  tree.open = true;
  if (!elements.length && !extras.length) { release(); throw new FormatError('No 3D geometry was found in this file.'); }
  const geometry = builder.build(elements.length);
  for (const e of elements) {
    const rows = [['Node', e.name], ['Type', e.type], ['Triangles', e.triangles.toLocaleString('en-US')]];
    if (e.instances) rows.push(['Instances', String(e.instances)]);
    if (e.materialNames.length) rows.push(['Material', e.materialNames.join(', ')]);
    if (e.color) rows.push(['Colour', '#' + e.color.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')]);
    e.props = [{ title: 'Node', rows }];
    e.text = `${e.name} ${e.type} ${e.materialNames.join(' ')}`.toLowerCase();
  }
  const LABEL = { stl: 'STL', obj: 'OBJ (Wavefront)', gltf: isGlb(buffer) ? 'glTF binary (GLB)' : 'glTF', ply: 'PLY', fbx: 'FBX', dae: 'COLLADA (DAE)', '3mf': '3MF' };
  const notes = [];
  if (missing.size) notes.push(`Not found (open them together with the model): ${[...missing].slice(0, 8).join(', ')}${missing.size > 8 ? '…' : ''}`);
  if (parsed.mtlWanted && !parsed.mtl) notes.push('The material file (MTL) was not found: default colours are used.');
  return {
    format: kind.toUpperCase(), formatLabel: LABEL[kind], fileName,
    units: parsed.units ?? { label: '', perMeter: null },
    upAxis: Y_UP.has(kind) ? 'y' : 'z',
    elements, tree, geometry, materials, extras,
    groupKeys: ['type'],
    info: [
      ['Format', LABEL[kind]],
      ['Units', parsed.units ? parsed.units.label : 'not stored in the file'],
      ['Meshes', String(elements.length)],
      ['Triangles', Math.round(triangles).toLocaleString('en-US')],
      ['Materials', String(Object.keys(materials).length)],
      ...(textures ? [['Textures', String(textures)]] : []),
      ...(extras.length ? [['Point clouds / lines', String(extras.length)]] : []),
      ...(Y_UP.has(kind) ? [['Axes', 'Y up in the file, shown Z up']] : []),
    ],
    notes,
    dispose: release,
    summary: () => meshSummary(LABEL[kind], fileName, elements, parsed.units, triangles),
  };
}

function meshSummary(label, fileName, elements, units, triangles) {
  const out = [`${label} 3D model "${fileName}". Units: ${units ? units.label : 'not stored in the file'}. ${elements.length} meshes, ${Math.round(triangles)} triangles. Mesh formats carry no engineering properties; names and materials only.`];
  out.push('', 'Meshes ([#id] name — material, triangles) — first 400:');
  for (const [i, e] of elements.slice(0, 400).entries()) out.push(`[#${i}] ${e.name}${e.materialNames.length ? ` — ${e.materialNames.join(', ')}` : ''}, ${e.triangles} triangles`);
  return out.join('\n');
}
