import './styles.css';
import { t, useDesktopStrings } from './i18n.js';
import * as platform from './platform.js';
import { fillIcons, icon } from './ui/icons.js';
import { renderMarkdown } from './ui/markdown.js';
import { Viewer } from './render/viewer.js';
import { CadRenderer, measureText, colorCss } from './render/cad-renderer.js';
import { PAPERS, exportPdf, exportImagePdf, planPlot } from './render/pdf-export.js';
import { resolveFormat, openBuffer, acceptAttribute, supportedGroups, formatFor, SNIFF_BYTES, FORMATS, openableExtensions, openableByCategory } from './formats/registry.js';
import { FormatError } from './formats/errors.js';
import { buildScene, updateScene, compactScene, deadRatio, recolorLayer, renameLayerInScene, liveItemCount, STROKE } from './cad/scene.js';
import { UNIT_NAMES } from './cad/drawing.js';
import { polygonArea } from './cad/geometry.js';
import { PickIndex } from './tools/pick.js';
import { analyze, annotateItem, search, bomCsv, layersCsv, drawingSummary, formatNum } from './tools/analysis.js';
import { RectTool, MeasureTool, drawMeasurements, formatLength, formatArea } from './tools/tools.js';
import {
  SelectTool, PanTool, LineTool, PolylineTool, RectangleTool, CircleTool, ArcTool, TextTool, RevCloudTool,
  MoveTool, RotateTool, ScaleTool, MirrorTool, OffsetTool, ImmediateTool,
} from './tools/edit-tools.js';
import { ALIASES } from './tools/cmdline.js';
import { EditDoc } from './edit/model.js';
import { gripsOf } from './edit/entities.js';
import * as ops from './edit/ops.js';
import { writeDxf } from './cad/dxf-writer.js';
import { renderPropsEditor } from './ui/props-editor.js';
import { openColorPicker, closeColorPicker } from './ui/color-picker.js';
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
  try { localStorage.setItem('protocad.ui', JSON.stringify({ theme: state.theme, showLw: state.showLw, editbar: state.editbar, snap: state.snap, ortho: state.ortho })); } catch { /* storage unavailable */ }
}

const prefs = loadUiPrefs();
const state = {
  doc: null, // { kind: 'cad', drawing, spaces, active } | { kind: 'pdf' | 'image', sheet } (page-like documents)
  hidden: new Set(),
  selection: [],
  highlights: [],
  pdfHits: [],
  measures: [],
  theme: THEMES[prefs.theme] ? prefs.theme : 'dark',
  showLw: !!prefs.showLw,
  snap: prefs.snap ?? true,
  ortho: !!prefs.ortho,
  editbar: prefs.editbar ?? window.innerWidth > 860, // the Draw/Modify bar is shown
  edit: null, // EditDoc of the open CAD drawing
  sheetScale: null, // calibrated { factor, unit } for PDFs and images
  print: { paper: 'A3', orientation: 'auto', area: 'extents', scale: 'fit', color: 'mono', lw: true, stamp: true, window: null },
};

const viewer = new Viewer($('#viewport'), {
  onCursor: (w) => updateStatus(w),
  // Keep the zoom % (and the coordinates under a still cursor) current while zooming.
  onView: () => updateStatus(viewer.cursor ? viewer.screenToWorld(...viewer.cursor) : null),
  drawOverlay: (o, v) => drawOverlay(o, v),
});

const isHidden = (layer) => state.hidden.has(layer);
const activeSpace = () => (state.doc?.kind === 'cad' ? state.doc.spaces[state.doc.active] : null);
/** Spaces whose scene exists (layouts are built when first shown). */
const builtSpaces = () => (state.doc?.kind === 'cad' ? state.doc.spaces.filter((sp) => !sp.lazy) : []);
/** Items on locked layers cannot be selected for editing. */
const isLockedItem = (id) => {
  const it = activeSpace()?.scene.items[id];
  return !!(it && state.doc.drawing.layers.get(it.layer)?.locked);
};
const editCtx = () => ({ doc: state.edit, drawing: state.doc.drawing, container: activeSpace().entities, measure: measureText });

// ---------------------------------------------------------------- editor API used by the editing tools
const PREVIEW = '#22d3ee';
const ed = {
  viewer,
  get doc() { return state.edit; },
  get drawing() { return state.doc?.drawing; },
  get space() { return activeSpace(); },
  get origin() { return activeSpace()?.scene.origin ?? { x: 0, y: 0 }; },
  get selection() { return state.selection; },
  get ortho() { return state.ortho; },
  setSelection(ids) {
    state.selection = ids;
    selectionChanged();
  },
  snapPoint(w, from, skip) {
    const sp = activeSpace();
    if (!sp || !state.snap) return null;
    return sp.pick.snap(w[0], w[1], 12 / viewer.view.scale, isHidden, { near: false, from, skip });
  },
  pickAt(x, y, r) {
    const sp = activeSpace();
    return sp ? sp.pick.pick(x, y, r, isHidden, isLockedItem) : null;
  },
  isLocked: isLockedItem,
  itemsInRect(rect, crossing) {
    const sp = activeSpace();
    return sp ? sp.pick.inRect(rect, crossing, isHidden, isLockedItem) : [];
  },
  selectedEntities() {
    const sp = activeSpace();
    return state.selection.map((id) => sp.scene.items[id]).filter((it) => it && !it.deleted && !isLockedItem(it.id)).map((it) => it.ent);
  },
  env() { return { doc: state.edit, drawing: state.doc.drawing, layer: state.edit.currentLayer, textStyle: state.doc.drawing.header.TEXTSTYLE }; },
  previewEnv() { return { doc: { newHandle: () => '' }, drawing: state.doc.drawing, layer: state.edit.currentLayer }; },
  /** Adds entities as one undo step; returns that step. */
  add(ents, label) {
    ops.addEntities(editCtx(), ents, label);
    return state.edit.undoStack.at(-1);
  },
  undoIfLast(step) { if (state.edit.undoStack.at(-1) === step) state.edit.undo(); },
  transformSelection(M, label) {
    const ents = ed.selectedEntities();
    if (!ents.length) return;
    const skipped = ops.transformEntities(editCtx(), ents, M, label);
    if (skipped) toast(`${skipped} ${t('transformSkipped')}`);
  },
  copySelection(M, label = 'Copy') {
    const ents = ed.selectedEntities();
    if (ents.length) ops.copyEntities(editCtx(), ents, M, label);
  },
  offset(ent, dist, side) { return ops.offsetOne(editCtx(), ent, dist, side); },
  applyGrip(grip, x, y) {
    const it = activeSpace().scene.items[grip.item];
    if (!it || it.deleted || isLockedItem(it.id)) return;
    if (grip.kind === 'move' && /DIMENSION|ACAD_TABLE/.test(it.ent.type)) {
      // Their graphics live in a block: move them like the Move command does.
      ops.transformEntities(editCtx(), [it.ent], [1, 0, 0, 1, x - grip.x, y - grip.y], 'Grip edit');
      return;
    }
    // Grips belong to the entity as it was when the grip was shown: find it again by position.
    ops.modifyEntities(editCtx(), [it.ent], (e) => {
      const g = gripsAt(e, it, grip);
      g?.apply(e, x, y);
    }, 'Grip edit');
  },
  gripEnv(it) {
    const o = activeSpace().scene.origin;
    return {
      measure: measureText,
      center: () => (Number.isFinite(it.bb?.[0]) ? [(it.bb[0] + it.bb[2]) / 2 + o.x, (it.bb[1] + it.bb[3]) / 2 + o.y] : null),
    };
  },
  drawItems(o, v, items, color, width) {
    const sp = activeSpace();
    if (!sp) return;
    v.applyTransform(o);
    sp.renderer.drawItems(o, { scale: v.view.scale }, items, color, width);
    o.setTransform(1, 0, 0, 1, 0, 0);
  },
  /** Draws temporary entities (rubber band of the drawing tools, grip edits). */
  drawPreview(o, v, ents) {
    const sp = activeSpace();
    if (!sp || !ents.length) return;
    let scene;
    try { scene = buildScene(state.doc.drawing, ents, { measure: measureText, origin: sp.scene.origin }); } catch { return; }
    const r = new CadRenderer(scene);
    v.applyTransform(o);
    r.drawItems(o, { scale: v.view.scale }, scene.items.map((it) => it.id), PREVIEW, 1.5, false);
    o.setTransform(1, 0, 0, 1, 0, 0);
  },
  /** The selection drawn through a matrix (scene coordinates): move/rotate/scale/mirror preview. */
  drawSelectionMoved(o, v, M) {
    const sp = activeSpace();
    if (!sp || !state.selection.length) return;
    v.applyTransform(o);
    o.transform(...M);
    const k = Math.sqrt(Math.abs(M[0] * M[3] - M[1] * M[2])) || 1;
    sp.renderer.drawItems(o, { scale: v.view.scale * k }, state.selection, PREVIEW, 1.5, false);
    o.setTransform(1, 0, 0, 1, 0, 0);
  },
  typed() { return $('#cmdInput').value; },
  message(text) { toast(text); },
  done() { setTool('select'); },
  refresh() { viewer.renderOverlay(); updateCmdline(); },
  textHeight() { return state.textHeight ?? (state.doc.drawing.header.TEXTSIZE > 0 ? state.doc.drawing.header.TEXTSIZE : 2.5); },
  setTextHeight(h) { state.textHeight = h; },
  lastOffset() { return state.offsetDist ?? 0; },
  setLastOffset(d) { state.offsetDist = d; },
};

/** The grip of entity `e` matching `grip` (computed for the same entity). */
function gripsAt(e, it, grip) {
  return gripsOf(e, ed.gripEnv(it)).find((g) => Math.abs(g.x - grip.x) < 1e-9 && Math.abs(g.y - grip.y) < 1e-9 && g.kind === grip.kind);
}
/** The open PDF or image (page-like documents share paging, measuring and printing). */
const activeSheet = () => state.doc?.sheet ?? null;

const measureEnv = {
  store: state.measures,
  snap: (w, v) => {
    const sp = activeSpace();
    if (!sp || !state.snap) return null;
    return sp.pick.snap(w[0], w[1], 12 / v.view.scale, isHidden);
  },
  units: () => measureUnits(),
  onDone: () => viewer.renderOverlay(),
  onCalibrate: (pts) => openCalibration(Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1])),
};

/** Asks for the real distance between the two calibration points (value + unit). */
function openCalibration(d) {
  const dlg = $('#calibrateDialog');
  const cur = measureUnits();
  $('#calInfo').textContent = `${t('calMeasured')}: ${formatLength(d * cur.factor, cur.unit)}`;
  $('#calValue').value = '';
  try { $('#calUnit').value = localStorage.getItem('protocad.calUnit') || 'm'; } catch { $('#calUnit').value = 'm'; }
  dlg.returnValue = '';
  dlg.onclose = () => {
    const v = parseFloat($('#calValue').value);
    const unit = $('#calUnit').value;
    if (dlg.returnValue === 'ok' && d > 0 && v > 0 && Number.isFinite(v)) {
      try { localStorage.setItem('protocad.calUnit', unit); } catch { /* storage unavailable */ }
      state.sheetScale = { factor: v / d, unit };
      toast(`${t('pdfScale')}: 1 ${activeSheet()?.unit || 'pt'} = ${(v / d).toPrecision(5)} ${unit}`);
      buildInfoPanel();
      viewer.renderOverlay();
    }
    setTool('select');
  };
  dlg.showModal();
  $('#calValue').focus();
}

function measureUnits() {
  if (state.doc?.kind === 'pdf') return state.sheetScale || { factor: 25.4 / 72, unit: 'mm' };
  if (state.doc?.kind === 'image') {
    const mm = state.doc.sheet.mmPerUnit; // from the file's DPI or SVG size, when present
    return state.sheetScale || (mm ? { factor: mm, unit: 'mm' } : { factor: 1, unit: 'px' });
  }
  const units = state.doc?.drawing?.units;
  return { factor: 1, unit: UNIT_NAMES[units] || '' };
}

// ---------------------------------------------------------------- UI text / chrome
function applyI18n() {
  for (const el of $$('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of $$('[data-i18n-title]')) { el.title = t(el.dataset.i18nTitle); el.setAttribute('aria-label', el.title); }
  for (const el of $$('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
  $('#formatsText').textContent = supportedGroups().map((g) => `${t('fmt_' + g.category)}: ${g.labels.join(', ')}`).join(' · ');
  buildQuickPrompts();
}

/**
 * data-needs lists the document kinds an element is shown for: doc, cad, pdf, image, 3d, sheet
 * (pdf + image) or bom (a 3D model with a bill of materials or element list).
 */
function updateNeeds() {
  const kind = state.doc?.kind;
  const has = (need) => (need === 'doc' ? !!kind : need === 'sheet' ? kind === 'pdf' || kind === 'image' : need === 'bom' ? !!state.doc?.model?.bom : need === kind);
  for (const el of $$('[data-needs]')) el.hidden = !el.dataset.needs.split(/\s+/).some(has);
  $('#welcome').hidden = !!kind;
  if (kind !== '3d') $('#sectionPanel').hidden = true;
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
/**
 * Opens any File-like object ({ name, arrayBuffer() }): picker, drag & drop, OS file handling.
 * The format comes from the registry (extension, corrected by the file's first bytes).
 * Resolves to true when the file is shown.
 */
let openSeq = 0; // the load whose result may be shown
let chosenSeq = 0; // order in which files were chosen
let latestLoadable = 0; // the latest chosen file that turned out to be openable
let loading = false; // a load of an openable file is running
let loadAbort = null; // cancels the running load (3D readers in workers) when another file is opened
async function openFile(file, resources = null) {
  // The last file chosen wins: results of earlier, slower loads are dropped. A file that cannot
  // be opened (unsupported, unreadable) does not cancel the one that is loading.
  const chosen = ++chosenSeq;
  let my = -1;
  const current = () => my === openSeq;
  const name = file.name || 'drawing';
  const known = formatFor(name);
  if (known?.category === 'unsupported') { showUnsupported(known.hint, known.label); return false; }
  // Opening another file replaces the drawing: unsaved edits are saved or dropped first.
  if (!(await confirmDiscard())) return false;
  showLoading(t('loading'));
  try {
    const buffer = await file.arrayBuffer();
    const format = resolveFormat(name, new Uint8Array(buffer, 0, Math.min(buffer.byteLength, SNIFF_BYTES)));
    if (!format) {
      toast(t('unsupported'), true, 6000);
      return false;
    }
    if (format.category === 'unsupported') { showUnsupported(format.hint, format.label); return false; }
    if (chosen < latestLoadable) return false; // a file chosen later is already loading
    latestLoadable = chosen;
    my = ++openSeq;
    loading = true;
    loadAbort?.abort();
    const abort = loadAbort = new AbortController();
    const fileSize = buffer.byteLength;
    if (format.category === '3d') showLoading(t('loading3d'));
    const result = await openBuffer(format, buffer, name, {
      signal: abort.signal,
      onProgress: (text) => { if (current()) showLoading(text); },
      resources,
      // Desktop: an OBJ's MTL, a glTF's .bin and textures next to the model.
      readSibling: platform.isDesktop && file.path ? (n) => platform.readSibling(file.path, n) : null,
    });
    if (!current()) { result.sheet?.dispose?.(); result.model?.dispose?.(); return false; }
    if (result.kind === '3d') {
      showLoading(t('building'));
      await nextFrame();
      if (!current()) { result.model.dispose?.(); return false; }
      await set3dDoc(result.model, fileSize);
    } else if (result.kind === 'cad') {
      showLoading(t('building'));
      await nextFrame();
      if (!current()) return false;
      setCadDoc(result.drawing, file.path ?? null);
      if (result.drawing.warnings.includes('truncated')) toast(t('fileTruncated'), false, 7000);
      if (result.drawing.warnings.includes('limit')) toast(t('fileTooLarge'), false, 7000);
      if (result.drawing.warnings.includes('dwgErrors')) toast(t('dwgErrors'), false, 8000);
    } else {
      setSheetDoc(result.kind, result.sheet);
    }
    state.doc.path = file.path ?? null;
    updateTitle();
    return true;
  } catch (err) {
    if (my !== -1 && !current()) return false;
    // Unreadable files are expected; only unexpected failures are logged as errors.
    if (err instanceof FormatError) console.warn(err.message);
    else console.error(err);
    if (err?.hint && err.hint !== 'unknown') showUnsupported(err.hint, err.label || formatFor(name)?.label);
    else toast(`${t('loadError')}: ${err?.message || err}`, true, 7000);
    return false;
  } finally {
    if (current()) loading = false;
    if (!loading) showLoading(null);
  }
}

/** Opens a file from disk (desktop) and adds it to the recent files once it is shown. */
async function openDiskFile(file, resources = null) {
  if (await openFile(file, resources)) platform.addRecent(file.path);
}

/**
 * Files handed over by the system (drag & drop, double-click, Open with, several files chosen):
 * one opens. A 3D model opened with other files (OBJ + MTL + textures, glTF + .bin) gets them
 * as its resources.
 */
function openHandedFiles(files, errors = []) {
  const main = files.find((f) => formatFor(f.name)?.category === '3d' && !/\.(mtl|bin)$/i.test(f.name)) ?? files[0];
  const is3d = formatFor(main?.name)?.category === '3d';
  const resources = is3d && files.length > 1 ? new Map(files.filter((f) => f !== main).map((f) => [f.name, f])) : null;
  if (main) (platform.isDesktop ? openDiskFile : openFile)(main, resources);
  const notes = [...errors];
  if (files.length > 1 && !resources) notes.push(t('oneFileAtATime'));
  if (notes.length) toast(notes.join(' '), errors.length > 0, errors.length ? 10000 : 5000);
}

/** File type filters of the desktop Open dialog, from the format registry. */
function openFilters() {
  return [
    { name: t('allSupported'), extensions: openableExtensions() },
    ...openableByCategory().map((g) => ({ name: `${t('fmt_' + g.category)} (${g.extensions.map((e) => e.toUpperCase()).join(', ')})`, extensions: g.extensions })),
    { name: t('allFiles'), extensions: ['*'] },
  ];
}

/** Toolbar, Ctrl+O and File > Open: the native Open dialog on desktop, the file input on the web. */
function chooseFile() {
  if (!platform.isDesktop) { $('#fileInput').click(); return; }
  platform.openDialog(openFilters()).then((file) => file && openDiskFile(file), (err) => toast(`${t('loadError')}: ${err.message}`, true, 7000));
}

/** Explains why a known format cannot be opened and which export to use instead. */
function showUnsupported(hint, label) {
  if (!loading) showLoading(null);
  const dlg = $('#unsupportedDialog');
  $('#unsupportedTitle').textContent = t('unsupportedTitle').replace('{fmt}', label || t('thisFile'));
  $('#unsupportedText').textContent = t('hint_' + hint) === 'hint_' + hint ? t('unsupported') : t('hint_' + hint);
  dlg.showModal();
}

function makeSpace(drawing, name, entities, isLayout) {
  const scene = buildScene(drawing, entities, { measure: measureText, origin: isLayout ? { x: 0, y: 0 } : undefined });
  const renderer = new CadRenderer(scene);
  const sp = { name, entities, scene, renderer, pick: new PickIndex(scene), isLayout, analysisDirty: false, cached: analyze(drawing, scene) };
  // After edits the totals (layer counts, BOM, search index) are recomputed when next needed.
  Object.defineProperty(sp, 'analysis', {
    get() {
      if (this.analysisDirty) { this.cached = analyze(drawing, this.scene, false); this.analysisDirty = false; }
      return this.cached;
    },
  });
  return sp;
}

function resetDocState() {
  // A file opened from outside (menu, Explorer, drag & drop) replaces the document under any
  // dialog that belongs to the previous one.
  for (const id of ['#printDialog', '#calibrateDialog']) if ($(id).open) $(id).close();
  activeSheet()?.dispose?.();
  if (state.doc?.kind === '3d') state.doc.view?.dispose();
  // Panels refreshed below must not show the old document (the caller sets the new one).
  state.doc = null;
  closeMenus();
  aiImage = { key: null, url: null }; // the assistant's copy of the previous picture
  state.selection = [];
  state.highlights = [];
  state.pdfHits = [];
  state.measures.length = 0;
  state.sheetScale = null;
  state.edit = null;
  state.textHeight = null;
  state.offsetDist = null;
  closeColorPicker();
  $('#cmdInput').value = '';
  state.print.window = null;
  state.print.area = 'extents';
  thumbObserver?.disconnect();
  $('#thumbs').innerHTML = '';
  showProperties();
  assistant.reset();
  $('#aiLog').innerHTML = '';
  $('#searchInput').value = '';
  // Keys typed after opening a file should reach the viewer, not a search box focused for the old one.
  if (document.activeElement === $('#searchInput')) $('#searchInput').blur();
  $('#searchList').innerHTML = '';
  $('#searchCount').textContent = '';
}

function setCadDoc(drawing, path = null) {
  resetDocState();
  const model = makeSpace(drawing, t('model'), drawing.modelEntities, false);
  const spaces = [model, ...drawing.layouts.map((l) => ({ name: l.name, entities: l.entities, isLayout: true, lazy: true }))];
  state.doc = { kind: 'cad', drawing, spaces, active: 0, path };
  state.edit = new EditDoc(drawing);
  state.edit.onChange(applyChange);
  state.hidden = new Set([...drawing.layers.values()].filter((l) => !l.visible).map((l) => l.name));
  updateNeeds();
  activateSpace(0);
  buildLayerPanel();
  buildInfoPanel();
  setSideTab(window.innerWidth > 860 ? 'layers' : null);
  setTool('select');
  updateEditUi();
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
  if (currentTool !== 'select' && !currentTool.startsWith('measure') && currentTool !== 'pan') setTool('select');
  const model = doc.spaces[0];
  viewer.setDocument({
    bbox: sp.scene.bbox,
    draw: (ctx, view, theme) => sp.renderer.draw(ctx, view, { theme, hidden: isHidden, showLw: state.showLw, model: sp.isLayout ? model.renderer : null }),
  });
  buildSpaceTabs();
  buildBlockPanel();
  showProperties();
}

function setSheetDoc(kind, sheet) {
  resetDocState();
  state.doc = { kind, sheet };
  updateNeeds();
  // Drop the previous drawing's layer and block lists (their handlers hold its scenes).
  buildLayerPanel();
  buildBlockPanel();
  viewer.setDocument(sheet);
  buildSpaceTabs();
  buildThumbs();
  buildInfoPanel();
  setSideTab(window.innerWidth > 860 && sheet.pageCount > 1 ? 'pages' : null);
  setTool('select');
  updateEditUi();
  if (!$('#rightbar').hidden && $('#rightTabs .active')?.dataset.rtab === 'ai') showAiIntro();
}

let doc3dModule = null;
/** Shows a 3D model (IFC, STEP, PCF, mesh formats) in the 3D viewport. */
async function set3dDoc(model, fileSize = 0) {
  const { Doc3D, sharedViewer } = await (doc3dModule ??= import('./view3d/doc3d.js'));
  try {
    sharedViewer();
  } catch (err) {
    // No WebGL (old graphics driver, hardware acceleration turned off): keep the open document.
    model.dispose?.();
    throw new Error(t('noWebgl'), { cause: err });
  }
  resetDocState();
  viewer.setDocument(null); // the 2D viewer lets go of the previous drawing
  state.doc = { kind: '3d', model, fileSize };
  updateNeeds();
  let view;
  try {
    view = new Doc3D(model, {
      t, toast, icon, escapeHtml, theme: THEMES[state.theme],
      onSelection: () => { showProperties(); updateStatus(); updateSelectionStatus(); },
      onStatus: (p) => updateStatus(p),
    });
  } catch (err) {
    model.dispose?.();
    state.doc = null;
    updateNeeds();
    throw err;
  }
  state.doc.view = view;
  view.setSnap(state.snap);
  $('#projLabel').textContent = view.ortho ? 'ORTHO' : 'PERSP';
  $('#wireBtn').classList.remove('active');
  $('#xrayBtn').classList.remove('active');
  buildLayerPanel();
  buildBlockPanel();
  buildSpaceTabs();
  buildInfoPanel();
  setSideTab(window.innerWidth > 860 ? 'model' : null);
  setTool('select');
  updateEditUi();
  updateStatus();
  showProperties();
  if (!$('#rightbar').hidden && $('#rightTabs .active')?.dataset.rtab === 'ai') showAiIntro();
}

/** The open 3D document's controller (Doc3D), or null. */
const view3d = () => (state.doc?.kind === '3d' ? state.doc.view ?? null : null);
function zoomExtentsActive() { if (view3d()) view3d().zoomExtents(); else viewer.zoomExtents(); }
function zoomActive(f) { if (view3d()) view3d().zoomAt(1 / f); else viewer.zoomAt(f); }

async function gotoPage(n) {
  const sheet = activeSheet();
  if (!sheet || n < 1 || n > sheet.pageCount || n === sheet.pageNo) return;
  try {
    await sheet.setPage(n);
  } catch (err) {
    toast(`${t('loadError')}: ${err?.message || err}`, true);
    return;
  }
  viewer.setDocument(sheet);
  buildInfoPanel();
  state.measures.length = 0;
  buildSpaceTabs();
  for (const el of $$('.thumb')) el.classList.toggle('active', +el.dataset.page === n);
}

// ---------------------------------------------------------------- overlay & status
function drawOverlay(o, v) {
  // Tools change their step on clicks too: keep the command line's prompt current.
  updateCmdline();
  const sp = activeSpace();
  if (sp) {
    if (state.highlights.length) ed.drawItems(o, v, state.highlights, '#22d3ee', 3);
    if (state.selection.length) ed.drawItems(o, v, state.selection, '#ff9f1c', 3);
  }
  if (state.doc?.kind === 'pdf' && state.pdfHits.length) {
    const page = state.doc.sheet.pageNo;
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
  if (state.doc.kind === '3d') { el.textContent = state.doc.view?.statusText(w) ?? ''; return; }
  const parts = [];
  if (w) {
    if (state.doc.kind === 'cad') {
      const o = activeSpace().scene.origin;
      parts.push(`X ${formatNum(w[0] + o.x, 3)}  Y ${formatNum(w[1] + o.y, 3)}`);
    } else {
      const { factor, unit } = measureUnits();
      // Images count Y from the top, like image editors.
      const y = state.doc.kind === 'image' ? activeSheet().height - w[1] : w[1];
      parts.push(`X ${formatNum(w[0] * factor, 2)}  Y ${formatNum(y * factor, 2)} ${unit}`);
    }
  }
  if (state.doc.kind === 'cad') {
    const u = UNIT_NAMES[state.doc.drawing.units];
    if (u) parts.push(u);
  } else {
    parts.push(`${Math.round((viewer.view.scale * 100) / activeSheet().pxPerUnit)}%`);
  }
  el.textContent = parts.join('   ·   ');
}

// ---------------------------------------------------------------- tools
const EDIT_TOOLS = {
  line: (e) => new LineTool(e),
  polyline: (e) => new PolylineTool(e),
  rectangle: (e) => new RectangleTool(e),
  circle: (e) => new CircleTool(e),
  arc: (e) => new ArcTool(e),
  text: (e) => new TextTool(e),
  revcloud: (e) => new RevCloudTool(e),
  move: (e) => new MoveTool(e, false),
  copy: (e) => new MoveTool(e, true),
  rotate: (e) => new RotateTool(e),
  scale: (e) => new ScaleTool(e),
  mirror: (e) => new MirrorTool(e),
  offset: (e) => new OffsetTool(e),
  erase: (e) => new ImmediateTool(e, 'Erase', eraseSelection),
  explode: (e) => new ImmediateTool(e, 'Explode', explodeSelection),
};

let currentTool = 'select';
let lastCommand = null;
function setTool(name) {
  if (EDIT_TOOLS[name] && !activeSpace()) name = 'select';
  currentTool = name;
  if (state.doc?.kind === '3d') {
    if (name === 'zoomWindow' || EDIT_TOOLS[name] || name.startsWith('measure:') && name !== 'measure:dist') name = currentTool = name.startsWith('measure:') ? 'measure:dist' : 'select';
    state.doc.view?.setTool(name);
  } else if (name === 'select') viewer.setTool(new SelectTool(ed));
  else if (name === 'pan') viewer.setTool(new PanTool());
  else if (name === 'zoomWindow') viewer.setTool(new RectTool((bb) => { viewer.zoomToBox(bb, 0.02); setTool('select'); }, t('zoomWindow')));
  else if (name.startsWith('measure:')) viewer.setTool(new MeasureTool(name.slice(8), measureEnv));
  else if (EDIT_TOOLS[name]) { lastCommand = name; viewer.setTool(EDIT_TOOLS[name](ed)); }
  for (const b of $$('[data-tool]')) {
    const tool = b.dataset.tool;
    b.classList.toggle('active', tool === name || (tool === 'measure' && name.startsWith('measure:')));
  }
  $('[data-action="zoomWindow"]').classList.toggle('active', name === 'zoomWindow');
  updateCmdline();
}

// ---------------------------------------------------------------- editing
/** Applies an edit to the scenes: only changed items are tessellated again (see updateScene). */
function applyChange(c) {
  const doc = state.doc;
  if (doc?.kind !== 'cad') return;
  const t0 = performance.now();
  const active = activeSpace();
  const boxes = [];
  let full = false;
  let panels = false;
  for (const l of c.layers) {
    panels = true;
    if (l.kind === 'rename') {
      for (const sp of builtSpaces()) {
        renameLayerInScene(sp.scene, l.from, l.to);
        sp.renderer.renameLayer(l.from, l.to);
        // The panel shows the cached counts until the totals are recomputed: rename them now.
        for (const st of sp.cached?.layerStats ?? []) if (st.name === l.from) st.name = l.to;
        sp.analysisDirty = true;
      }
      if (state.hidden.delete(l.from)) state.hidden.add(l.to);
      full = true;
    } else if (l.kind === 'color') {
      for (const sp of builtSpaces()) { recolorLayer(sp.scene, l.name, l.rgb); sp.renderer.recolor(l.name, l.rgb); }
      full = true;
    } else if (l.kind === 'delete') state.hidden.delete(l.name);
  }
  // Items that draw a changed block (dimension and table graphics, edited block contents).
  const changedBlocks = c.blocks.size ? blocksUsing(doc.drawing, c.blocks) : null;
  for (const sp of builtSpaces()) {
    const rebuild = [], remove = [];
    for (const e of c.ents) {
      const own = state.edit.owner.get(e);
      const has = sp.scene.itemOf.has(e);
      if (own === sp.entities || (own === undefined && has)) rebuild.push(e);
      else if (has) remove.push(e);
    }
    if (changedBlocks) {
      for (const it of sp.scene.items) {
        if (it.deleted) continue;
        const e = it.ent;
        const name = e.type === 'ACAD_TABLE' ? ops.tableBlockName(doc.drawing, e) : e.type === 'INSERT' ? e.blockName ?? e.name : e.type?.includes('DIMENSION') ? e.name : null;
        if (name && changedBlocks.has(name) && !c.ents.has(e)) rebuild.push(e);
      }
    }
    if (!rebuild.length && !remove.length) continue;
    if (sp !== active) full = full || (!sp.isLayout && active?.isLayout);
    for (const e of [...rebuild, ...remove]) {
      const id = sp.scene.itemOf.get(e);
      if (id !== undefined) boxes.push(sp.scene.items[id].bb.slice());
      if (e.type === 'XLINE' || e.type === 'RAY') full = true;
    }
    const r = updateScene(sp.scene, { rebuild, remove });
    sp.renderer.update(r);
    sp.pick.update(r);
    for (const id of r.items) {
      const it = sp.scene.items[id];
      annotateItem(sp.scene, it);
      if (!it.deleted && sp === active) boxes.push(it.bb);
    }
    sp.analysisDirty = true;
    panels = true;
    if (deadRatio(sp.scene) > 0.3 && sp.scene.prims.length > 20000) scheduleCompaction(sp);
  }
  if (active) state.selection = state.selection.filter((id) => !active.scene.items[id]?.deleted);
  if (full) viewer.render(true);
  else viewer.renderRegion(boxes);
  state.lastEdit = { ms: performance.now() - t0, at: t0 };
  if (panels) schedulePanels(c.layers.length > 0);
  updateEditUi();
  if (state.selection.length || c.layers.length) showProperties();
  updateCmdline();
}

/** Names of the changed blocks and of every block that (indirectly) inserts one of them. */
function blocksUsing(drawing, names) {
  const out = new Set(names);
  let grew = true;
  while (grew) {
    grew = false;
    for (const b of drawing.blocks.values()) {
      if (out.has(b.name)) continue;
      if (b.entities.some((e) => (e.type === 'INSERT' && out.has(e.blockName ?? e.name)) || (e.type?.includes('DIMENSION') && out.has(e.name)))) { out.add(b.name); grew = true; }
    }
  }
  return out;
}

let compactTimer = 0;
/** Drops dead primitives once many accumulated (off the critical path; item ids stay). */
function scheduleCompaction(sp) {
  clearTimeout(compactTimer);
  compactTimer = setTimeout(() => {
    if (!state.doc?.spaces?.includes(sp)) return;
    compactScene(sp.scene);
    sp.renderer = new CadRenderer(sp.scene);
    sp.pick = new PickIndex(sp.scene);
    viewer.render(true);
  }, 1500);
}

let panelTimer = 0;
/** Layer counts, block list and info follow an edit shortly after (they need the totals). */
function schedulePanels(layersNow) {
  if (layersNow) buildLayerPanel(true);
  clearTimeout(panelTimer);
  panelTimer = setTimeout(() => {
    if (state.doc?.kind !== 'cad') return;
    buildLayerPanel();
    buildBlockPanel();
    buildInfoPanel();
    if ($('#searchInput').value.trim()) runSearch();
  }, 350);
}

function selectionChanged() {
  showProperties();
  viewer.renderOverlay();
  updateSelectionStatus();
  updateCmdline();
}

function updateSelectionStatus() {
  const n = view3d() ? view3d().selection.length : state.selection.length;
  const el = $('#selCount');
  el.hidden = !n;
  el.textContent = n ? `${n.toLocaleString('en-US')} ${t('selected')}` : '';
}

/** Title (with * when modified), undo/redo buttons, edit bar, current layer, snap/ortho toggles. */
function updateEditUi() {
  updateTitle();
  const e = state.edit;
  const ub = $('#undoBtn'), rb = $('#redoBtn');
  ub.disabled = !e?.canUndo;
  rb.disabled = !e?.canRedo;
  ub.title = e?.canUndo ? `${t('undo')}: ${e.undoLabel}` : t('undo');
  rb.title = e?.canRedo ? `${t('redo')}: ${e.redoLabel}` : t('redo');
  $('#editbar').hidden = state.doc?.kind !== 'cad' || !state.editbar;
  $('#editToggle').classList.toggle('active', state.editbar);
  $('#snapBtn').classList.toggle('on', state.snap);
  $('#orthoBtn').classList.toggle('on', state.ortho);
  $('#snapToggle').checked = state.snap;
  const sel = $('#curLayer');
  if (state.doc?.kind === 'cad') {
    const cur = e.currentLayer;
    const names = [...state.doc.drawing.layers.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const key = names.join('\n') + '|' + cur;
    if (sel.dataset.key !== key) {
      sel.innerHTML = names.map((n) => `<option ${n === cur ? 'selected' : ''}>${escapeHtml(n)}</option>`).join('');
      sel.dataset.key = key;
    }
  }
  updateSelectionStatus();
}

function updateTitle() {
  const doc = state.doc;
  const name = doc?.kind === 'cad' ? doc.drawing.fileName : doc?.kind === '3d' ? doc.model.fileName : doc?.sheet?.fileName;
  const modified = !!state.edit?.modified;
  document.title = name ? `${modified ? '*' : ''}${name} – ProtoCAD Viewer` : 'ProtoCAD Viewer';
  platform.setModified(modified);
}

function eraseSelection() {
  const ents = ed.selectedEntities();
  if (!ents.length) { toast(t('selectFirst')); return; }
  state.selection = [];
  ops.eraseEntities(editCtx(), ents);
}

function explodeSelection() {
  const ents = ed.selectedEntities();
  if (!ents.length) { toast(t('selectFirst')); return; }
  const { created, skipped, reasons } = ops.explodeEntities(editCtx(), ents);
  if (!created.length && reasons?.length) { toast(`${t('explodeRefused')} ${reasons.join(', ')}`, true, 7000); return; }
  if (!created.length) { toast(t('explodeNone')); return; }
  const sp = activeSpace();
  state.selection = created.map((e) => sp.scene.itemOf.get(e)).filter((id) => id !== undefined);
  selectionChanged();
  if (skipped) toast(`${skipped} of ${ents.length} objects could not be exploded${reasons?.length ? ` (${t('explodeRefused')} ${reasons.join(', ')})` : ''}.`);
}

function selectAll() {
  const sp = activeSpace();
  if (!sp) return;
  state.selection = sp.scene.items.filter((it) => !it.deleted && it.last > it.first && !isHidden(it.layer) && !isLockedItem(it.id)).map((it) => it.id);
  selectionChanged();
}

function undo() {
  if (!state.edit) return;
  // Inside a command, Ctrl+Z first takes back the last point.
  if (viewer.tool?.undoPoint?.()) { viewer.renderOverlay(); updateCmdline(); return; }
  const label = state.edit.undo();
  toast(label ? `${t('undone')}: ${label}` : t('nothingToUndo'), false, 1600);
}

function redo() {
  if (!state.edit) return;
  const label = state.edit.redo();
  toast(label ? `${t('redone')}: ${label}` : t('nothingToRedo'), false, 1600);
}

function setOrtho(on) {
  state.ortho = on;
  saveUiPrefs();
  updateEditUi();
  viewer.renderOverlay();
}

function setSnap(on) {
  state.snap = on;
  view3d()?.setSnap(on);
  saveUiPrefs();
  updateEditUi();
  viewer.renderOverlay();
}

// ---------------------------------------------------------------- command line
/** Shows the active command's prompt; the input takes typed coordinates, values and command aliases. */
function updateCmdline(typing = false) {
  const bar = $('#cmdbar');
  const prompt = viewer.tool?.prompt || '';
  const input = $('#cmdInput');
  const show = state.doc?.kind === 'cad' && (!!prompt || typing || document.activeElement === input || !!input.value);
  if (bar.hidden === show) bar.hidden = !show;
  const text = prompt || 'Command:';
  if ($('#cmdPrompt').textContent !== text) { $('#cmdPrompt').textContent = text; bar.classList.remove('bad'); }
}

function submitCommand(text) {
  const input = $('#cmdInput');
  const tool = viewer.tool;
  if (tool?.prompt && tool.input) {
    let accepted = false;
    try {
      accepted = tool.input(text);
    } catch (err) {
      console.error(err);
      toast(`${t('invalidInput')}: ${err.message}`, true, 4000);
      input.value = '';
      setTool('select');
      return;
    }
    if (!accepted) {
      $('#cmdbar').classList.add('bad');
      toast(`${t('invalidInput')}: ${text}`, true, 2500);
      return;
    }
    input.value = '';
  } else {
    input.value = '';
    const word = text.trim().toUpperCase();
    const cmd = word ? ALIASES[word] : lastCommand;
    if (!cmd) { if (word) toast(`${t('unknownCommand')}: ${text.trim()}`, true, 2500); }
    else runCommand(cmd);
  }
  viewer.renderOverlay();
  updateCmdline();
  // Keep typing into the line while a command waits for text; otherwise the drawing gets the keys back.
  if (!(viewer.tool?.prompt && viewer.tool.inputKind === 'text')) input.blur();
}

function runCommand(cmd) {
  if (state.doc?.kind !== 'cad') return;
  if (cmd === 'undo') undo();
  else if (cmd === 'redo') redo();
  else if (EDIT_TOOLS[cmd]) setTool(cmd);
}

$('#cmdInput').addEventListener('keydown', (ev) => {
  const input = ev.currentTarget;
  if (ev.key === 'Enter' || (ev.key === ' ' && viewer.tool?.inputKind !== 'text' && input.value.trim())) {
    ev.preventDefault();
    submitCommand(input.value);
  } else if (ev.key === 'Escape') {
    ev.preventDefault();
    ev.stopPropagation();
    if (input.value) { input.value = ''; viewer.renderOverlay(); return; }
    input.blur();
    cancelCommand();
  }
});
$('#cmdInput').addEventListener('input', () => { $('#cmdbar').classList.remove('bad'); viewer.renderOverlay(); });
$('#cmdInput').addEventListener('blur', () => setTimeout(() => updateCmdline(), 0));
$('#cmdInput').addEventListener('focus', () => updateCmdline(true));

/** Esc: the tool takes back its step, or the command ends (and the selection clears in Select). */
function cancelCommand() {
  if (viewer.tool?.key?.({ key: 'Escape' })) { viewer.renderOverlay(); updateCmdline(); return; }
  if (currentTool !== 'select') setTool('select');
  else if (state.selection.length || state.highlights.length) { state.selection = []; state.highlights = []; selectionChanged(); }
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
/** Shows a sidebar tab; `focus` puts the cursor in the search box (only when the user asked for Search). */
function setSideTab(name, focus = false) {
  const sb = $('#sidebar');
  if (!name) {
    sb.classList.remove('open');
    name = $('#sideTabs button.active:not([hidden])')?.dataset.tab;
    if (!name || $(`#sideTabs [data-tab="${name}"]`).hidden) name = { pdf: 'search', image: 'info', '3d': 'model' }[state.doc?.kind] || 'layers';
  }
  for (const b of $$('#sideTabs button')) b.classList.toggle('active', b.dataset.tab === name);
  for (const p of $$('.tab-panel')) p.classList.toggle('active', p.dataset.panel === name);
  if (name === 'search' && focus) setTimeout(() => $('#searchInput').focus(), 0);
}

/**
 * Layers: visibility (eye, click the row; double-click isolates), lock, colour, current layer
 * (bold with a check), and a row menu to make current, rename, recolour, lock or delete.
 * `stale` reuses the last counts (they are recomputed shortly after an edit).
 */
function buildLayerPanel(stale = false) {
  const ul = $('#layerList');
  const doc = state.doc;
  if (doc?.kind !== 'cad') { ul.innerHTML = ''; return; }
  const sp0 = doc.spaces[0];
  const analysis = stale && sp0.analysisDirty ? sp0.cached : sp0.analysis;
  const counts = new Map(analysis.layerStats.map((s) => [s.name, s]));
  const filter = $('#layerFilter').value.trim().toLowerCase();
  const theme = { ...THEMES.dark };
  const current = state.edit?.currentLayer;
  const layers = [...doc.drawing.layers.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  ul.innerHTML = '';
  for (const l of layers) {
    if (filter && !l.name.toLowerCase().includes(filter)) continue;
    const s = counts.get(l.name);
    const li = document.createElement('li');
    const on = !state.hidden.has(l.name);
    li.classList.toggle('off', !on);
    li.classList.toggle('current', l.name === current);
    li.dataset.layer = l.name;
    li.innerHTML = `<button class="eye ${on ? 'on' : ''}" type="button">${icon(on ? 'eye' : 'eyeOff')}</button>
      <button class="row-btn lock ${l.locked ? 'on' : ''}" type="button" title="${escapeHtml(l.locked ? t('layerUnlock') : t('layerLock'))}">${icon(l.locked ? 'lock' : 'unlock')}</button>
      <button class="swatch" type="button" title="${escapeHtml(t('layerColor'))}" style="background:${colorCss(l.rgb, theme)}"></button>
      <span class="name" title="${escapeHtml(l.name)}">${escapeHtml(l.name)}</span>
      ${l.name === current ? `<span class="cur-mark" title="${escapeHtml(t('layerCurrent'))}">${icon('check')}</span>` : ''}
      <span class="count">${s ? s.entities : 0}</span>
      <button class="row-btn more" type="button" title="${escapeHtml(t('layerRename'))}…">${icon('more')}</button>`;
    li.title = [s?.length ? `${t('length')}: ${formatLength(s.length, UNIT_NAMES[doc.drawing.units])}` : '', l.locked ? t('layerLocked') : ''].filter(Boolean).join('\n');
    li.addEventListener('click', (ev) => {
      if (ev.target.closest('.lock')) { layerOp(() => state.edit.setLayerLock(l.name, !l.locked)); return; }
      if (ev.target.closest('.swatch')) { pickLayerColor(ev.target.closest('.swatch'), l); return; }
      // The page-wide click handler closes menus: this click opens one.
      if (ev.target.closest('.more')) { ev.stopPropagation(); openLayerMenu(ev.target.closest('.more'), l); return; }
      if (ev.target.closest('.rename')) return;
      if (state.hidden.has(l.name)) state.hidden.delete(l.name);
      else state.hidden.add(l.name);
      layersChanged();
    });
    li.addEventListener('dblclick', (ev) => {
      if (ev.target.closest('button, .rename')) return;
      ev.preventDefault();
      state.hidden = new Set([...doc.drawing.layers.keys()].filter((n) => n !== l.name));
      layersChanged();
    });
    ul.append(li);
  }
}

/** Runs a layer edit, reporting why it was refused (name taken, layer not empty...). */
function layerOp(fn) {
  try { fn(); } catch (err) { toast(err.message, true, 5000); }
}

function pickLayerColor(anchor, l) {
  openColorPicker(anchor, {
    value: { colorIndex: l.aci, color: l.trueColor ?? undefined }, allowBy: false, title: `${t('layer')} ${l.name}`,
    onPick: (v) => layerOp(() => state.edit.setLayerColor(l.name, v.colorIndex === 256 ? l.aci : v.colorIndex, typeof v.color === 'number' ? v.color : null)),
  });
}

function openLayerMenu(anchor, l) {
  closeMenus();
  const menu = $('#layerMenu');
  menu.innerHTML = `<button data-op="current">${icon('check')}<span>${t('layerSetCurrent')}</span></button>
    <button data-op="rename">${icon('edit')}<span>${t('layerRename')}</span></button>
    <button data-op="color">${icon('sparkle')}<span>${t('layerColor')}</span></button>
    <button data-op="lock">${icon(l.locked ? 'unlock' : 'lock')}<span>${l.locked ? t('layerUnlock') : t('layerLock')}</span></button>
    <hr /><button data-op="delete">${icon('trash')}<span>${t('layerDelete')}</span></button>`;
  menu.hidden = false;
  const r = anchor.getBoundingClientRect();
  menu.style.top = `${Math.min(r.bottom + 4, window.innerHeight - menu.offsetHeight - 8)}px`;
  menu.style.left = `${Math.max(8, Math.min(r.left - menu.offsetWidth + r.width, window.innerWidth - menu.offsetWidth - 8))}px`;
  menu.onclick = (ev) => {
    const op = ev.target.closest('[data-op]')?.dataset.op;
    if (!op) return;
    menu.hidden = true;
    if (op === 'current') layerOp(() => state.edit.setCurrentLayer(l.name));
    else if (op === 'rename') startRename(l.name);
    else if (op === 'color') pickLayerColor(anchor, l);
    else if (op === 'lock') layerOp(() => state.edit.setLayerLock(l.name, !l.locked));
    else if (op === 'delete') layerOp(() => state.edit.deleteLayer(l.name));
  };
}

/** Inline rename in the layer list (Enter applies, Esc cancels). */
function startRename(name) {
  const li = [...$$('#layerList li')].find((x) => x.dataset.layer === name);
  if (!li) return;
  const span = li.querySelector('.name');
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'rename';
  input.value = name;
  input.dir = 'auto';
  span.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (apply) => {
    if (done) return;
    done = true;
    if (apply && input.value.trim() && input.value.trim() !== name) layerOp(() => state.edit.renameLayer(name, input.value));
    buildLayerPanel(true);
  };
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

function newLayer() {
  if (!state.edit) return;
  let n = 1;
  while ([...state.doc.drawing.layers.keys()].some((k) => k.toLowerCase() === `${t('newLayerName')}${n}`.toLowerCase())) n++;
  const name = `${t('newLayerName')}${n}`;
  layerOp(() => state.edit.newLayer(name));
  $('#layerFilter').value = '';
  buildLayerPanel(true);
  startRename(name);
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
      [t('entities'), String(liveItemCount(sp.scene))], [t('layers'), String(d.layers.size)],
      // DGN cells are stored as anonymous blocks, so count the cell names in use instead.
      [t('blocks'), String(d.source === 'dgn' ? sp.analysis.blocks.length : [...d.blocks.keys()].filter((n) => !n.startsWith('*')).length)],
      ['Layouts', d.layouts.map((l) => l.name).join(', ') || '-']);
    if (sp.scene.warnings.length) rows.push([t('warnings'), sp.scene.warnings.slice(0, 12).join(', ')]);
  } else if (doc?.kind === '3d') {
    const m = doc.model;
    rows.push([t('file'), m.fileName], ...m.info);
    const b = doc.view?.sm.bbox();
    if (b) rows.push([t('size'), `${[0, 1, 2].map((k) => formatNum(b[k + 3] - b[k])).join(' × ')} ${m.units?.label ?? ''}`.trim()]);
    if (doc.fileSize) rows.push([t('fileSize'), formatBytes(doc.fileSize)]);
  } else if (doc?.kind === 'pdf') {
    const pdf = doc.sheet;
    rows.push([t('file'), pdf.fileName], [t('format'), 'PDF'], [t('pages'), String(pdf.pageCount)],
      [t('size'), `${formatNum(pdf.bbox[2] * 25.4 / 72, 0)} × ${formatNum(pdf.bbox[3] * 25.4 / 72, 0)} mm`]);
  } else if (doc?.kind === 'image') {
    const img = doc.sheet;
    rows.push([t('file'), img.fileName], [t('format'), img.format], [t('pixelSize'), `${formatNum(img.pixelWidth, 0)} × ${formatNum(img.pixelHeight, 0)} px`]);
    if (img.reducedTo) rows.push([t('shownAt'), `${formatNum(img.reducedTo[0], 0)} × ${formatNum(img.reducedTo[1], 0)} px (${t('reducedForMemory')})`]);
    if (img.pageCount > 1) rows.push([t('pages'), `${img.pageNo} / ${img.pageCount}`]);
    if (img.dpi) {
      const d = img.dpi.x === img.dpi.y ? formatNum(img.dpi.x, 1) : `${formatNum(img.dpi.x, 1)} × ${formatNum(img.dpi.y, 1)}`;
      rows.push([t('resolution'), img.mmPerUnit
        ? `${d} dpi · ${formatNum(img.width * img.mmPerUnit, 0)} × ${formatNum(img.height * img.mmPerUnit, 0)} mm`
        : `${d} dpi (${t('screenDpi')})`]);
    }
    rows.push([t('fileSize'), formatBytes(img.buffer.byteLength)]);
    if (state.sheetScale) rows.push([t('pdfScale'), `1 px = ${state.sheetScale.factor.toPrecision(4)} ${state.sheetScale.unit}`]);
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
  } else if (doc?.kind === 'pdf' || doc?.sheet?.pageCount > 1) {
    const pdf = doc.sheet;
    const wrap = document.createElement('span');
    wrap.className = 'pager';
    wrap.innerHTML = `<button data-p="-1">${icon('prev')}</button><span>${t('page')} ${pdf.pageNo} ${t('of')} ${pdf.pageCount}</span><button data-p="1">${icon('next')}</button>`;
    wrap.addEventListener('click', (ev) => {
      const b = ev.target.closest('button');
      if (b) gotoPage(pdf.pageNo + Number(b.dataset.p));
    });
    host.append(wrap);
  }
}

let thumbObserver = null;
function buildThumbs() {
  const host = $('#thumbs');
  host.innerHTML = '';
  thumbObserver?.disconnect();
  const pdf = activeSheet();
  // Thumbnails are rendered one at a time, only once they scroll into view.
  const queue = [];
  let busy = false;
  const pump = async () => {
    if (busy) return;
    busy = true;
    while (queue.length && activeSheet() === pdf) {
      const el = queue.shift();
      try { el.prepend(await pdf.thumbnail(+el.dataset.page)); } catch { /* page could not be rendered */ }
      await new Promise((r) => setTimeout(r, 0));
    }
    busy = false;
  };
  const io = thumbObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting || e.target.dataset.done) continue;
      e.target.dataset.done = '1';
      queue.push(e.target);
    }
    pump();
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
  if (!q.trim() || !doc) { state.highlights = []; state.pdfHits = []; view3d()?.highlight([]); viewer.renderOverlay(); return; }
  if (doc.kind === '3d') {
    const v = doc.view;
    const ids = await v.search(q);
    if ($('#searchInput').value !== q || state.doc !== doc) return;
    v.highlight(ids);
    $('#searchCount').textContent = ids.length ? `${ids.length >= 500 ? '500+' : ids.length} ${t('results')}` : t('noResults');
    for (const id of ids) {
      const d = v.describe(id);
      const li = document.createElement('li');
      li.innerHTML = `<span class="name"><bdi>${escapeHtml(d.name)}</bdi><span class="sub">${escapeHtml([d.type, d.where].filter(Boolean).join(' · '))}</span></span>`;
      li.addEventListener('click', () => { v.select([id], true); v.reveal(id); closeSidebarOnMobile(); });
      ul.append(li);
    }
    return;
  }
  if (doc.kind === 'cad') {
    const sp = activeSpace();
    const res = search(sp.analysis, q);
    state.highlights = res.filter((r) => r.item !== undefined).map((r) => r.item);
    $('#searchCount').textContent = res.length ? `${res.length} ${t('results')}` : t('noResults');
    for (const r of res) {
      const li = document.createElement('li');
      if (r.kind === 'layer') {
        li.innerHTML = `<span class="name"><bdi>${escapeHtml(r.text)}</bdi></span><span class="tag">${t('layer')}</span>`;
        li.addEventListener('click', () => {
          state.hidden = new Set([...doc.drawing.layers.keys()].filter((n) => n !== r.layer));
          layersChanged();
        });
      } else {
        const it = sp.scene.items[r.item];
        li.innerHTML = `<span class="name"><bdi>${escapeHtml(r.text)}</bdi><span class="sub">${escapeHtml(it.layer)} · ${escapeHtml(it.type)}</span></span>`;
        li.addEventListener('click', () => {
          state.selection = [r.item];
          selectionChanged();
          zoomToItems([r.item]);
          closeSidebarOnMobile();
        });
      }
      ul.append(li);
    }
    viewer.renderOverlay();
  } else {
    const hits = await doc.sheet.search(q);
    if ($('#searchInput').value !== q) return;
    state.pdfHits = hits;
    $('#searchCount').textContent = hits.length ? `${hits.length} ${t('results')}` : doc.kind === 'image' ? t('imageNoText') : t('noResults');
    for (const h of hits) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="name"><bdi>${escapeHtml(h.text)}</bdi></span><span class="tag">${t('page')} ${h.page}</span>`;
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
  if (view3d()) {
    const v = view3d();
    $('#propsFab').hidden = !v.selection.length;
    v.renderProps(dl);
    if (v.selection.length && window.innerWidth > 860 && $('#rightbar').hidden) openRight('props');
    return;
  }
  const sp = activeSpace();
  const items = sp ? state.selection.map((id) => sp.scene.items[id]).filter((it) => it && !it.deleted) : [];
  // On phones the panel is a drawer: a button offers it while something is selected.
  $('#propsFab').hidden = !items.length;
  if (!items.length) {
    dl.innerHTML = `<div class="empty">${t('nothingSelected')}</div>`;
    return;
  }
  if (dl.contains(document.activeElement) && document.activeElement.matches('input, textarea')) {
    // Do not replace a field the user is typing in; it refreshes on commit.
    if (dl.dataset.sel === state.selection.join(',')) return;
  }
  dl.dataset.sel = state.selection.join(',');
  const it = items[0];
  const e = it.ent;
  const unit = UNIT_NAMES[state.doc.drawing.units] || '';
  const ro = [];
  if (items.length === 1) {
    if (e.handle) ro.push([t('handle'), e.handle]);
    if (it.text && e.type !== 'TEXT' && e.type !== 'MTEXT') ro.push([t('text'), it.text]);
    if (e.type?.includes('DIMENSION') && Number.isFinite(e.measurement)) ro.push(['Value', formatNum(e.measurement, 3)]);
    if (e.type?.includes('DIMENSION') && e.text && e.text !== '<>') ro.push(['Text override', e.text]);
    if (it.length) ro.push([t('length'), formatLength(it.length, unit)]);
    const closed = sp.scene.prims.slice(it.first, it.last).find((p) => p.k === STROKE && p.closed);
    if (closed && ['LWPOLYLINE', 'POLYLINE2D', 'CIRCLE', 'ELLIPSE'].includes(e.type)) ro.push([t('area'), formatArea(Math.abs(polygonArea(closed.pts)), unit)]);
    if (e.type === 'LINE') ro.push(['Angle', `${(((Math.atan2(e.endPoint.y - e.startPoint.y, e.endPoint.x - e.startPoint.x) * 180) / Math.PI + 360) % 360).toFixed(2)}°`]);
  } else {
    const len = items.reduce((n, x) => n + (x.length || 0), 0);
    if (len) ro.push([t('length'), formatLength(len, unit)]);
  }
  const bb = [Infinity, Infinity, -Infinity, -Infinity];
  for (const x of items) if (Number.isFinite(x.bb?.[0])) { bb[0] = Math.min(bb[0], x.bb[0]); bb[1] = Math.min(bb[1], x.bb[1]); bb[2] = Math.max(bb[2], x.bb[2]); bb[3] = Math.max(bb[3], x.bb[3]); }
  if (Number.isFinite(bb[0])) ro.push([t('size'), `${formatNum(bb[2] - bb[0])} × ${formatNum(bb[3] - bb[1])} ${unit}`]);
  renderPropsEditor(dl, {
    items, drawing: state.doc.drawing, theme: THEMES.dark, readonly: ro,
    locked: items.some((x) => isLockedItem(x.id)),
    firstRgb: sp.scene.prims[it.first]?.rgb,
    modify: (label, fn) => ops.modifyEntities(editCtx(), items.map((x) => x.ent), fn, label),
    pickColor: (anchor, ent, cb) => openColorPicker(anchor, { value: { colorIndex: ent.colorIndex, color: ent.color }, allowBy: true, onPick: cb }),
    toast,
  });
  if (window.innerWidth > 860 && $('#rightbar').hidden) openRight('props');
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
let aiImage = { key: null, url: null };
const assistant = new Assistant({
  async getDocument() {
    const doc = state.doc;
    if (doc.kind === '3d') return { key: `3d|${doc.model.fileName}`, title: doc.model.fileName, text: doc.view.summary() };
    if (doc.kind === 'cad') {
      const sp = activeSpace();
      return { key: `${doc.drawing.fileName}|${sp.name}|v${state.edit?.version ?? 0}`, title: doc.drawing.fileName, text: drawingSummary(doc.drawing, sp.scene, sp.analysis, sp.name) };
    }
    const sheet = doc.sheet;
    if (doc.kind === 'image') {
      // Images carry no text: the page itself goes to the model, encoded once per page.
      const key = `image|${sheet.fileName}|${sheet.pageNo}`;
      if (aiImage.key !== key) {
        let url = null;
        try { url = imageDataUrl(sheet.pageImage(1568)); } catch (err) { console.warn('Page image unavailable for the assistant', err); }
        aiImage = { key, url };
      }
      return {
        key, title: sheet.fileName,
        text: `${sheet.format} image "${sheet.fileName}", ${Math.round(sheet.pixelWidth)} × ${Math.round(sheet.pixelHeight)} pixels, ${formatBytes(sheet.buffer.byteLength)}${sheet.pageCount > 1 ? `, page ${sheet.pageNo} of ${sheet.pageCount}` : ''}. There is no extracted text; ${aiImage.url ? 'the image is attached' : 'the image could not be attached'}.`,
        images: aiImage.url ? [aiImage.url] : [],
      };
    }
    const { text } = await sheet.fullText();
    return { key: `pdf|${sheet.fileName}|${sheet.pageCount}`, title: sheet.fileName, text: `PDF document "${sheet.fileName}", ${sheet.pageCount} page(s). The user is viewing page ${sheet.pageNo}.\n${text}` };
  },
  captureView: () => {
    try {
      return view3d() ? view3d().captureView() : viewer.captureView();
    } catch {
      // e.g. an SVG with embedded HTML makes the canvas unreadable in some browsers
      throw new Error(t('captureFailed'));
    }
  },
  tools: {
    async find_in_drawing({ query }) {
      const doc = state.doc;
      if (doc.kind === '3d') {
        const ids = await doc.view.search(query, 300);
        doc.view.highlight(ids);
        return { total: ids.length, matches: ids.slice(0, 60).map((id) => doc.view.describe(id)) };
      }
      if (doc.kind === 'image') return { matches: [], total: 0, note: 'Images have no searchable text; read the attached image instead.' };
      if (doc.kind === 'pdf') {
        const hits = await doc.sheet.search(query, 60);
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
      if (doc.kind === '3d') {
        const ids = (item_ids || []).filter((i) => doc.model.elements[i]);
        doc.view.highlight(ids);
        if (ids.length) doc.view.zoomTo(ids);
        else doc.view.zoomExtents();
        return { zoomed_to: ids.length };
      }
      if (doc.sheet) {
        if (page) await gotoPage(page);
        if (text && doc.kind === 'pdf') {
          const hits = (await doc.sheet.search(text, 50)).filter((h) => h.page === doc.sheet.pageNo);
          state.pdfHits = hits;
          if (hits[0]) await focusPdfHit(hits[0]);
          return { page: doc.sheet.pageNo, highlighted: hits.length };
        }
        viewer.zoomExtents();
        return { page: doc.sheet.pageNo };
      }
      const ids = (item_ids || []).filter((i) => activeSpace().scene.items[i] && !activeSpace().scene.items[i].deleted);
      state.highlights = ids;
      zoomToItems(ids);
      return { zoomed_to: ids.length };
    },
    async set_layers({ only, show, hide, reset }) {
      if (view3d()) return view3d().setGroups({ only, show, hide, reset });
      const d = state.doc.drawing;
      if (!d) return { error: 'No CAD drawing is open (layers only exist in CAD drawings).' };
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
      if (view3d()) return view3d().details(item_ids);
      const sp = activeSpace();
      if (!sp) return { error: 'No CAD drawing is open' };
      const o = sp.scene.origin;
      return item_ids.slice(0, 50).map((id) => {
        const it = sp.scene.items[id];
        if (!it || it.deleted) return { id, error: 'not found (it may have been erased)' };
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
    // 3D models have their own wording where it differs (bill of materials, review).
    b.addEventListener('click', () => sendAi(t(state.doc?.kind === '3d' && t(k + 'Prompt3d') !== k + 'Prompt3d' ? k + 'Prompt3d' : k + 'Prompt'), k === 'aiQuick4' ? true : undefined));
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
  const map = { 'no-key': 'aiNoKey', auth: 'aiErrAuth', rate: 'aiErrRate', network: 'aiErrNetwork', model: 'aiErrModel', refusal: 'aiErrRefusal', 'max-tokens': 'aiErrMaxTokens', overloaded: 'aiErrOverloaded' };
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
  user.dir = 'auto'; // questions and answers may be in Arabic
  user.textContent = text;
  log.append(user);
  const bot = document.createElement('div');
  bot.className = 'msg bot';
  bot.dir = 'auto';
  bot.innerHTML = `<span class="thinking">${t('aiThinking')}</span>`;
  log.append(bot);
  bot.scrollIntoView({ block: 'end' });
  const sendBtn = $('#aiSend');
  sendBtn.innerHTML = `<span>${t('aiStop')}</span>`;
  let md = '';
  let frame = 0;
  let stopped = false;
  const paint = () => {
    frame = 0;
    bot.innerHTML = md.trim() ? renderMarkdown(md) : stopped ? '' : `<span class="thinking">${t('aiThinking')}</span>`;
    // References to items that do not exist in this drawing stay plain text.
    for (const r of bot.querySelectorAll('.ref')) {
      const ok = view3d() ? !!state.doc.model.elements[+r.dataset.item] : (() => { const it = activeSpace()?.scene.items[+r.dataset.item]; return it && !it.deleted; })();
      if (!ok) r.replaceWith(r.textContent);
    }
    if (stopped) bot.insertAdjacentHTML('beforeend', `<div class="muted small">${t('aiStopped')}</div>`);
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
      if (ev.code === 'aborted') { stopped = true; return; }
      if (!md.trim()) bot.remove();
      appendAiError(ev.code, ev.message);
    }
  });
  cancelAnimationFrame(frame);
  if (bot.isConnected) {
    if (md.trim() || stopped) paint();
    else bot.remove();
  }
  sendBtn.innerHTML = `<span>${t('aiSend')}</span>`;
}

$('#aiLog').addEventListener('click', (ev) => {
  const ref = ev.target.closest('.ref');
  if (!ref) return;
  const id = Number(ref.dataset.item);
  if (view3d()) { if (state.doc.model.elements[id]) { view3d().select([id], true); view3d().reveal(id); } return; }
  const it = activeSpace()?.scene.items[id];
  if (it && !it.deleted) {
    state.selection = [id];
    selectionChanged();
    zoomToItems([id]);
  }
});

$('#aiForm').addEventListener('submit', (ev) => {
  ev.preventDefault();
  // While an answer streams only the Stop button (the send button) stops it.
  if (assistant.busy) { if (ev.submitter?.id === 'aiSend') assistant.stop(); return; }
  const input = $('#aiInput');
  const text = input.value;
  input.value = '';
  sendAi(text);
});
$('#aiInput').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
    ev.preventDefault();
    if (!assistant.busy) $('#aiForm').requestSubmit();
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
  // Esc leaves returnValue unchanged: clear the previous "save" so it cannot save this time.
  $('#settingsDialog').returnValue = '';
  $('#settingsDialog').showModal();
}

$('#settingsDialog').addEventListener('close', () => {
  if ($('#settingsDialog').returnValue !== 'save') return;
  state.theme = $('#sTheme').value;
  state.showLw = $('#sLw').checked;
  saveUiPrefs();
  platform.setThemeMenu(state.theme);
  assistant.saveSettings({ apiKey: $('#sKey').value.trim(), model: $('#sModel').value, effort: $('#sEffort').value });
  viewer.setTheme(THEMES[state.theme]);
  view3d()?.setTheme(THEMES[state.theme]);
  toast(t('saved'));
  const errs = $$('#aiLog .msg.error');
  if (assistant.settings.apiKey) errs.forEach((e) => e.remove());
});

// ---------------------------------------------------------------- printing
/** The print dialog; `toSave` (File > Export PDF) puts the focus on the save button. */
function openPrint(toSave = false) {
  const dlg = $('#printDialog');
  if (dlg.open) return;
  const kind = state.doc.kind;
  const isPdf = kind === 'pdf';
  if (kind === '3d') {
    // The 3D view is printed as a picture: rendered once now, at high resolution, on white.
    try {
      state.snap3d?.dispose();
      state.snap3d = view3d().snapshotSheet();
    } catch (err) {
      toast(`${t('printFailed')}: ${err?.message || err}`, true, 7000);
      return;
    }
  }
  $('.print-grid', dlg).hidden = isPdf;
  $('#pdfPrint').hidden = !isPdf;
  // Images use paper, orientation, area and title strip; scale/colour/lineweights are CAD-only.
  for (const el of $$('[data-print="cad"]', dlg)) el.hidden = kind !== 'cad';
  for (const el of $$('[data-print="area"]', dlg)) el.hidden = kind === '3d';
  for (const el of $$('[data-print="3d"]', dlg)) el.hidden = kind !== '3d';
  $('[data-print="pages"]', dlg).hidden = !(kind === 'image' && state.doc.sheet.pageCount > 1);
  $('#pDownload span').textContent = isPdf ? t('downloadOriginal') : t('downloadPdf');
  $('#pDesktopHint').hidden = !platform.isDesktop;
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
  if (toSave) $('#pDownload').focus();
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
  const sheet = printSheet();
  let area = sp ? sp.scene.bbox : sheet.bbox;
  if (p.area === 'view' && !view3d()) area = viewer.visibleBounds();
  if (p.area === 'window' && p.window && !view3d()) area = p.window;
  if (sheet) {
    // Images: the area is clipped to the picture and always fitted to the paper.
    const b = sheet.bbox;
    area = [Math.max(area[0], b[0]), Math.max(area[1], b[1]), Math.min(area[2], b[2]), Math.min(area[3], b[3])];
    if (area[0] >= area[2] || area[1] >= area[3]) area = b;
    const all = sheet.pageCount > 1 && $('#pPages').value === 'all';
    return { paper: p.paper, orientation: p.orientation, area, scaleMode: 'fit', stamp: p.stamp, pages: all ? 'all' : 'current', title: `${sheet.fileName}${sheet.pageCount > 1 && !all ? ` – ${t('page')} ${sheet.pageNo}` : ''}` };
  }
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
  const plan = planPlot(sp?.scene, o.units, o);
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
  if (sp) {
    ctx.setTransform(s * plan.k, 0, 0, -s * plan.k, s * (plan.ox - a[0] * plan.k), s * (plan.oy + a[3] * plan.k));
    // The preview shows the plot's real colours (the PDF keeps them too).
    const theme = o.colorMode === 'color' ? { bg: '#ffffff', fg: '#000000', mono: false, trueColor: true } : { bg: '#ffffff', fg: '#000000', mono: true };
    const vb = [a[0] - (plan.ox / plan.k), a[1] - plan.pageH / plan.k, a[2] + plan.pageW / plan.k, a[3] + plan.oy / plan.k];
    sp.renderer.draw(ctx, { scale: s * plan.k / dpr, bounds: vb, dpr }, { theme, hidden: isHidden, showLw: o.lineweights, model: sp.isLayout ? state.doc.spaces[0].renderer : null });
  } else {
    const w = (a[2] - a[0]) * plan.k * s, h = (a[3] - a[1]) * plan.k * s;
    ctx.drawImage(printSheet().renderArea(a, w, h), plan.ox * s, plan.oy * s, w, h);
  }
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
  const scale = sp ? ` · ${t('scaleLabel')} ${plan.scaleLabel}` : '';
  $('#pInfo').textContent = `${o.paper} ${plan.landscape ? t('landscape') : t('portrait')} · ${Math.round(plan.pageW)}×${Math.round(plan.pageH)} mm${scale}`;
  $('#pInfo').classList.toggle('warn', !plan.fits);
  if (!plan.fits) $('#pInfo').textContent += ` · ${t('printTooBig')}`;
  const sheet = activeSheet();
  if (sheet?.pageCount > 1 && $('#pPages').value === 'all') $('#pInfo').textContent += ` · ${t('pagesAllCount').replace('{n}', sheet.pageCount)}`;
}

/** What prints for page-like documents: the PDF/image, or the 3D view's snapshot. */
const printSheet = () => (state.doc?.kind === '3d' ? state.snap3d : activeSheet());

function makePlotPdf() {
  const sp = activeSpace();
  if (!sp) return exportImagePdf(printSheet(), plotOptions());
  return exportPdf(sp.scene, plotOptions());
}

function pdfFileName() {
  const base = (state.doc.kind === 'cad' ? state.doc.drawing.fileName : state.doc.kind === '3d' ? state.doc.model.fileName : state.doc.sheet.fileName).replace(/\.[^.]+$/, '');
  const sp = activeSpace();
  return `${base}${sp?.isLayout ? '-' + sp.name : ''}.pdf`;
}

const pdfFilters = () => [{ name: t('pdfFile'), extensions: ['pdf'] }];
const csvFilters = () => [{ name: t('csvFile'), extensions: ['csv'] }];
const pngFilters = () => [{ name: t('pngFile'), extensions: ['png'] }];

/** Saves the 3D view as a PNG (about 3× the screen resolution). */
async function savePng() {
  const v = view3d();
  if (!v) return;
  try {
    await saveAs(await v.pngBlob(), pdfFileName().replace(/\.pdf$/, '.png'), pngFilters());
  } catch (err) {
    toast(`${t('saveFailed')}: ${err?.message || err}`, true, 7000);
  }
}

/** Saves an export: Save dialog on desktop (then says where it went), a download on the web. */
async function saveAs(blob, name, filters) {
  try {
    const path = await platform.saveFile(blob, name, filters, { directory: docFolder() });
    if (path) toast(`${t('savedTo')} ${path}`, false, 6000);
  } catch (err) {
    console.error(err);
    toast(saveError(err), true, 7000);
  }
}

/** Folder of the open file (desktop), where Save dialogs start. */
function docFolder() {
  const p = state.doc?.path;
  return p ? p.slice(0, Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))) || null : null;
}

/** "Could not save the file: …", without repeating it when the message already says so. */
function saveError(err) {
  const msg = err?.message || String(err);
  return /^could not (save|write)/i.test(msg) ? msg : `${t('saveFailed')}: ${msg}`;
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

/** Runs a print/export step, reporting failures (memory, blocked image data…) instead of failing silently. */
async function guarded(fn) {
  try {
    await fn();
  } catch (err) {
    console.error(err);
    toast(`${t('printFailed')}: ${err?.message || err}`, true, 7000);
  }
}

$('#printDialog').addEventListener('close', () => { state.snap3d?.dispose(); state.snap3d = null; });
$('#pPng').addEventListener('click', () => guarded(savePng));

$('#pDownload').addEventListener('click', () => guarded(async () => {
  if (state.doc.kind === 'pdf') {
    await saveAs(new Blob([state.doc.sheet.buffer], { type: 'application/pdf' }), state.doc.sheet.fileName, pdfFilters());
    return;
  }
  await saveAs(makePlotPdf().output('blob'), pdfFileName(), pdfFilters());
}));

$('#pPrint').addEventListener('click', () => guarded(async () => {
  const isPdf = state.doc.kind === 'pdf';
  const blob = isPdf ? new Blob([state.doc.sheet.buffer], { type: 'application/pdf' }) : makePlotPdf().output('blob');
  try {
    await platform.printPdf(blob, isPdf ? state.doc.sheet.fileName : pdfFileName());
  } catch (err) {
    // The PDF exists; only handing it to the PDF app failed (the message says what to do).
    toast(err?.message || String(err), true, 9000);
    return;
  }
  $('#printDialog').close();
  if (platform.isDesktop) toast(t('printOpened'), false, 8000);
}));

// ---------------------------------------------------------------- event wiring
function onAction(action, el) {
  switch (action) {
    case 'open': chooseFile(); break;
    case 'sample': openSample(); break;
    case 'sample3d': openSample('cooling-water.pcf', 'cooling-water-sample.pcf'); break;
    case 'extents': zoomExtentsActive(); break;
    case 'zoomWindow': setTool(currentTool === 'zoomWindow' ? 'select' : 'zoomWindow'); break;
    case 'zoomIn': zoomActive(1.5); break;
    case 'zoomOut': zoomActive(1 / 1.5); break;
    case 'select': setTool('select'); state.selection = []; view3d()?.select([]); selectionChanged(); break;
    case 'pan': setTool(currentTool === 'pan' ? 'select' : 'pan'); break;
    case 'toggleEditbar': state.editbar = !state.editbar; saveUiPrefs(); updateEditUi(); break;
    case 'undo': undo(); break;
    case 'redo': redo(); break;
    case 'save': saveDrawing(false); break;
    case 'saveAs': saveDrawing(true); break;
    case 'layerNew': newLayer(); break;
    case 'measureMenu': toggleMenu(el, '#measureMenu'); break;
    case 'viewsMenu': toggleMenu(el, '#viewsMenu'); break;
    case 'measure:clear': state.measures.length = 0; view3d()?.clearMeasures(); viewer.renderOverlay(); closeMenus(); break;
    case 'proj3d': if (view3d()) { $('#projLabel').textContent = view3d().toggleProjection() ? 'ORTHO' : 'PERSP'; updateStatus(); } break;
    case 'section3d': {
      const panel = $('#sectionPanel');
      panel.hidden = !panel.hidden;
      if (!panel.hidden && view3d()?.viewer.clip.mode === 'off') view3d().setSection('box');
      break;
    }
    case 'sectionClose': $('#sectionPanel').hidden = true; break;
    case 'wire3d': if (view3d()) $('#wireBtn').classList.toggle('active', view3d().setDisplay({ wireframe: !view3d().display.wireframe }).wireframe); break;
    case 'xray3d': if (view3d()) $('#xrayBtn').classList.toggle('active', view3d().setDisplay({ xray: !view3d().display.xray }).xray); break;
    case 'treeAll': view3d()?.showAll(); break;
    case 'treeNone': view3d()?.hideAll(); break;
    case 'savePng': closeMenus(); savePng(); break;
    case 'bom3dCsv': {
      const v = view3d();
      if (!v) break;
      const { name, text } = v.bomCsv();
      saveAs(new Blob(['\ufeff' + text], { type: 'text/csv' }), name, csvFilters());
      break;
    }
    case 'print': openPrint(); break;
    case 'ai': openRight('ai'); break;
    case 'closeRight': closeRight(); break;
    // Cancel buttons are type="button" so that Enter in a field submits the dialog (Apply / Save).
    case 'cancelDialog': el.closest('dialog').close('cancel'); break;
    case 'showProps': openRight('props'); break;
    case 'settings': openSettings(); break;
    case 'layersAll': state.hidden.clear(); layersChanged(); break;
    case 'layersNone': state.hidden = new Set(state.doc.drawing.layers.keys()); layersChanged(); break;
    case 'layersCsv': {
      const sp = state.doc.spaces[0];
      saveAs(new Blob(['﻿' + layersCsv(sp.analysis, UNIT_NAMES[state.doc.drawing.units])], { type: 'text/csv' }), pdfFileName().replace(/\.pdf$/, '-layers.csv'), csvFilters());
      break;
    }
    case 'bomCsv': {
      const sp = activeSpace();
      saveAs(new Blob(['﻿' + bomCsv(sp.analysis)], { type: 'text/csv' }), pdfFileName().replace(/\.pdf$/, '-BOM.csv'), csvFilters());
      break;
    }
    case 'aiNew': assistant.reset(); showAiIntro(); break;
    case 'toggleSidebar': $('#sidebar').classList.toggle('open'); break;
    default:
      if (action.startsWith('measure:')) { setTool(action); closeMenus(); }
      else if (action.startsWith('cmd:')) runCommand(action.slice(4));
      else if (action.startsWith('view3d:')) { view3d()?.setView(action.slice(7)); closeMenus(); }
      else if (action.startsWith('sel3d:') && view3d()) {
        const v = view3d(), op = action.slice(6);
        if (op === 'zoom') v.zoomTo(v.selection);
        else if (op === 'isolate') v.isolate(v.selection);
        else if (op === 'hide') { v.setHidden([...v.hidden, ...v.selection]); v.select([]); }
        else if (op === 'section') v.sectionAroundSelection();
      }
  }
}

document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-action]');
  if (el) { onAction(el.dataset.action, el); return; }
  const tab = ev.target.closest('[data-tab]');
  if (tab) { setSideTab(tab.dataset.tab, true); return; }
  const rtab = ev.target.closest('[data-rtab]');
  if (rtab) { openRight(rtab.dataset.rtab); return; }
  if (!ev.target.closest('.menu')) closeMenus();
});

$('#snapBtn').addEventListener('click', () => setSnap(!state.snap));
$('#orthoBtn').addEventListener('click', () => setOrtho(!state.ortho));
$('#curLayer').addEventListener('change', (ev) => { layerOp(() => state.edit?.setCurrentLayer(ev.target.value)); ev.target.blur(); });

function toggleMenu(btn, id) {
  const menu = $(id);
  const open = menu.hidden;
  closeMenus();
  if (!open) return;
  menu.hidden = false;
  const r = btn.getBoundingClientRect();
  menu.style.top = `${r.bottom + 4}px`;
  menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8))}px`;
}
function closeMenus() { $('#measureMenu').hidden = true; $('#viewsMenu').hidden = true; $('#layerMenu').hidden = true; }

// On small screens the drawers close when the drawing is touched.
for (const id of ['#viewport', '#viewport3d']) {
  $(id).addEventListener('pointerdown', () => {
    closeSidebarOnMobile();
    if (window.innerWidth <= 860) closeRight();
    closeMenus();
  });
}

function closeRight() {
  $('#rightbar').hidden = true;
  document.body.classList.remove('right-open');
}

$('#snapToggle').addEventListener('change', (ev) => setSnap(ev.target.checked));
$('#layerFilter').addEventListener('input', buildLayerPanel);
$('#searchInput').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 220); });
$('#fileInput').addEventListener('change', (ev) => {
  const files = [...ev.target.files];
  ev.target.value = '';
  if (files.length > 1) openHandedFiles(files);
  else if (files[0]) openFile(files[0]);
});

/** Reload, print, find, find-next and view-source keys of the webview (desktop program). */
function isBrowserShortcut(ev) {
  const k = ev.key.toLowerCase();
  if (ev.key === 'F5' || (ev.key === 'F3' && state.doc?.kind !== 'cad')) return true;
  return (ev.ctrlKey || ev.metaKey) && !ev.altKey && ['r', 'p', 'f', 'g', 'u'].includes(k);
}

/** Printable keys that start typing into the command line. */
const TYPABLE = /^[\p{L}\p{N}\p{P}\p{S} ]$/u; // any letter, digit, punctuation or symbol (Ø ° ± Arabic…)

document.addEventListener('keydown', (ev) => {
  // An open menu closes first, even when its Snap checkbox has the focus.
  if (ev.key === 'Escape' && (!$('#measureMenu').hidden || !$('#viewsMenu').hidden || !$('#layerMenu').hidden)) {
    closeMenus();
    if (ev.target.closest('.menu')) ev.target.blur();
    ev.preventDefault();
    return;
  }
  const cad = state.doc?.kind === 'cad';
  const inField = !!ev.target.closest('input, textarea, select');
  const cmdLine = ev.target.id === 'cmdInput';
  // Desktop: the webview's own browser shortcuts (reload loses the drawing; print/find open
  // WebView2's dialogs) never run. Ctrl+P and Ctrl+F still reach the app's actions below.
  if (platform.isDesktop && isBrowserShortcut(ev)) ev.preventDefault();
  // Ctrl/Cmd shortcuts work everywhere except inside dialogs, and before the single-key ones.
  const mod = ev.ctrlKey || ev.metaKey;
  if (mod && !ev.altKey && !ev.target.closest('dialog')) {
    const k = ev.key.toLowerCase();
    if (k === 'o') { ev.preventDefault(); chooseFile(); return; }
    if (k === 'p' && state.doc) { ev.preventDefault(); openPrint(); return; }
    if (k === 'f' && state.doc) { ev.preventDefault(); setSideTab('search', true); $('#sidebar').classList.add('open'); return; }
    if (k === 's' && cad) { ev.preventDefault(); saveDrawing(ev.shiftKey); return; }
    // Text fields keep their own undo and select-all (the empty command line does not).
    if (cad && (!inField || (cmdLine && !ev.target.value))) {
      if (k === 'z' && !ev.shiftKey) { ev.preventDefault(); undo(); return; }
      if (k === 'y' || (k === 'z' && ev.shiftKey)) { ev.preventDefault(); redo(); return; }
      if (k === 'a' && !inField) { ev.preventDefault(); selectAll(); return; }
    }
  }
  if (cad && ev.key === 'F8') { ev.preventDefault(); setOrtho(!state.ortho); return; }
  if (cad && ev.key === 'F3') { ev.preventDefault(); setSnap(!state.snap); return; }
  if (mod || ev.altKey || inField || ev.target.closest('dialog')) return;
  if (cad && ev.key === ' ' && !$('#cmdInput').value) {
    // Space held down: left-drag pans (released on keyup).
    ev.preventDefault();
    if (!ev.repeat) viewer.setPanKey(true);
    return;
  }
  if (viewer.tool?.key?.(ev)) { viewer.renderOverlay(); updateCmdline(); ev.preventDefault(); return; }
  if (cad && ev.key === 'Enter' && currentTool === 'select' && lastCommand) {
    // Enter repeats the last command, as in AutoCAD.
    ev.preventDefault();
    runCommand(lastCommand);
    return;
  }
  if (cad && (ev.key === 'Delete' || (ev.key === 'Backspace' && currentTool === 'select')) && state.selection.length) {
    ev.preventDefault();
    eraseSelection();
    return;
  }
  // Typing goes to the command line: values while a command waits, command aliases (L, PL, M...) otherwise.
  if (cad && ev.key.length === 1 && TYPABLE.test(ev.key) && ev.key !== ' ') {
    const waiting = !!viewer.tool?.prompt;
    const alias = currentTool === 'select' && /^[a-z]$/i.test(ev.key) && !/^f$/i.test(ev.key);
    if (waiting || alias) {
      ev.preventDefault();
      const input = $('#cmdInput');
      input.value += ev.key;
      updateCmdline(true);
      input.focus();
      viewer.renderOverlay();
      return;
    }
  }
  if (ev.key === 'Escape' && view3d()) {
    // 3D: Esc drops the measurement in progress, then leaves the tool, then clears the selection.
    if (view3d().cancel()) return;
    if (currentTool !== 'select') { setTool('select'); return; }
    view3d().select([]);
    view3d().highlight([]);
    return;
  }
  if (ev.key === 'Escape') {
    // Esc with no measurement in progress leaves the tool.
    if (currentTool !== 'select') setTool('select');
    closeMenus();
    state.selection = [];
    state.highlights = [];
    selectionChanged();
  } else if ((ev.key === 'f' || ev.key === 'F' || ev.key === 'Home') && state.doc) zoomExtentsActive();
  else if ((ev.key === '+' || ev.key === '=') && state.doc) zoomActive(1.5);
  else if (ev.key === '-' && state.doc) zoomActive(1 / 1.5);
  else if (ev.key === 'PageDown' && activeSheet()) gotoPage(activeSheet().pageNo + 1);
  else if (ev.key === 'PageUp' && activeSheet()) gotoPage(activeSheet().pageNo - 1);
});
document.addEventListener('keyup', (ev) => { if (ev.key === ' ') viewer.setPanKey(false); });
window.addEventListener('blur', () => viewer.setPanKey(false));

// ---------------------------------------------------------------- saving
const dxfFilters = () => [{ name: t('dxfFile'), extensions: ['dxf'] }];
let saving = null;

/**
 * Saves the drawing as DXF (AutoCAD 2013). Ctrl+S writes back to the DXF it came from (desktop);
 * anything else (web, DWG/DGN/HP-GL sources, Save As) asks where to save / downloads.
 * Resolves to true when saved.
 */
function saveDrawing(saveAs) {
  if (state.doc?.kind !== 'cad') return Promise.resolve(false);
  // Native menu accelerators and the page may both report Ctrl+S: one save at a time.
  saving ??= doSave(saveAs).finally(() => { saving = null; });
  return saving;
}

async function doSave(saveAs) {
  const doc = state.doc;
  const d = doc.drawing;
  // What is being saved: edits made while a dialog is open stay unsaved.
  const edit = state.edit;
  const top = edit.undoStack.at(-1) ?? null;
  let text, report;
  try {
    const sp = doc.spaces[0];
    const o = sp.scene.origin, bb = sp.scene.bbox;
    ({ text, report } = writeDxf(d, { extents: [bb[0] + o.x, bb[1] + o.y, bb[2] + o.x, bb[3] + o.y], handleSeed: edit.nextHandle, doc: edit }));
  } catch (err) {
    console.error(err);
    toast(`${t('saveFailed')}: ${err.message}`, true, 7000);
    return false;
  }
  const blob = new Blob([text], { type: 'application/dxf' });
  const name = d.fileName.replace(/\.[^.]+$/, '') + '.dxf';
  let path = null;
  try {
    let overwrite = !saveAs && platform.isDesktop && doc.path && /\.dxf$/i.test(doc.path);
    // Overwriting the source would lose or convert something: say what before writing.
    if (overwrite && report.summary()) {
      const answer = await askLoss(report.summary(), d.fileName);
      if (answer === 'cancel') return false;
      if (answer === 'saveas') overwrite = false;
    }
    if (overwrite) {
      await platform.writeFile(doc.path, blob); // keeps the previous file as <name>.dxf.bak
      path = doc.path;
    } else {
      path = await platform.saveFile(blob, name, dxfFilters(), { directory: docFolder() });
      if (path === null) return false; // cancelled
    }
  } catch (err) {
    console.error(err);
    toast(saveError(err), true, 7000);
    return false;
  }
  if (path) {
    doc.path = path;
    d.fileName = path.split(/[\\/]/).pop();
    platform.addRecent(path);
  } else if (!/\.dxf$/i.test(d.fileName)) d.fileName = name;
  if (state.edit === edit) edit.markSaved(top);
  const notes = [];
  if (d.source !== 'dxf' && !doc.dxfNoticeShown) {
    doc.dxfNoticeShown = true;
    notes.push(t(d.source === 'dwg' ? 'savedDxfNote' : 'savedDxfNoteOther').replace('{file}', d.fileName));
  } else notes.push(path ? `${t('savedTo')} ${path}` : `${t('saved')}: ${d.fileName}`);
  const summary = report.summary();
  if (summary) notes.push(`${t('saveSummary')} ${summary}.`);
  toast(notes.join(' '), false, summary || notes.length > 1 ? 10000 : 4000);
  updateEditUi();
  buildInfoPanel();
  return true;
}

/** Asks before overwriting a drawing when saving would convert or leave out objects. */
function askLoss(summary, file) {
  const dlg = $('#lossDialog');
  $('#lossText').textContent = t('lossText').replace('{file}', file);
  $('#lossList').innerHTML = summary.split(', ').map((x) => `<li>${escapeHtml(x)}</li>`).join('');
  dlg.returnValue = '';
  return new Promise((resolve) => {
    dlg.onclose = () => resolve(dlg.returnValue || 'cancel');
    dlg.showModal();
  });
}

/**
 * Before the drawing is replaced or closed: unsaved edits are saved (true), dropped (true)
 * or the action is cancelled (false).
 */
function confirmDiscard() {
  if (!state.edit?.modified) return Promise.resolve(true);
  const dlg = $('#unsavedDialog');
  if (dlg.open) return Promise.resolve(false);
  $('#unsavedText').textContent = t('unsavedText').replace('{file}', state.doc.drawing.fileName);
  dlg.returnValue = '';
  return new Promise((resolve) => {
    dlg.onclose = async () => {
      if (dlg.returnValue === 'discard') resolve(true);
      else if (dlg.returnValue === 'save') resolve(await saveDrawing(false));
      else resolve(false);
    };
    dlg.showModal();
    dlg.querySelector('button[value=save]').focus();
  });
}

// Leaving the web page with unsaved changes asks first (the browser shows its own question).
window.addEventListener('beforeunload', (ev) => {
  if (state.edit?.modified) { ev.preventDefault(); ev.returnValue = ''; }
});
// Desktop: closing the window (or Quit) with unsaved changes asks Save / Don't save / Cancel.
platform.onCloseRequested(async () => {
  if (await confirmDiscard()) platform.closeWindow();
});

// Drag and drop. The desktop program receives dropped files natively (with their paths,
// for recent files) and reports the drag state; the page only stops the webview's default.
let dragDepth = 0;
window.addEventListener('dragover', (ev) => ev.preventDefault());
if (platform.isDesktop) {
  window.addEventListener('drop', (ev) => ev.preventDefault());
  platform.onDragState((on) => document.body.classList.toggle('dragging', on));
} else {
  window.addEventListener('dragenter', (ev) => { if (ev.dataTransfer?.types?.includes('Files')) { dragDepth++; document.body.classList.add('dragging'); } });
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) document.body.classList.remove('dragging'); });
  window.addEventListener('drop', (ev) => {
    ev.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragging');
    const files = ev.dataTransfer?.files;
    if (files?.length) openHandedFiles([...files]);
  });
}

// Files opened from the operating system: double-click / Open with (desktop program) or
// PWA file handling (installed web app).
platform.onOpenFiles(openHandedFiles);

// ---------------------------------------------------------------- desktop program
/** Native menu (src-tauri/src/menu.rs): the same actions as the toolbar. */
function onMenu(id) {
  if (id.startsWith('theme:')) { setTheme(id.slice(6)); return; }
  if ($('dialog[open]')) return; // finish the open dialog first
  if (id === 'open') chooseFile();
  else if (id === 'formats') showFormats();
  else if (!state.doc) return;
  else if (id === 'print') openPrint();
  else if (id === 'export-pdf') openPrint(true);
  else if (id === 'save') saveDrawing(false);
  else if (id === 'save-as') saveDrawing(true);
  else if (id === 'undo') undo();
  else if (id === 'redo') redo();
  else if (id === 'zoom-extents') zoomExtentsActive();
  else if (id === 'zoom-in') zoomActive(1.5);
  else if (id === 'zoom-out') zoomActive(1 / 1.5);
}

function setTheme(name) {
  if (!THEMES[name]) return;
  state.theme = name;
  saveUiPrefs();
  viewer.setTheme(THEMES[name]);
  view3d()?.setTheme(THEMES[name]);
  platform.setThemeMenu(name);
}

/** Help > Supported formats: what opens, and what is recognised with export advice. */
function showFormats() {
  const item = (f) => `${escapeHtml(f.label)} <span class="muted">${f.exts.map((e) => '.' + e).join(' ')}</span>`;
  const groups = new Map();
  for (const f of FORMATS) {
    const key = f.open ? 'fmt_' + f.category : 'formatsExplained';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item(f));
  }
  $('#formatsList').innerHTML = [...groups].map(([key, items]) => `<dt>${escapeHtml(t(key))}</dt><dd>${items.join('<br>')}</dd>`).join('');
  $('#formatsDialog').showModal();
}

/** Recent files on the welcome screen (desktop). */
function renderRecent(paths) {
  const ul = $('#recentList');
  ul.innerHTML = '';
  for (const path of paths) {
    const name = path.split(/[\\/]/).pop();
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.title = path;
    b.innerHTML = `<bdi class="name">${escapeHtml(name)}</bdi><bdi class="dir">${escapeHtml(path.slice(0, path.length - name.length).replace(/[\\/]$/, ''))}</bdi>`;
    b.addEventListener('click', () => openDiskFile(platform.readPath(path)));
    li.append(b);
    ul.append(li);
  }
  $('#recentFiles').hidden = !paths.length;
}

function initDesktop() {
  document.documentElement.classList.add('desktop');
  platform.onMenu(onMenu);
  platform.setThemeMenu(state.theme);
  platform.onRecentChange(renderRecent);
  platform.recentFiles().then(renderRecent, (err) => console.warn(err));
  $('#recentClear').addEventListener('click', () => platform.clearRecent());
}

async function openSample(file = 'plant.dxf', as = 'plant-room-sample.dxf') {
  try {
    showLoading(t('loading'));
    const res = await fetch(new URL(`samples/${file}`, document.baseURI));
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const blob = await res.blob();
    await openFile(new File([blob], as));
  } catch (err) {
    toast(`${t('loadError')}: ${err.message}`, true);
    showLoading(null);
  }
}

function formatBytes(n) {
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** PNG data URL of a canvas, or JPEG when the PNG would be too large to send. */
function imageDataUrl(c) {
  const png = c.toDataURL('image/png');
  return png.length < 4.5e6 ? png : c.toDataURL('image/jpeg', 0.85);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ---------------------------------------------------------------- start
if (platform.isDesktop) useDesktopStrings();
$('#fileInput').accept = acceptAttribute();
fillIcons();
applyI18n();
updateNeeds();
viewer.setTheme(THEMES[state.theme]);
setTool('select');
showProperties();
updateEditUi();
if (platform.isDesktop) initDesktop();
if (new URLSearchParams(location.search).has('sample')) openSample();
else if (new URLSearchParams(location.search).has('sample3d')) openSample('cooling-water.pcf', 'cooling-water-sample.pcf');
platform.registerServiceWorker();
window.protocad = { state, viewer, openFile, openHandedFiles, ed, ops, saveDrawing, setTool, runCommand, submitCommand, activeSpace, view3d, assistant, view3dStats: () => doc3dModule?.then((m) => m.viewerStats()) ?? null };
