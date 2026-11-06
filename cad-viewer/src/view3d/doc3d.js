// An open 3D model in the app: the shared 3D viewport, the model tree (visibility, isolate,
// zoom-to), selection and properties, search, the bill of materials (PCF) or element list (IFC),
// the section panel, the AI assistant's view of the model and the print snapshot.
import { SceneModel } from './scene-model.js';
import { Viewer3D, formatValue } from './viewer3d.js';
import { pcfBom, pcfBomCsv, bomKey } from '../formats/pcf.js';

const $ = (s, r = document) => r.querySelector(s);
const MAX_CHILDREN = 400;

let viewer = null;
/**
 * The 3D viewport is created once (one WebGL context) and shows one model at a time. Throws when
 * WebGL is not available (checked before the open document is replaced).
 */
export function sharedViewer() {
  viewer ??= new Viewer3D($('#viewport3d'));
  return viewer;
}

const csvCell = (v) => { const s = String(v ?? ''); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

export class Doc3D {
  /**
   * @param model format adapter model
   * @param ui { t, toast, icon, escapeHtml, theme, onSelection(), onStatus(point|null), onTool() }
   */
  constructor(model, ui) {
    this.model = model;
    this.ui = ui;
    this.viewer = sharedViewer();
    this.sm = new SceneModel(model);
    for (const x of model.extras ?? []) this.sm.group.add(x);
    this.selection = [];
    this.highlights = [];
    this.hidden = new Set(model.initialHidden ?? []);
    this.sm.setHidden(this.hidden);
    this.listeners = new AbortController();
    this.viewer.events = {
      onSelect: (id, ev) => this.onPick(id, ev),
      onCursor: (p) => ui.onStatus?.(p ? this.fileCoords(p) : null),
      onMeasure: () => ui.onMeasure?.(),
    };
    this.viewer.setTheme(ui.theme);
    this.viewer.setModel(this.sm, model.units?.label ?? '');
    this.viewer.setTool('select');
    this.buildTreeIndex();
    this.wire();
    this.renderTree();
    this.renderBom();
    this.updateSectionUi();
    for (const n of model.notes ?? []) ui.toast(n, false, 8000);
  }

  get fileName() { return this.model.fileName; }
  get units() { return this.model.units?.label ?? ''; }
  get shift() { return this.model.geometry.shift; }
  fileCoords(p) { const s = this.shift; return [p.x + s[0], p.y + s[1], p.z + s[2]]; }

  dispose() {
    this.listeners.abort();
    this.viewer.setModel(null);
    this.viewer.renderer.renderLists.dispose();
    this.sm.dispose();
    for (const x of this.model.extras ?? []) { x.geometry?.dispose(); x.material?.dispose?.(); }
    this.model.dispose?.();
    $('#modelTree').innerHTML = '';
    $('#bomTable').innerHTML = '';
    $('#sectionPanel').hidden = true;
  }

  // ------------------------------------------------------------------ view
  setTheme(theme) { this.viewer.setTheme(theme); }
  zoomExtents() { this.viewer.zoomExtents(); }
  zoomAt(f) { this.viewer.zoomAt(f); }
  setView(name) { this.viewer.setView(name); }
  setTool(name) { this.viewer.setTool(name === 'pan' ? 'pan' : name.startsWith('measure') ? 'measure' : 'select'); }
  setSnap(on) { this.viewer.snapOn = on; }
  clearMeasures() { this.viewer.clearMeasures(); }
  cancel() { return this.viewer.cancel(); }
  get ortho() { return this.viewer.isOrtho; }
  toggleProjection() { this.viewer.setProjection(!this.viewer.isOrtho); return this.viewer.isOrtho; }
  setDisplay(mode) { this.sm.setMode(mode); this.viewer.requestRender(); return this.sm.mode; }
  get display() { return this.sm.mode; }
  captureView() { return this.viewer.captureView(); }
  zoomTo(ids) { this.viewer.zoomToElements(ids.filter((i) => this.sm.hasGeometry(i))); }

  // ------------------------------------------------------------------ selection
  onPick(id, ev) {
    const add = ev?.shiftKey || ev?.ctrlKey || ev?.metaKey;
    if (id === null) { if (!add) this.select([]); return; }
    if (add) this.select(this.selection.includes(id) ? this.selection.filter((x) => x !== id) : [...this.selection, id]);
    else this.select([id]);
    this.reveal(id);
  }

  select(ids, zoom = false) {
    this.selection = [...new Set(ids)];
    this.sm.setOverlay('selection', this.selection);
    this.viewer.requestRender();
    if (zoom && this.selection.length) this.zoomTo(this.selection);
    this.markTreeSelection();
    this.ui.onSelection?.();
  }

  highlight(ids) {
    this.highlights = ids;
    this.sm.setOverlay('highlight', ids);
    this.viewer.requestRender();
  }

  // ------------------------------------------------------------------ visibility
  setHidden(ids) {
    this.hidden = new Set(ids);
    this.sm.setHidden(this.hidden);
    this.viewer.requestRender();
    this.renderTree();
  }

  showAll() { this.setHidden([]); }
  hideAll() { this.setHidden(this.model.elements.map((_, i) => i)); }
  isolate(ids) {
    const keep = new Set(ids);
    this.setHidden(this.model.elements.map((_, i) => i).filter((i) => !keep.has(i)));
  }

  /** Values of the model's grouping fields (IFC type / storey, PCF pipeline / category…) -> element ids. */
  groups() {
    if (this.groupCache) return this.groupCache;
    const out = new Map();
    for (const key of this.model.groupKeys ?? ['type']) {
      const m = new Map();
      this.model.elements.forEach((e, i) => { const v = e[key]; if (v) { if (!m.has(v)) m.set(v, []); m.get(v).push(i); } });
      out.set(key, m);
    }
    this.groupCache = out;
    return out;
  }

  /** AI set_layers for 3D: show/hide/isolate groups by name (type, storey, pipeline, category…). */
  setGroups({ only, show, hide, reset }) {
    const groups = this.groups();
    const find = (name) => {
      const n = String(name).toLowerCase();
      const hits = [];
      for (const m of groups.values()) for (const [k, ids] of m) if (k.toLowerCase() === n) hits.push(...ids);
      return hits;
    };
    let hidden = reset ? new Set(this.model.initialHidden ?? []) : new Set(this.hidden);
    const unknown = [];
    if (only?.length) {
      const keep = new Set(only.flatMap((n) => { const h = find(n); if (!h.length) unknown.push(n); return h; }));
      hidden = new Set(this.model.elements.map((_, i) => i).filter((i) => !keep.has(i)));
    }
    for (const n of show ?? []) { const h = find(n); if (!h.length) unknown.push(n); for (const i of h) hidden.delete(i); }
    for (const n of hide ?? []) { const h = find(n); if (!h.length) unknown.push(n); for (const i of h) hidden.add(i); }
    this.setHidden(hidden);
    const visibleGroups = {};
    for (const [key, m] of groups) visibleGroups[key] = [...m].filter(([, ids]) => ids.some((i) => !hidden.has(i))).map(([k]) => k).slice(0, 80);
    return { visible_elements: this.model.elements.length - hidden.size, hidden_elements: hidden.size, visible_groups: visibleGroups, ...(unknown.length ? { not_found: unknown } : {}) };
  }

  // ------------------------------------------------------------------ tree
  buildTreeIndex() {
    let key = 0;
    this.nodes = new Map();
    this.nodeOf = new Map();
    const walk = (n, parent) => {
      n.key = ++key;
      n.parent = parent;
      this.nodes.set(n.key, n);
      if (n.id !== undefined && !this.nodeOf.has(n.id)) this.nodeOf.set(n.id, n);
      for (const c of n.children ?? []) walk(c, n);
    };
    walk(this.model.tree, null);
    this.model.tree.open = true;
    // Open the first levels (IFC: project, site, building; others: the file and its first group).
    // (type groups stay closed; spatial levels open down to the storeys).
    const open = (n, d) => { if (d < 6 && (n.children?.length ?? 0) <= 60) { n.open = true; for (const c of n.children ?? []) if (c.children?.length && c.type !== 'group') open(c, d + 1); } };
    open(this.model.tree, 0);
  }

  idsOf(n) {
    if (n.ids) return n.ids;
    const out = [];
    const walk = (x) => { if (x.id !== undefined) out.push(x.id); for (const c of x.children ?? []) walk(c); };
    walk(n);
    n.ids = out;
    return out;
  }

  renderTree() {
    const ul = $('#modelTree');
    if (!ul) return;
    const { escapeHtml, icon } = this.ui;
    const filter = $('#treeFilter')?.value.trim().toLowerCase() ?? '';
    const rows = [];
    const row = (n, depth) => {
      const ids = this.idsOf(n);
      const hid = ids.reduce((k, i) => k + (this.hidden.has(i) ? 1 : 0), 0);
      const on = hid < ids.length || !ids.length;
      const kids = n.children?.length ?? 0;
      const label = n.id !== undefined ? n.name : `${n.name}`;
      const sub = n.type && n.type !== 'group' && n.id !== undefined && n.type !== n.name ? `<span class="tsub">${escapeHtml(n.type)}</span>` : '';
      rows.push(`<li data-k="${n.key}" class="${on ? '' : 'off'}${hid && hid < ids.length ? ' partial' : ''}${n.id !== undefined && this.selection.includes(n.id) ? ' sel' : ''}" style="--d:${depth}">`
        + `<button class="caret${kids ? '' : ' none'}" type="button" tabindex="-1">${kids ? icon(n.open ? 'down' : 'next') : ''}</button>`
        + `<button class="eye ${on ? 'on' : ''}" type="button" title="${escapeHtml(this.ui.t('toggleVisibility'))}">${icon(on ? 'eye' : 'eyeOff')}</button>`
        + `<span class="name" title="${escapeHtml(label)}">${escapeHtml(label)}${sub}</span>`
        + `${kids ? `<span class="count">${ids.length.toLocaleString('en-US')}</span>` : ''}`
        + `<button class="row-btn iso" type="button" title="${escapeHtml(this.ui.t('isolate'))}">${icon('target')}</button></li>`);
      if (n.open && kids) {
        const list = n.children.slice(0, n.more ?? MAX_CHILDREN);
        for (const c of list) row(c, depth + 1);
        if (kids > list.length) rows.push(`<li class="more" data-more="${n.key}" style="--d:${depth + 1}"><span class="name muted">${escapeHtml(this.ui.t('showMore').replace('{n}', (kids - list.length).toLocaleString('en-US')))}</span></li>`);
      }
    };
    if (filter) {
      const words = filter.split(/\s+/);
      let n = 0;
      for (const node of this.nodes.values()) {
        if (n >= 1000) break;
        const text = `${node.name} ${node.type ?? ''} ${node.id !== undefined ? this.model.elements[node.id]?.text ?? '' : ''}`.toLowerCase();
        if (words.every((w) => text.includes(w)) && node !== this.model.tree) {
          const saved = node.open;
          node.open = false;
          row(node, 0);
          node.open = saved;
          n++;
        }
      }
      if (!n) rows.push(`<li class="muted">${escapeHtml(this.ui.t('noResults'))}</li>`);
    } else row(this.model.tree, 0);
    ul.innerHTML = rows.join('');
  }

  markTreeSelection() {
    const sel = new Set(this.selection);
    for (const li of document.querySelectorAll('#modelTree li[data-k]')) {
      const n = this.nodes.get(+li.dataset.k);
      li.classList.toggle('sel', n?.id !== undefined && sel.has(n.id));
    }
  }

  /** Opens the tree down to an element and scrolls its row into view. */
  reveal(id) {
    const n = this.nodeOf.get(id);
    if (!n || $('#treeFilter')?.value.trim()) return;
    let changed = false;
    for (let p = n.parent; p; p = p.parent) if (!p.open) { p.open = true; changed = true; }
    // Make sure the element is within the shown part of a long list.
    for (let c = n; c.parent; c = c.parent) {
      const i = c.parent.children.indexOf(c);
      if (i >= (c.parent.more ?? MAX_CHILDREN)) { c.parent.more = i + 50; changed = true; }
    }
    if (changed) this.renderTree();
    $(`#modelTree li[data-k="${n.key}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  onTreeClick(ev, dbl = false) {
    const more = ev.target.closest('li[data-more]');
    if (more) { const n = this.nodes.get(+more.dataset.more); n.more = (n.more ?? MAX_CHILDREN) + 2000; this.renderTree(); return; }
    const li = ev.target.closest('li[data-k]');
    if (!li) return;
    const n = this.nodes.get(+li.dataset.k);
    if (!n) return;
    const ids = this.idsOf(n);
    if (ev.target.closest('.caret')) { if (n.children?.length) { n.open = !n.open; this.renderTree(); } return; }
    if (ev.target.closest('.eye')) {
      const anyVisible = ids.some((i) => !this.hidden.has(i));
      const h = new Set(this.hidden);
      for (const i of ids) { if (anyVisible) h.add(i); else h.delete(i); }
      this.setHidden(h);
      return;
    }
    if (ev.target.closest('.iso')) { this.isolate(ids); this.zoomTo(ids); return; }
    if (dbl) { this.zoomTo(ids); return; }
    if (n.id !== undefined && !n.children?.length) this.select(ev.shiftKey || ev.ctrlKey ? [...this.selection, n.id] : [n.id]);
    else this.select(ids.length > 20000 ? [] : ids);
    if (n.children?.length && !n.open && !ev.shiftKey) { n.open = true; this.renderTree(); }
  }

  // ------------------------------------------------------------------ properties
  /** Fills the Properties panel (`dl.props`) for the selection; IFC property sets load afterwards. */
  renderProps(dl) {
    const { escapeHtml, t } = this.ui;
    const ids = this.selection;
    const u = this.units ? ` ${this.units}` : '';
    const f = (v) => formatValue(v);
    if (!ids.length) { dl.innerHTML = `<div class="empty">${escapeHtml(t('nothingSelected3d'))}</div>`; return; }
    const groups = [];
    const box = this.sm.bbox(ids);
    if (ids.length === 1) {
      const e = this.model.elements[ids[0]];
      groups.push(...(e.props ?? [{ title: e.type, rows: [['Name', e.name]] }]));
    } else {
      const types = new Map();
      for (const i of ids) { const ty = this.model.elements[i]?.type ?? '?'; types.set(ty, (types.get(ty) ?? 0) + 1); }
      groups.push({ title: `${ids.length.toLocaleString('en-US')} ${t('selected')}`, rows: [...types].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, n]) => [k, String(n)]) });
    }
    if (box) {
      const s = this.shift;
      groups.push({ title: `${t('location')}${u ? ` (${this.units})` : ''}`, rows: [
        ['Min', `${f(box[0] + s[0])}, ${f(box[1] + s[1])}, ${f(box[2] + s[2])}`],
        ['Max', `${f(box[3] + s[0])}, ${f(box[4] + s[1])}, ${f(box[5] + s[2])}`],
        [t('size'), `${f(box[3] - box[0])} × ${f(box[4] - box[1])} × ${f(box[5] - box[2])}${u}`],
      ] });
    }
    const html = (gs) => gs.map((g) => `<div class="section">${escapeHtml(g.title)}</div>${g.rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd dir="auto">${escapeHtml(v)}</dd>`).join('')}`).join('');
    const actions = `<div class="props-actions"><button class="mini" data-action="sel3d:zoom">${t('zoomTo')}</button><button class="mini" data-action="sel3d:isolate">${t('isolate')}</button><button class="mini" data-action="sel3d:hide">${t('hide')}</button><button class="mini" data-action="sel3d:section">${t('sectionAround')}</button></div>`;
    dl.innerHTML = actions + html(groups);
    if (ids.length === 1 && this.model.loadProps) {
      const id = ids[0];
      const note = document.createElement('div');
      note.className = 'empty';
      note.textContent = t('loadingProps');
      dl.append(note);
      this.model.loadProps(id).then((more) => {
        if (this.selection.length !== 1 || this.selection[0] !== id || !dl.isConnected) return;
        note.remove();
        // The element's own group replaces the worker's raw attribute list.
        dl.insertAdjacentHTML('beforeend', html(more.filter((g) => g.title !== 'Attributes' || !this.model.elements[id].props)));
      }, () => note.remove());
    }
  }

  /** item_details for the assistant. */
  async details(ids) {
    const out = [];
    for (const id of ids.slice(0, 30)) {
      const e = this.model.elements[id];
      if (!e) { out.push({ id, error: 'not found' }); continue; }
      const props = {};
      const groups = [...(e.props ?? [])];
      if (this.model.loadProps) { try { groups.push(...(await this.model.loadProps(id))); } catch { /* none */ } }
      for (const g of groups) for (const [k, v] of g.rows) if (Object.keys(props).length < 80) props[`${g.title}: ${k}`] = v;
      const b = this.sm.bbox([id]);
      const s = this.shift;
      out.push({ id, name: e.name, type: e.type, properties: props, bbox: b ? [b[0] + s[0], b[1] + s[1], b[2] + s[2], b[3] + s[0], b[4] + s[1], b[5] + s[2]].map((v) => +v.toFixed(3)) : undefined, units: this.units || undefined, hidden: this.hidden.has(id) || undefined });
    }
    return out;
  }

  // ------------------------------------------------------------------ search
  /** Elements matching all words (names, types, attributes; IFC: also property values). */
  async search(query, limit = 500) {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const hits = [];
    this.model.elements.forEach((e, i) => { if (hits.length < limit && words.every((w) => (e.text ?? e.name.toLowerCase()).includes(w))) hits.push(i); });
    if (this.model.searchDeep && hits.length < limit) {
      try {
        const deep = await this.model.searchDeep(query);
        const have = new Set(hits);
        for (const i of deep) if (!have.has(i) && hits.length < limit) hits.push(i);
      } catch { /* worker gone */ }
    }
    return hits;
  }

  describe(id) {
    const e = this.model.elements[id];
    return { id, name: e.name, type: e.type, where: e.storey || e.pipeline || e.assembly || '' };
  }

  // ------------------------------------------------------------------ bill of materials
  renderBom() {
    const box = $('#bomTable');
    const sel = $('#bomFilter');
    const bom = this.model.bom;
    if (!box || !bom) { if (box) box.innerHTML = ''; return; }
    const { escapeHtml, t } = this.ui;
    if (bom.kind === 'pcf') {
      const pcf = this.model.pcf;
      sel.hidden = false;
      if (!sel.dataset.file || sel.dataset.file !== this.fileName) {
        sel.innerHTML = `<option value="">${escapeHtml(t('allPipelines'))}</option>` + pcf.pipelines.map((p) => `<option>${escapeHtml(p.ref)}</option>`).join('');
        sel.dataset.file = this.fileName;
      }
      const b = pcfBom(pcf, { pipeline: sel.value || null });
      this.currentBom = b;
      const cats = [];
      for (const r of b.rows) { if (cats.at(-1)?.name !== r.category) cats.push({ name: r.category, rows: [] }); cats.at(-1).rows.push(r); }
      box.innerHTML = `<table class="bom-table"><thead><tr><th>${t('itemCode')}</th><th>${t('description')}</th><th>${t('sizeCol')}</th><th class="num">${t('qty')}</th></tr></thead><tbody>`
        + cats.map((c) => `<tr class="cat"><td colspan="4">${escapeHtml(c.name)}</td></tr>` + c.rows.map((r) => `<tr data-key="${escapeHtml(r.key)}" title="${escapeHtml(t('clickToShow'))}"><td>${escapeHtml(r.itemCode || '–')}</td><td>${escapeHtml(r.description)}</td><td class="nowrap">${escapeHtml(r.size)}</td><td class="num nowrap">${escapeHtml(String(r.qty))} ${escapeHtml(r.unit)}</td></tr>`).join('')).join('')
        + `</tbody></table><h4>${t('pipeLengthPerSize')}</h4><table class="bom-table"><tbody>`
        + b.pipeLengths.map((p) => `<tr data-bore="${p.bore}"><td>${escapeHtml(p.size)}</td><td class="num">${p.length} ${p.unit}</td></tr>`).join('')
        + `<tr class="total"><td>${t('total')}</td><td class="num">${b.totalPipe} ${b.lengthUnit}</td></tr></tbody></table>`;
    } else {
      sel.hidden = true;
      const unit = this.units;
      box.innerHTML = `<table class="bom-table"><thead><tr><th>${t('typeCol')}</th><th>${t('description')}</th><th class="num">${t('count')}</th><th class="num">${t('length')}</th></tr></thead><tbody>`
        + bom.rows.map((r, i) => `<tr data-row="${i}" title="${escapeHtml(t('clickToShow'))}"><td>${escapeHtml(r.category)}</td><td>${escapeHtml(r.description || '–')}</td><td class="num">${r.qty}</td><td class="num nowrap">${r.length ? `${formatValue(r.length)} ${escapeHtml(unit)}` : ''}</td></tr>`).join('')
        + '</tbody></table>';
    }
  }

  /** Element ids behind a BOM row (click shows them). */
  bomRowIds(tr) {
    const els = this.model.elements;
    if (tr.dataset.key !== undefined) {
      const pcf = this.model.pcf;
      const pl = $('#bomFilter').value || null;
      return pcf.components.map((c, i) => (c.physical && (!pl || c.pipeline === pl) && bomKey(c, pcf.units) === tr.dataset.key ? i : -1)).filter((i) => i >= 0);
    }
    if (tr.dataset.bore !== undefined) {
      const pcf = this.model.pcf;
      const pl = $('#bomFilter').value || null;
      return pcf.components.map((c, i) => (/^PIPE/.test(c.type) && (!pl || c.pipeline === pl) && String(c.bore ?? 0) === tr.dataset.bore ? i : -1)).filter((i) => i >= 0);
    }
    if (tr.dataset.row !== undefined) {
      const r = this.model.bom.rows[+tr.dataset.row];
      return els.map((e, i) => (e.type === r.category && (e.typeObject || e.objectType || e.ifcName || '') === r.description && this.sm.hasGeometry(i) ? i : -1)).filter((i) => i >= 0);
    }
    return [];
  }

  bomCsv() {
    const bom = this.model.bom;
    const base = this.fileName.replace(/\.[^.]+$/, '');
    if (bom.kind === 'pcf') {
      const pl = $('#bomFilter').value;
      return { name: `${base}${pl ? '-' + pl : ''}-BOM.csv`, text: pcfBomCsv(this.currentBom ?? pcfBom(this.model.pcf), `${this.fileName}${pl ? ' – ' + pl : ''}`) };
    }
    const lines = [['IFC type', 'Type / name', 'Count', `Total length (${this.units})`].join(',')];
    for (const r of bom.rows) lines.push([r.category, r.description, r.qty, r.length || ''].map(csvCell).join(','));
    return { name: `${base}-elements.csv`, text: lines.join('\r\n') + '\r\n' };
  }

  // ------------------------------------------------------------------ section
  setSection(mode) {
    const v = this.viewer;
    if (mode === 'off') v.setSection({ mode: 'off' });
    else if (mode === 'box') v.setSection({ mode: 'box', box: v.clip.box ?? v.sectionRange() });
    else v.setSection({ mode: 'plane', axis: mode, offset: v.clip.mode === 'plane' && v.clip.axis === mode ? v.clip.offset : 0.5 });
    this.updateSectionUi();
  }

  sectionAroundSelection() {
    const b = this.sm.bbox(this.selection);
    if (!b) return;
    const pad = Math.max(...[0, 1, 2].map((k) => b[k + 3] - b[k])) * 0.05 + this.viewer.radius * 0.002;
    this.viewer.setSection({ mode: 'box', box: [b[0] - pad, b[1] - pad, b[2] - pad, b[3] + pad, b[4] + pad, b[5] + pad] });
    this.zoomTo(this.selection);
    $('#sectionPanel').hidden = false;
    this.updateSectionUi();
  }

  updateSectionUi() {
    const c = this.viewer.clip;
    const r = this.viewer.sectionRange();
    const mode = c.mode === 'plane' ? c.axis : c.mode;
    for (const b of document.querySelectorAll('#sectionPanel [data-sec]')) b.classList.toggle('active', b.dataset.sec === mode);
    $('#secBox').hidden = c.mode !== 'box';
    $('#secPlane').hidden = c.mode !== 'plane';
    if (c.mode === 'box' && c.box) {
      ['x', 'y', 'z'].forEach((a, k) => {
        const span = r[k + 3] - r[k] || 1;
        $(`#sec${a}0`).value = String(Math.round(((c.box[k] - r[k]) / span) * 1000));
        $(`#sec${a}1`).value = String(Math.round(((c.box[k + 3] - r[k]) / span) * 1000));
      });
    }
    if (c.mode === 'plane') { $('#secPos').value = String(Math.round(c.offset * 1000)); $('#secFlip').checked = c.flip; }
    document.querySelector('[data-action="section3d"]')?.classList.toggle('active', c.mode !== 'off');
  }

  onSectionInput() {
    const v = this.viewer;
    const r = v.sectionRange();
    if (v.clip.mode === 'box') {
      const box = [0, 0, 0, 0, 0, 0];
      ['x', 'y', 'z'].forEach((a, k) => {
        let lo = +$(`#sec${a}0`).value / 1000, hi = +$(`#sec${a}1`).value / 1000;
        if (lo > hi - 0.002) [lo, hi] = [Math.min(lo, hi - 0.002), Math.max(hi, lo + 0.002)];
        box[k] = r[k] + (r[k + 3] - r[k]) * lo;
        box[k + 3] = r[k] + (r[k + 3] - r[k]) * hi;
      });
      v.setSection({ box });
    } else if (v.clip.mode === 'plane') {
      v.setSection({ offset: +$('#secPos').value / 1000, flip: $('#secFlip').checked });
    }
  }

  // ------------------------------------------------------------------ wiring
  wire() {
    const sig = { signal: this.listeners.signal };
    $('#modelTree').addEventListener('click', (ev) => this.onTreeClick(ev), sig);
    $('#modelTree').addEventListener('dblclick', (ev) => this.onTreeClick(ev, true), sig);
    $('#treeFilter').addEventListener('input', () => { clearTimeout(this.filterTimer); this.filterTimer = setTimeout(() => this.renderTree(), 200); }, sig);
    $('#bomFilter').addEventListener('change', () => this.renderBom(), sig);
    $('#bomTable').addEventListener('click', (ev) => {
      const tr = ev.target.closest('tr[data-key], tr[data-row], tr[data-bore]');
      if (!tr) return;
      const ids = this.bomRowIds(tr);
      for (const x of document.querySelectorAll('#bomTable tr.on')) x.classList.remove('on');
      tr.classList.add('on');
      this.select(ids);
      this.zoomTo(ids);
    }, sig);
    $('#sectionPanel').addEventListener('click', (ev) => { const b = ev.target.closest('[data-sec]'); if (b) this.setSection(b.dataset.sec); }, sig);
    $('#sectionPanel').addEventListener('input', () => this.onSectionInput(), sig);
  }

  // ------------------------------------------------------------------ assistant, status, printing
  summary() {
    const m = this.model;
    const b = this.sm.bbox();
    const s = this.shift;
    const head = [`Viewer: 3D model. Units: ${this.units || 'not stored in the file'}.`];
    if (b) head.push(`Bounding box (file coordinates): min (${[0, 1, 2].map((k) => formatValue(b[k] + s[k])).join(', ')}), max (${[3, 4, 5].map((k) => formatValue(b[k] + s[k - 3])).join(', ')}); size ${[0, 1, 2].map((k) => formatValue(b[k + 3] - b[k])).join(' × ')} ${this.units}. Z is up.`);
    head.push(`Grouping fields for set_layers: ${(m.groupKeys ?? []).join(', ')}. Element ids are the [#id] numbers.`);
    if (this.hidden.size) head.push(`${this.hidden.size} elements are currently hidden.`);
    return `${head.join('\n')}\n\n${m.summary ? m.summary() : ''}`;
  }

  statusText(point) {
    const parts = [];
    if (point) parts.push(`X ${formatValue(point[0])}  Y ${formatValue(point[1])}  Z ${formatValue(point[2])}${this.units ? ' ' + this.units : ''}`);
    else if (this.units) parts.push(this.units);
    parts.push(this.viewer.isOrtho ? this.ui.t('orthographic') : this.ui.t('perspective'));
    if (this.selection.length) parts.push(`${this.selection.length} ${this.ui.t('selected')}`);
    return parts.join('   ·   ');
  }

  /** The current view as a picture "sheet" for the print / PDF dialog (white background). */
  snapshotSheet() {
    const canvas = this.viewer.snapshot(3, 4096, '#ffffff');
    const W = canvas.width, H = canvas.height;
    return {
      format: '3D view', fileName: this.fileName, canvas, bbox: [0, 0, W, H], width: W, height: H, pageCount: 1, pageNo: 1,
      photo: true, printInfo: `3D view (${this.model.formatLabel ?? this.model.format})`,
      renderArea(rect, w, h) {
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(w));
        c.height = Math.max(1, Math.round(h));
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(canvas, rect[0], H - rect[3], rect[2] - rect[0], rect[3] - rect[1], 0, 0, c.width, c.height);
        return c;
      },
      dispose() { canvas.width = 0; canvas.height = 0; },
    };
  }

  /** PNG of the current view at about 3× screen resolution. */
  pngBlob() {
    const c = this.viewer.snapshot(3, 4096, this.ui.theme.bg);
    return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('The image could not be created.'))), 'image/png'));
  }
}
