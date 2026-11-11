// Properties panel: shows the selection and edits it. Multi-selections show the values they
// share and "*varies*" otherwise. General properties (layer, colour, linetype, lineweight) apply
// to any selection; type fields (text, block attributes, geometry) when all objects share the type.
// Every change is one undoable step (api.modify).
import { lineweightToMm, lineweightToRaw, LINEWEIGHTS_MM, LW_BYLAYER, LW_BYBLOCK, LW_DEFAULT } from '../cad/drawing.js';
import { colorCss } from '../render/cad-renderer.js';
import { colorLabel } from './color-picker.js';

const DEG = 180 / Math.PI;
const VARIES = '*varies*';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const numText = (v, d = 4) => (Number.isFinite(v) ? String(+v.toFixed(d)) : '');

/** The value all entities share (by key function), or VARIES. */
function common(ents, fn) {
  let first;
  for (let i = 0; i < ents.length; i++) {
    const v = fn(ents[i]);
    if (i === 0) first = v;
    else if (typeof v === 'number' && typeof first === 'number' ? Math.abs(v - first) > 1e-9 : v !== first) return VARIES;
  }
  return first;
}

/**
 * @param dl the panel's <dl>
 * @param api {
 *   items: scene items, drawing, unit, locked (bool), readonly rows: [[label, value]],
 *   modify(label, fn(entity)), pickColor(anchor, current, cb), toast(msg), formatNum, theme
 * }
 */
export function renderPropsEditor(dl, api) {
  const { items, drawing } = api;
  const ents = items.map((it) => it.ent);
  const src = drawing.source;
  const types = {};
  for (const e of ents) types[e.type] = (types[e.type] || 0) + 1;
  const type = Object.keys(types).length === 1 ? ents[0].type : null;
  const dis = api.locked ? 'disabled' : '';
  const rows = [];
  const row = (label, html, cls = '') => rows.push(`<dt>${esc(label)}</dt><dd class="${cls}">${html}</dd>`);
  const input = (key, value, kind = 'num') => {
    const v = value === VARIES ? '' : kind === 'num' ? numText(value) : value ?? '';
    const ph = value === VARIES ? VARIES : '';
    return `<input class="pe" data-key="${key}" data-kind="${kind}" type="text" ${kind === 'num' ? 'inputmode="decimal"' : ''} dir="auto" value="${esc(v)}" placeholder="${ph}" ${dis} />`;
  };

  // ---- general
  row('Type', esc(type ?? `${ents.length} objects: ${Object.entries(types).map(([t, n]) => `${n} ${t}`).join(', ')}`));
  const layerVal = common(ents, (e) => e.layer ?? '0');
  const layers = [...drawing.layers.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  row('Layer', `<select class="pe" data-key="layer" ${dis}>${layerVal === VARIES ? `<option value="" selected disabled>${VARIES}</option>` : ''}${layers.map((n) => `<option ${n === layerVal ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>`);
  const colorVal = common(ents, colorLabel);
  const swatchRgb = colorVal === VARIES ? null : api.firstRgb;
  const swatch = swatchRgb === null || swatchRgb === undefined ? '' : `<span class="swatch" style="background:${colorCss(swatchRgb, api.theme)}"></span>`;
  row('Color', `<button type="button" class="pe-color mini" data-key="color" ${dis}>${swatch}<span>${esc(colorVal)}</span></button>`);
  const ltVal = common(ents, (e) => (!e.lineType || /^bylayer$/i.test(e.lineType) ? 'ByLayer' : /^byblock$/i.test(e.lineType) ? 'ByBlock' : e.lineType));
  const ltNames = ['ByLayer', 'ByBlock', ...[...drawing.ltypes.values()].map((t) => t.name).filter((n) => !/^by(layer|block)$/i.test(n))];
  if (!ltNames.some((n) => /^continuous$/i.test(n))) ltNames.splice(2, 0, 'Continuous');
  if (ltVal !== VARIES && !ltNames.includes(ltVal)) ltNames.push(ltVal);
  row('Linetype', `<select class="pe" data-key="lineType" ${dis}>${ltVal === VARIES ? `<option value="" selected disabled>${VARIES}</option>` : ''}${ltNames.map((n) => `<option ${n === ltVal ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>`);
  const lwKey = (e) => { const v = lineweightToMm(e.lineweight, src); return v < 0 ? String(v) : v.toFixed(2); };
  const lwVal = common(ents, lwKey);
  const lwOpts = [[String(LW_BYLAYER), 'ByLayer'], [String(LW_BYBLOCK), 'ByBlock'], [String(LW_DEFAULT), 'Default'], ...LINEWEIGHTS_MM.map((v) => [v.toFixed(2), `${v.toFixed(2)} mm`])];
  if (lwVal !== VARIES && !lwOpts.some(([k]) => k === lwVal)) lwOpts.push([lwVal, `${lwVal} mm`]);
  row('Lineweight', `<select class="pe" data-key="lineweight" ${dis}>${lwVal === VARIES ? `<option value="" selected disabled>${VARIES}</option>` : ''}${lwOpts.map(([k, l]) => `<option value="${k}" ${k === lwVal ? 'selected' : ''}>${l}</option>`).join('')}</select>`);

  // ---- type specific
  const geo = [];
  const section = (title) => geo.push(`<div class="section">${esc(title)}</div>`);
  const field = (label, key, value, kind) => geo.push(`<dt>${esc(label)}</dt><dd>${input(key, value, kind)}</dd>`);
  const c = (fn) => common(ents, fn);
  if (type === 'LINE') {
    section('Geometry');
    field('Start X', 'startPoint.x', c((e) => e.startPoint.x)); field('Start Y', 'startPoint.y', c((e) => e.startPoint.y));
    field('End X', 'endPoint.x', c((e) => e.endPoint.x)); field('End Y', 'endPoint.y', c((e) => e.endPoint.y));
  } else if (type === 'CIRCLE' || type === 'ARC') {
    section('Geometry');
    field('Center X', 'center.x', c((e) => e.center.x)); field('Center Y', 'center.y', c((e) => e.center.y));
    field('Radius', 'radius', c((e) => e.radius)); field('Diameter', 'diameter', c((e) => e.radius * 2));
    if (type === 'ARC') { field('Start angle', 'startAngle', c((e) => e.startAngle * DEG)); field('End angle', 'endAngle', c((e) => e.endAngle * DEG)); }
  } else if (type === 'TEXT') {
    section('Text');
    field('Contents', 'text', c((e) => e.text), 'str');
    field('Height', 'textHeight', c((e) => e.textHeight)); field('Rotation', 'rotation', c((e) => (e.rotation || 0) * DEG));
    field('Width factor', 'xScale', c((e) => e.xScale ?? 1));
  } else if (type === 'MTEXT') {
    section('Text');
    const v = c((e) => String(e.text ?? '').replace(/\\P/g, '\n'));
    geo.push(`<dt>Contents</dt><dd><textarea class="pe" data-key="mtext" data-kind="str" rows="3" dir="auto" placeholder="${v === VARIES ? VARIES : ''}" ${dis}>${v === VARIES ? '' : esc(v)}</textarea></dd>`);
    field('Height', 'textHeight', c((e) => e.textHeight)); field('Rotation', 'rotation', c((e) => (e.direction && (e.direction.x || e.direction.y) ? Math.atan2(e.direction.y, e.direction.x) : e.rotation || 0) * DEG));
  } else if (type === 'INSERT') {
    section('Block');
    geo.push(`<dt>Name</dt><dd>${esc(c((e) => e.name))}</dd>`);
    field('Position X', 'insertionPoint.x', c((e) => e.insertionPoint.x)); field('Position Y', 'insertionPoint.y', c((e) => e.insertionPoint.y));
    field('Rotation', 'rotation', c((e) => (e.rotation || 0) * DEG));
    field('Scale X', 'xScale', c((e) => e.xScale ?? 1)); field('Scale Y', 'yScale', c((e) => e.yScale ?? 1));
    // Attributes (valve tags, sizes...) by tag, common values across the selection.
    const tags = [];
    for (const e of ents) for (const a of e.attribs ?? []) if (a.tag && !tags.includes(a.tag)) tags.push(a.tag);
    if (tags.length) {
      section('Attributes');
      for (const tag of tags) {
        const v = c((e) => e.attribs?.find((a) => a.tag === tag)?.text?.text ?? null);
        geo.push(`<dt>${esc(tag)}</dt><dd>${input(`attr:${tag}`, v === null ? '' : v, 'str')}</dd>`);
      }
    }
  } else if (type === 'LWPOLYLINE') {
    section('Polyline');
    const closed = c((e) => !!((e.flag ?? 0) & 1));
    geo.push(`<dt>Closed</dt><dd><input type="checkbox" class="pe" data-key="closed" ${closed === true ? 'checked' : ''} ${dis} /></dd>`);
    field('Global width', 'constantWidth', c((e) => e.constantWidth || 0));
  } else if (type?.includes('DIMENSION')) {
    // A dimension draws from its graphics block, so changing e.text alone would show nothing and
    // write a text that disagrees with the graphics: the override is shown, not edited.
  }
  const info = (api.readonly ?? []).map(([k, v]) => `<dt>${esc(k)}</dt><dd dir="auto">${v?.html ?? esc(String(v))}</dd>`);
  dl.innerHTML = rows.join('') + geo.join('') + (info.length ? `<div class="section">Info</div>${info.join('')}` : '') +
    (api.locked ? '<div class="empty small-note">On a locked layer: unlock it in the Layers panel to edit.</div>' : '');

  // ---- events
  const apply = (label, fn) => api.modify(label, fn);
  dl.querySelectorAll('select.pe').forEach((s) => s.addEventListener('change', () => {
    const v = s.value, key = s.dataset.key;
    if (key === 'layer') apply('Layer', (e) => { e.layer = v; });
    else if (key === 'lineType') apply('Linetype', (e) => { if (v === 'ByLayer') delete e.lineType; else e.lineType = v; });
    else if (key === 'lineweight') {
      const mm = parseFloat(v);
      apply('Lineweight', (e) => { e.lineweight = lineweightToRaw(mm < 0 ? Math.round(mm) : mm, src); });
    }
  }));
  dl.querySelector('.pe-color')?.addEventListener('click', (ev) => {
    api.pickColor(ev.currentTarget, ents[0], (val) => apply('Color', (e) => {
      e.colorIndex = val.colorIndex;
      if (typeof val.color === 'number') e.color = val.color; else delete e.color;
    }));
  });
  dl.querySelectorAll('input.pe[type=checkbox]').forEach((cb) => cb.addEventListener('change', () => {
    apply(cb.checked ? 'Close polyline' : 'Open polyline', (e) => { e.flag = cb.checked ? (e.flag ?? 0) | 1 : (e.flag ?? 0) & ~1; });
  }));
  const commit = (el) => {
    const key = el.dataset.key, kind = el.dataset.kind;
    const raw = el.value;
    if (kind === 'num') {
      const n = Number(raw.trim());
      if (!raw.trim() || !Number.isFinite(n)) { if (raw.trim()) api.toast('Enter a number'); return; }
      setNumber(key, n, apply);
    } else if (key === 'mtext') apply('Text', (e) => { e.text = raw.replace(/\r\n|\r|\n/g, '\\P'); });
    else if (key === 'text') { if (raw.length) apply('Text', (e) => { e.text = raw.replace(/[\r\n]+/g, ' '); }); }
    else if (key.startsWith('attr:')) {
      const tag = key.slice(5);
      apply(`Attribute ${tag}`, (e) => { for (const a of e.attribs ?? []) if (a.tag === tag && a.text) a.text.text = raw; });
    }
  };
  dl.querySelectorAll('input.pe[type=text], textarea.pe').forEach((el) => {
    el.addEventListener('change', () => commit(el));
    el.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && (el.tagName !== 'TEXTAREA' || ev.ctrlKey)) { ev.preventDefault(); el.blur(); }
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); el.value = el.defaultValue; el.blur(); }
    });
  });
}

function setNumber(key, n, apply) {
  const rad = n / DEG;
  const pos = (field, axis) => (e) => { e[field] = { ...(e[field] ?? { x: 0, y: 0, z: 0 }), [axis]: n }; };
  switch (key) {
    case 'startPoint.x': case 'startPoint.y': case 'endPoint.x': case 'endPoint.y': case 'center.x': case 'center.y':
    case 'insertionPoint.x': case 'insertionPoint.y': {
      const [f, a] = key.split('.');
      apply('Position', key.startsWith('insertionPoint') ? moveInsert(a, n) : pos(f, a));
      break;
    }
    case 'radius': if (n > 0) apply('Radius', (e) => { e.radius = n; }); break;
    case 'diameter': if (n > 0) apply('Diameter', (e) => { e.radius = n / 2; }); break;
    case 'startAngle': apply('Start angle', (e) => { e.startAngle = rad; }); break;
    case 'endAngle': apply('End angle', (e) => { e.endAngle = rad; }); break;
    case 'textHeight': if (n > 0) apply('Text height', (e) => { e.textHeight = n; }); break;
    case 'xScale': if (n !== 0) apply('Scale', (e) => { e.xScale = n; }); break;
    case 'yScale': if (n !== 0) apply('Scale', (e) => { e.yScale = n; }); break;
    case 'constantWidth': if (n >= 0) apply('Width', (e) => { e.constantWidth = n; }); break;
    case 'rotation':
      apply('Rotation', (e) => {
        if (e.type === 'INSERT') rotateInsert(e, rad);
        else if (e.type === 'MTEXT') { e.rotation = rad; if (e.direction) e.direction = { x: Math.cos(rad), y: Math.sin(rad), z: 0 }; } else e.rotation = rad;
      });
      break;
  }
}

/** Moving a block reference moves its attributes with it. */
function moveInsert(axis, n) {
  return (e) => {
    const d = n - (e.insertionPoint?.[axis] ?? 0);
    e.insertionPoint = { ...e.insertionPoint, [axis]: n };
    for (const a of e.attribs ?? []) {
      for (const k of ['startPoint', 'endPoint']) if (a.text?.[k] && (k === 'startPoint' || a.text[k].x || a.text[k].y)) a.text[k] = { ...a.text[k], [axis]: a.text[k][axis] + d };
    }
  };
}

/** Rotating a block reference turns its attributes around the insertion point too. */
function rotateInsert(e, rad) {
  const da = rad - (e.rotation || 0);
  const c = Math.cos(da), s = Math.sin(da), o = e.insertionPoint;
  e.rotation = rad;
  for (const a of e.attribs ?? []) {
    for (const k of ['startPoint', 'endPoint']) {
      const p = a.text?.[k];
      if (!p || (k === 'endPoint' && !p.x && !p.y)) continue;
      const x = p.x - o.x, y = p.y - o.y;
      a.text[k] = { ...p, x: o.x + x * c - y * s, y: o.y + x * s + y * c };
    }
    if (a.text) a.text.rotation = (a.text.rotation || 0) + da;
  }
}
