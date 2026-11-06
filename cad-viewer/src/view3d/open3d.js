// Entry point of the 3D formats (loaded on demand by the format registry): reads a file into the
// viewer's model { format, units, elements, tree, geometry, materials, info, … }.
import { loadIfc } from './ifc.js';
import { loadMeshFormat } from './mesh-formats.js';
import { buildPcfModel } from './pcf-model.js';
import { workerClient } from './worker-client.js';
import { FormatError } from '../formats/errors.js';

const OCCT_LABEL = { step: 'STEP', iges: 'IGES', brep: 'BREP (OpenCascade)' };

async function loadOcct(kind, buffer, fileName, ctx) {
  ctx.onProgress?.(`Reading ${OCCT_LABEL[kind]}… (large assemblies can take a while)`);
  const client = workerClient(new Worker(new URL('./occt-worker.js', import.meta.url), { type: 'module' }), ctx.signal);
  let res;
  try {
    res = await client.call('load', { format: kind, buffer }, [buffer]);
  } finally {
    client.dispose(); // nothing more to ask: free OpenCascade's memory
  }
  const units = kind === 'brep' ? { label: 'mm', perMeter: 1000, assumed: true } : { label: 'mm', perMeter: 1000 };
  const elements = res.elements.map((e) => {
    const rows = [['Name', e.name], ['Assembly', e.assembly || '-'], ['Triangles', e.triangles.toLocaleString('en-US')], ['B-rep faces', String(e.faces)],
      ['Colour', '#' + e.color.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')]];
    return { ...e, props: [{ title: 'Part', rows }], text: `${e.name} ${e.assembly}`.toLowerCase() };
  });
  res.tree.open = true;
  const tri = elements.reduce((s, e) => s + e.triangles, 0);
  return {
    format: kind.toUpperCase(), formatLabel: OCCT_LABEL[kind], fileName, units, upAxis: 'z',
    elements, tree: res.tree, geometry: res.geometry, materials: res.materials,
    groupKeys: ['assembly'],
    info: [
      ['Format', OCCT_LABEL[kind]],
      ['Units', kind === 'brep' ? 'mm (assumed; BREP files store no unit)' : 'mm (converted from the file\'s unit)'],
      ['Parts', String(elements.length)],
      ['Triangles', tri.toLocaleString('en-US')],
      ['Read in', `${(res.times.total / 1000).toFixed(1)} s`],
    ],
    summary: () => {
      const out = [`${OCCT_LABEL[kind]} CAD model "${fileName}", units mm. ${elements.length} parts (meshes), ${tri} triangles.`, '', 'Assembly tree:'];
      const walk = (n, d) => {
        if (out.length > 600) return;
        out.push(`${'  '.repeat(d)}${n.id !== undefined ? `[#${n.id}] ` : ''}${n.name}`);
        for (const c of n.children ?? []) walk(c, d + 1);
      };
      walk(res.tree, 0);
      return out.join('\n');
    },
  };
}

/** IFCZIP: the .ifc file inside a zip archive (other files are passed through). */
async function unzipIfc(buffer) {
  const b = new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength));
  if (!(b[0] === 0x50 && b[1] === 0x4b && b[2] === 3 && b[3] === 4)) return buffer;
  const { unzipSync } = await import('three/addons/libs/fflate.module.js');
  const files = unzipSync(new Uint8Array(buffer), { filter: (f) => /\.ifc$/i.test(f.name) });
  const first = Object.values(files)[0];
  if (!first) throw new FormatError('This IFCZIP archive contains no .ifc file.');
  return first.buffer.byteLength === first.byteLength ? first.buffer : first.slice().buffer;
}

/**
 * @param {'ifc'|'step'|'iges'|'brep'|'pcf'|'stl'|'obj'|'gltf'|'ply'|'fbx'|'dae'|'3mf'} kind
 * @param {ArrayBuffer} buffer
 * @param {string} fileName
 * @param {{ signal?: AbortSignal, onProgress?(text: string): void, resources?: Map<string, Blob>, readSibling?(name: string): Promise<ArrayBuffer|null> }} ctx
 */
export async function open3d(kind, buffer, fileName, ctx = {}) {
  if (kind === 'pcf') return buildPcfModel(buffer, fileName);
  if (kind === 'ifc') return loadIfc(await unzipIfc(buffer), fileName, ctx);
  if (OCCT_LABEL[kind]) return loadOcct(kind, buffer, fileName, ctx);
  if (['stl', 'obj', 'gltf', 'ply', 'fbx', 'dae', '3mf'].includes(kind)) return loadMeshFormat(kind, buffer, fileName, ctx);
  throw new FormatError(`Unknown 3D format ${kind}.`);
}
