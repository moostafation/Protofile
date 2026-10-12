// PlantForge command language: suggestions while typing. Knows what each command expects next, so after
// "connect P-101A.N2 to" it offers the free nozzles of the same size first.

import { nextTag } from "../engine/commands";
import { TEMPLATES } from "../engine/equipment";
import { REPORTS } from "../db/schema";
import { COMMANDS } from "./commands";
import { Token, norm, statements, tokenize } from "./lexer";
import { KINDS, Kind, VERBS, VERB_WORDS, kw, lookup } from "./vocab";
import { EndTarget, World } from "./world";

export interface Suggestion {
  label: string;
  /** Text that replaces the word being typed. */
  insert: string;
  detail?: string;
}

export interface Suggestions {
  items: Suggestion[];
  /** Syntax of the command being typed. */
  hint: string;
  /** Where the word being typed starts. */
  from: number;
}

const ARABIC = /[؀-ۿ]/;
const S = (label: string, detail?: string, insert = label): Suggestion => ({ label, detail, insert });
const SETS = [S("it", "the last thing made or found"), S("selection", "what is selected"), S("pumps"), S("lines"), S("equipment"), S("racks"), S("all")];
const DIR_STEPS = ["east 1000", "west 1000", "north 1000", "south 1000", "up 1000", "down 1000"].map((d) => S(d, "step (mm, or 2m)"));
const KINDS_ADD: [string, string][] = [
  ["pump", "centrifugal pump"],
  ["vessel", "vertical vessel"],
  ["column", "tall column"],
  ["drum", "horizontal drum"],
  ["exchanger", "shell & tube"],
  ["tank", "storage tank"],
  ["rack", "pipe rack"],
  ["nozzle", "on equipment"],
  ["gate", "gate valve on a line"],
  ["globe", "globe valve on a line"],
  ["check", "check valve on a line"],
  ["tee", "tee on a line"],
  ["system", "hierarchy system"],
];
const WHERE_KEYS = ["nps", "spec", "status", "system", "fluid", "type", "length", "elbows", "valves", "errors", "group"].map((k) => S(`${k}=`, "filter", `${k}=`));

export function suggest(text: string, w: World, macros: Record<string, string> = {}): Suggestions {
  let tokens: Token[];
  try {
    tokens = tokenize(text);
  } catch {
    return { items: [], hint: "", from: text.length };
  }
  const trailing = /\s$/.test(text) || text === "";
  const last = tokens[tokens.length - 1];
  const typing = !trailing && last && last.t !== "str" && last.t !== "sep" ? last : null;
  const from = typing ? typing.start : text.length;
  const partial = typing ? text.slice(typing.start) : "";
  const all = typing ? tokens.slice(0, -1) : tokens;
  const sts = statements(all);
  const endsWithSep = all.length && (all[all.length - 1].t === "sep" || (all[all.length - 1].t === "word" && ["then", "ثم"].includes(norm(all[all.length - 1].v))));
  const st = endsWithSep || !sts.length ? [] : sts[sts.length - 1];
  const filter = (items: Suggestion[]) => {
    const p = norm(partial.replace(/^["']/, ""));
    const hits = p ? items.filter((i) => norm(i.label).startsWith(p) || (p.length >= 2 && norm(i.label).includes(p))) : items;
    return hits.sort((a, b) => Number(!norm(a.label).startsWith(p)) - Number(!norm(b.label).startsWith(p))).slice(0, 9);
  };

  if (!st.length) {
    const arabic = ARABIC.test(partial);
    const verbs = COMMANDS.filter((c) => c.verb !== "flanged" && c.verb !== "again").map((c) => S(c.verb, c.summary));
    const ar = VERB_WORDS.flatMap(([v, ws]) => ws.filter((x) => ARABIC.test(x)).map((x) => S(x, COMMANDS.find((c) => c.verb === v)?.ar ?? v)));
    const mac = Object.keys(macros).map((m) => S(m, `macro: ${macros[m]}`));
    const objs = partial.length >= 2 ? w.names().map((n) => S(n, "jump to it")) : [];
    return { items: filter([...(arabic ? ar : verbs), ...mac, ...objs]), hint: "Type a command (help lists them) or a name to jump to it", from };
  }

  const verb = st[0].t === "word" ? lookup(VERBS, st[0].v) : undefined;
  const cmd = COMMANDS.find((c) => c.verb === verb);
  const hint = cmd ? cmd.syntax : macros[norm(st[0].v)] ? `macro: ${macros[norm(st[0].v)]}` : "";
  if (!cmd) return { items: [], hint, from };
  const args = st.slice(1);
  const prev = args[args.length - 1];
  const prevKw = prev?.t === "word" ? kw(prev.v) : undefined;

  const names = (filterType?: "equipment" | "line" | "structure") =>
    (filterType ? (filterType === "equipment" ? w.equipment() : filterType === "line" ? w.lines() : w.racks()) : w.all()).map((r) => S(r.name, w.kindName(r)));
  const ends = (e: EndTarget[], nps?: string) =>
    e
      .filter((x) => x.free)
      .sort((a, b) => Number(nps ? a.nps !== nps : 0) - Number(nps ? b.nps !== nps : 0))
      .map((x) => S(x.label, `${x.nps}" free${nps && x.nps !== nps ? " (other size)" : ""}`));
  const refsThen = (after: Suggestion[]) => (args.length === 0 || prevKw === "and" || prev?.v === "," ? [...names(), ...SETS] : prevKw === "where" ? WHERE_KEYS : after);
  let items: Suggestion[] = [];

  switch (verb) {
    case "add": {
      const kind = args[0]?.t === "word" ? lookup(KINDS, args[0].v) : undefined;
      if (!args.length) items = KINDS_ADD.map(([k, d]) => S(k, d));
      else if (prevKw === "at") items = [S("0,0", "E,N in mm"), ...names("equipment")];
      else if (prevKw === "on") items = kind === "nozzle" ? names("equipment").filter((n) => n.detail !== "pump") : names("line");
      else if (prevKw === "near") items = [S("start"), S("end")];
      else if (prevKw === "facing" || prevKw === "branch") items = ["north", "east", "south", "west", "top", "bottom", "up", "down"].map((d) => S(d));
      else if (kind && ["pump", "vvessel", "column", "hdrum", "exchanger", "tank"].includes(kind)) {
        const tpl = TEMPLATES[kind === "column" ? "vvessel" : (kind as Exclude<Kind, "column">) as keyof typeof TEMPLATES];
        items = [
          ...(args.length === 1 ? [S(nextTag(w.doc, tpl.prefix), "next free tag")] : []),
          S("at", "where: 5000,3000 or V-101 east 4000"),
          S("rot", "rotation, e.g. rot 90"),
          S("x2", "number of copies"),
          S("spacing", "between copies, e.g. spacing 2500 east"),
          S("as", "description"),
          ...Object.keys(tpl.params).map((p) => S(`${p}=`, "size (mm)", `${p}=`)),
        ];
      } else if (kind === "rack") items = ["at", "along", "length", "width", "levels", "bay"].map((k) => S(k));
      else if (kind === "nozzle") items = args.length === 1 ? ['2"', '3"', '4"', '6"', '8"'].map((s) => S(s, "size")) : ["on", "facing", "elev", "top", "station", "as", "proj"].map((k) => S(k));
      else if (kind && ["gate", "globe", "check", "valve", "tee"].includes(kind)) items = (args.length === 1 && kind !== "tee" && kind !== "valve" ? [S("valve")] : []).concat(["on", "at", "mid", "near", ...(kind === "tee" ? ["branch"] : [])].map((k) => S(k)));
      break;
    }
    case "connect": {
      const first = args[0]?.t === "word" ? w.end(args[0].v) : null;
      if (!args.length) items = ends(w.ends());
      else if (args.length === 1) items = [S("to")];
      else if (prevKw === "to") items = ends(w.ends().filter((e) => e.label !== first?.label), first?.nps);
      else items = ["size", "spec", "as", "number"].map((k) => S(k));
      break;
    }
    case "route": {
      const first = args.find((a) => a.t === "word" && w.end(a.v));
      const nps = first ? w.end(first.v)?.nps : undefined;
      if (!args.length) items = [S("from", "a nozzle"), S("at", "a point")];
      else if (prevKw === "from") items = ends(w.ends());
      else if (prevKw === "to") items = ends(w.ends(), nps);
      else if (prevKw === "at") items = [S("0,0,3000", "E,N,EL")];
      else items = [...DIR_STEPS, S("to", "finish at a nozzle (auto-route)"), S("flanged"), S("size"), S("as")];
      break;
    }
    case "move":
    case "copy":
      items = refsThen(prevKw === "to" ? [S("0,0"), ...names()] : [...DIR_STEPS, S("to", "a position"), ...(verb === "copy" ? [S("x2", "copies"), S("as")] : []), S("where")]);
      break;
    case "rotate":
      items = refsThen([S("90"), S("180"), S("-90"), S("by")]);
      break;
    case "set": {
      const ref = args[0]?.t === "word" ? w.byName(args[0].v) : null;
      const noz = args[0]?.t === "word" ? w.end(args[0].v) : null;
      if (!args.length) items = [...names(), ...SETS, ...w.ends().map((e) => S(e.label, `${e.nps}" nozzle`))];
      else if (prev?.t === "op" && prev.v === "=") {
        const key = norm(args[args.length - 2]?.v ?? "");
        items =
          key === "status"
            ? ["working", "review", "approved", "rejected"].map((x) => S(x))
            : key === "color"
              ? ["yellow", "green", "blue", "orange", "teal", "purple", "pink", "lime"].map((x) => S(x))
              : key === "system"
                ? (w.doc.hierarchy ?? []).filter((h) => h.kind === "system").map((h) => S(`'${h.name}'`))
                : [];
      } else {
        const keys = noz
          ? ["nps", "service", "proj", "elev", "facing", "station"]
          : ref?.type === "equipment"
            ? ["tag", "desc", "rot", "e", "n", "el", ...Object.keys(TEMPLATES[w.eq(ref.id)!.template].params)]
            : ref?.type === "line"
              ? ["number", "spec", "nps", "fluid", "color"]
              : ref?.type === "structure"
                ? ["tag", "length", "width", "bay", "levels", "along"]
                : ["status", "system", "group"];
        items = refsThen([...keys, "status", "system", "group"].map((k) => S(`${k}=`, "property", `${k}=`)).concat(S("where")));
      }
      break;
    }
    case "view":
      items = ["iso", "iso ne", "iso nw", "iso se", "plan", "north", "south", "east", "west"].map((v) => S(v));
      break;
    case "color":
      items = args.length ? [S("status"), S("line")] : [S("by status"), S("by line")];
      break;
    case "labels":
      items = [S("on"), S("off")];
      break;
    case "export":
      items = [S("zip", "PCF + iso DXF/SVG + MTO"), S("mto", "csv"), S("json", "model"), S("ifc", "input for the Python engine"), S("png", "screenshot"), S("database", ".sqlite in .zip"), S("reports", "all reports as csv")];
      break;
    case "report":
      items = REPORTS.map((r) => S(r.name.toLowerCase()));
      break;
    case "help":
      items = COMMANDS.map((c) => S(c.verb, c.summary));
      break;
    case "list":
    case "count":
      items = refsThen([S("where")]);
      if (!args.length) items = [S("free nozzles"), S("valves"), S("nozzles"), S("systems"), ...(verb === "list" ? [S("reports")] : []), ...items];
      break;
    case "measure":
      items = !args.length || prevKw === "to" ? [...names(), ...w.ends().map((e) => S(e.label, `${e.nps}" nozzle`))] : [S("to")];
      break;
    case "info":
      items = [...names(), ...w.ends().map((e) => S(e.label, `${e.nps}" nozzle`))];
      break;
    case "iso":
      items = names("line");
      break;
    case "section":
      items = refsThen([]).concat(args.length ? [] : [S("off")]);
      break;
    case "macro":
      items = Object.keys(macros).map((m) => S(m, macros[m]));
      break;
    case "run":
      items = Object.keys(macros).map((m) => S(m, macros[m]));
      break;
    case "find":
    case "select":
    case "zoom":
    case "show":
    case "hide":
    case "isolate":
    case "delete":
    case "reroute":
    case "approve":
    case "submit":
    case "reject":
    case "reopen":
    case "rename":
      items = refsThen([S("where"), S("and")]);
      break;
  }
  return { items: filter(items).map((i) => ({ ...i, insert: /[=.]$/.test(i.insert) ? i.insert : `${i.insert} ` })), hint, from };
}
