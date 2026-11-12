// The editable document: changes to entities, layers and blocks of a Drawing, recorded as
// transactions for undo/redo. Entities keep their identity (edits mutate them and keep
// snapshots), so scene items, selections and the table-block map stay valid; listeners get a
// summary of what changed and update only those parts of the scenes.
import { layerRgb, LW_DEFAULT } from '../cad/drawing.js';

/** Deep copy of plain entity data. */
export function cloneData(v) {
  return typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v));
}

function restore(ent, snap) {
  for (const k of Object.keys(ent)) delete ent[k];
  Object.assign(ent, cloneData(snap));
}

/** Calls fn(entity, container) for every entity of the drawing: model, layouts, blocks (and attributes). */
export function forEachEntity(drawing, fn) {
  const seen = new Set();
  const visit = (list) => {
    if (!list || seen.has(list)) return;
    seen.add(list);
    for (const e of list) {
      fn(e, list);
      if (e.attribs?.length) for (const a of e.attribs) fn(a, e.attribs);
    }
  };
  visit(drawing.modelEntities);
  for (const l of drawing.layoutDefs ?? drawing.layouts) visit(l.entities);
  for (const b of drawing.blocks.values()) visit(b.entities);
}

const isHex = (h) => typeof h === 'string' && /^[0-9A-Fa-f]{1,15}$/.test(h);

/** Next free handle after every handle used in the drawing. */
function handleSeed(drawing) {
  let max = 0;
  const see = (h) => { if (isHex(h)) { const v = parseInt(h, 16); if (v > max) max = v; } };
  forEachEntity(drawing, (e) => {
    see(e.handle);
    for (const v of e.vertices ?? []) see(v.handle);
  });
  for (const b of drawing.blocks.values()) see(b.handle);
  for (const l of drawing.layers.values()) see(l.handle);
  see(drawing.header?.HANDSEED);
  return max + 1;
}

export const RESERVED_LAYERS = new Set(['0', 'DEFPOINTS']);

/** Characters AutoCAD does not allow in layer and block names. */
export const BAD_NAME = /[<>/\\":;?*|=`]/;

export class EditDoc {
  constructor(drawing) {
    this.d = drawing;
    this.undoStack = [];
    this.redoStack = [];
    this.savedTop = null;
    this.owner = new WeakMap(); // entity -> the array that holds it (null once removed)
    this.listeners = new Set();
    this.nextHandle = Math.max(handleSeed(drawing), (drawing.raw?.maxHandle ?? 0) + 1);
    this.version = 0;
    this.dirty = new WeakSet();
    this.dirtyBlocks = new Set();
    this.dirtyLayers = false;
  }

  /** True when there are changes since opening or the last save. */
  get modified() {
    return (this.undoStack.at(-1) ?? null) !== this.savedTop;
  }

  /** Marks the state saved; `top` is the undo step that was on top when the save started. */
  markSaved(top = this.undoStack.at(-1) ?? null) {
    this.savedTop = top;
    this.emit({ ents: new Set(), blocks: new Set(), layers: [], saved: true });
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  get undoLabel() { return this.undoStack.at(-1)?.label ?? ''; }
  get redoLabel() { return this.redoStack.at(-1)?.label ?? ''; }

  newHandle() {
    return (this.nextHandle++).toString(16).toUpperCase();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(change) {
    this.version++;
    // What changed since opening (also when undone later): saving re-writes these, and keeps the
    // original records of everything else (DXF sources).
    for (const e of change.ents ?? []) this.dirty.add(e);
    for (const b of change.blocks ?? []) this.dirtyBlocks.add(b);
    if (change.layers?.length) this.dirtyLayers = true;
    for (const fn of this.listeners) fn(change);
  }

  /** Starts a transaction; ops apply immediately, commit() makes them one undo step. */
  begin(label) {
    return new Transaction(this, label);
  }

  /** Runs fn(tx) as one undoable step; an exception rolls the changes back. */
  run(label, fn) {
    const tx = this.begin(label);
    try {
      const result = fn(tx);
      tx.commit();
      return result;
    } catch (err) {
      tx.rollback();
      throw err;
    }
  }

  undo() {
    const tx = this.undoStack.pop();
    if (!tx) return false;
    const change = newChange();
    for (let i = tx.ops.length - 1; i >= 0; i--) tx.ops[i].undo(change);
    this.redoStack.push(tx);
    this.emit(change);
    return tx.label;
  }

  redo() {
    const tx = this.redoStack.pop();
    if (!tx) return false;
    const change = newChange();
    for (const op of tx.ops) op.redo(change);
    this.undoStack.push(tx);
    this.emit(change);
    return tx.label;
  }

  // ------------------------------------------------------------ layers
  /** Number of entities on a layer, anywhere in the drawing (blocks included). */
  layerUsage(name) {
    let n = 0;
    forEachEntity(this.d, (e) => { if ((e.layer ?? '0') === name) n++; });
    return n;
  }

  checkLayerName(name, except) {
    const n = (name ?? '').trim();
    if (!n) return 'The name is empty.';
    if (BAD_NAME.test(n)) return 'Names cannot contain < > / \\ " : ; ? * | = `';
    if (n.length > 255) return 'The name is too long.';
    for (const k of this.d.layers.keys()) if (k !== except && k.toLowerCase() === n.toLowerCase()) return `A layer named "${k}" already exists.`;
    return null;
  }

  newLayer(name, aci = 7) {
    const err = this.checkLayerName(name);
    if (err) throw new Error(err);
    const layer = { name, rgb: layerRgb(aci, null), aci, trueColor: null, on: true, frozen: false, locked: false, lw: LW_DEFAULT, ltype: 'Continuous', plot: true, visible: true, count: 0 };
    this.run(`New layer ${name}`, (tx) => tx.custom({
      redo: (c) => { this.d.layers.set(name, layer); c.layers.push({ kind: 'add', name }); },
      undo: (c) => { this.d.layers.delete(name); c.layers.push({ kind: 'delete', name }); },
    }));
    return layer;
  }

  renameLayer(from, to) {
    to = to.trim();
    // Layer names are case-insensitive (AutoCAD): "walls" finds "WALLS".
    if (!this.d.layers.has(from)) from = [...this.d.layers.keys()].find((k) => k.toLowerCase() === String(from).toLowerCase()) ?? from;
    if (!this.d.layers.has(from)) throw new Error(`There is no layer "${from}".`);
    if (from === to) return;
    if (RESERVED_LAYERS.has(from.toUpperCase())) throw new Error(`Layer "${from}" cannot be renamed.`);
    const err = this.checkLayerName(to, from);
    if (err) throw new Error(err);
    const d = this.d;
    const swap = (a, b, c) => {
      const layer = d.layers.get(a);
      // Keep the panel order stable: rebuild the map with the new key in place.
      const entries = [...d.layers.entries()].map(([k, v]) => (k === a ? [b, v] : [k, v]));
      d.layers.clear();
      for (const [k, v] of entries) d.layers.set(k, v);
      layer.name = b;
      forEachEntity(d, (e) => { if (e.layer === a) e.layer = b; });
      if (d.header.CLAYER === a) d.header.CLAYER = b;
      c.layers.push({ kind: 'rename', from: a, to: b });
    };
    this.run(`Rename layer ${from}`, (tx) => tx.custom({ redo: (c) => swap(from, to, c), undo: (c) => swap(to, from, c) }));
  }

  setLayerColor(name, aci, trueColor = null) {
    const layer = this.d.layers.get(name);
    if (!layer) return;
    const before = { aci: layer.aci, trueColor: layer.trueColor, rgb: layer.rgb };
    const after = { aci, trueColor, rgb: layerRgb(aci, trueColor) };
    const set = (v, c) => { Object.assign(layer, v); c.layers.push({ kind: 'color', name, rgb: v.rgb }); };
    this.run(`Layer ${name} colour`, (tx) => tx.custom({ redo: (c) => set(after, c), undo: (c) => set(before, c) }));
  }

  setLayerLock(name, locked) {
    const layer = this.d.layers.get(name);
    if (!layer || layer.locked === locked) return;
    const set = (v, c) => { layer.locked = v; c.layers.push({ kind: 'lock', name }); };
    this.run(`${locked ? 'Lock' : 'Unlock'} layer ${name}`, (tx) => tx.custom({ redo: (c) => set(locked, c), undo: (c) => set(!locked, c) }));
  }

  get currentLayer() {
    const n = this.d.header.CLAYER;
    return n && this.d.layers.has(n) ? n : '0';
  }

  setCurrentLayer(name) {
    if (!this.d.layers.has(name) || name === this.currentLayer) return;
    const before = this.d.header.CLAYER;
    const set = (v, c) => { this.d.header.CLAYER = v; c.layers.push({ kind: 'current', name: v }); };
    this.run(`Current layer ${name}`, (tx) => tx.custom({ redo: (c) => set(name, c), undo: (c) => set(before, c) }));
  }

  /** Deletes a layer that holds no entities (not 0, Defpoints or the current layer). */
  deleteLayer(name) {
    if (RESERVED_LAYERS.has(name.toUpperCase())) throw new Error(`Layer "${name}" cannot be deleted.`);
    if (name === this.currentLayer) throw new Error('The current layer cannot be deleted. Make another layer current first.');
    const n = this.layerUsage(name);
    if (n) throw new Error(`Layer "${name}" is not empty (${n} object${n > 1 ? 's' : ''}).`);
    const layer = this.d.layers.get(name);
    if (!layer) return;
    const entries = [...this.d.layers.entries()];
    this.run(`Delete layer ${name}`, (tx) => tx.custom({
      redo: (c) => { this.d.layers.delete(name); c.layers.push({ kind: 'delete', name }); },
      undo: (c) => {
        this.d.layers.clear();
        for (const [k, v] of entries) this.d.layers.set(k, v);
        c.layers.push({ kind: 'add', name });
      },
    }));
  }
}

function newChange() {
  return { ents: new Set(), blocks: new Set(), layers: [] };
}

class Transaction {
  constructor(doc, label) {
    this.doc = doc;
    this.label = label;
    this.ops = [];
    this.change = newChange();
    this.done = false;
  }

  push(op) {
    op.redo(this.change);
    this.ops.push(op);
    return op;
  }

  /** Adds an entity to a container (model/layout entity list or block entities). */
  add(container, ent, { block } = {}) {
    const doc = this.doc;
    this.push({
      redo(c) { container.push(ent); doc.owner.set(ent, container); c.ents.add(ent); if (block) c.blocks.add(block); },
      undo(c) {
        const i = container.lastIndexOf(ent);
        if (i >= 0) container.splice(i, 1);
        doc.owner.set(ent, null);
        c.ents.add(ent);
        if (block) c.blocks.add(block);
      },
    });
    return ent;
  }

  /** Removes entities from a container (one pass, so large selections stay fast). */
  remove(container, ents, { block } = {}) {
    const doc = this.doc;
    const set = new Set(ents);
    let removed = []; // [index, entity] in ascending order
    this.push({
      redo(c) {
        removed = [];
        let w = 0;
        for (let r = 0; r < container.length; r++) {
          const e = container[r];
          if (set.has(e)) { removed.push([r, e]); doc.owner.set(e, null); c.ents.add(e); } else container[w++] = e;
        }
        container.length = w;
        if (block) c.blocks.add(block);
      },
      undo(c) {
        for (const [i, e] of removed) { container.splice(i, 0, e); doc.owner.set(e, container); c.ents.add(e); }
        if (block) c.blocks.add(block);
      },
    });
  }

  /**
   * Changes an entity in place: `fn(ent)` mutates it; snapshots before and after make it
   * undoable. `container` records where the entity lives; `block` names the block it is in.
   */
  modify(ent, fn, { container, block } = {}) {
    const doc = this.doc;
    const before = cloneData(ent);
    try {
      fn(ent);
    } catch (err) {
      restore(ent, before); // a half-applied change never stays behind
      throw err;
    }
    const after = cloneData(ent);
    if (container && doc.owner.get(ent) === undefined) doc.owner.set(ent, container);
    const op = {
      redo(c) { c.ents.add(ent); if (block) c.blocks.add(block); },
      undo(c) { restore(ent, before); c.ents.add(ent); if (block) c.blocks.add(block); },
    };
    // The first redo is the mutation that already happened; later redos restore `after`.
    let first = true;
    const redo = op.redo;
    op.redo = (c) => { if (!first) restore(ent, after); first = false; redo(c); };
    return this.push(op);
  }

  /** Any other undoable change: { redo(change), undo(change) }. */
  custom(op) {
    return this.push(op);
  }

  commit() {
    if (this.done) return;
    this.done = true;
    if (!this.ops.length) return;
    this.doc.undoStack.push(this);
    this.doc.redoStack.length = 0;
    this.doc.emit(this.change);
  }

  rollback() {
    if (this.done) return;
    this.done = true;
    const c = newChange();
    for (let i = this.ops.length - 1; i >= 0; i--) this.ops[i].undo(c);
    if (this.ops.length) this.doc.emit(c);
  }
}
