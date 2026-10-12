// PlantForge command language: running a line of commands. Statements are separated by ';' or "then";
// each one sees the plant as left by the one before ("it" carries over). A line can also be a macro,
// "again", or - while a pipe is being drawn - steps such as "east 2000" and "to E-101.N1".

import { ApprovalError } from "../engine/meta";
import { COMMANDS, Ctx, Env, Stop } from "./commands";
import { CmdError, Token, norm, statements, tokenize } from "./lexer";
import { Reader, closest } from "./reader";
import { VERBS, VERB_WORDS, kw, lookup } from "./vocab";
import { Ref, World } from "./world";

export interface Session {
  it: Ref[];
  last: string | null;
  macros: Record<string, string>;
}

export const newSession = (macros: Record<string, string> = {}): Session => ({ it: [], last: null, macros });

const ENGLISH_VERBS = VERB_WORDS.flatMap(([, w]) => w.filter((x) => /^[a-z-]+$/.test(x)));

/** Run one line. Returns false when a statement failed (the rest of the line is skipped). */
export function execute(text: string, env: Env, s: Session, depth = 0): boolean {
  const raw = text.trim();
  if (!raw) return true;
  if (depth > 8) {
    env.out("Macros call each other too deeply", "error");
    return false;
  }
  const first = raw.split(/\s+/)[0];
  const verb0 = lookup(VERBS, first);
  try {
    if (verb0 === "macro") return defineMacro(raw.slice(first.length).trim(), env, s);
    if (verb0 === "again") {
      if (!s.last) throw new CmdError("Nothing to repeat yet");
      env.out(`(again) ${s.last}`);
      return execute(s.last, env, s, depth + 1);
    }
    const tokens = tokenize(raw);
    for (const st of statements(tokens)) {
      const stRaw = raw.slice(st[0].start, st[st.length - 1].end);
      if (!statement(st, stRaw, env, s, depth)) return false;
    }
    if (depth === 0 && !["history", "help", "macros", "clear"].includes(verb0 ?? "")) s.last = raw;
    return true;
  } catch (e) {
    return fail(e, env);
  }
}

function fail(e: unknown, env: Env): false {
  if (e instanceof Stop) return false;
  if (e instanceof CmdError || e instanceof ApprovalError) {
    env.out(e.message, "error");
    return false;
  }
  throw e;
}

function statement(st: Token[], raw: string, env: Env, s: Session, depth: number): boolean {
  const w = new World(env.doc(), env.model(), s.it, env.selection());
  const t0 = st[0];
  try {
    // drawing a pipe: steps and "to <nozzle>" go to the route tool
    if (env.routing?.()) {
      const r = new Reader(st, w, raw);
      const step = r.step();
      if (step) {
        const steps = [step];
        for (let x = r.step(); x; x = r.step()) steps.push(x);
        r.end_();
        for (const x of steps) env.routeStep?.(x.dir, x.mm);
        return true;
      }
      if (t0.t === "word" && kw(t0.v) === "to") {
        r.i++;
        const end = r.end();
        r.end_();
        env.routeTo?.(end);
        return true;
      }
    }
    const verb = t0.t === "word" ? lookup(VERBS, t0.v) : undefined;
    if (!verb || verb === "run") {
      const name = verb === "run" ? (st[1]?.v ?? "") : t0.v;
      const body = s.macros[norm(name)];
      if (body) {
        const argsFrom = verb === "run" ? st[2] : st[1];
        const args = argsFrom ? raw.slice(argsFrom.start - st[0].start).trim().split(/\s+/) : [];
        const expanded = body.replace(/\$(\d|\*)/g, (_, k) => (k === "*" ? args.join(" ") : (args[Number(k) - 1] ?? "")));
        env.out(`(${name}) ${expanded}`);
        return execute(expanded, env, s, depth + 1);
      }
      if (verb === "run") throw new CmdError(`No macro "${name}". macros lists them`);
      // a bare name jumps to the object
      if (t0.t === "word" && (w.byName(t0.v) || w.end(t0.v))) return statement(tokenize(`find ${raw}`), `find ${raw}`, env, s, depth);
      const guess = t0.t === "word" ? (closest(t0.v, [...ENGLISH_VERBS, ...Object.keys(s.macros)]) ?? closest(t0.v, w.names())) : null;
      throw new CmdError(`I don't know "${t0.v}"${guess ? `. Did you mean ${guess}?` : ""} Type help for the commands.`);
    }
    const cmd = COMMANDS.find((c) => c.verb === verb)!;
    const ctx: Ctx = {
      env,
      w,
      macros: s.macros,
      it: (refs) => {
        s.it = refs;
      },
      say: (text, kind) => env.out(text, kind),
      table: (head, rows, max = 40) => table(env, head, rows, max),
      commit: (doc, label) => {
        if (!env.apply(doc, label)) throw new Stop();
      },
    };
    cmd.run(new Reader(st.slice(1), w, raw), ctx);
    return true;
  } catch (e) {
    return fail(e, env);
  }
}

function defineMacro(rest: string, env: Env, s: Session): boolean {
  const [name, ...body] = rest.split(/\s+/);
  if (!name) {
    env.out('macro <name> <commands>, e.g. macro pumpset add pump at $1 x2 spacing 2500 east');
    return false;
  }
  if (norm(name) === "delete" || norm(name) === "remove") {
    const n = norm(body[0] ?? "");
    if (!s.macros[n]) return env.out(`No macro ${body[0] ?? ""}`, "error"), false;
    delete s.macros[n];
    env.out(`Deleted macro ${n}`, "ok");
    return true;
  }
  const n = norm(name);
  if (!body.length) {
    env.out(s.macros[n] ? `${n}: ${s.macros[n]}` : `No macro ${n}`, s.macros[n] ? "out" : "error");
    return !!s.macros[n];
  }
  if (lookup(VERBS, n)) return env.out(`"${n}" is already a command; pick another name`, "error"), false;
  s.macros[n] = rest.slice(name.length).trim().replace(/^=\s*/, "");
  env.out(`Saved macro ${n}: ${s.macros[n]}`, "ok");
  return true;
}

function table(env: Env, head: string[], rows: unknown[][], max: number) {
  if (!rows.length) return env.out("(none)");
  const cell = (v: unknown) => {
    const t = v === null || v === undefined ? "" : typeof v === "number" ? String(Math.round(v * 100) / 100) : String(v);
    return t.length > 30 ? `${t.slice(0, 29)}…` : t;
  };
  const shown = rows.slice(0, max).map((r) => r.map(cell));
  const widths = head.map((h, i) => Math.max(h.length, ...shown.map((r) => (r[i] ?? "").length)));
  const line = (r: string[]) => r.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  env.out(line(head));
  for (const r of shown) env.out(line(r));
  if (rows.length > max) env.out(`… ${rows.length - max} more (${rows.length} in all)`);
}
