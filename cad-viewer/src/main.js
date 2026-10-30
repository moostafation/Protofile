import './styles.css';
import { t, getLang, setLang } from './i18n.js';
import { fillIcons, icon } from './ui/icons.js';
import { renderMarkdown } from './ui/markdown.js';
import { Viewer } from './render/viewer.js';
import { CadRenderer, measureText, colorCss } from './render/cad-renderer.js';
import { PAPERS, exportPdf, planPlot } from './render/pdf-export.js';
import { loadCad } from './cad/loader.js';
import { buildScene, STROKE } from './cad/scene.js';
import { UNIT_NAMES } from './cad/drawing.js';
import { polygonArea } from './cad/geometry.js';
import { PickIndex } from './tools/pick.js';
import { analyze, search, bomCsv, layersCsv, drawingSummary, formatNum } from './tools/analysis.js';
import { SelectTool, RectTool, MeasureTool, drawMeasurements, formatLength, formatArea } from './tools/tools.js';
import { Assistant } from './ai/assistant.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const THEMES = {
  dark: { bg: '#1d2127', fg: '#ffffff', mono: false },
  light: { bg: '#ffffff', fg: '#000000', mono: false },
  mono: { bg: '#ffffff', fg: '#000000', mono: true },
};
const SCALES = [1, 2, 5, 10, 20, 25, 50, 75, 100, 125, 150, 200, 250, 300, 400, 500, 750, 1000, 1250, 1500, 2000, 2500, 5000];

function loadUiPrefs() {
  try { return JSON.parse(localStorage.getItem('protocad.ui') || '{}'); } catch { return {}; }
}
function saveUiPrefs() {
  try { localStorage.setItem('protocad.ui', JSON.stringify({ theme: state.theme, showLw: state.showLw })); } catch { /* storage unavailable */ }
}

const prefs = loadUiPrefs();
const state = {
  doc: null, // { kind: 'cad', drawing, spaces, active } | { kind: 'pdf', pdf }
  hidden: new Set(),
  selection: [],
  highlights: [],
  pdfHits: [],
  measures: [],
  theme: THEMES[prefs.theme] ? prefs.theme : 'dark',
  showLw: !!prefs.showLw,
  snap: true,
  pdfScale: null,
  print: { paper: 'A3', orientation: 'auto', area: 'extents', scale: 'fit', color: 'mono', lw: true, stamp: true, window: null },
};

const viewer = new Viewer($('#viewport'), {
  onCursor: (w) => updateStatus(w),
  onView: () => {},
  drawOverlay: (o, v) => drawOverlay(o, v),
});

// ---------------------------------------------------------------- app API used by tools
const app = {
  get selection() { return state.selection; },
  pickAt(x, y, r) {
    const sp = activeSpace();
    if (!sp) return null;
    return sp.pick.pick(x, y, r, isHidden);
  },
  select(item) {
    state.selection = item === null || item === undefined ? [] : [item];
    showProperties();
    viewer.renderOverlay();
  },
  drawItemsOverlay(o, v, items, color, width) {
    const sp = activeSpace();
    if (!sp) return;
    v.applyTransform(o);
    sp.renderer.drawItems(o, { scale: v.view.scale }, items, color, width);
    o.setTransform(1, 0, 0, 1, 0, 0);
  },
};

const isHidden = (layer) => state.hidden.has(layer);
const activeSpace = () => (state.doc?.kind === 'cad' ? state.doc.spaces[state.doc.active] : null);

const measureEnv = {
  store: state.measures,
  snap: (w, v) => {
    const sp = activeSpace();
    if (!sp || !state.snap) return null;
    return sp.pick.snap(w[0], w[1], 12 / v.view.scale, isHidden);
  },
  units: () => measureUnits(),
  onDone: () => viewer.renderOverlay(),
  onCalibrate: (pts) => {
    const d = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]);
    const v = parseFloat((prompt(t('realDistance')) || '').replace(',', '.'));
    if (d > 0 && v > 0) {
      state.pdfScale = { factor: v / d, unit: 'm' };
      toast(`${t('pdfScale')}: 1 pt = ${(v / d).toFixed(5)} m`);
    }
    setTool('select');
  },
};

function measureUnits() {
  if (state.doc?.kind === 'pdf') return state.pdfScale || { factor: 25.4 / 72, unit: 'mm' };
  const units = state.doc?.drawing?.units;
  return { factor: 1, unit: UNIT_NAMES[units] || '' };
}

// ---------------------------------------------------------------- i18n / chrome
function applyI18n() {
  const lang = getLang();
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  for (const el of $$('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of $$('[data-i18n-title]')) { el.title = t(el.dataset.i18nTitle); el.setAttribute('aria-label', el.title); }
  for (const el of $$('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
  buildQuickPrompts();
}

function updateNeeds() {
  const kind = state.doc?.kind;
  for (const el of $$('[data-needs]')) {
    const need = el.dataset.needs;
    el.hidden = need === 'doc' ? !kind : need !== kind;
  }
  $('#welcome').hidden = !!kind;
}

function toast(msg, isError = false, ms = 3500) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, ms);
}

function showLoading(text) {
  $('#loading').hidden = !text;
  $('#loadingText').textContent = text || '';
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

// ---------------------------------------------------------------- opening files
async function openFile(file) {
  const name = file.name || 'drawing';
  const ext = name.split('.').pop().toLowerCase();
  if (!['dwg', 'dxf', 'pdf'].includes(ext)) {
    toast(t('unsupported'), true);
    return;
  }
  showLoading(t('loading'));
  try {
    const buffer = await file.arrayBuffer();
    if (ext === 'pdf') {
      const { openPdf } = await import('./pdf/pdf-doc.js');
      const pdf = await openPdf(buffer, name);
      setPdfDoc(pdf);
    } else {
      const drawing = await loadCad(buffer, name);
      showLoading(t('building'));
      await nextFrame();
      setCadDoc(drawing);
    }
    document.title = `${name} – ProtoCAD Viewer`;
  } catch (err) {
    console.error(err);
    toast(`${t('loadError')}: ${err.message || err}`, true, 7000);
  } finally {
    showLoading(null);
  }
}

function makeSpace(drawing, name, entities, isLayout) {
  const scene = buildScene(drawing, entities, { measure: measureText, origin: isLayout ? { x: 0, y: 0 } : undefined });
  const renderer = new CadRenderer(scene);
  return { name, scene, renderer, pick: new PickIndex(scene), analysis: analyze(drawing, scene), isLayout };
}

function resetDocState() {
  state.selection = [];
  state.highlights = [];
  state.pdfHits = [];
  state.measures.length = 0;
  state.pdfScale = null;
  assistant.reset();
  $('#aiLog').innerHTML = '';
  $('#searchInput').value = '';
  $('#searchList').innerHTML = '';
  $('#searchCount').textContent = '';
}

function setCadDoc(drawing) {
  resetDocState();
  const model = makeSpace(drawing, t('model'), drawing.modelEntities, false);
  const spaces = [model, ...drawing.layouts.map((l) => ({ name: l.name, entities: l.entities, isLayout: true, lazy: true }))];
  state.doc = { kind: 'cad', drawing, spaces, active: 0 };
  state.hidden = new Set([...drawing.layers.values()].filter((l) => !l.visible).map((l) => l.name));
  updateNeeds();
  activateSpace(0);
  buildLayerPanel();
  buildInfoPanel();
  setSideTab(window.innerWidth > 860 ? 'layers' : null);
  setTool('select');
  if (!$('#rightbar').hidden && $('#rightTabs .active')?.dataset.rtab === 'ai') showAiIntro();
}

function activateSpace(i) {
  const doc = state.doc;
  let sp = doc.spaces[i];
  if (sp.lazy) {
    sp = doc.spaces[i] = makeSpace(doc.drawing, sp.name, sp.entities, true);
  }
  doc.active = i;
  state.selection = [];
  state.highlights = [];
  const model = doc.spaces[0];
  viewer.setDocument({
    bbox: sp.scene.bbox,
    draw: (ctx, view, theme) => sp.renderer.draw(ctx, view, { theme, hidden: isHidden, showLw: state.showLw, model: sp.isLayout ? model.renderer : null }),
  });
  buildSpaceTabs();
  buildBlockPanel();
  showProperties();
}

function setPdfDoc(pdf) {
  resetDocState();
  state.doc = { kind: 'pdf', pdf };
  updateNeeds();
  viewer.setDocument(pdf);
  buildSpaceTabs();
  buildThumbs();
  buildInfoPanel();
  setSideTab(window.innerWidth > 860 && pdf.pageCount > 1 ? 'pages' : null);
  setTool('select');
  if (!$('#rightbar').hidden && $('#rightTabs .active')?.dataset.rtab === 'ai') showAiIntro();
}

async function gotoPage(n) {
  const pdf = state.doc.pdf;
  if (n < 1 || n > pdf.pageCount || n === pdf.pageNo) return;
  await pdf.setPage(n);
  viewer.setDocument(pdf);
  state.measures.length = 0;
  buildSpaceTabs();
  for (const el of $$('.thumb')) el.classList.toggle('active', +el.dataset.page === n);
}

// ---------------------------------------------------------------- overlay & status
function drawOverlay(o, v) {
  const sp = activeSpace();
  if (sp) {
    if (state.highlights.length) app.drawItemsOverlay(o, v, state.highlights, '#22d3ee', 3);
    if (state.selection.length) app.drawItemsOverlay(o, v, state.selection, '#ff9f1c', 3);
  }
  if (state.doc?.kind === 'pdf' && state.pdfHits.length) {
    const page = state.doc.pdf.pageNo;
    o.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
    for (const h of state.pdfHits) {
      if (h.page !== page) continue;
      const [x0, y0] = v.worldToScreen(h.rect[0], h.rect[3]);
      const [x1, y1] = v.worldToScreen(h.rect[2], h.rect[1]);
      o.fillStyle = h.active ? 'rgba(255,159,28,0.45)' : 'rgba(255,230,0,0.35)';
      o.fillRect(x0 - 2, y0 - 2, x1 - x0 + 4, y1 - y0 + 4);
      if (h.active) { o.strokeStyle = '#ff9f1c'; o.lineWidth = 2; o.strokeRect(x0 - 3, y0 - 3, x1 - x0 + 6, y1 - y0 + 6); }
    }
  }
  if (state.measures.length) drawMeasurements(o, v, state.measures, measureEnv);
  o.setTransform(1, 0, 0, 1, 0, 0);
}

function updateStatus(w) {
  const el = $('#status');
  if (!state.doc) { el.textContent = ''; return; }
  const parts = [];
  if (w) {
    if (state.doc.kind === 'cad') {
      const o = activeSpace().scene.origin;
      parts.push(`X ${formatNum(w[0] + o.x, 3)}  Y ${formatNum(w[1] + o.y, 3)}`);
    } else {
      const { factor, unit } = measureUnits();
      parts.push(`X ${formatNum(w[0] * factor, 2)}  Y ${formatNum(w[1] * factor, 2)} ${unit}`);
    }
  }
  if (state.doc.kind === 'cad') {
    const u = UNIT_NAMES[state.doc.drawing.units];
    if (u) parts.push(u);
  } else {
    parts.push(`${Math.round(viewer.view.scale * 100 * 72 / 96)}%`);
  }
  el.textContent = parts.join('   ·   ');
}

// ---------------------------------------------------------------- tools
let currentTool = 'select';
function setTool(name) {
  currentTool = name;
  if (name === 'select') viewer.setTool(new SelectTool(app));
  else if (name === 'zoomWindow') viewer.setTool(new RectTool((bb) => { viewer.zoomToBox(bb, 0.02); setTool('select'); }, t('zoomWindow')));
  else if (name.startsWith('measure:')) viewer.setTool(new MeasureTool(name.slice(8), measureEnv));
  for (const b of $$('[data-tool]')) {
    const tool = b.dataset.tool;
    b.classList.toggle('active', tool === name || (tool === 'measure' && name.startsWith('measure:')));
  }
  $('[data-action="zoomWindow"]').classList.toggle('active', name === 'zoomWindow');
}

function zoomToItems(ids, pad = 0.35) {
  const sp = activeSpace();
  if (!sp || !ids.length) return;
  const bb = [Infinity, Infinity, -Infinity, -Infinity];
  for (const id of ids) {
    const it = sp.scene.items[id];
    if (!it?.bb || !Number.isFinite(it.bb[0])) continue;
    bb[0] = Math.min(bb[0], it.bb[0]); bb[1] = Math.min(bb[1], it.bb[1]);
    bb[2] = Math.max(bb[2], it.bb[2]); bb[3] = Math.max(bb[3], it.bb[3]);
  }
  if (!Number.isFinite(bb[0])) return;
  // Never zoom closer than ~2% of the drawing so a single text stays in context.
  const ext = sp.scene.bbox;
  const minSize = Math.max(ext[2] - ext[0], ext[3] - ext[1]) * 0.02;
  const cx = (bb[0] + bb[2]) / 2, cy = (bb[1] + bb[3]) / 2;
  const hw = Math.max((bb[2] - bb[0]) / 2, minSize / 2), hh = Math.max((bb[3] - bb[1]) / 2, minSize / 2);
  viewer.zoomToBox([cx - hw, cy - hh, cx + hw, cy + hh], pad);
}

// ---------------------------------------------------------------- side panels
function setSideTab(name) {
  const sb = $('#sidebar');
  if (!name) {
    sb.classList.remove('open');
    name = $('#sideTabs button.active:not([hidden])')?.dataset.tab;
    if (!name || $(`#sideTabs [data-tab="${name}"]`).hidden) name = state.doc?.kind === 'pdf' ? 'search' : 'layers';
  }
  for (const b of $$('#sideTabs button')) b.classList.toggle('active', b.dataset.tab === name);
  for (const p of $$('.tab-panel')) p.classList.toggle('active', p.dataset.panel === name);
  if (name === 'search') setTimeout(() => $('#searchInput').focus(), 0);
}

function buildLayerPanel() {
  const ul = $('#layerList');
  const doc = state.doc;
  if (doc?.kind !== 'cad') { ul.innerHTML = ''; return; }
  const counts = new Map(doc.spaces[0].analysis.layerStats.map((s) => [s.name, s]));
  const filter = $('#layerFilter').value.trim().toLowerCase();
  const theme = { ...THEMES.dark };
  const layers = [...doc.drawing.layers.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  ul.innerHTML = '';
  for (const l of layers) {
    if (filter && !l.name.toLowerCase().includes(filter)) continue;
    const s = counts.get(l.name);
    const li = document.createElement('li');
    const on = !state.hidden.has(l.name);
    li.classList.toggle('off', !on);
    li.innerHTML = `<button class="eye ${on ? 'on' : ''}">${icon(on ? 'eye' : 'eyeOff')}</button>
      <span class="swatch" style="background:${colorCss(l.rgb, theme)}"></span>
      <span class="name" title="${escapeHtml(l.name)}">${escapeHtml(l.name)}</span>
      <span class="count">${s ? s.entities : 0}</span>`;
    li.title = s?.length ? `${t('length')}: ${formatLength(s.length, UNIT_NAMES[doc.drawing.units])}` : '';
    li.addEventListener('click', () => {
      if (state.hidden.has(l.name)) state.hidden.delete(l.name);
      else state.hidden.add(l.name);
      layersChanged();
    });
    li.addEventListener('dblclick', (ev) => {
      ev.preventDefault();
      state.hidden = new Set([...doc.drawing.layers.keys()].filter((n) => n !== l.name));
      layersChanged();
    });
    ul.append(li);
  }
}

function layersChanged() {
  buildLayerPanel();
  viewer.render(true);
}

function buildBlockPanel() {
  const ul = $('#blockList');
  ul.innerHTML = '';
  const sp = activeSpace();
  if (!sp) return;
  if (!sp.analysis.blocks.length) {
    ul.innerHTML = `<li class="muted">${t('noResults')}</li>`;
    return;
  }
  for (const b of sp.analysis.blocks) {
    const li = document.createElement('li');
    const attrs = [...b.attrValues.keys()].slice(0, 6).join(', ');
    li.innerHTML = `<span class="name">${escapeHtml(b.name)}<span class="sub">${escapeHtml(attrs || [...b.layers].join(', '))}</span></span><span class="count">× ${b.count}</span>`;
    li.addEventListener('click', () => {
      state.highlights = b.items;
      state.selection = [];
      zoomToItems(b.items, 0.08);
      closeSidebarOnMobile();
    });
    ul.append(li);
  }
}

function buildInfoPanel() {
  const dl = $('#infoList');
  const rows = [];
  const doc = state.doc;
  if (doc?.kind === 'cad') {
    const d = doc.drawing;
    const sp = doc.spaces[0];
    const [x0, y0, x1, y1] = sp.scene.bbox;
    const o = sp.scene.origin;
    const unit = UNIT_NAMES[d.units] || '-';
    rows.push([t('file'), d.fileName], [t('format'), `${d.source.toUpperCase()} ${d.version || ''}`], [t('units'), unit],
      [t('extents'), `(${formatNum(x0 + o.x)}, ${formatNum(y0 + o.y)}) – (${formatNum(x1 + o.x)}, ${formatNum(y1 + o.y)})`],
      [t('size'), `${formatNum(x1 - x0)} × ${formatNum(y1 - y0)} ${unit === '-' ? '' : unit}`],
      [t('entities'), String(sp.scene.items.length)], [t('layers'), String(d.layers.size)],
      [t('blocks'), String([...d.blocks.keys()].filter((n) => !n.startsWith('*')).length)],
      ['Layouts', d.layouts.map((l) => l.name).join(', ') || '-']);
    if (sp.scene.warnings.length) rows.push([t('warnings'), sp.scene.warnings.slice(0, 12).join(', ')]);
  } else if (doc?.kind === 'pdf') {
    rows.push([t('file'), doc.pdf.fileName], [t('format'), 'PDF'], [t('pages'), String(doc.pdf.pageCount)],
      [t('size'), `${formatNum(doc.pdf.bbox[2] * 25.4 / 72, 0)} × ${formatNum(doc.pdf.bbox[3] * 25.4 / 72, 0)} mm`]);
  }
  dl.innerHTML = rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd dir="auto">${escapeHtml(v)}</dd>`).join('');
}

function buildSpaceTabs() {
  const host = $('#spaceTabs');
  host.innerHTML = '';
  const doc = state.doc;
  if (doc?.kind === 'cad') {
    doc.spaces.forEach((sp, i) => {
      const b = document.createElement('button');
      b.textContent = sp.name;
      b.classList.toggle('active', i === doc.active);
      b.addEventListener('click', () => { if (i !== doc.active) { activateSpace(i); } });
      host.append(b);
    });
  } else if (doc?.kind === 'pdf') {
    const pdf = doc.pdf;
    const wrap = document.createElement('span');
    wrap.className = 'pager';
    const rtl = getLang() === 'ar';
    wrap.innerHTML = `<button data-p="-1">${icon(rtl ? 'next' : 'prev')}</button><span>${t('page')} ${pdf.pageNo} ${t('of')} ${pdf.pageCount}</span><button data-p="1">${icon(rtl ? 'prev' : 'next')}</button>`;
    wrap.addEventListener('click', (ev) => {
      const b = ev.target.closest('button');
      if (b) gotoPage(pdf.pageNo + Number(b.dataset.p));
    });
    host.append(wrap);
  }
}

function buildThumbs() {
  const host = $('#thumbs');
  host.innerHTML = '';
  const pdf = state.doc.pdf;
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting || e.target.dataset.done) continue;
      e.target.dataset.done = '1';
      pdf.thumbnail(+e.target.dataset.page).then((c) => e.target.prepend(c)).catch(() => {});
    }
  }, { root: host });
  for (let n = 1; n <= pdf.pageCount; n++) {
    const d = document.createElement('div');
    d.className = 'thumb' + (n === pdf.pageNo ? ' active' : '');
    d.dataset.page = n;
    d.innerHTML = `<span>${n}</span>`;
    d.style.minHeight = '120px';
    d.addEventListener('click', () => { gotoPage(n); closeSidebarOnMobile(); });
    host.append(d);
    io.observe(d);
  }
}

let searchTimer = 0;
async function runSearch() {
  const q = $('#searchInput').value;
  const ul = $('#searchList');
  const doc = state.doc;
  ul.innerHTML = '';
  $('#searchCount').textContent = '';
  if (!q.trim() || !doc) { state.highlights = []; state.pdfHits = []; viewer.renderOverlay(); return; }
  if (doc.kind === 'cad') {
    const sp = activeSpace();
    const res = search(sp.analysis, q);
    state.highlights = res.filter((r) => r.item !== undefined).map((r) => r.item);
    $('#searchCount').textContent = res.length ? `${res.length} ${t('results')}` : t('noResults');
    for (const r of res) {
      const li = document.createElement('li');
      if (r.kind === 'layer') {
        li.innerHTML = `<span class="name">${escapeHtml(r.text)}</span><span class="tag">${t('layer')}</span>`;
        li.addEventListener('click', () => {
          state.hidden = new Set([...doc.drawing.layers.keys()].filter((n) => n !== r.layer));
          layersChanged();
        });
      } else {
        const it = sp.scene.items[r.item];
        li.innerHTML = `<span class="name">${escapeHtml(r.text)}<span class="sub">${escapeHtml(it.layer)} · ${escapeHtml(it.type)}</span></span>`;
        li.addEventListener('click', () => {
          state.selection = [r.item];
          showProperties();
          zoomToItems([r.item]);
          closeSidebarOnMobile();
        });
      }
      ul.append(li);
    }
    viewer.renderOverlay();
  } else {
    const hits = await doc.pdf.search(q);
    if ($('#searchInput').value !== q) return;
    state.pdfHits = hits;
    $('#searchCount').textContent = hits.length ? `${hits.length} ${t('results')}` : t('noResults');
    for (const h of hits) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="name">${escapeHtml(h.text)}</span><span class="tag">${t('page')} ${h.page}</span>`;
      li.addEventListener('click', () => focusPdfHit(h));
      ul.append(li);
    }
    viewer.renderOverlay();
  }
}

async function focusPdfHit(h) {
  for (const x of state.pdfHits) x.active = x === h;
  await gotoPage(h.page);
  const r = h.rect;
  const pad = Math.max(r[2] - r[0], r[3] - r[1]) * 4 + 30;
  viewer.zoomToBox([r[0] - pad, r[1] - pad, r[2] + pad, r[3] + pad], 0);
  closeSidebarOnMobile();
}

function closeSidebarOnMobile() {
  if (window.innerWidth <= 860) $('#sidebar').classList.remove('open');
}

// ---------------------------------------------------------------- properties
function showProperties() {
  const dl = $('#propList');
  const sp = activeSpace();
  const id = state.selection[0];
  if (!sp || id === undefined) {
    dl.innerHTML = `<div class="empty">${t('nothingSelected')}</div>`;
    return;
  }
  const it = sp.scene.items[id];
  const e = it.ent;
  const unit = UNIT_NAMES[state.doc.drawing.units] || '';
  const pt = (p) => (p ? `${formatNum(p.x, 3)}, ${formatNum(p.y, 3)}` : '');
  const rows = [[t('type'), e.type], [t('layer'), it.layer]];
  const firstPrim = sp.scene.prims[it.first];
  if (firstPrim) {
    const swatch = `<span style="display:inline-block;width:12px;height:12px;border-radius:3px;vertical-align:middle;background:${colorCss(firstPrim.rgb, THEMES.dark)}"></span> `;
    rows.push([t('color'), { html: swatch + escapeHtml(colorName(e)) }]);
  }
  if (e.handle) rows.push([t('handle'), e.handle]);
  if (e.type === 'INSERT') {
    rows.push([t('block'), e.name]);
    rows.push([t('position'), pt(e.insertionPoint)]);
    if (e.rotation) rows.push(['∠', `${((e.rotation * 180) / Math.PI).toFixed(2)}°`]);
    if ((e.xScale ?? 1) !== 1 || (e.yScale ?? 1) !== 1) rows.push(['Scale', `${formatNum(e.xScale ?? 1, 3)} × ${formatNum(e.yScale ?? 1, 3)}`]);
  }
  if (it.text) rows.push([t('text'), it.text]);
  if (e.type?.includes('DIMENSION') && Number.isFinite(e.measurement)) rows.push(['Value', formatNum(e.measurement, 3)]);
  if (e.radius) rows.push(['R', `${formatNum(e.radius, 3)} ${unit}`], ['Ø', `${formatNum(e.radius * 2, 3)} ${unit}`]);
  if (e.center) rows.push(['Center', pt(e.center)]);
  if (e.startPoint && e.type === 'LINE') rows.push(['Start', pt(e.startPoint)], ['End', pt(e.endPoint)]);
  if (it.length) rows.push([t('length'), formatLength(it.length, unit)]);
  const closed = sp.scene.prims.slice(it.first, it.last).find((p) => p.k === STROKE && p.closed);
  if (closed && ['LWPOLYLINE', 'POLYLINE2D', 'CIRCLE', 'ELLIPSE'].includes(e.type)) rows.push([t('area'), formatArea(Math.abs(polygonArea(closed.pts)), unit)]);
  if (it.bb && Number.isFinite(it.bb[0])) rows.push([t('size'), `${formatNum(it.bb[2] - it.bb[0])} × ${formatNum(it.bb[3] - it.bb[1])} ${unit}`]);
  let html = rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd dir="auto">${v?.html ?? escapeHtml(String(v))}</dd>`).join('');
  if (it.attribs?.length) {
    html += `<div class="section">${t('attributes')}</div>`;
    html += it.attribs.map((a) => `<dt>${escapeHtml(a.tag)}</dt><dd dir="auto">${escapeHtml(a.value)}</dd>`).join('');
  }
  dl.innerHTML = html;
  if (window.innerWidth > 860 && $('#rightbar').hidden) openRight('props');
}

function colorName(e) {
  if (typeof e.color === 'number') return `RGB ${(e.color >> 16) & 255},${(e.color >> 8) & 255},${e.color & 255}`;
  const ci = e.colorIndex ?? 256;
  return ci === 256 ? 'ByLayer' : ci === 0 ? 'ByBlock' : `ACI ${ci}`;
}

function openRight(tab) {
  $('#rightbar').hidden = false;
  document.body.classList.add('right-open');
  for (const b of $$('#rightTabs button')) b.classList.toggle('active', b.dataset.rtab === tab);
  for (const p of $$('.rpanel')) p.classList.toggle('active', p.dataset.rpanel === tab);
  if (tab === 'ai') {
    if (!$('#aiLog').children.length) showAiIntro();
    setTimeout(() => $('#aiInput').focus(), 0);
  }
}

// ---------------------------------------------------------------- AI assistant
const assistant = new Assistant({
  async getDocument() {
    const doc = state.doc;
    if (doc.kind === 'cad') {
      const sp = activeSpace();
      return { key: `${doc.drawing.fileName}|${sp.name}|${sp.scene.items.length}`, title: doc.drawing.fileName, text: drawingSummary(doc.drawing, sp.scene, sp.analysis, sp.name) };
    }
    const { text } = await doc.pdf.fullText();
    return { key: `pdf|${doc.pdf.fileName}|${doc.pdf.pageCount}`, title: doc.pdf.fileName, text: `PDF document "${doc.pdf.fileName}", ${doc.pdf.pageCount} page(s). The user is viewing page ${doc.pdf.pageNo}.\n${text}` };
  },
  captureView: () => viewer.captureView(),
  tools: {
    async find_in_drawing({ query }) {
      const doc = state.doc;
      if (doc.kind === 'pdf') {
        const hits = await doc.pdf.search(query, 60);
        state.pdfHits = hits;
        viewer.renderOverlay();
        return { matches: hits.slice(0, 40).map((h) => ({ page: h.page, text: h.text })), total: hits.length };
      }
      const sp = activeSpace();
      const res = search(sp.analysis, query, 200);
      return {
        total: res.length,
        matches: res.slice(0, 50).map((r) => (r.kind === 'layer' ? { layer: r.layer, kind: 'layer' } : { id: r.item, kind: r.kind, layer: sp.scene.items[r.item].layer, text: r.text.slice(0, 200) })),
      };
    },
    async zoom_to({ item_ids, page, text }) {
      const doc = state.doc;
      if (doc.kind === 'pdf') {
        if (page) await gotoPage(page);
        if (text) {
          const hits = (await doc.pdf.search(text, 50)).filter((h) => h.page === doc.pdf.pageNo);
          state.pdfHits = hits;
          if (hits[0]) await focusPdfHit(hits[0]);
          return { page: doc.pdf.pageNo, highlighted: hits.length };
        }
        return { page: doc.pdf.pageNo };
      }
      const ids = (item_ids || []).filter((i) => activeSpace().scene.items[i]);
      state.highlights = ids;
      zoomToItems(ids);
      return { zoomed_to: ids.length };
    },
    async set_layers({ only, show, hide, reset }) {
      const d = state.doc.drawing;
      if (!d) return { error: 'No CAD drawing is open' };
      const names = [...d.layers.keys()];
      const match = (n) => names.filter((x) => x.toLowerCase() === n.toLowerCase());
      if (reset) state.hidden = new Set();
      if (only?.length) {
        const keep = new Set(only.flatMap(match));
        state.hidden = new Set(names.filter((n) => !keep.has(n)));
      }
      for (const n of show || []) for (const m of match(n)) state.hidden.delete(m);
      for (const n of hide || []) for (const m of match(n)) state.hidden.add(m);
      layersChanged();
      return { visible: names.filter((n) => !state.hidden.has(n)) };
    },
    async item_details({ item_ids }) {
      const sp = activeSpace();
      if (!sp) return { error: 'No CAD drawing is open' };
      const o = sp.scene.origin;
      return item_ids.slice(0, 50).map((id) => {
        const it = sp.scene.items[id];
        if (!it) return { id, error: 'not found' };
        return {
          id, type: it.type, layer: it.layer, block: it.name, attributes: it.attribs, text: it.text,
          length: it.length ? +it.length.toFixed(3) : undefined,
          bbox: it.bb && Number.isFinite(it.bb[0]) ? [it.bb[0] + o.x, it.bb[1] + o.y, it.bb[2] + o.x, it.bb[3] + o.y].map((v) => +v.toFixed(3)) : undefined,
        };
      });
    },
  },
});

function buildQuickPrompts() {
  const host = $('#aiQuick');
  host.innerHTML = '';
  for (const k of ['aiQuick1', 'aiQuick2', 'aiQuick3', 'aiQuick4']) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = t(k);
    b.addEventListener('click', () => sendAi(t(k + 'Prompt'), k === 'aiQuick4' ? true : undefined));
    host.append(b);
  }
}

function showAiIntro() {
  const log = $('#aiLog');
  log.innerHTML = '';
  const intro = document.createElement('div');
  intro.className = 'msg intro';
  intro.textContent = t('aiIntro');
  log.append(intro);
  if (!assistant.settings.apiKey) appendAiError('no-key');
}

function appendAiError(code, message) {
  const map = { 'no-key': 'aiNoKey', auth: 'aiErrAuth', rate: 'aiErrRate', network: 'aiErrNetwork', model: 'aiErrModel', refusal: 'aiErrRefusal', 'max-tokens': 'aiErrMaxTokens' };
  const div = document.createElement('div');
  div.className = 'msg error';
  div.textContent = map[code] ? t(map[code]) : `${t('aiErr')}${message ? ': ' + message : ''}`;
  if (code === 'no-key' || code === 'auth' || code === 'model') {
    const b = document.createElement('button');
    b.className = 'mini';
    b.style.marginInlineStart = '8px';
    b.textContent = t('settings');
    b.addEventListener('click', openSettings);
    div.append(b);
  }
  $('#aiLog').append(div);
  div.scrollIntoView({ block: 'end' });
}

async function sendAi(text, includeView) {
  text = text.trim();
  if (!text || !state.doc || assistant.busy) return;
  const log = $('#aiLog');
  if (!log.children.length) showAiIntro();
  const user = document.createElement('div');
  user.className = 'msg user';
  user.textContent = text;
  log.append(user);
  const bot = document.createElement('div');
  bot.className = 'msg bot';
  bot.innerHTML = `<span class="thinking">${t('aiThinking')}</span>`;
  log.append(bot);
  bot.scrollIntoView({ block: 'end' });
  const sendBtn = $('#aiSend');
  sendBtn.innerHTML = `<span>${t('aiStop')}</span>`;
  let md = '';
  let frame = 0;
  const paint = () => {
    frame = 0;
    bot.innerHTML = md.trim() ? renderMarkdown(md) : `<span class="thinking">${t('aiThinking')}</span>`;
    log.scrollTop = log.scrollHeight;
  };
  await assistant.send(text, { includeView: includeView ?? $('#aiView').checked }, (ev) => {
    if (ev.type === 'text') {
      md += ev.text;
      if (!frame) frame = requestAnimationFrame(paint);
    } else if (ev.type === 'tool') {
      const div = document.createElement('div');
      div.className = 'msg tool';
      const arg = ev.input.query || ev.input.text || (ev.input.item_ids ? ev.input.item_ids.map((i) => '#' + i).join(' ') : '') || (ev.input.only || ev.input.hide || ev.input.show || []).join(', ') || (ev.input.page ? `${t('page')} ${ev.input.page}` : '');
      div.textContent = `${t('tool_' + ev.name)} ${arg}`.trim();
      log.insertBefore(div, bot);
    } else if (ev.type === 'error') {
      if (!md.trim()) bot.remove();
      if (ev.code !== 'aborted') appendAiError(ev.code, ev.message);
    }
  });
  cancelAnimationFrame(frame);
  if (bot.isConnected) {
    if (md.trim()) paint();
    else bot.remove();
  }
  sendBtn.innerHTML = `<span>${t('aiSend')}</span>`;
}

$('#aiLog').addEventListener('click', (ev) => {
  const ref = ev.target.closest('.ref');
  if (!ref) return;
  const id = Number(ref.dataset.item);
  if (activeSpace()?.scene.items[id]) {
    state.selection = [id];
    showProperties();
    zoomToItems([id]);
  }
});

$('#aiForm').addEventListener('submit', (ev) => {
  ev.preventDefault();
  if (assistant.busy) { assistant.stop(); return; }
  const input = $('#aiInput');
  const text = input.value;
  input.value = '';
  sendAi(text);
});
$('#aiInput').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
    ev.preventDefault();
    $('#aiForm').requestSubmit();
  }
});

// ---------------------------------------------------------------- settings
function openSettings() {
  const s = assistant.settings;
  $('#sTheme').value = state.theme;
  $('#sLw').checked = state.showLw;
  $('#sKey').value = s.apiKey;
  $('#sModel').value = s.model;
  $('#sEffort').value = s.effort;
  $('#settingsDialog').showModal();
}

$('#settingsDialog').addEventListener('close', () => {
  if ($('#settingsDialog').returnValue !== 'save') return;
  state.theme = $('#sTheme').value;
  state.showLw = $('#sLw').checked;
  saveUiPrefs();
  assistant.saveSettings({ apiKey: $('#sKey').value.trim(), model: $('#sModel').value, effort: $('#sEffort').value });
  viewer.setTheme(THEMES[state.theme]);
  toast(t('saved'));
  const errs = $$('#aiLog .msg.error');
  if (assistant.settings.apiKey) errs.forEach((e) => e.remove());
});

// ---------------------------------------------------------------- printing
function openPrint() {
  const dlg = $('#printDialog');
  const isPdf = state.doc.kind === 'pdf';
  $('.print-grid', dlg).hidden = isPdf;
  $('#pdfPrint').hidden = !isPdf;
  $('#pDownload span').textContent = isPdf ? t('downloadOriginal') : t('downloadPdf');
  if (!isPdf) {
    const p = state.print;
    $('#pPaper').innerHTML = Object.keys(PAPERS).map((k) => `<option>${k}</option>`).join('');
    $('#pScale').innerHTML = `<option value="fit">${t('fit')}</option>` + SCALES.map((s) => `<option value="${s}">1:${s}</option>`).join('');
    $('#pPaper').value = p.paper;
    $('#pOrient').value = p.orientation;
    $('#pArea').value = p.area === 'window' && !p.window ? 'extents' : p.area;
    $('#pScale').value = p.scale;
    $('#pColor').value = p.color;
    $('#pLw').checked = p.lw;
    $('#pStamp').checked = p.stamp;
  }
  dlg.showModal();
  if (!isPdf) updatePrintPreview();
}

function readPrintOptions() {
  const p = state.print;
  p.paper = $('#pPaper').value;
  p.orientation = $('#pOrient').value;
  p.area = $('#pArea').value;
  p.scale = $('#pScale').value;
  p.color = $('#pColor').value;
  p.lw = $('#pLw').checked;
  p.stamp = $('#pStamp').checked;
  return p;
}

function plotOptions() {
  const p = readPrintOptions();
  const sp = activeSpace();
  let area = sp.scene.bbox;
  if (p.area === 'view') area = viewer.visibleBounds();
  if (p.area === 'window' && p.window) area = p.window;
  return {
    paper: p.paper, orientation: p.orientation, area,
    scaleMode: p.scale === 'fit' ? 'fit' : 'ratio', ratio: Number(p.scale),
    colorMode: p.color, lineweights: p.lw, stamp: p.stamp,
    hidden: isHidden, units: state.doc.drawing.units,
    title: `${state.doc.drawing.fileName}${sp.isLayout ? ' – ' + sp.name : ''}`,
    model: sp.isLayout ? state.doc.spaces[0].scene : null,
  };
}

function updatePrintPreview() {
  const sp = activeSpace();
  const o = plotOptions();
  const plan = planPlot(sp.scene, o.units, o);
  const c = $('#pPreview');
  const maxW = 520, maxH = 400;
  const k = Math.min(maxW / plan.pageW, maxH / plan.pageH);
  const dpr = window.devicePixelRatio || 1;
  c.width = Math.round(plan.pageW * k * dpr);
  c.height = Math.round(plan.pageH * k * dpr);
  c.style.width = `${plan.pageW * k}px`;
  c.style.height = `${plan.pageH * k}px`;
  const ctx = c.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  // paper mm -> preview px, then drawing units -> paper mm.
  const s = k * dpr;
  const m = plan.margin;
  ctx.save();
  ctx.beginPath();
  ctx.rect(m * s, m * s, (plan.pageW - 2 * m) * s, (plan.pageH - 2 * m - plan.stampH) * s);
  ctx.clip();
  const a = plan.area;
  ctx.setTransform(s * plan.k, 0, 0, -s * plan.k, s * (plan.ox - a[0] * plan.k), s * (plan.oy + a[3] * plan.k));
  const theme = o.colorMode === 'color' ? { bg: '#ffffff', fg: '#000000', mono: false } : { bg: '#ffffff', fg: '#000000', mono: true };
  const vb = [a[0] - (plan.ox / plan.k), a[1] - plan.pageH / plan.k, a[2] + plan.pageW / plan.k, a[3] + plan.oy / plan.k];
  sp.renderer.draw(ctx, { scale: s * plan.k / dpr, bounds: vb, dpr }, { theme, hidden: isHidden, showLw: o.lineweights, model: sp.isLayout ? state.doc.spaces[0].renderer : null });
  ctx.restore();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.strokeStyle = 'rgba(0,0,0,0.25)';
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(m * s, m * s, (plan.pageW - 2 * m) * s, (plan.pageH - 2 * m) * s);
  if (plan.stampH) {
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(m * s, (plan.pageH - m - plan.stampH + 1) * s, (plan.pageW - 2 * m) * s, Math.max(1, 0.3 * s));
  }
  $('#pInfo').textContent = `${o.paper} ${plan.landscape ? t('landscape') : t('portrait')} · ${Math.round(plan.pageW)}×${Math.round(plan.pageH)} mm · ${t('scaleLabel')} ${plan.scaleLabel}`;
}

function makePlotPdf() {
  const sp = activeSpace();
  return exportPdf(sp.scene, plotOptions());
}

function pdfFileName() {
  const base = (state.doc.kind === 'cad' ? state.doc.drawing.fileName : state.doc.pdf.fileName).replace(/\.[^.]+$/, '');
  const sp = activeSpace();
  return `${base}${sp?.isLayout ? '-' + sp.name : ''}.pdf`;
}

function printBlob(blob) {
  const url = URL.createObjectURL(blob);
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  frame.src = url;
  document.body.append(frame);
  frame.onload = () => {
    setTimeout(() => {
      try {
        frame.contentWindow.focus();
        frame.contentWindow.print();
      } catch {
        window.open(url, '_blank');
      }
    }, 250);
  };
  setTimeout(() => { frame.remove(); URL.revokeObjectURL(url); }, 120000);
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

$('#printOptions').addEventListener('change', (ev) => {
  if (ev.target.id === 'pArea' && ev.target.value === 'window') {
    $('#printDialog').close();
    viewer.setTool(new RectTool((bb) => {
      state.print.window = bb;
      state.print.area = 'window';
      setTool('select');
      openPrint();
      $('#pArea').value = 'window';
      updatePrintPreview();
    }, t('pickWindow')));
    return;
  }
  updatePrintPreview();
});

$('#pDownload').addEventListener('click', () => {
  if (state.doc.kind === 'pdf') {
    download(new Blob([state.doc.pdf.buffer], { type: 'application/pdf' }), state.doc.pdf.fileName);
    return;
  }
  makePlotPdf().save(pdfFileName());
});

$('#pPrint').addEventListener('click', () => {
  if (state.doc.kind === 'pdf') {
    printBlob(new Blob([state.doc.pdf.buffer], { type: 'application/pdf' }));
  } else {
    printBlob(makePlotPdf().output('blob'));
  }
  $('#printDialog').close();
});

// ---------------------------------------------------------------- event wiring
function onAction(action, el) {
  switch (action) {
    case 'open': $('#fileInput').click(); break;
    case 'sample': openSample(); break;
    case 'extents': viewer.zoomExtents(); break;
    case 'zoomWindow': setTool(currentTool === 'zoomWindow' ? 'select' : 'zoomWindow'); break;
    case 'zoomIn': viewer.zoomAt(1.5); break;
    case 'zoomOut': viewer.zoomAt(1 / 1.5); break;
    case 'select': setTool('select'); state.selection = []; showProperties(); break;
    case 'measureMenu': toggleMenu(el); break;
    case 'measure:clear': state.measures.length = 0; viewer.renderOverlay(); closeMenus(); break;
    case 'print': openPrint(); break;
    case 'ai': openRight('ai'); break;
    case 'closeRight': closeRight(); break;
    case 'settings': openSettings(); break;
    case 'lang':
      setLang(getLang() === 'ar' ? 'en' : 'ar');
      applyI18n();
      if (state.doc?.kind === 'cad') { state.doc.spaces[0].name = t('model'); buildBlockPanel(); }
      buildSpaceTabs();
      buildInfoPanel();
      showProperties();
      setTool(currentTool);
      break;
    case 'layersAll': state.hidden.clear(); layersChanged(); break;
    case 'layersNone': state.hidden = new Set(state.doc.drawing.layers.keys()); layersChanged(); break;
    case 'layersCsv': {
      const sp = state.doc.spaces[0];
      download(new Blob(['﻿' + layersCsv(sp.analysis, UNIT_NAMES[state.doc.drawing.units])], { type: 'text/csv' }), pdfFileName().replace(/\.pdf$/, '-layers.csv'));
      break;
    }
    case 'bomCsv': {
      const sp = activeSpace();
      download(new Blob(['﻿' + bomCsv(sp.analysis)], { type: 'text/csv' }), pdfFileName().replace(/\.pdf$/, '-BOM.csv'));
      break;
    }
    case 'aiNew': assistant.reset(); showAiIntro(); break;
    case 'toggleSidebar': $('#sidebar').classList.toggle('open'); break;
    default:
      if (action.startsWith('measure:')) { setTool(action); closeMenus(); }
  }
}

document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-action]');
  if (el) { onAction(el.dataset.action, el); return; }
  const tab = ev.target.closest('[data-tab]');
  if (tab) { setSideTab(tab.dataset.tab); return; }
  const rtab = ev.target.closest('[data-rtab]');
  if (rtab) { openRight(rtab.dataset.rtab); return; }
  if (!ev.target.closest('.menu')) closeMenus();
});

function toggleMenu(btn) {
  const menu = $('#measureMenu');
  const open = menu.hidden;
  closeMenus();
  if (!open) return;
  menu.hidden = false;
  const r = btn.getBoundingClientRect();
  menu.style.top = `${r.bottom + 4}px`;
  const rtl = document.documentElement.dir === 'rtl';
  const left = rtl ? r.right - menu.offsetWidth : r.left;
  menu.style.left = `${Math.max(8, Math.min(left, window.innerWidth - menu.offsetWidth - 8))}px`;
}
function closeMenus() { $('#measureMenu').hidden = true; }

// On small screens the drawers close when the drawing is touched.
$('#viewport').addEventListener('pointerdown', () => {
  closeSidebarOnMobile();
  if (window.innerWidth <= 860) closeRight();
});

function closeRight() {
  $('#rightbar').hidden = true;
  document.body.classList.remove('right-open');
}

$('#snapToggle').addEventListener('change', (ev) => { state.snap = ev.target.checked; });
$('#layerFilter').addEventListener('input', buildLayerPanel);
$('#searchInput').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 220); });
$('#fileInput').addEventListener('change', (ev) => {
  const f = ev.target.files[0];
  ev.target.value = '';
  if (f) openFile(f);
});

document.addEventListener('keydown', (ev) => {
  if (ev.target.closest('input, textarea, select, dialog')) return;
  if (viewer.tool?.key?.(ev)) { viewer.renderOverlay(); ev.preventDefault(); return; }
  if (ev.key === 'Escape') {
    if (currentTool !== 'select') setTool('select');
    state.selection = [];
    state.highlights = [];
    showProperties();
    viewer.renderOverlay();
  } else if ((ev.key === 'f' || ev.key === 'F' || ev.key === 'Home') && state.doc) viewer.zoomExtents();
  else if ((ev.key === '+' || ev.key === '=') && state.doc) viewer.zoomAt(1.5);
  else if (ev.key === '-' && state.doc) viewer.zoomAt(1 / 1.5);
  else if (ev.key === 'PageDown' && state.doc?.kind === 'pdf') gotoPage(state.doc.pdf.pageNo + 1);
  else if (ev.key === 'PageUp' && state.doc?.kind === 'pdf') gotoPage(state.doc.pdf.pageNo - 1);
  else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'o') { ev.preventDefault(); $('#fileInput').click(); }
  else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'p' && state.doc) { ev.preventDefault(); openPrint(); }
  else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'f' && state.doc) { ev.preventDefault(); setSideTab('search'); $('#sidebar').classList.add('open'); }
});

// Drag and drop
let dragDepth = 0;
window.addEventListener('dragenter', (ev) => { if (ev.dataTransfer?.types?.includes('Files')) { dragDepth++; document.body.classList.add('dragging'); } });
window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) document.body.classList.remove('dragging'); });
window.addEventListener('dragover', (ev) => ev.preventDefault());
window.addEventListener('drop', (ev) => {
  ev.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  const f = ev.dataTransfer?.files?.[0];
  if (f) openFile(f);
});

// Files opened from the OS when installed as an app (PWA file handling).
if ('launchQueue' in window) {
  window.launchQueue.setConsumer(async (params) => {
    const handle = params.files?.[0];
    if (handle) openFile(await handle.getFile());
  });
}

async function openSample() {
  try {
    showLoading(t('loading'));
    const res = await fetch(new URL('samples/plant.dxf', document.baseURI));
    const blob = await res.blob();
    await openFile(new File([blob], 'plant-room-sample.dxf'));
  } catch (err) {
    toast(`${t('loadError')}: ${err.message}`, true);
    showLoading(null);
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ---------------------------------------------------------------- start
fillIcons();
applyI18n();
updateNeeds();
viewer.setTheme(THEMES[state.theme]);
setTool('select');
showProperties();
if (new URLSearchParams(location.search).has('sample')) openSample();
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register(new URL('sw.js', document.baseURI)).catch(() => {});
}
window.protocad = { state, viewer, openFile };
