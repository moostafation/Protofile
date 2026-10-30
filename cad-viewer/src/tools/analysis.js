// Drawing analysis: search index, block counts (BOM), per-layer statistics.
// Also produces the compact text summary the AI assistant receives.
import { STROKE, TEXT } from '../cad/scene.js';
import { polylineLength } from '../cad/geometry.js';
import { decodeText, decodeMText } from '../cad/text.js';
import { UNIT_NAMES } from '../cad/drawing.js';

function itemText(e) {
  switch (e.type) {
    case 'TEXT': return decodeText(e.text);
    case 'MTEXT': return decodeMText(e.text).join(' ');
    case 'ATTRIB': case 'ATTDEF': return decodeText(e.text?.text);
    case 'MULTILEADER': return e.textContent ? decodeMText(e.textContent).join(' ') : '';
    default: return '';
  }
}

function attribsOf(e) {
  return (e.attribs ?? []).map((a) => ({ tag: a.tag || '', value: decodeText(a.text?.text ?? '') })).filter((a) => a.value);
}

/** Builds analysis data for a scene (model space or layout). */
export function analyze(drawing, scene) {
  const layerStats = new Map();
  const stat = (name) => {
    let s = layerStats.get(name);
    if (!s) layerStats.set(name, (s = { name, entities: 0, length: 0, types: {} }));
    return s;
  };
  const blocks = new Map();
  const searchable = [];
  const dims = [];

  for (const it of scene.items) {
    const e = it.ent;
    const s = stat(it.layer);
    s.entities++;
    s.types[e.type] = (s.types[e.type] || 0) + 1;

    if (e.type === 'INSERT') {
      const attrs = attribsOf(e);
      it.attribs = attrs;
      it.name = e.name;
      if (!e.name.startsWith('*')) {
        let b = blocks.get(e.name);
        if (!b) blocks.set(e.name, (b = { name: e.name, count: 0, layers: new Set(), items: [], attrValues: new Map() }));
        b.count++;
        b.layers.add(it.layer);
        b.items.push(it.id);
        for (const a of attrs) {
          const key = `${a.tag}=${a.value}`;
          b.attrValues.set(key, (b.attrValues.get(key) || 0) + 1);
        }
      }
      const label = [e.name, ...attrs.map((a) => `${a.tag}:${a.value}`)].join(' ');
      searchable.push({ item: it.id, kind: 'block', text: label });
    } else if (e.type?.includes('DIMENSION')) {
      const v = e.text && e.text !== '<>' && e.text.trim() ? decodeMText(e.text).join(' ') : formatNum(e.measurement);
      if (v) { dims.push(v); searchable.push({ item: it.id, kind: 'dim', text: v }); }
    } else {
      const t = itemText(e);
      if (t.trim()) {
        it.text = t;
        searchable.push({ item: it.id, kind: 'text', text: t });
      }
    }

    // Lengths of linework that belongs directly to this layer (pipes, ducts, walls).
    if (['LINE', 'LWPOLYLINE', 'POLYLINE2D', 'POLYLINE3D', 'ARC', 'SPLINE', 'CIRCLE', 'ELLIPSE'].includes(e.type)) {
      let len = 0;
      for (let k = it.first; k < it.last; k++) {
        const p = scene.prims[k];
        if (p.k === STROKE && !p.infinite) len += polylineLength(p.pts, p.closed);
      }
      it.length = len;
      s.length += len;
    }
  }

  // Texts nested inside blocks (e.g. tags drawn as plain text) are searchable too.
  for (const p of scene.prims) {
    if (p.k !== TEXT) continue;
    const it = scene.items[p.item];
    if (it.ent.type === 'INSERT') {
      const t = p.lines.map((l) => l.s).join(' ');
      if (t.trim() && !searchable.some((s) => s.item === it.id && s.text.includes(t))) searchable.push({ item: it.id, kind: 'block-text', text: t });
    }
  }

  return {
    layerStats: [...layerStats.values()].sort((a, b) => b.entities - a.entities),
    blocks: [...blocks.values()].sort((a, b) => b.count - a.count),
    searchable,
    dims,
  };
}

export function formatNum(v, digits = 2) {
  if (!Number.isFinite(v)) return '';
  return Number(v.toFixed(digits)).toLocaleString('en-US', { maximumFractionDigits: digits });
}

/** Case/diacritic-insensitive search over texts, block names, attributes, layers. */
export function search(analysis, query, limit = 300) {
  const q = normalize(query);
  if (!q) return [];
  const terms = q.split(/\s+/).filter(Boolean);
  const out = [];
  for (const s of analysis.searchable) {
    const t = normalize(s.text);
    if (terms.every((term) => t.includes(term))) {
      out.push({ item: s.item, kind: s.kind, text: s.text });
      if (out.length >= limit) break;
    }
  }
  if (out.length < limit) {
    for (const l of analysis.layerStats) {
      if (normalize(l.name).includes(q)) out.push({ layer: l.name, kind: 'layer', text: l.name });
    }
  }
  return out;
}

function normalize(s) {
  return (s || '').toLowerCase().normalize('NFKD').replace(/[̀-ًͯ-ٟ]/g, '').replace(/\s+/g, ' ').trim();
}

/** CSV bill of materials for block references (with attribute breakdown). */
export function bomCsv(analysis) {
  const rows = [['Block', 'Count', 'Layers', 'Attributes']];
  for (const b of analysis.blocks) {
    const attrs = [...b.attrValues.entries()].map(([k, n]) => `${k} (${n})`).join('; ');
    rows.push([b.name, String(b.count), [...b.layers].join(' '), attrs]);
  }
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}

export function layersCsv(analysis, unit) {
  const rows = [['Layer', 'Entities', `Linework length (${unit || 'units'})`]];
  for (const l of analysis.layerStats) rows.push([l.name, String(l.entities), l.length ? l.length.toFixed(2) : '']);
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Compact, structured description of the drawing for the AI assistant.
 * Long lists are truncated with a note so the model knows data was cut.
 */
export function drawingSummary(drawing, scene, analysis, spaceName, maxChars = 120000) {
  const unit = UNIT_NAMES[drawing.units] || 'unitless';
  const [x0, y0, x1, y1] = scene.bbox;
  const o = scene.origin;
  const lines = [];
  lines.push(`File: ${drawing.fileName} (${drawing.source.toUpperCase()}${drawing.version ? ', ' + drawing.version : ''})`);
  lines.push(`Space: ${spaceName}. Units: ${unit}. Extents: (${formatNum(x0 + o.x)}, ${formatNum(y0 + o.y)}) to (${formatNum(x1 + o.x)}, ${formatNum(y1 + o.y)}), size ${formatNum(x1 - x0)} x ${formatNum(y1 - y0)} ${unit}.`);
  lines.push(`Top-level entities: ${scene.items.length}. Layouts: ${drawing.layouts.map((l) => l.name).join(', ') || 'none'}.`);
  lines.push('');
  lines.push('## Layers (name | entities | linework length | entity types)');
  for (const l of analysis.layerStats) {
    const info = drawing.layers.get(l.name);
    const types = Object.entries(l.types).map(([t, n]) => `${t}:${n}`).join(' ');
    lines.push(`${l.name} | ${l.entities} | ${l.length ? formatNum(l.length) + ' ' + unit : '-'} | ${types}${info && !info.visible ? ' | (off/frozen in file)' : ''}`);
  }
  lines.push('');
  lines.push('## Block references (name | count | layers | attribute values with counts)');
  for (const b of analysis.blocks) {
    const attrs = [...b.attrValues.entries()].slice(0, 60).map(([k, n]) => `${k}${n > 1 ? ` x${n}` : ''}`).join('; ');
    lines.push(`${b.name} | ${b.count} | ${[...b.layers].join(' ')} | ${attrs}`);
  }
  lines.push('');
  lines.push('## Texts and labels (item id | layer | text)');
  const seen = new Set();
  let body = lines.join('\n');
  const textLines = [];
  for (const s of analysis.searchable) {
    if (s.kind === 'block') continue;
    const key = s.text.trim();
    if (!key || seen.has(key + s.kind)) continue;
    seen.add(key + s.kind);
    textLines.push(`#${s.item} | ${scene.items[s.item].layer} | ${key.replace(/\s+/g, ' ').slice(0, 300)}`);
  }
  let used = body.length;
  let shown = 0;
  for (const t of textLines) {
    if (used + t.length + 1 > maxChars) break;
    body += '\n' + t;
    used += t.length + 1;
    shown++;
  }
  if (shown < textLines.length) body += `\n(… ${textLines.length - shown} more texts not included)`;
  return body;
}
