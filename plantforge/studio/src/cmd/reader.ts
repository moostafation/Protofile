// PlantForge command language: reading the words after a verb - objects and sets, positions, steps,
// distances, sizes, key=value pairs. Every reader method either consumes what it understands or throws a
// CmdError that says what was expected.

import { normalizeNps } from "../engine/catalog";
import { V3, add, scale } from "../engine/vec";
import { CmdError, Token, norm } from "./lexer";
import { DIRS, KINDS, Kind, compactDir, kw, lookup } from "./vocab";
import { EndTarget, ItemTarget, Ref, World } from "./world";

const SET_WORDS: Record<string, "equipment" | "structure"> = { equipment: "equipment", equip: "equipment", معدات: "equipment", steel: "structure", structures: "structure", structure: "structure", حديد: "structure" };

export interface Cond {
  key: string;
  op: string;
  value: string;
}

export class Reader {
  i = 0;
  constructor(
    readonly toks: Token[],
    readonly w: World,
    readonly src = "",
  ) {}

  get done() {
    return this.i >= this.toks.length;
  }
  peek(o = 0): Token | undefined {
    return this.toks[this.i + o];
  }
  next(): Token {
    const t = this.toks[this.i++];
    if (!t) throw new CmdError("The command ends too early");
    return t;
  }
  /** The rest of the statement as typed (for SQL). */
  restRaw(): string {
    const t = this.peek();
    if (!t) return "";
    const last = this.toks[this.toks.length - 1];
    this.i = this.toks.length;
    return this.src.slice(t.start, last.end);
  }
  isWord(o = 0) {
    return this.peek(o)?.t === "word";
  }
  /** Keyword name of the next token, if it is one. */
  peekKw(o = 0): string | undefined {
    const t = this.peek(o);
    return t?.t === "word" ? kw(t.v) : undefined;
  }
  takeKw(...names: string[]): string | null {
    const k = this.peekKw();
    if (k && names.includes(k)) {
      this.i++;
      return k;
    }
    return null;
  }
  takeOp(op: string): boolean {
    const t = this.peek();
    if (t?.t === "op" && t.v === op) {
      this.i++;
      return true;
    }
    return false;
  }
  peekKind(o = 0): Kind | undefined {
    const t = this.peek(o);
    return t?.t === "word" ? lookup(KINDS, t.v) : undefined;
  }
  takeKind(): Kind | undefined {
    const k = this.peekKind();
    if (k) this.i++;
    return k;
  }
  /** A pattern like x3 (copies). */
  takeTimes(): number | null {
    const t = this.peek();
    if (t?.t === "word" && /^[x×]\d+$/i.test(t.v)) {
      this.i++;
      return Number(t.v.slice(1));
    }
    if (this.takeKw("times")) return this.int("how many times");
    if (t?.t === "num" && kw(this.peek(1)?.v ?? "") === "times") {
      this.i += 2;
      return t.n!;
    }
    return null;
  }

  // ---------------------------------------------------------------- values
  num(what = "a number"): number {
    const t = this.peek();
    if (t?.t === "num") {
      this.i++;
      return t.n!;
    }
    throw new CmdError(`Expected ${what}${t ? `, not "${t.v}"` : ""}`);
  }
  maybeNum(): number | null {
    return this.peek()?.t === "num" ? this.num() : null;
  }
  int(what: string): number {
    const n = this.num(what);
    if (!Number.isInteger(n) || n < 1) throw new CmdError(`${what} must be a whole number`);
    return n;
  }
  /** A pipe size: 6" or, after "size", a plain 6. */
  size(): string {
    const t = this.next();
    if (t.t === "size" || t.t === "num") return normalizeNps(t.t === "size" ? t.v : String(t.n));
    throw new CmdError(`Expected a pipe size like 6", not "${t.v}"`);
  }
  maybeSize(): string | null {
    const t = this.peek();
    if (t?.t === "size") return this.size();
    if (this.takeKw("size")) return this.size();
    return null;
  }
  /** Text: 'quoted' or a single word. */
  text(what = "a name"): string {
    const t = this.next();
    if (t.t === "str" || t.t === "word" || t.t === "num") return t.v;
    throw new CmdError(`Expected ${what}`);
  }

  // ---------------------------------------------------------------- directions and positions
  /** One step: "east 500", "شرق 2m", "e500", "up 1500". */
  step(): { dir: V3; mm: number } | null {
    const t = this.peek();
    if (t?.t !== "word") return null;
    if (this.w.byName(t.v)) return null;
    const c = compactDir(t.v);
    if (c) {
      this.i++;
      return c;
    }
    const d = lookup(DIRS, t.v);
    if (d && this.peek(1)?.t === "num") {
      this.i += 2;
      return { dir: d, mm: this.toks[this.i - 1].n! };
    }
    return null;
  }
  /** Steps added up: "east 3000 north 500" (with an optional "by"); also "by 3000,500". */
  offsets(): V3 | null {
    this.takeKw("by");
    const t = this.peek();
    if (t?.t === "coord") {
      this.i++;
      return [t.nums![0], t.nums![1], t.nums![2] ?? 0];
    }
    let sum: V3 | null = null;
    for (let s = this.step(); s; s = this.step()) sum = add(sum ?? [0, 0, 0], scale(s.dir, s.mm));
    return sum;
  }
  /** An absolute position: 5000,3000[,EL] · e5000 n3000 · V-101 east 4000 · P-101A.N2 up 500. */
  position(): V3 {
    const t = this.peek();
    if (!t) throw new CmdError("Where? Give E,N like 5000,3000 or an object: at V-101 east 4000");
    if (t.t === "coord") {
      this.i++;
      const [e, n, z] = t.nums!;
      return [e, n, z ?? 0];
    }
    if (t.t === "word") {
      const end = this.w.end(t.v);
      const obj = end ? null : this.w.byName(t.v);
      const itRef = kw(t.v) === "it" ? this.w.it[0] : null;
      if (end || obj || itRef) {
        this.i++;
        let base: V3;
        if (end) {
          const r = end.ref.kind === "nozzle" ? this.w.model.equipment.get(end.ref.eq)?.nozzles.find((n) => n.props.name === (end.ref as { nozzle: string }).nozzle)?.ports[0].pos : null;
          base = r ?? this.w.position(end.owner);
        } else base = this.w.position((obj ?? itRef)!);
        return add(base, this.offsets() ?? [0, 0, 0]);
      }
      let p: [number, number, number] | null = null;
      for (let s = this.step(); s; s = this.step()) {
        p = p ?? [0, 0, 0];
        const k = s.dir[0] ? 0 : s.dir[1] ? 1 : 2;
        p[k] = s.mm * (s.dir[k] as number);
      }
      if (p) return p;
    }
    throw new CmdError(`I don't know where "${t.v}" is. Use E,N like 5000,3000, steps like e5000 n3000, or an object name`);
  }
  /** An angle in degrees ("90", "90deg", or a compass word: north 0, east 90, south 180, west 270). */
  angle(): number {
    const t = this.peek();
    if (t?.t === "num") return this.num();
    const d = t?.t === "word" ? lookup(DIRS, t.v) : undefined;
    if (d && !d[2]) {
      this.i++;
      return ((Math.round((Math.atan2(d[0], d[1]) * 180) / Math.PI) % 360) + 360) % 360;
    }
    throw new CmdError("Expected an angle like 90 or a direction like east");
  }

  // ---------------------------------------------------------------- objects
  /** One object. */
  ref(what = "an object"): Ref {
    const list = this.refs(what);
    if (list.length !== 1) throw new CmdError(`${what[0].toUpperCase()}${what.slice(1)}: expected one object, got ${list.length}`);
    return list[0];
  }

  /** A nozzle or tee branch. */
  end(): EndTarget {
    const t = this.next();
    const e = t.t === "word" ? this.w.end(t.v) : null;
    if (!e) throw new CmdError(`"${t.v}" is not a nozzle or tee branch. Write it as P-101A.N2 or 4"-P-1002.T1`);
    return e;
  }
  peekEnd(): EndTarget | null {
    const t = this.peek();
    return t?.t === "word" ? this.w.end(t.v) : null;
  }
  peekItem(): ItemTarget | null {
    const t = this.peek();
    return t?.t === "word" ? this.w.item(t.v) : null;
  }

  /**
   * A set of objects: names, wildcards (P-10*), kinds (pumps, lines, racks, equipment), it, selection, all,
   * joined with "and" or ",", optionally filtered: lines where nps>=6 and spec=A1A.
   */
  refs(what = "objects"): Ref[] {
    // each name or set is a group; "where" filters the group right before it:
    // "C-201 and lines where nps>=6" is C-201 plus the 6" and bigger lines
    const groups: Ref[][] = [];
    for (;;) {
      const t = this.peek();
      if (!t || t.t !== "word") break;
      const k = kw(t.v);
      const kind = lookup(KINDS, t.v);
      const setWord = SET_WORDS[norm(t.v)];
      const named = this.w.byName(t.v);
      let group: Ref[];
      if (named) group = [named];
      else if (k === "it") group = this.w.it;
      else if (k === "selection") group = this.w.selection;
      else if (k === "all") group = this.w.all();
      else if (setWord) group = setWord === "equipment" ? this.w.equipment() : this.w.racks();
      else if (kind === "line") group = this.w.lines();
      else if (kind === "rack") group = this.w.racks();
      else if (kind && ["pump", "vvessel", "column", "hdrum", "exchanger", "tank"].includes(kind)) {
        const tpl = kind === "column" ? "vvessel" : kind;
        group = this.w.doc.equipment.filter((e) => e.template === tpl && (kind !== "column" || (e.params.H ?? 0) >= 12000)).map((e) => this.w.ref("equipment", e));
      } else if (t.v.includes("*")) group = this.w.wildcard(t.v);
      else break;
      this.i++;
      if (this.takeKw("where")) {
        const conds = this.conds();
        group = group.filter((r) => conds.every((c) => test(this.w.attr(r, c.key), c)));
      }
      groups.push(group);
      if (this.takeOp(",") || (this.peekKw() === "and" && this.peek(1)?.t === "word" && !this.condAhead(1))) {
        if (this.peekKw() === "and") this.i++;
        continue;
      }
      break;
    }
    if (!groups.length) {
      const t = this.peek();
      throw new CmdError(t ? `I don't know "${t.v}"${this.suggestName(t.v)}` : `Which ${what}? Give a name like P-101A, a set like pumps, or "it"`);
    }
    const out: Ref[] = [];
    for (const r of groups.flat()) if (!out.some((o) => o.id === r.id)) out.push(r);
    return out;
  }

  private condAhead(o: number) {
    return this.peek(o + 1)?.t === "op";
  }

  conds(): Cond[] {
    const out: Cond[] = [];
    do {
      const key = this.next();
      const op = this.next();
      if (key.t !== "word" || op.t !== "op" || op.v === ",") throw new CmdError("A condition looks like nps>=6, status=approved or spec=A1A");
      const val = this.next();
      out.push({ key: key.v, op: op.v, value: val.t === "size" ? val.v : val.t === "num" ? String(val.v) : val.v });
    } while (this.takeKw("and"));
    return out;
  }

  /** key=value pairs (also "key value"). */
  pairs(): [string, Token[]][] {
    const out: [string, Token[]][] = [];
    while (!this.done) {
      const k = this.next();
      if (k.t !== "word") throw new CmdError(`Expected a property name, not "${k.v}"`);
      this.takeOp("=");
      const v = this.next();
      const vals = [v];
      out.push([k.v, vals]);
    }
    if (!out.length) throw new CmdError("What should change? e.g. rot=90, nps=6, desc='Feed pump'");
    return out;
  }

  /** Nothing should be left over. */
  end_(): void {
    if (!this.done) throw new CmdError(`I didn't understand "${this.src.slice(this.peek()!.start)}"`);
  }

  suggestName(word: string): string {
    const best = closest(word, this.w.names());
    return best ? `. Did you mean ${best}?` : "";
  }
}

function test(v: string | number | undefined, c: Cond): boolean {
  if (v === undefined) return false;
  const num = Number(c.value.replace(/"$/, ""));
  if (typeof v === "number" && Number.isFinite(num)) {
    switch (c.op) {
      case "=":
        return v === num;
      case "!=":
        return v !== num;
      case ">":
        return v > num;
      case "<":
        return v < num;
      case ">=":
        return v >= num;
      case "<=":
        return v <= num;
    }
  }
  const a = norm(String(v));
  const b = norm(c.value);
  const eq = b.includes("*") ? new RegExp(`^${b.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(a) : a === b || a.replace(/\s+/g, "") === b.replace(/\s+/g, "");
  return c.op === "!=" ? !eq : c.op === "=" ? eq : false;
}

/** The closest word by edit distance (for "did you mean"). */
export function closest(word: string, words: string[], max = 2): string | null {
  const w = word.toUpperCase();
  let best: string | null = null;
  let bd = max + 1;
  for (const c of words) {
    const d = lev(w, c.toUpperCase());
    if (d < bd) {
      bd = d;
      best = c;
    }
  }
  return bd <= max ? best : null;
}

function lev(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 3) return 99;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
