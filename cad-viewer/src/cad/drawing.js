// Normalizes a DwgDatabase (from libredwg-web) or the DXF parser's equivalent
// into a Drawing: resolved layers, linetypes, blocks and spaces.
import { aciToRgb, FOREGROUND } from './aci.js';

// DWG stores lineweights as an index into this table (1/100 mm).
const DWG_LW = [0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100, 106, 120, 140, 158, 200, 211];
const LW_VALUES = new Set(DWG_LW);

export const LW_BYLAYER = -1;
export const LW_BYBLOCK = -2;
export const LW_DEFAULT = -3;

/** Converts a raw lineweight to mm, or one of the LW_* markers. */
export function lineweightToMm(raw, source) {
  if (raw === undefined || raw === null) return LW_BYLAYER;
  if (source === 'dwg') {
    if (raw === 29) return LW_BYLAYER;
    if (raw === 30) return LW_BYBLOCK;
    if (raw === 31) return LW_DEFAULT;
    if (raw >= 0 && raw < DWG_LW.length) return DWG_LW[raw] / 100;
    if (LW_VALUES.has(raw)) return raw / 100;
    return LW_DEFAULT;
  }
  if (raw === -1) return LW_BYLAYER;
  if (raw === -2) return LW_BYBLOCK;
  if (raw < 0) return LW_DEFAULT;
  return raw / 100;
}

export const UNIT_NAMES = {
  0: '', 1: 'in', 2: 'ft', 3: 'mi', 4: 'mm', 5: 'cm', 6: 'm', 7: 'km', 8: 'µin', 9: 'mil', 10: 'yd',
  11: 'Å', 12: 'nm', 13: 'µm', 14: 'dm', 15: 'dam', 16: 'hm', 17: 'Gm', 18: 'AU', 19: 'ly', 20: 'pc',
};

/** Millimetres per drawing unit, used for plot scales. */
export const UNIT_TO_MM = { 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000, 7: 1e6, 10: 914.4, 14: 100 };

function layerColor(l, source) {
  // DWG layers keep their ACI in colorIndex (256 means "true color in `color`").
  if (source === 'dwg') {
    if (l.colorIndex >= 1 && l.colorIndex <= 255) return aciToRgb(l.colorIndex);
    if (typeof l.color === 'number') return l.color === 0xffffff ? FOREGROUND : l.color;
    return FOREGROUND;
  }
  if (typeof l.color === 'number') return l.color === 0xffffff ? FOREGROUND : l.color;
  return aciToRgb(l.colorIndex);
}

/**
 * @param {object} db DwgDatabase-like object
 * @param {'dwg'|'dxf'} source
 */
export function buildDrawing(db, source, fileName) {
  const layers = new Map();
  for (const l of db.tables?.LAYER?.entries ?? []) {
    let lw = lineweightToMm(l.lineweight, source);
    if (lw < 0) lw = LW_DEFAULT;
    layers.set(l.name, {
      name: l.name,
      rgb: layerColor(l, source),
      on: !l.off && !(l.colorIndex < 0),
      frozen: !!l.frozen,
      locked: !!l.locked,
      lw,
      ltype: l.lineType || 'Continuous',
      plot: l.plotFlag !== 0,
      visible: !l.off && !l.frozen,
      count: 0,
    });
  }
  if (!layers.has('0')) {
    layers.set('0', { name: '0', rgb: FOREGROUND, on: true, frozen: false, locked: false, lw: LW_DEFAULT, ltype: 'Continuous', plot: true, visible: true, count: 0 });
  }

  const ltypes = new Map();
  for (const t of db.tables?.LTYPE?.entries ?? []) {
    const pattern = (t.pattern ?? []).map((p) => p.elementLength ?? 0);
    ltypes.set(t.name.toUpperCase(), { name: t.name, description: t.description || '', pattern });
  }

  const blocks = new Map();
  const blockByHandle = new Map();
  for (const b of db.tables?.BLOCK_RECORD?.entries ?? []) {
    const block = { name: b.name, handle: b.handle, base: b.basePoint ?? { x: 0, y: 0, z: 0 }, flags: b.flags ?? 0, entities: b.entities ?? [] };
    blocks.set(b.name, block);
    if (b.handle) blockByHandle.set(b.handle, block);
  }

  const modelBlock = [...blocks.values()].find((b) => /^\*model_space$/i.test(b.name));
  let modelEntities;
  if (modelBlock && modelBlock.entities.length) {
    modelEntities = modelBlock.entities;
  } else {
    // Older files: anything not owned by a paper space block is model space.
    const paperHandles = new Set([...blocks.values()].filter((b) => /^\*paper_space/i.test(b.name)).map((b) => b.handle));
    modelEntities = (db.entities ?? []).filter((e) => !e.isInPaperSpace && !paperHandles.has(e.ownerBlockRecordSoftId));
  }

  // Layouts (paper space), sorted by tab order, skipping "Model".
  const layouts = [];
  for (const lo of db.objects?.LAYOUT ?? []) {
    if (/^model$/i.test(lo.layoutName)) continue;
    const block = blockByHandle.get(lo.paperSpaceTableId);
    if (!block) continue;
    const entities = block.entities.length
      ? block.entities
      : (db.entities ?? []).filter((e) => e.ownerBlockRecordSoftId === block.handle);
    if (!entities.length) continue;
    layouts.push({ name: lo.layoutName, tabOrder: lo.tabOrder ?? 0, entities, limits: [lo.minLimit, lo.maxLimit] });
  }
  layouts.sort((a, b) => a.tabOrder - b.tabOrder);

  // Tables are drawn from their anonymous *T block. Newer DWG versions may not link the
  // block, so unlinked tables take the unclaimed *T blocks in handle order.
  const tableBlocks = new Map();
  const allEntities = [...modelEntities, ...layouts.flatMap((l) => l.entities)];
  const tables = allEntities.filter((e) => e.type === 'ACAD_TABLE');
  const claimed = new Set();
  for (const e of tables) {
    const b = (e.blockName && blocks.get(e.blockName)) || (e.blockRecordHandle && blockByHandle.get(e.blockRecordHandle));
    if (b) { tableBlocks.set(e, b.name); claimed.add(b.name); }
  }
  const byHandle = (a, b) => parseInt(a.handle || '0', 16) - parseInt(b.handle || '0', 16);
  const free = [...blocks.values()].filter((b) => /^\*T\d+$/i.test(b.name) && !claimed.has(b.name)).sort(byHandle);
  for (const e of tables.filter((t) => !tableBlocks.has(t)).sort(byHandle)) {
    const b = free.shift();
    if (b) tableBlocks.set(e, b.name);
  }

  const header = db.header ?? {};
  return {
    tableBlocks,
    source,
    fileName,
    header,
    version: header.ACADVER || '',
    units: header.INSUNITS ?? 0,
    ltscale: (header.LTSCALE || 1) * (header.CELTSCALE || 1),
    layers,
    ltypes,
    blocks,
    blockByHandle,
    modelEntities,
    layouts,
  };
}
