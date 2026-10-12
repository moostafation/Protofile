// PlantForge command language: words. Every command and keyword has an English name and Arabic aliases;
// lookups go through norm() so spelling variants (أ/ا, ة/ه, ى/ي, diacritics) all match.

import type { TemplateId } from "../engine/doc";
import type { V3 } from "../engine/vec";
import { norm } from "./lexer";

const table = <T>(rows: [T, string[]][]): Map<string, T> => {
  const m = new Map<string, T>();
  for (const [value, words] of rows) for (const w of words) m.set(norm(w), value);
  return m;
};

/** Arabic words often carry the article: "الطلمبة" -> "طلمبه". */
const variants = (w: string) => {
  const n = norm(w);
  return n.startsWith("ال") && n.length > 3 ? [n, n.slice(2)] : [n];
};
export const lookup = <T>(m: Map<string, T>, w: string): T | undefined => {
  for (const v of variants(w)) {
    const hit = m.get(v);
    if (hit !== undefined) return hit;
  }
  return undefined;
};

// ------------------------------------------------------------------ verbs
export const VERB_WORDS: [string, string[]][] = [
  ["add", ["add", "new", "create", "place", "ضيف", "اضف", "زود", "انشئ", "حط"]],
  ["connect", ["connect", "link", "وصل", "اوصل"]],
  ["route", ["route", "draw", "ارسم", "مد"]],
  ["copy", ["copy", "duplicate", "array", "انسخ", "كرر"]],
  ["move", ["move", "shift", "حرك", "انقل", "زق"]],
  ["rotate", ["rotate", "turn", "لف", "ادر"]],
  ["set", ["set", "change", "edit", "خلي", "غير", "عدل", "اجعل"]],
  ["rename", ["rename", "سمي"]],
  ["delete", ["delete", "remove", "erase", "امسح", "احذف", "شيل"]],
  ["reroute", ["reroute", "re-route"]],
  ["find", ["find", "search", "go", "goto", "دور", "ابحث", "لاقي", "روح"]],
  ["select", ["select", "pick", "اختار", "حدد"]],
  ["zoom", ["zoom", "fit", "frame", "قرب", "زوم"]],
  ["view", ["view", "look", "منظر", "بص"]],
  ["show", ["show", "unhide", "اظهر", "وري"]],
  ["hide", ["hide", "اخفي", "خبي"]],
  ["isolate", ["isolate", "only", "اعزل", "بس"]],
  ["color", ["color", "colour", "لون"]],
  ["labels", ["labels", "tags", "اسامي", "ليبل"]],
  ["section", ["section", "cut", "قطاع", "اقطع"]],
  ["info", ["info", "about", "what", "معلومات", "بيانات", "ايه"]],
  ["list", ["list", "table", "قائمه", "لسته", "جدول"]],
  ["count", ["count", "how-many", "عد", "كام"]],
  ["measure", ["measure", "distance", "قيس", "المسافه"]],
  ["check", ["check", "verify", "افحص", "راجع"]],
  ["clash", ["clash", "clashes", "تصادم", "كلاش"]],
  ["approve", ["approve", "اعتمد", "وافق"]],
  ["submit", ["submit", "review", "قدم"]],
  ["reject", ["reject", "ارفض"]],
  ["reopen", ["reopen", "unlock", "افتح"]],
  ["iso", ["iso", "isometric", "ايزو"]],
  ["export", ["export", "download", "صدر", "نزل"]],
  ["save", ["save", "احفظ"]],
  ["sql", ["sql", "query", "استعلام"]],
  ["report", ["report", "تقرير"]],
  ["undo", ["undo", "تراجع", "رجع"]],
  ["redo", ["redo"]],
  ["again", ["again", "repeat", ".", "تاني", "كمان"]],
  ["macro", ["macro", "ماكرو"]],
  ["macros", ["macros", "ماكروز"]],
  ["run", ["run", "شغل"]],
  ["history", ["history", "سجل"]],
  ["clear", ["clear", "cls", "نضف"]],
  ["help", ["help", "?", "مساعده", "ساعدني"]],
  ["finish", ["finish", "done", "end", "خلص"]],
  ["flanged", ["flanged", "flange", "فلانشه"]],
];
export const VERBS = table(VERB_WORDS);

// ------------------------------------------------------------------ object kinds
export type Kind = TemplateId | "column" | "rack" | "nozzle" | "valve" | "gate" | "globe" | "check" | "tee" | "system" | "line";
export const KINDS = table<Kind>([
  ["pump", ["pump", "pumps", "طلمبه", "طلمبات", "مضخه", "مضخات"]],
  ["vvessel", ["vessel", "vessels", "drum-v", "فيسل", "وعاء", "اوعيه"]],
  ["column", ["column", "columns", "tower", "عمود", "برج", "اعمده"]],
  ["hdrum", ["drum", "drums", "درم", "درام"]],
  ["exchanger", ["exchanger", "exchangers", "hx", "مبادل", "مبادلات"]],
  ["tank", ["tank", "tanks", "تانك", "خزان", "تانكات", "خزانات"]],
  ["rack", ["rack", "racks", "piperack", "راك", "راكات"]],
  ["nozzle", ["nozzle", "nozzles", "نوزل", "فوهه", "نوزلات"]],
  ["valve", ["valve", "valves", "بلف", "محبس", "بلوف"]],
  ["gate", ["gate", "جيت", "بوابه"]],
  ["globe", ["globe", "جلوب"]],
  ["check", ["check", "non-return", "تشيك"]],
  ["tee", ["tee", "tees", "تي"]],
  ["system", ["system", "systems", "سيستم", "نظام"]],
  ["line", ["line", "lines", "pipe", "pipes", "pipeline", "pipelines", "خط", "خطوط", "ماسوره", "مواسير"]],
]);

// ------------------------------------------------------------------ directions
export const DIRS = table<V3>([
  [[1, 0, 0], ["east", "e", "شرق"]],
  [[-1, 0, 0], ["west", "w", "غرب"]],
  [[0, 1, 0], ["north", "n", "شمال"]],
  [[0, -1, 0], ["south", "s", "جنوب"]],
  [[0, 0, 1], ["up", "u", "el", "elevation", "فوق", "لفوق"]],
  [[0, 0, -1], ["down", "d", "تحت", "لتحت"]],
]);

/** Compact form: e500, n-200, u1.5m. */
export function compactDir(word: string): { dir: V3; mm: number } | null {
  const m = /^([ewnsud])(-?\d+(?:\.\d+)?)(mm|m)?$/i.exec(word);
  if (!m) return null;
  const dir = DIRS.get(m[1].toLowerCase())!;
  return { dir, mm: Number(m[2]) * (m[3]?.toLowerCase() === "m" ? 1000 : 1) };
}

// ------------------------------------------------------------------ keywords
export const KEYWORDS = table<string>([
  ["at", ["at", "@", "عند", "في"]],
  ["to", ["to", "into", "with", "الى", "لحد", "مع", "ل"]],
  ["from", ["from", "من"]],
  ["by", ["by", "بمقدار"]],
  ["on", ["on", "onto", "of", "على", "علي"]],
  ["where", ["where", "whose", "with-only", "لما", "اللي"]],
  ["and", ["and", "&", "و"]],
  ["rot", ["rot", "rotation", "rotated", "angle", "زاويه"]],
  ["times", ["times", "copies", "مرات", "نسخ"]],
  ["spacing", ["spacing", "every", "step", "كل"]],
  ["as", ["as", "service", "fluid", "خدمه"]],
  ["size", ["size", "nps", "bore", "مقاس"]],
  ["spec", ["spec", "class", "سبك"]],
  ["number", ["number", "no", "رقم"]],
  ["along", ["along", "axis", "بطول", "اتجاه"]],
  ["length", ["length", "long", "طول"]],
  ["width", ["width", "wide", "عرض"]],
  ["levels", ["levels", "tiers", "ادوار"]],
  ["facing", ["facing", "towards", "ناحيه", "باصص"]],
  ["elev", ["elev", "height", "ارتفاع"]],
  ["station", ["station", "محطه"]],
  ["top", ["top", "roof", "head", "فوق-الراس"]],
  ["bottom", ["bottom", "تحت-خالص"]],
  ["branch", ["branch", "فرع"]],
  ["mid", ["mid", "middle", "center", "centre", "النص", "نص"]],
  ["start", ["start", "beginning", "البدايه", "بدايه"]],
  ["end", ["end", "النهايه", "نهايه"]],
  ["near", ["near", "close", "جنب", "قرب"]],
  ["in", ["in", "inside", "جوه"]],
  ["all", ["all", "everything", "الكل", "كله", "كل-حاجه"]],
  ["none", ["none", "nothing", "ولاحاجه"]],
  ["it", ["it", "this", "that", "last", "ده", "دي", "هو", "هي"]],
  ["selection", ["selection", "selected", "sel", "المختار", "المحدد"]],
  ["free", ["free", "open", "unconnected", "فاضي", "فاضيه"]],
  ["yes", ["yes", "شغال", "ظاهر"]],
  ["off", ["off", "no", "مقفول", "اقفل"]],
  ["status", ["status", "approval", "حاله"]],
  ["flanged", ["flanged", "فلانشه"]],
]);

export const kw = (w: string) => lookup(KEYWORDS, w);
export const isKw = (w: string, name: string) => lookup(KEYWORDS, w) === name;

// ------------------------------------------------------------------ views
export const VIEWS = table<string>([
  ["iso-sw", ["iso", "iso-sw", "sw", "isometric", "ايزو"]],
  ["iso", ["iso-se", "se"]],
  ["iso-ne", ["iso-ne", "ne"]],
  ["iso-nw", ["iso-nw", "nw"]],
  ["plan", ["plan", "top", "مسقط", "فوق"]],
  ["north", ["north", "front", "شمال"]],
  ["south", ["south", "back", "جنوب"]],
  ["east", ["east", "right", "شرق"]],
  ["west", ["west", "left", "غرب"]],
]);

/** Line colour names for "set <line> color <name>" (indexes of LINE_COLORS). */
export const COLOR_NAMES: Record<string, number> = { yellow: 0, green: 1, blue: 2, orange: 3, teal: 4, purple: 5, pink: 6, lime: 7, اصفر: 0, اخضر: 1, ازرق: 2, برتقالي: 3, بنفسجي: 5 };
