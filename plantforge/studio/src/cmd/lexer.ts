// PlantForge command language: tokens.
//   words      P-101A  P-101A.N2  4"-P-1002-A1A  pumps  طلمبة
//   numbers    500  2.5m  30m  6in  90deg  90°        (lengths are converted to mm)
//   sizes      6"  1-1/2"  3/4"                        (pipe NPS)
//   coords     5000,3000   5000,3000,4500              (E,N[,EL] in mm)
//   strings    'Feed pump'  "Cooling water"
//   operators  =  >  <  >=  <=  !=  ,
//   separator  ;

export type TokType = "word" | "num" | "size" | "coord" | "str" | "op" | "sep";

export interface Token {
  t: TokType;
  /** Text as typed (strings without their quotes). */
  v: string;
  /** Numbers: value in mm (lengths) or degrees (angles); plain numbers as typed. */
  n?: number;
  unit?: string;
  /** Coordinates. */
  nums?: number[];
  start: number;
  end: number;
}

const UNIT_MM: Record<string, number> = { mm: 1, cm: 10, m: 1000, km: 1_000_000, in: 25.4, ft: 304.8 };

export class CmdError extends Error {}

const COORD = /^-?\d+(?:\.\d+)?(?:\s*,\s*-?\d+(?:\.\d+)?){1,2}(?![\w.%"])/;
const NUM = /^(-?\d+(?:\.\d+)?)(mm|cm|m|km|in|ft|deg|°)?$/i;
const SIZE = /^(\d+(?:\.\d+)?(?:-\d+\/\d+)?|\d+\/\d+)"$/;
const STOP = new Set([" ", "\t", "\n", ";", "'", "=", "<", ">", "!", ","]);

export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === " " || c === "\t" || c === "\n") {
      i++;
      continue;
    }
    if (c === ";") {
      out.push({ t: "sep", v: ";", start: i, end: i + 1 });
      i++;
      continue;
    }
    // quoted text: 'single' anywhere, "double" only at the start of a token (6"-P-1002 is a word)
    if (c === "'" || c === '"') {
      const close = text.indexOf(c, i + 1);
      if (close < 0) throw new CmdError(`Text that starts with ${c} needs a closing ${c}`);
      out.push({ t: "str", v: text.slice(i + 1, close), start: i, end: close + 1 });
      i = close + 1;
      continue;
    }
    const two = text.slice(i, i + 2);
    if (two === ">=" || two === "<=" || two === "!=") {
      out.push({ t: "op", v: two, start: i, end: i + 2 });
      i += 2;
      continue;
    }
    if (c === "=" || c === "<" || c === ">" || c === ",") {
      out.push({ t: "op", v: c, start: i, end: i + 1 });
      i++;
      continue;
    }
    const m = COORD.exec(text.slice(i));
    if (m) {
      const nums = m[0].split(",").map((s) => Number(s.trim()));
      out.push({ t: "coord", v: m[0], nums, start: i, end: i + m[0].length });
      i += m[0].length;
      continue;
    }
    let j = i;
    while (j < text.length && !STOP.has(text[j])) j++;
    const word = text.slice(i, j);
    out.push(classify(word, i, j));
    i = j;
  }
  return out;
}

function classify(word: string, start: number, end: number): Token {
  const size = SIZE.exec(word);
  if (size) return { t: "size", v: size[1], start, end };
  const num = NUM.exec(word);
  if (num) {
    const unit = (num[2] ?? "").toLowerCase();
    const value = Number(num[1]);
    if (unit === "deg" || unit === "°") return { t: "num", v: word, n: value, unit: "deg", start, end };
    return { t: "num", v: word, n: unit ? value * UNIT_MM[unit] : value, unit: unit || undefined, start, end };
  }
  return { t: "word", v: word, start, end };
}

/** Lower case, Arabic letters unified (أ إ آ -> ا, ة -> ه, ى -> ي), diacritics and tatweel removed. */
export function norm(w: string): string {
  return w
    .toLowerCase()
    .replace(/[ً-ْـ]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي");
}

/** Split a token list into statements at ';' and at the words "then" / "ثم". */
export function statements(tokens: Token[]): Token[][] {
  const out: Token[][] = [[]];
  for (const t of tokens) {
    if (t.t === "sep" || (t.t === "word" && (norm(t.v) === "then" || norm(t.v) === "ثم"))) out.push([]);
    else out[out.length - 1].push(t);
  }
  return out.filter((s) => s.length);
}
