// Writes markups into a PDF with pdf-lib: as real PDF annotations (Square, Circle, Line, PolyLine,
// Polygon with a cloudy border, Ink, FreeText, Stamp) with appearance streams, so Acrobat,
// Bluebeam and browsers show them and can still edit them; or flattened into the page content.
// Each annotation also carries the app's own description (/PCMarkup) so that re-opening the file
// here gives editable markups again (extractMarkups).
import {
  PDFDocument, PDFName, PDFString, PDFHexString, PDFArray, PDFDict, StandardFonts, pushGraphicsState, popGraphicsState, drawObject,
} from 'pdf-lib';
import {
  boxOf, bboxOf, cloudOutline, arrowHead, headLen, calloutJoin, textLayout, stampLayout, measureLabelAt, boxPolygon,
} from './markup.js';

const KEY = 'PCMarkup';

const n = (v) => (Math.round(v * 1000) / 1000).toString();
function rgb(hex) {
  const v = parseInt(String(hex || '#ff0000').slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}
const col = (hex) => rgb(hex).map(n).join(' ');

function pdfDate(iso) {
  const d = iso ? new Date(iso) : new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

/** Characters the standard Helvetica font cannot encode become '?'. */
function safeText(font, s) {
  let out = '';
  for (const ch of String(s ?? '')) {
    try { font.encodeText(ch); out += ch; } catch { out += '?'; }
  }
  return out;
}

function ellipse(cx, cy, rx, ry) {
  const k = 0.5523;
  return [`${n(cx + rx)} ${n(cy)} m`,
    `${n(cx + rx)} ${n(cy + k * ry)} ${n(cx + k * rx)} ${n(cy + ry)} ${n(cx)} ${n(cy + ry)} c`,
    `${n(cx - k * rx)} ${n(cy + ry)} ${n(cx - rx)} ${n(cy + k * ry)} ${n(cx - rx)} ${n(cy)} c`,
    `${n(cx - rx)} ${n(cy - k * ry)} ${n(cx - k * rx)} ${n(cy - ry)} ${n(cx)} ${n(cy - ry)} c`,
    `${n(cx + k * rx)} ${n(cy - ry)} ${n(cx + rx)} ${n(cy - k * ry)} ${n(cx + rx)} ${n(cy)} c`, 'h'].join('\n');
}

const path = (pts, closed) => pts.map(([x, y], i) => `${n(x)} ${n(y)} ${i ? 'l' : 'm'}`).join('\n') + (closed ? '\nh' : '');

/** Content stream operators (PDF user space) that draw the markup; `m` is already in PDF space. */
function appearance(m, fonts) {
  const ops = ['q', '/GS0 gs', `${col(m.color)} RG`, `${n(m.width ?? 1)} w`, '1 J', '1 j'];
  if (m.fill) ops.push(`${col(m.fill)} rg`);
  const fs = m.fill ? 'B' : 'S';
  const measure = (s, size) => fonts.reg.widthOfTextAtSize(safeText(fonts.reg, s), size);
  const measureBold = (s, size) => fonts.bold.widthOfTextAtSize(safeText(fonts.bold, s), size);
  const text = (s, x, y, size, bold, align = 'left') => {
    const f = bold ? fonts.bold : fonts.reg;
    const str = safeText(f, s);
    const tw = f.widthOfTextAtSize(str, size);
    const x0 = align === 'center' ? x - tw / 2 : x;
    return `BT /${bold ? 'F2' : 'F1'} ${n(size)} Tf ${n(x0)} ${n(y)} Td ${f.encodeText(str).toString()} Tj ET`;
  };
  switch (m.type) {
    case 'pen': case 'line': ops.push(path(m.pts, false), 'S'); break;
    case 'arrow': ops.push(path(m.pts, false), 'S', path(arrowHead(m.pts[0], m.pts[1], headLen(m)), false), 'S'); break;
    case 'rect': ops.push(path(boxPolygon(boxOf(m)), true), (m.width ?? 1) > 0 ? fs : 'f'); break;
    case 'highlight': ops.push(`${col(m.fill || m.color)} rg`, path(boxPolygon(boxOf(m)), true), 'f'); break;
    case 'ellipse': {
      const b = boxOf(m);
      ops.push(ellipse((b[0] + b[2]) / 2, (b[1] + b[3]) / 2, (b[2] - b[0]) / 2, (b[3] - b[1]) / 2), fs);
      break;
    }
    case 'cloud': ops.push(path(cloudOutline(m), true), fs); break;
    case 'text': case 'callout': {
      const L = textLayout(m, measure);
      const b = L.b;
      if (m.type === 'callout') {
        const j = calloutJoin(m);
        ops.push(path([j, m.pts[0]], false), 'S', path(arrowHead(j, m.pts[0], headLen(m)), false), 'S');
      }
      ops.push(m.fill ? `${col(m.fill)} rg` : '1 1 1 rg', path(boxPolygon(b), true), (m.width ?? 1) > 0 ? 'B' : 'f');
      ops.push(`${col(m.color)} rg`);
      L.lines.forEach((s, i) => { if (s) ops.push(text(s, b[0] + L.pad, b[3] - L.pad - L.fs * 0.9 - i * L.lh, L.fs)); });
      break;
    }
    case 'stamp': {
      const S = stampLayout(m, measure, measureBold);
      const b = S.b;
      ops.push(`${n(Math.max(m.width ?? 1, (b[3] - b[1]) * 0.04))} w`, path(boxPolygon(b), true), 'S', `${col(m.color)} rg`);
      const cx = (b[0] + b[2]) / 2;
      ops.push(text(S.label, cx, b[1] + (b[3] - b[1]) * (S.sub ? 0.42 : 0.33), S.fs, true, 'center'));
      if (S.sub) ops.push(text(S.sub, cx, b[1] + (b[3] - b[1]) * 0.14, S.fs2, false, 'center'));
      break;
    }
    case 'measure': {
      ops.push(path(m.pts, m.mode === 'area'), m.mode === 'area' && m.fill ? 'B' : 'S');
      const r = (m.fontSize || 12) * 0.4;
      ops.push(`${col(m.color)} rg`);
      for (const q of [m.pts[0], m.pts[m.pts.length - 1]]) ops.push(ellipse(q[0], q[1], r, r), 'f');
      const [lx, ly] = measureLabelAt(m);
      const size = m.fontSize || 12, tw = measure(m.text || '', size);
      ops.push('1 1 1 rg', `${n(lx - tw / 2 - size * 0.3)} ${n(ly - size * 0.45)} ${n(tw + size * 0.6)} ${n(size * 1.3)} re f`, `${col(m.color)} rg`);
      ops.push(text(m.text || '', lx, ly, size, false, 'center'));
      break;
    }
    default: break;
  }
  ops.push('Q');
  return ops.join('\n');
}

/** Markup in PDF user space: points mapped, sizes scaled. */
function toPdfSpace(m, map, scale) {
  return {
    ...m,
    pts: m.pts.map(([x, y]) => map(x, y)),
    width: (m.width ?? 1) * scale,
    fontSize: (m.fontSize || 12) * scale,
    arc: m.arc ? m.arc * scale : undefined,
  };
}

const flatNums = (pts) => pts.flat();

function annotDict(ctx, m, rect, apRef, fonts) {
  const base = {
    Type: 'Annot', Rect: rect, F: 4, C: rgb(m.color), CA: m.opacity ?? 1,
    NM: PDFString.of(m.id), T: PDFHexString.fromText(m.author || ''), M: PDFString.of(pdfDate(m.date)),
    CreationDate: PDFString.of(pdfDate(m.date)), Contents: PDFHexString.fromText(m.text || ''),
    BS: { Type: 'Border', W: m.width ?? 1, S: 'S' }, AP: { N: apRef },
  };
  const ic = m.fill ? { IC: rgb(m.fill) } : {};
  switch (m.type) {
    case 'rect': return { ...base, ...ic, Subtype: 'Square', Subj: PDFHexString.fromText('Rectangle') };
    case 'highlight': return { ...base, Subtype: 'Square', IC: rgb(m.fill || m.color), BS: { W: 0 }, Subj: PDFHexString.fromText('Highlight') };
    case 'ellipse': return { ...base, ...ic, Subtype: 'Circle', Subj: PDFHexString.fromText('Ellipse') };
    case 'line': return { ...base, Subtype: 'Line', L: flatNums(m.pts), LE: ['None', 'None'], Subj: PDFHexString.fromText('Line') };
    case 'arrow': return { ...base, Subtype: 'Line', L: flatNums(m.pts), LE: ['None', 'OpenArrow'], Subj: PDFHexString.fromText('Arrow') };
    case 'pen': return { ...base, Subtype: 'Ink', InkList: [flatNums(m.pts)], Subj: PDFHexString.fromText('Pen') };
    case 'cloud': return { ...base, ...ic, Subtype: 'Polygon', Vertices: flatNums(m.pts), BE: { S: 'C', I: 1 }, Subj: PDFHexString.fromText('Cloud') };
    case 'text': return {
      ...base, Subtype: 'FreeText', DA: PDFString.of(`/Helv ${n(m.fontSize)} Tf ${col(m.color)} rg`), Q: 0,
      Subj: PDFHexString.fromText('Text Box'),
    };
    case 'callout': {
      const j = calloutJoin(m);
      const b = boxOf(m);
      return {
        ...base, Subtype: 'FreeText', IT: 'FreeTextCallout', CL: [...m.pts[0], ...j], LE: 'OpenArrow',
        DA: PDFString.of(`/Helv ${n(m.fontSize)} Tf ${col(m.color)} rg`), Q: 0,
        RD: [b[0] - rect[0], b[1] - rect[1], rect[2] - b[2], rect[3] - b[3]].map((v) => Math.max(0, v)),
        Subj: PDFHexString.fromText('Callout'),
      };
    }
    case 'stamp': {
      const name = { APPROVED: 'Approved', REJECTED: 'NotApproved', 'FOR CONSTRUCTION': 'ForPublicRelease' }[m.text] || 'Draft';
      return { ...base, Subtype: 'Stamp', Name: name, Subj: PDFHexString.fromText('Stamp') };
    }
    case 'measure':
      if (m.mode === 'dist') return { ...base, Subtype: 'Line', L: flatNums(m.pts.slice(0, 2)), LE: ['Circle', 'Circle'], IT: 'LineDimension', Cap: true, Subj: PDFHexString.fromText('Length Measurement') };
      if (m.mode === 'area') return { ...base, ...ic, Subtype: 'Polygon', Vertices: flatNums(m.pts), IT: 'PolygonDimension', Subj: PDFHexString.fromText('Area Measurement') };
      return { ...base, Subtype: 'PolyLine', Vertices: flatNums(m.pts), IT: 'PolyLineDimension', Subj: PDFHexString.fromText('Perimeter Measurement') };
    default: return { ...base, Subtype: 'Square' };
  }
}

/** Measure/approximate a markup's extent in PDF space (text and stamps: their box). */
function rectOf(m, measure) {
  const b = bboxOf(m);
  if (m.type === 'measure') {
    const [lx, ly] = measureLabelAt(m);
    const size = m.fontSize || 12, tw = measure(m.text || '', size);
    b[0] = Math.min(b[0], lx - tw / 2 - size); b[2] = Math.max(b[2], lx + tw / 2 + size);
    b[1] = Math.min(b[1], ly - size); b[3] = Math.max(b[3], ly + size * 1.2);
  }
  return b;
}

/**
 * Builds the output PDF.
 *   source: bytes of the PDF to mark up, or null with `image` = { bytes, type: 'png' | 'jpg', width, height }
 *           or an array of them (one page each: the image at width × height points);
 *   pages:  [{ index (0-based), markups, map(x, y) -> [px, py] in PDF user space, scale (world -> pt) }];
 *   flatten: draw into the page content instead of adding annotations.
 * Returns Uint8Array.
 */
export async function writeMarkedPdf({ source = null, image = null, pages, flatten = false }) {
  let pdf;
  if (source) pdf = await PDFDocument.load(source, { ignoreEncryption: true, updateMetadata: false });
  else {
    pdf = await PDFDocument.create();
    for (const im of Array.isArray(image) ? image : [image]) {
      const img = im.type === 'jpg' ? await pdf.embedJpg(im.bytes) : await pdf.embedPng(im.bytes);
      const page = pdf.addPage([im.width, im.height]);
      page.drawImage(img, { x: 0, y: 0, width: im.width, height: im.height });
    }
  }
  const fonts = { reg: await pdf.embedFont(StandardFonts.Helvetica), bold: await pdf.embedFont(StandardFonts.HelveticaBold) };
  const ctx = pdf.context;
  const measure = (s, size) => fonts.reg.widthOfTextAtSize(safeText(fonts.reg, s), size);
  const allPages = pdf.getPages();
  for (const { index, markups, map, scale = 1 } of pages) {
    const page = allPages[index];
    if (!page || !markups.length) continue;
    if (flatten) isolateContent(page);
    for (const orig of markups) {
      const m = toPdfSpace(orig, map, scale);
      const rect = rectOf(m, measure).map((v) => Math.round(v * 1000) / 1000);
      const resources = ctx.obj({
        Font: { F1: fonts.reg.ref, F2: fonts.bold.ref },
        ExtGState: { GS0: { Type: 'ExtGState', CA: m.opacity ?? 1, ca: m.opacity ?? 1 } },
      });
      const form = ctx.flateStream(appearance(m, fonts), { Type: 'XObject', Subtype: 'Form', BBox: rect, Resources: resources });
      const formRef = ctx.register(form);
      if (flatten) {
        const name = page.node.newXObject('MkAP', formRef);
        page.pushOperators(pushGraphicsState(), drawObject(name), popGraphicsState());
        continue;
      }
      const dict = ctx.obj(annotDict(ctx, m, rect, formRef, fonts));
      // The app's own record of the markup, in the viewer's page coordinates.
      dict.set(PDFName.of(KEY), PDFHexString.fromText(JSON.stringify(orig)));
      dict.set(PDFName.of('P'), page.ref);
      page.node.addAnnot(ctx.register(dict));
    }
  }
  return pdf.save({ useObjectStreams: false });
}

/** Wraps the page's existing content in q … Q so that drawing appended after it starts from a clean state. */
function isolateContent(page) {
  page.node.normalize();
  const start = page.doc.context.register(page.createContentStream(pushGraphicsState()));
  const end = page.doc.context.register(page.createContentStream(popGraphicsState()));
  page.node.wrapContentStreams(start, end);
}

/**
 * Markups this app saved into a PDF (/PCMarkup annotations): returns { markups, bytes } where
 * `bytes` is the PDF without those annotations (they are shown and edited as markups instead),
 * or null when the file has none.
 */
export async function extractMarkups(bytes) {
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const markups = [];
  pdf.getPages().forEach((page, i) => {
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!annots) return;
    const mine = [];
    for (let k = annots.size() - 1; k >= 0; k--) {
      const a = annots.lookupMaybe(k, PDFDict);
      const raw = a?.lookupMaybe(PDFName.of(KEY), PDFHexString, PDFString);
      if (!raw) continue;
      try {
        const m = JSON.parse(raw.decodeText());
        m.page = i + 1;
        mine.unshift(m);
        annots.remove(k);
      } catch { /* not ours after all: leave it */ }
    }
    markups.push(...mine);
  });
  if (!markups.length) return null;
  return { markups, bytes: await pdf.save({ useObjectStreams: false }) };
}

export { mayHaveMarkups } from './markup.js';
