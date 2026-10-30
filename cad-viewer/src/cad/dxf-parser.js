// ASCII DXF reader. It produces the same object shape that libredwg-web's
// DwgDatabase uses for DWG files, so one tessellator can draw both formats.
// Angles are converted to radians and lineweights are left in 1/100 mm
// (the normalizer knows the difference through `source: 'dxf'`).

const DEG = Math.PI / 180;

function decode(buffer) {
  const bytes = new Uint8Array(buffer);
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 200000)));
  if (head.startsWith('AutoCAD Binary DXF')) {
    throw new Error('Binary DXF is not supported. Save the drawing as ASCII DXF or DWG.');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    const m = head.match(/\$DWGCODEPAGE\s*\r?\n\s*3\s*\r?\n\s*ANSI_(\d+)/i);
    const page = m ? `windows-${m[1]}` : 'windows-1252';
    try {
      return new TextDecoder(page).decode(bytes);
    } catch {
      return new TextDecoder('windows-1252').decode(bytes);
    }
  }
}

function readPairs(text) {
  const lines = text.split(/\r?\n/);
  const codes = [];
  const values = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i], 10);
    if (Number.isNaN(code)) {
      // Tolerate a stray blank line by resyncing one line forward.
      i -= 1;
      continue;
    }
    codes.push(code);
    values.push(lines[i + 1].replace(/\s+$/, ''));
  }
  return { codes, values };
}

/** Sequential cursor over (code, value) pairs. */
class Cursor {
  constructor(codes, values, start = 0, end = codes.length) {
    this.codes = codes;
    this.values = values;
    this.i = start;
    this.end = end;
  }
  get done() { return this.i >= this.end; }
  get code() { return this.codes[this.i]; }
  get value() { return this.values[this.i]; }
  num() { return parseFloat(this.values[this.i]); }
  int() { return parseInt(this.values[this.i], 10); }
  next() { this.i++; }
}

const num = (v) => parseFloat(v);
const int = (v) => parseInt(v, 10);

/** Reads the shared entity properties that appear in every entity. */
function common(e, code, v) {
  switch (code) {
    case 5: e.handle = v.trim(); return true;
    case 8: e.layer = v; return true;
    case 6: e.lineType = v; return true;
    case 62: e.colorIndex = int(v); return true;
    case 420: e.color = int(v) & 0xffffff; return true;
    case 370: e.lineweight = int(v); return true;
    case 48: e.lineTypeScale = num(v); return true;
    case 60: e.isVisible = int(v) === 0; return true;
    case 67: e.isInPaperSpace = int(v) === 1; return true;
    case 330: if (!e.ownerBlockRecordSoftId) e.ownerBlockRecordSoftId = v.trim(); return true;
    case 440: e.transparency = int(v); return true;
    default: return false;
  }
}

function newEntity(type) {
  return { type, handle: '', layer: '0', colorIndex: 256, lineweight: -1, lineTypeScale: 1, isVisible: true };
}

function pt(e, key) {
  if (!e[key]) e[key] = { x: 0, y: 0, z: 0 };
  return e[key];
}

/** Generic reader for entities whose codes don't repeat. `map` is code -> [key, axis|'num'|'int'|'str'|fn]. */
function simple(type, c, map) {
  const e = newEntity(type);
  for (; !c.done; c.next()) {
    const code = c.code, v = c.value;
    const m = map[code];
    if (m) {
      const [key, kind] = m;
      if (kind === 'x' || kind === 'y' || kind === 'z') pt(e, key)[kind] = num(v);
      else if (kind === 'num') e[key] = num(v);
      else if (kind === 'deg') e[key] = num(v) * DEG;
      else if (kind === 'int') e[key] = int(v);
      else e[key] = v;
    } else if (code === 100) {
      e._subclass = v;
    } else {
      common(e, code, v);
    }
  }
  return e;
}

const P = (key, base) => ({ [base]: [key, 'x'], [base + 10]: [key, 'y'], [base + 20]: [key, 'z'] });
const EXT = { 210: ['extrusionDirection', 'x'], 220: ['extrusionDirection', 'y'], 230: ['extrusionDirection', 'z'] };

const SIMPLE = {
  LINE: { ...P('startPoint', 10), ...P('endPoint', 11), ...EXT },
  CIRCLE: { ...P('center', 10), 40: ['radius', 'num'], ...EXT },
  ARC: { ...P('center', 10), 40: ['radius', 'num'], 50: ['startAngle', 'deg'], 51: ['endAngle', 'deg'], ...EXT },
  ELLIPSE: { ...P('center', 10), ...P('majorAxisEndPoint', 11), 40: ['axisRatio', 'num'], 41: ['startAngle', 'num'], 42: ['endAngle', 'num'], ...EXT },
  POINT: { ...P('position', 10), ...EXT },
  SOLID: { ...P('corner1', 10), ...P('corner2', 11), ...P('corner3', 12), ...P('corner4', 13), ...EXT },
  TRACE: { ...P('corner1', 10), ...P('corner2', 11), ...P('corner3', 12), ...P('corner4', 13), ...EXT },
  '3DFACE': { ...P('corner1', 10), ...P('corner2', 11), ...P('corner3', 12), ...P('corner4', 13), 70: ['flag', 'int'] },
  XLINE: { ...P('firstPoint', 10), ...P('unitDirection', 11) },
  RAY: { ...P('firstPoint', 10), ...P('unitDirection', 11) },
  TEXT: {
    ...P('startPoint', 10), ...P('endPoint', 11), 40: ['textHeight', 'num'], 1: ['text', 'str'], 50: ['rotation', 'deg'],
    41: ['xScale', 'num'], 51: ['obliqueAngle', 'deg'], 7: ['styleName', 'str'], 71: ['generationFlag', 'int'],
    72: ['halign', 'int'], 73: ['valign', 'int'], ...EXT,
  },
  INSERT: {
    2: ['name', 'str'], ...P('insertionPoint', 10), 41: ['xScale', 'num'], 42: ['yScale', 'num'], 43: ['zScale', 'num'],
    50: ['rotation', 'deg'], 70: ['columnCount', 'int'], 71: ['rowCount', 'int'], 44: ['columnSpacing', 'num'],
    45: ['rowSpacing', 'num'], 66: ['hasAttribs', 'int'], ...EXT,
  },
  DIMENSION: {
    2: ['name', 'str'], ...P('definitionPoint', 10), ...P('textPoint', 11), 1: ['text', 'str'], 42: ['measurement', 'num'],
    70: ['dimensionType', 'int'], 3: ['styleName', 'str'], ...P('subDefinitionPoint1', 13), ...P('subDefinitionPoint2', 14),
  },
  ACAD_TABLE: { 2: ['blockName', 'str'], ...P('startPoint', 10) },
  VIEWPORT: {
    ...P('viewportCenter', 10), 40: ['width', 'num'], 41: ['height', 'num'], 68: ['status', 'int'], 69: ['viewportId', 'int'],
    ...P('displayCenter', 12), 45: ['viewHeight', 'num'], 51: ['viewTwistAngle', 'deg'], 90: ['statusBitFlags', 'int'],
  },
};

function textDefaults(e) {
  e.text ??= '';
  e.textHeight ??= 1;
  e.rotation ??= 0;
  e.xScale ??= 1;
  e.halign ??= 0;
  e.valign ??= 0;
  e.startPoint ??= { x: 0, y: 0, z: 0 };
  e.endPoint ??= { x: 0, y: 0, z: 0 };
  return e;
}

function readAttrib(type, c) {
  // ATTRIB/ATTDEF reuse TEXT codes, but vertical alignment is 74 (73 is field length).
  const e = newEntity(type);
  const t = { thickness: 0, startPoint: { x: 0, y: 0 }, endPoint: { x: 0, y: 0 }, textHeight: 1, rotation: 0, xScale: 1, halign: 0, valign: 0, text: '' };
  let inMText = false;
  let seen72 = false;
  for (; !c.done; c.next()) {
    const code = c.code, v = c.value;
    if (code === 101) { inMText = true; continue; }
    if (inMText) continue; // embedded MTEXT copy of the attribute; the plain text fields are enough.
    switch (code) {
      case 10: t.startPoint.x = num(v); break;
      case 20: t.startPoint.y = num(v); break;
      case 11: t.endPoint.x = num(v); break;
      case 21: t.endPoint.y = num(v); break;
      case 40: t.textHeight = num(v); break;
      case 1: t.text = v; break;
      case 2: e.tag = v; break;
      case 3: e.prompt = v; break;
      case 50: t.rotation = num(v) * DEG; break;
      case 41: t.xScale = num(v); break;
      case 7: t.styleName = v; break;
      case 70: e.flags = int(v); break;
      // Some writers repeat 71/72 in the AcDbAttribute subclass; the AcDbText values come first.
      case 72: if (!seen72) { t.halign = int(v); seen72 = true; } break;
      case 74: t.valign = int(v); break;
      case 71: if (t.generationFlag === undefined) t.generationFlag = int(v); break;
      case 210: (t.extrusionDirection ??= { x: 0, y: 0, z: 1 }).x = num(v); break;
      case 220: (t.extrusionDirection ??= { x: 0, y: 0, z: 1 }).y = num(v); break;
      case 230: (t.extrusionDirection ??= { x: 0, y: 0, z: 1 }).z = num(v); break;
      default: common(e, code, v);
    }
  }
  e.text = t;
  return e;
}

function readMText(c) {
  const e = newEntity('MTEXT');
  const chunks = [];
  let last = '';
  for (; !c.done; c.next()) {
    const code = c.code, v = c.value;
    switch (code) {
      case 10: pt(e, 'insertionPoint').x = num(v); break;
      case 20: pt(e, 'insertionPoint').y = num(v); break;
      case 30: pt(e, 'insertionPoint').z = num(v); break;
      case 11: pt(e, 'direction').x = num(v); break;
      case 21: pt(e, 'direction').y = num(v); break;
      case 31: pt(e, 'direction').z = num(v); break;
      case 40: e.textHeight = num(v); break;
      case 41: e.rectWidth = num(v); break;
      case 44: e.lineSpacing = num(v); break;
      case 71: e.attachmentPoint = int(v); break;
      case 72: e.drawingDirection = int(v); break;
      case 3: chunks.push(v); break;
      case 1: last = v; break;
      case 7: e.styleName = v; break;
      case 50: e.rotation = num(v) * DEG; break;
      case 210: pt(e, 'extrusionDirection').x = num(v); break;
      case 220: pt(e, 'extrusionDirection').y = num(v); break;
      case 230: pt(e, 'extrusionDirection').z = num(v); break;
      default: common(e, code, v);
    }
  }
  e.text = chunks.join('') + last;
  e.textHeight ??= 1;
  e.attachmentPoint ??= 1;
  e.rotation ??= 0;
  e.insertionPoint ??= { x: 0, y: 0, z: 0 };
  return e;
}

function readLwPolyline(c) {
  const e = newEntity('LWPOLYLINE');
  e.vertices = [];
  e.flag = 0;
  let v = null;
  for (; !c.done; c.next()) {
    const code = c.code, val = c.value;
    switch (code) {
      case 10: v = { x: num(val), y: 0, bulge: 0 }; e.vertices.push(v); break;
      case 20: if (v) v.y = num(val); break;
      case 42: if (v) v.bulge = num(val); break;
      case 40: if (v) v.startWidth = num(val); break;
      case 41: if (v) v.endWidth = num(val); break;
      case 43: e.constantWidth = num(val); break;
      case 70: e.flag = int(val); break;
      case 38: e.elevation = num(val); break;
      case 210: pt(e, 'extrusionDirection').x = num(val); break;
      case 220: pt(e, 'extrusionDirection').y = num(val); break;
      case 230: pt(e, 'extrusionDirection').z = num(val); break;
      default: common(e, code, val);
    }
  }
  return e;
}

function readSpline(c) {
  const e = newEntity('SPLINE');
  e.knots = []; e.weights = []; e.controlPoints = []; e.fitPoints = [];
  let cp = null, fp = null;
  for (; !c.done; c.next()) {
    const code = c.code, v = c.value;
    switch (code) {
      case 70: e.flag = int(v); break;
      case 71: e.degree = int(v); break;
      case 40: e.knots.push(num(v)); break;
      case 41: e.weights.push(num(v)); break;
      case 10: cp = { x: num(v), y: 0, z: 0 }; e.controlPoints.push(cp); break;
      case 20: if (cp) cp.y = num(v); break;
      case 30: if (cp) cp.z = num(v); break;
      case 11: fp = { x: num(v), y: 0, z: 0 }; e.fitPoints.push(fp); break;
      case 21: if (fp) fp.y = num(v); break;
      case 31: if (fp) fp.z = num(v); break;
      default: common(e, code, v);
    }
  }
  e.degree ??= 3;
  e.flag ??= 0;
  return e;
}

function readLeader(c) {
  const e = newEntity('LEADER');
  e.vertices = [];
  let v = null;
  for (; !c.done; c.next()) {
    const code = c.code, val = c.value;
    switch (code) {
      case 10: v = { x: num(val), y: 0, z: 0 }; e.vertices.push(v); break;
      case 20: if (v) v.y = num(val); break;
      case 71: e.isArrowheadEnabled = int(val) === 1; break;
      case 72: e.isSpline = int(val) === 1; break;
      case 3: e.styleName = v; break;
      default: common(e, code, val);
    }
  }
  return e;
}

function readWipeout(type, c) {
  const e = newEntity(type);
  e.boundaryPoints = [];
  let b = null;
  for (; !c.done; c.next()) {
    const code = c.code, v = c.value;
    switch (code) {
      case 10: pt(e, 'position').x = num(v); break;
      case 20: pt(e, 'position').y = num(v); break;
      case 11: pt(e, 'uPixel').x = num(v); break;
      case 21: pt(e, 'uPixel').y = num(v); break;
      case 12: pt(e, 'vPixel').x = num(v); break;
      case 22: pt(e, 'vPixel').y = num(v); break;
      case 13: pt(e, 'imageSize').x = num(v); break;
      case 23: pt(e, 'imageSize').y = num(v); break;
      case 71: e.clippingBoundaryType = int(v); break;
      case 14: b = { x: num(v), y: 0 }; e.boundaryPoints.push(b); break;
      case 24: if (b) b.y = num(v); break;
      default: common(e, code, v);
    }
  }
  return e;
}

function readMLine(c) {
  // DXF MLINE: 11 vertex, 12 segment direction, 13 miter direction, 74 + 41s element params.
  const e = newEntity('MLINE');
  e.vertices = [];
  let v = null, line = null, remaining = 0;
  for (; !c.done; c.next()) {
    const code = c.code, val = c.value;
    switch (code) {
      case 40: e.scale = num(val); break;
      case 70: e.justification = int(val); break;
      case 71: e.flags = int(val); break;
      case 73: e.numberOfLines = int(val); break;
      case 11: v = { vertex: { x: num(val), y: 0, z: 0 }, vertexDirection: { x: 1, y: 0, z: 0 }, miterDirection: { x: 0, y: 1, z: 0 }, lines: [] }; e.vertices.push(v); break;
      case 21: if (v) v.vertex.y = num(val); break;
      case 12: if (v) v.vertexDirection.x = num(val); break;
      case 22: if (v) v.vertexDirection.y = num(val); break;
      case 13: if (v) v.miterDirection.x = num(val); break;
      case 23: if (v) v.miterDirection.y = num(val); break;
      case 74: if (v) { line = { segmentParams: [] }; v.lines.push(line); remaining = int(val); } break;
      case 41: if (line && remaining > 0) { line.segmentParams.push(num(val)); remaining--; } break;
      default: common(e, code, val);
    }
  }
  return e;
}

function readHatch(c) {
  const e = newEntity('HATCH');
  e.boundaryPaths = [];
  e.definitionLines = [];
  e.patternName = '';
  e.solidFill = 0;
  // Header part, up to the boundary path count (91).
  for (; !c.done; c.next()) {
    const code = c.code, v = c.value;
    if (code === 91) { c.next(); break; }
    switch (code) {
      case 2: e.patternName = v; break;
      case 70: e.solidFill = int(v); break;
      case 71: e.associativity = int(v); break;
      case 210: pt(e, 'extrusionDirection').x = num(v); break;
      case 220: pt(e, 'extrusionDirection').y = num(v); break;
      case 230: pt(e, 'extrusionDirection').z = num(v); break;
      case 30: e.elevation = num(v); break;
      default: common(e, code, v);
    }
  }
  const take = (code) => {
    if (!c.done && c.code === code) { const v = c.value; c.next(); return v; }
    return undefined;
  };
  const takeNum = (code, d = 0) => { const v = take(code); return v === undefined ? d : num(v); };
  const skipSources = () => {
    if (!c.done && c.code === 97) {
      const n = c.int(); c.next();
      for (let k = 0; k < n && !c.done && c.code === 330; k++) c.next();
    }
  };

  // Boundary paths: each starts with 92.
  while (!c.done && c.code === 92) {
    const flag = c.int(); c.next();
    if (flag & 2) {
      const path = { boundaryPathTypeFlag: flag, vertices: [], isClosed: true };
      const hasBulge = takeNum(72) === 1;
      path.isClosed = take(73) !== '0';
      const n = takeNum(93);
      for (let k = 0; k < n && !c.done; k++) {
        const x = takeNum(10), y = takeNum(20);
        const bulge = hasBulge && !c.done && c.code === 42 ? takeNum(42) : 0;
        path.vertices.push({ x, y, bulge });
      }
      e.boundaryPaths.push(path);
    } else {
      const path = { boundaryPathTypeFlag: flag, edges: [] };
      const n = takeNum(93);
      for (let k = 0; k < n && !c.done && c.code === 72; k++) {
        const type = c.int(); c.next();
        if (type === 1) {
          path.edges.push({ type, start: { x: takeNum(10), y: takeNum(20) }, end: { x: takeNum(11), y: takeNum(21) } });
        } else if (type === 2) {
          const edge = { type, center: { x: takeNum(10), y: takeNum(20) }, radius: takeNum(40) };
          edge.startAngle = takeNum(50) * DEG;
          edge.endAngle = takeNum(51) * DEG;
          edge.isCCW = takeNum(73, 1) === 1;
          path.edges.push(edge);
        } else if (type === 3) {
          const edge = { type, center: { x: takeNum(10), y: takeNum(20) }, end: { x: takeNum(11), y: takeNum(21) } };
          edge.lengthOfMinorAxis = takeNum(40);
          edge.startAngle = takeNum(50) * DEG;
          edge.endAngle = takeNum(51) * DEG;
          edge.isCCW = takeNum(73, 1) === 1;
          path.edges.push(edge);
        } else if (type === 4) {
          const edge = { type, degree: takeNum(94, 3), knots: [], controlPoints: [], fitDatum: [] };
          const rational = takeNum(73) === 1;
          edge.isPeriodic = takeNum(74) === 1;
          const nk = takeNum(95), ncp = takeNum(96);
          for (let j = 0; j < nk && !c.done && c.code === 40; j++) edge.knots.push(takeNum(40));
          for (let j = 0; j < ncp && !c.done && c.code === 10; j++) {
            const p = { x: takeNum(10), y: takeNum(20) };
            if (rational && !c.done && c.code === 42) p.weight = takeNum(42);
            edge.controlPoints.push(p);
          }
          // Fit data count (97) is ambiguous with the source-object count that ends a path.
          if (!c.done && c.code === 97) {
            const nextCode = c.codes[c.i + 1];
            if (nextCode === 11 || nextCode === 12 || nextCode === 97) {
              const nf = c.int(); c.next();
              for (let j = 0; j < nf && !c.done && c.code === 11; j++) edge.fitDatum.push({ x: takeNum(11), y: takeNum(21) });
              if (!c.done && c.code === 12) { take(12); take(22); }
              if (!c.done && c.code === 13) { take(13); take(23); }
            }
          }
          path.edges.push(edge);
        } else {
          break;
        }
      }
      e.boundaryPaths.push(path);
    }
    skipSources();
  }

  // Pattern data and the rest.
  let def = null, dashes = 0;
  for (; !c.done; c.next()) {
    const code = c.code, v = c.value;
    switch (code) {
      case 75: e.hatchStyle = int(v); break;
      case 76: e.patternType = int(v); break;
      case 52: e.patternAngle = num(v) * DEG; break;
      case 41: e.patternScale = num(v); break;
      case 53: def = { angle: num(v) * DEG, base: { x: 0, y: 0 }, offset: { x: 0, y: 0 }, dashLengths: [] }; e.definitionLines.push(def); break;
      case 43: if (def) def.base.x = num(v); break;
      case 44: if (def) def.base.y = num(v); break;
      case 45: if (def) def.offset.x = num(v); break;
      case 46: if (def) def.offset.y = num(v); break;
      case 79: dashes = int(v); break;
      case 49: if (def && dashes > 0) { def.dashLengths.push(num(v)); dashes--; } break;
      case 450: e.gradientFlag = int(v); break;
      case 470: e.gradientName = v; break;
      case 63: e.gradientColorIndex ??= int(v); break;
      case 421: e.gradientRgb ??= int(v) & 0xffffff; break;
      default: common(e, code, v);
    }
  }
  return e;
}

function readPolylineHeader(c) {
  const e = newEntity('POLYLINE');
  e.flag = 0;
  for (; !c.done; c.next()) {
    const code = c.code, v = c.value;
    switch (code) {
      case 70: e.flag = int(v); break;
      case 40: e.startWidth = num(v); break;
      case 41: e.endWidth = num(v); break;
      case 30: e.elevation = num(v); break;
      case 210: pt(e, 'extrusionDirection').x = num(v); break;
      case 220: pt(e, 'extrusionDirection').y = num(v); break;
      case 230: pt(e, 'extrusionDirection').z = num(v); break;
      default: common(e, code, v);
    }
  }
  e.vertices = [];
  return e;
}

function readVertex(c) {
  const v = { x: 0, y: 0, z: 0, bulge: 0, flag: 0 };
  for (; !c.done; c.next()) {
    const code = c.code, val = c.value;
    switch (code) {
      case 10: v.x = num(val); break;
      case 20: v.y = num(val); break;
      case 30: v.z = num(val); break;
      case 42: v.bulge = num(val); break;
      case 40: v.startWidth = num(val); break;
      case 41: v.endWidth = num(val); break;
      case 70: v.flag = int(val); break;
      case 71: v.polyfaceIndex0 = int(val); break;
      case 72: v.polyfaceIndex1 = int(val); break;
      case 73: v.polyfaceIndex2 = int(val); break;
      case 74: v.polyfaceIndex3 = int(val); break;
    }
  }
  return v;
}

function readEntity(type, c) {
  if (SIMPLE[type]) {
    const e = simple(type, c, SIMPLE[type]);
    if (type === 'TEXT') textDefaults(e);
    if (type === 'INSERT') { e.xScale ??= 1; e.yScale ??= 1; e.rotation ??= 0; e.attribs = []; }
    if (type === 'ARC') { e.startAngle ??= 0; e.endAngle ??= 0; }
    if (type === 'ELLIPSE') { e.startAngle ??= 0; e.endAngle ??= Math.PI * 2; }
    return e;
  }
  switch (type) {
    case 'LWPOLYLINE': return readLwPolyline(c);
    case 'SPLINE': return readSpline(c);
    case 'MTEXT': return readMText(c);
    case 'ATTRIB': case 'ATTDEF': return readAttrib(type, c);
    case 'HATCH': return readHatch(c);
    case 'LEADER': return readLeader(c);
    case 'WIPEOUT': case 'IMAGE': return readWipeout(type, c);
    case 'MLINE': return readMLine(c);
    case 'POLYLINE': return readPolylineHeader(c);
    default: {
      const e = newEntity(type);
      for (; !c.done; c.next()) common(e, c.code, c.value);
      return e;
    }
  }
}

function finishPolyline(e) {
  // Convert DXF POLYLINE into the DWG-style POLYLINE2D / POLYLINE3D / mesh variants.
  if (e.flag & 64) e.type = 'POLYFACE';
  else if (e.flag & 16) e.type = 'POLYGONMESH';
  else if (e.flag & 8) e.type = 'POLYLINE3D';
  else e.type = 'POLYLINE2D';
  return e;
}

/**
 * Parses an ASCII DXF file into a DwgDatabase-like object.
 * @param {ArrayBuffer} buffer
 */
export function parseDxf(buffer) {
  const { codes, values } = readPairs(decode(buffer));
  const db = {
    source: 'dxf',
    header: {},
    tables: { LAYER: { entries: [] }, LTYPE: { entries: [] }, STYLE: { entries: [] }, BLOCK_RECORD: { entries: [] } },
    objects: { LAYOUT: [] },
    entities: [],
  };
  const blocks = new Map(); // name -> record
  const recordByHandle = new Map();

  let i = 0;
  const n = codes.length;
  // Returns [start, end) of the record starting at i (a code-0 pair) excluding the 0 pair.
  const recordEnd = (start) => {
    let j = start + 1;
    while (j < n && codes[j] !== 0) j++;
    return j;
  };

  while (i < n) {
    if (codes[i] !== 0 || values[i] !== 'SECTION') { i++; continue; }
    const section = values[i + 1];
    i += 2;
    if (section === 'HEADER') {
      let name = null;
      while (i < n && !(codes[i] === 0 && values[i] === 'ENDSEC')) {
        const code = codes[i], v = values[i];
        if (code === 9) name = v;
        else if (name) {
          const key = name.slice(1);
          if (code === 10 || code === 20 || code === 30) {
            db.header[key] ??= { x: 0, y: 0, z: 0 };
            db.header[key][code === 10 ? 'x' : code === 20 ? 'y' : 'z'] = num(v);
          } else if (code >= 1 && code <= 9) db.header[key] = v;
          else db.header[key] = num(v);
        }
        i++;
      }
    } else if (section === 'TABLES') {
      while (i < n && !(codes[i] === 0 && values[i] === 'ENDSEC')) {
        if (codes[i] !== 0) { i++; continue; }
        const type = values[i];
        const end = recordEnd(i);
        const c = new Cursor(codes, values, i + 1, end);
        if (type === 'LAYER') {
          const l = { name: '', colorIndex: 7, color: undefined, off: false, frozen: false, locked: false, lineweight: -3, lineType: 'Continuous', plotFlag: 1 };
          for (; !c.done; c.next()) {
            switch (c.code) {
              case 2: l.name = c.value; break;
              case 62: { const ci = c.int(); l.off = ci < 0; l.colorIndex = Math.abs(ci); break; }
              case 420: l.color = c.int() & 0xffffff; break;
              case 70: { const f = c.int(); l.frozen = !!(f & 1); l.locked = !!(f & 4); break; }
              case 6: l.lineType = c.value; break;
              case 370: l.lineweight = c.int(); break;
              case 290: l.plotFlag = c.int(); break;
            }
          }
          db.tables.LAYER.entries.push(l);
        } else if (type === 'LTYPE') {
          const lt = { name: '', description: '', totalPatternLength: 0, pattern: [] };
          for (; !c.done; c.next()) {
            switch (c.code) {
              case 2: lt.name = c.value; break;
              case 3: lt.description = c.value; break;
              case 40: lt.totalPatternLength = c.num(); break;
              case 49: lt.pattern.push({ elementLength: c.num(), elementTypeFlag: 0 }); break;
              case 74: if (lt.pattern.length) lt.pattern[lt.pattern.length - 1].elementTypeFlag = c.int(); break;
            }
          }
          db.tables.LTYPE.entries.push(lt);
        } else if (type === 'STYLE') {
          const s = { name: '', font: '', widthFactor: 1, fixedTextHeight: 0 };
          for (; !c.done; c.next()) {
            switch (c.code) {
              case 2: s.name = c.value; break;
              case 3: s.font = c.value; break;
              case 41: s.widthFactor = c.num(); break;
              case 40: s.fixedTextHeight = c.num(); break;
            }
          }
          db.tables.STYLE.entries.push(s);
        } else if (type === 'BLOCK_RECORD') {
          const r = { name: '', handle: '', flags: 0, entities: [], basePoint: { x: 0, y: 0, z: 0 } };
          for (; !c.done; c.next()) {
            if (c.code === 2) r.name = c.value;
            else if (c.code === 5) r.handle = c.value.trim();
            else if (c.code === 340) r.layout = c.value.trim();
          }
          db.tables.BLOCK_RECORD.entries.push(r);
          recordByHandle.set(r.handle, r);
          blocks.set(r.name, r);
        }
        i = end;
      }
    } else if (section === 'BLOCKS' || section === 'ENTITIES') {
      let current = null; // block record receiving entities (BLOCKS section)
      let parent = null; // POLYLINE or INSERT awaiting VERTEX/ATTRIB/SEQEND
      while (i < n && !(codes[i] === 0 && values[i] === 'ENDSEC')) {
        if (codes[i] !== 0) { i++; continue; }
        const type = values[i];
        const end = recordEnd(i);
        const c = new Cursor(codes, values, i + 1, end);
        i = end;
        if (type === 'BLOCK') {
          const b = { name: '', flags: 0, basePoint: { x: 0, y: 0, z: 0 }, entities: [] };
          let owner = '';
          for (; !c.done; c.next()) {
            switch (c.code) {
              case 2: b.name = c.value; break;
              case 70: b.flags = c.int(); break;
              case 10: b.basePoint.x = c.num(); break;
              case 20: b.basePoint.y = c.num(); break;
              case 30: b.basePoint.z = c.num(); break;
              case 330: owner = c.value.trim(); break;
            }
          }
          let rec = blocks.get(b.name) || recordByHandle.get(owner);
          if (!rec) {
            rec = { name: b.name, handle: owner, entities: [] };
            db.tables.BLOCK_RECORD.entries.push(rec);
            blocks.set(b.name, rec);
          }
          rec.name = b.name;
          rec.flags = b.flags;
          rec.basePoint = b.basePoint;
          rec.entities = [];
          current = rec;
          continue;
        }
        if (type === 'ENDBLK') { current = null; parent = null; continue; }
        if (type === 'SEQEND') {
          if (parent && parent.type === 'POLYLINE') finishPolyline(parent);
          parent = null;
          continue;
        }
        if (type === 'VERTEX') {
          if (parent && parent.type === 'POLYLINE') parent.vertices.push(readVertex(c));
          continue;
        }
        if (type === 'ATTRIB' && parent && parent.type === 'INSERT') {
          parent.attribs.push(readAttrib('ATTRIB', c));
          continue;
        }
        if (parent && parent.type === 'POLYLINE') finishPolyline(parent);
        parent = null;
        const e = readEntity(type, c);
        if (type === 'POLYLINE') parent = e;
        else if (type === 'INSERT' && e.hasAttribs === 1) parent = e;
        if (current) current.entities.push(e);
        else db.entities.push(e);
      }
      if (parent && parent.type === 'POLYLINE') finishPolyline(parent);
    } else if (section === 'OBJECTS') {
      while (i < n && !(codes[i] === 0 && values[i] === 'ENDSEC')) {
        if (codes[i] !== 0) { i++; continue; }
        const type = values[i];
        const end = recordEnd(i);
        if (type === 'LAYOUT') {
          const lo = { layoutName: '', tabOrder: 0, paperSpaceTableId: '' };
          let inLayout = false;
          for (let j = i + 1; j < end; j++) {
            if (codes[j] === 100 && values[j] === 'AcDbLayout') inLayout = true;
            else if (inLayout && codes[j] === 1) lo.layoutName = values[j];
            else if (inLayout && codes[j] === 71) lo.tabOrder = int(values[j]);
            else if (inLayout && codes[j] === 330) lo.paperSpaceTableId = values[j].trim();
          }
          db.objects.LAYOUT.push(lo);
        }
        i = end;
      }
    } else {
      while (i < n && !(codes[i] === 0 && values[i] === 'ENDSEC')) i++;
    }
  }

  // Entities from the ENTITIES section belong to model space unless flagged as paper space.
  const model = [...blocks.values()].find((b) => /^\*model_space$/i.test(b.name));
  const paper = [...blocks.values()].find((b) => /^\*paper_space$/i.test(b.name));
  for (const e of db.entities) {
    if (e.isInPaperSpace && paper) e.ownerBlockRecordSoftId = paper.handle;
    else if (model) e.ownerBlockRecordSoftId = model.handle;
  }
  if (model) model.entities = db.entities.filter((e) => !e.isInPaperSpace);
  if (paper) paper.entities = [...paper.entities, ...db.entities.filter((e) => e.isInPaperSpace)];
  return db;
}
