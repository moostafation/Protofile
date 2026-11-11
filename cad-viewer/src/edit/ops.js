// Edit operations on a drawing's entities, each one undoable step of the EditDoc:
// add, erase, move/rotate/scale/mirror (transform), copy, explode, offset, property changes.
// `ctx` = { doc, drawing, container (the space's entity list), measure? }.
import { cloneData } from './model.js';
import { transformEntity, explodeEntity, offsetEntity, assignHandles, retextDimension } from './entities.js';

/** Block holding a table's graphics. */
export function tableBlockName(drawing, e) {
  return e.blockName || drawing.tableBlocks?.get(e) || null;
}

/** How many entities (anywhere) reference each dimension or table block. */
function blockRefCounts(drawing, names) {
  const counts = new Map([...names].map((n) => [n, 0]));
  const seen = new Set();
  const visit = (list) => {
    if (!list || seen.has(list)) return;
    seen.add(list);
    for (const e of list) {
      const n = e.type === 'ACAD_TABLE' ? tableBlockName(drawing, e) : e.type?.includes('DIMENSION') ? e.name : e.type === 'INSERT' ? (e.blockName ?? e.name) : null;
      if (n && counts.has(n)) counts.set(n, counts.get(n) + 1);
    }
  };
  visit(drawing.modelEntities);
  for (const l of drawing.layoutDefs ?? drawing.layouts) visit(l.entities);
  for (const b of drawing.blocks.values()) visit(b.entities);
  return counts;
}

/** Next free anonymous block name with the prefix (*D, *T, *U). */
function nextAnonymous(drawing, prefix) {
  let n = 0;
  const re = new RegExp(`^\\${prefix}(\\d+)$`, 'i');
  for (const k of drawing.blocks.keys()) { const m = re.exec(k); if (m) n = Math.max(n, +m[1]); }
  return `${prefix}${n + 1}`;
}

/** Copies a block definition under a new anonymous name (one undoable step part). */
function duplicateBlock(tx, ctx, name, prefix) {
  const { drawing, doc } = ctx;
  const src = drawing.blocks.get(name);
  if (!src) return null;
  const newName = nextAnonymous(drawing, prefix);
  const block = { name: newName, handle: doc.newHandle(), base: { ...(src.base ?? { x: 0, y: 0, z: 0 }) }, flags: (src.flags ?? 0) | 1, entities: src.entities.map((e) => assignHandles(cloneData(e), doc)) };
  tx.custom({
    redo: (c) => { drawing.blocks.set(newName, block); c.blocks.add(newName); },
    undo: (c) => { drawing.blocks.delete(newName); c.blocks.add(newName); },
  });
  return block;
}

function envFor(ctx, tx, shared) {
  const { drawing } = ctx;
  return {
    measure: ctx.measure,
    tableBlock: (e) => tableBlockName(drawing, e),
    // Dimension and table graphics live in their own (anonymous) block: transform it too.
    blockXform: (name, M, owner, value) => {
      let block = name && drawing.blocks.get(name);
      if (!block) return;
      if (shared?.get(name) > 1) {
        const prefix = owner.type === 'ACAD_TABLE' ? '*T' : '*D';
        block = duplicateBlock(tx, ctx, name, prefix);
        if (owner.type === 'ACAD_TABLE') { owner.blockName = block.name; drawing.tableBlocks?.set(owner, block.name); } else owner.name = block.name;
        shared.set(name, shared.get(name) - 1);
      }
      for (const be of block.entities) {
        tx.modify(be, (x) => {
          transformEntity(x, M, { measure: ctx.measure });
          // A scaled dimension shows its new measurement.
          if (value && x.type === 'MTEXT') x.text = retextDimension(x.text, value.from, value.to);
          if (value && x.type === 'TEXT') x.text = retextDimension(x.text, value.from, value.to);
        }, { container: block.entities, block: block.name });
      }
    },
  };
}

function sharedBlocks(ctx, ents) {
  const names = new Set();
  for (const e of ents) {
    if (e.type?.includes('DIMENSION') && e.name) names.add(e.name);
    if (e.type === 'ACAD_TABLE') { const n = tableBlockName(ctx.drawing, e); if (n) names.add(n); }
  }
  return names.size ? blockRefCounts(ctx.drawing, names) : null;
}

/** Adds new entities to the space (they get handles here). */
export function addEntities(ctx, ents, label = 'Draw') {
  const { doc, container } = ctx;
  return doc.run(label, (tx) => {
    for (const e of ents) {
      if (!e.handle) assignHandles(e, doc);
      tx.add(container, e);
    }
    return ents;
  });
}

export function eraseEntities(ctx, ents) {
  if (!ents.length) return;
  ctx.doc.run(`Erase ${ents.length}`, (tx) => tx.remove(ctx.container, ents));
}

/**
 * Applies the affine matrix M (world coordinates) to entities.
 * Returns the number of entities that could not be transformed.
 */
export function transformEntities(ctx, ents, M, label = 'Move') {
  let failed = 0;
  ctx.doc.run(label, (tx) => {
    const env = envFor(ctx, tx, sharedBlocks(ctx, ents));
    for (const e of ents) {
      let res = true;
      // Replacements (circle -> ellipse) only happen for non-uniform scales, which the tools never use.
      tx.modify(e, (x) => { res = transformEntity(x, M, env); }, { container: ctx.container });
      if (!res || res.replace) failed++;
    }
  });
  return failed;
}

/** Copies entities, transformed by M. Returns the copies. */
export function copyEntities(ctx, ents, M, label = 'Copy') {
  const { doc, drawing, container } = ctx;
  return doc.run(label, (tx) => {
    const out = [];
    for (const e of ents) {
      const copy = assignHandles(cloneData(e), doc);
      // Dimensions and tables get their own copy of their graphics block.
      if (e.type?.includes('DIMENSION') && e.name && drawing.blocks.has(e.name)) copy.name = duplicateBlock(tx, ctx, e.name, '*D').name;
      if (e.type === 'ACAD_TABLE') {
        const n = tableBlockName(drawing, e);
        if (n) { copy.blockName = duplicateBlock(tx, ctx, n, '*T').name; drawing.tableBlocks?.set(copy, copy.blockName); }
      }
      tx.add(container, copy);
      const env = envFor(ctx, tx, null);
      tx.modify(copy, (x) => transformEntity(x, M, env), { container });
      out.push(copy);
    }
    return out;
  });
}

/** Explodes entities. Returns { created, skipped } (skipped: entities that cannot be exploded). */
export function explodeEntities(ctx, ents) {
  const { doc, drawing, container } = ctx;
  let skipped = 0;
  const created = [];
  // Dimensions and tables inside an exploded block: their graphics block is copied and moved too.
  const moves = [];
  const env = { drawing, measure: ctx.measure, tableBlock: (e) => tableBlockName(drawing, e), blockXform: (name, M, owner) => { if (name) moves.push({ name, M, owner }); } };
  const parts = new Map();
  for (const e of ents) {
    env.reasons = null;
    const before = moves.length;
    const p = explodeEntity(e, env);
    if (p && p.length) parts.set(e, p); else { skipped++; moves.length = before; }
    if (env.reasons) for (const r of env.reasons) (env.allReasons ??= new Set()).add(r);
  }
  const reasons = [...(env.allReasons ?? [])];
  if (!parts.size) return { created, skipped, reasons };
  doc.run(`Explode ${parts.size}`, (tx) => {
    for (const { name, M, owner } of moves) {
      const table = owner.type === 'ACAD_TABLE';
      const block = duplicateBlock(tx, ctx, name, table ? '*T' : '*D');
      if (!block) continue;
      for (const be of block.entities) transformEntity(be, M, { measure: ctx.measure });
      if (table) { owner.blockName = block.name; drawing.tableBlocks?.set(owner, block.name); } else owner.name = block.name;
    }
    tx.remove(container, [...parts.keys()]);
    for (const p of parts.values()) {
      for (const n of p) {
        assignHandles(n, doc);
        tx.add(container, n);
        created.push(n);
      }
    }
  });
  return { created, skipped, reasons };
}

/** Offset copy of one entity through the point `side` (world). Returns the new entity or null. */
export function offsetOne(ctx, e, dist, side) {
  const n = offsetEntity(e, dist, side);
  if (!n) return null;
  assignHandles(n, ctx.doc);
  ctx.doc.run('Offset', (tx) => tx.add(ctx.container, n));
  return n;
}

/** Changes entities with fn(entity) as one undoable step. */
export function modifyEntities(ctx, ents, fn, label = 'Properties') {
  if (!ents.length) return;
  ctx.doc.run(label, (tx) => {
    for (const e of ents) tx.modify(e, fn, { container: ctx.container });
  });
}
