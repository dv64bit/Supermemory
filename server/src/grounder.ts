// D2 Ground: a candidate survives only if (code) its quote is really in the new part of the source, outside the
// assistant's turns, with no unresolved relative date; then (LLM, one batched call) the source supports it.
// Small models often copy a quote loosely, or copy the assistant's restatement of what the user said; those survive
// the code check when the user's own words carry the quote's key words, and the LLM check decides.
// Relative dates the extractor left in the text are resolved against the document date, not rejected.
// Everything rejected is returned with a reason, and the dream run records it.
import type { Candidate, Unit } from "./extractor";
import { call } from "./llm";

export type Rejection = { content: string; reason: string };

const QUOTE_MIN = 0.9;
// Loose match: share of the quote's key words found close together in the user's own words.
const LOOSE_MIN = 0.8;
const LOOSE_SLACK = 2; // the window may be twice the quote's key-word count, for words the paraphrase dropped
// Words that carry no fact; "could"/"should" stay, so an assistant's suggestion doesn't match the user's question.
const FILLER = new Set(["i", "m", "me", "my", "you", "your", "we", "our", "the", "a", "an", "to", "of", "in", "on", "at", "for",
  "and", "or", "is", "am", "are", "was", "were", "be", "been", "it", "its", "that", "this", "with", "so", "s", "ll", "ve", "re", "d",
  "t", "just", "now", "btw", "oh", "user", "users"]);
const keyWords = (s: string) => tokens(s).map((x) => x.t).filter((t) => !FILLER.has(t)).join(" ");
// Relative time words left in a memory mean the date was never resolved: the memory would be wrong tomorrow.
export const RELATIVE_DATE =
  /\b(today|tonight|tomorrow|yesterday|this (morning|evening|week|weekend|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|next (week|weekend|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|last (night|week|weekend|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|in (a|one|two|three|four|five|\d+) (days?|weeks?|months?|years?)|(a|one|two|three|\d+) (days?|weeks?|months?|years?) ago)\b/i;

type Token = { t: string; start: number; end: number };
const tokens = (s: string): Token[] => [...s.matchAll(/[\p{L}\p{N}]+/gu)].map((m) => ({ t: m[0].toLowerCase(), start: m.index!, end: m.index! + m[0].length }));

/** Best match of `quote` in `source` by in-window token overlap: score 1 = every quote token present. */
export function locate(quote: string, source: string, slack = 1): { score: number; start: number; end: number } {
  const q = tokens(quote).map((x) => x.t);
  const s = tokens(source);
  if (!q.length || !s.length) return { score: 0, start: 0, end: 0 };
  const need = new Map<string, number>();
  for (const t of q) need.set(t, (need.get(t) ?? 0) + 1);
  const k = Math.min(Math.ceil(q.length * slack), s.length);
  let best = { score: 0, start: 0, end: 0 };
  // Sliding window of k tokens; `have` counts how many quote tokens the window covers.
  const win = new Map<string, number>();
  let have = 0;
  const add = (t: string, d: number) => {
    const before = Math.min(win.get(t) ?? 0, need.get(t) ?? 0);
    win.set(t, (win.get(t) ?? 0) + d);
    have += Math.min(win.get(t)!, need.get(t) ?? 0) - before;
  };
  for (let i = 0; i < s.length; i++) {
    add(s[i].t, 1);
    if (i >= k) add(s[i - k].t, -1);
    if (i >= k - 1 && have / q.length > best.score) best = { score: have / q.length, start: s[i - k + 1].start, end: s[i].end };
  }
  return best;
}

/** Character spans of "User:" / "Assistant:" turns; empty when the text isn't a transcript. */
function turns(text: string) {
  const out: { role: "user" | "assistant"; start: number; end: number }[] = [];
  for (const m of text.matchAll(/^(User|Assistant):/gm)) {
    if (out.length) out.at(-1)!.end = m.index!;
    out.push({ role: m[1] === "User" ? "user" : "assistant", start: m.index!, end: text.length });
  }
  return out;
}

/** The text outside the assistant's turns (the whole text when it isn't a transcript). */
const userText = (text: string, spans: ReturnType<typeof turns>) =>
  spans.length ? spans.filter((t) => t.role === "user").map((t) => text.slice(t.start, t.end)).join("\n") : text;

const DAY = 86_400_000;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const NUM: Record<string, number> = { a: 1, one: 1, two: 2, three: 3, four: 4, five: 5 };
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const monday = (t: number) => t - ((new Date(t).getUTCDay() + 6) % 7) * DAY;
const month = (d: Date, add: number) => { const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + add, 1)); return `in ${MONTHS[m.getUTCMonth()]} ${m.getUTCFullYear()}`; };

/** Rewrites relative time words (RELATIVE_DATE) as absolute dates against `date`: "last week" -> "in the week of 2026-10-12". */
export function resolveDates(text: string, date: Date): string {
  const day = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const shift = (unit: string, n: number) => {
    const u = unit.replace(/s$/, "");
    if (u === "day") return `on ${iso(day + n * DAY)}`;
    if (u === "week") return `in the week of ${iso(monday(day + n * 7 * DAY))}`;
    if (u === "month") return month(date, n);
    return `in ${date.getUTCFullYear() + n}`;
  };
  return text.replace(new RegExp(RELATIVE_DATE.source, "gi"), (m) => {
    const w = m.toLowerCase().split(/\s+/);
    if (["today", "tonight"].includes(w[0]) || (w[0] === "this" && ["morning", "evening"].includes(w[1]))) return `on ${iso(day)}`;
    if (w[0] === "tomorrow") return `on ${iso(day + DAY)}`;
    if (w[0] === "yesterday" || m.toLowerCase() === "last night") return `on ${iso(day - DAY)}`;
    if (w[0] === "in") return shift(w[2], NUM[w[1]] ?? Number(w[1]));
    if (w.at(-1) === "ago") return shift(w[1], -(NUM[w[0]] ?? Number(w[0])));
    const dir = w[0] === "next" ? 1 : w[0] === "last" ? -1 : 0;
    if (w[1] === "weekend") return `on the weekend of ${iso(monday(day) + (5 + 7 * dir) * DAY)}`;
    if (w[1] === "week") return shift("week", dir);
    if (w[1] === "month") return month(date, dir);
    if (w[1] === "year") return shift("year", dir);
    // Weekdays: "this"/"next" = the first one after today ("this" may be today), "last" = the latest one before today.
    const target = WEEKDAYS.indexOf(w[1]);
    const today = new Date(day).getUTCDay();
    const ahead = (target - today + 7) % 7;
    const n = dir < 0 ? -(((today - target + 7) % 7) || 7) : dir > 0 ? ahead || 7 : ahead;
    return `on ${iso(day + n * DAY)}`;
  });
}

const groundSchema = {
  type: "object", additionalProperties: false, required: ["verdicts"],
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["i", "verdict"],
        properties: { i: { type: "integer" }, verdict: { type: "string", enum: ["supported", "unsupported"] } },
      },
    },
  },
};
const llmOn = () => process.env.GROUND_LLM !== "off";

export async function ground(unit: Unit, cands: Candidate[]): Promise<{ kept: Candidate[]; rejected: Rejection[] }> {
  const rejected: Rejection[] = [];
  const reject = (c: Candidate, reason: string) => (rejected.push({ content: c.content, reason }), false);
  const spans = turns(unit.content);
  const own = userText(unit.content, spans);
  const checked = cands.map((c) => ({ ...c, content: resolveDates(c.content, unit.documentDate) })).filter((c) => {
    if (c.speaker === "assistant") return reject(c, "said by the assistant");
    if (RELATIVE_DATE.test(c.content)) return reject(c, "unresolved relative date");
    const hit = locate(c.quote, unit.content);
    const overlapped = spans.filter((t) => t.start < hit.end && hit.start < t.end);
    const assistants = overlapped.length > 0 && overlapped.every((t) => t.role === "assistant");
    if (hit.score >= QUOTE_MIN && !assistants) return true;
    // A loose quote, or the assistant restating the user: fine if the user's own words carry the quote's key words.
    const key = keyWords(c.quote);
    if (key && locate(key, keyWords(own), LOOSE_SLACK).score >= LOOSE_MIN) return true;
    if (hit.score >= QUOTE_MIN) return reject(c, "quote is the assistant's words");
    const old = unit.context && locate(c.quote, unit.context).score >= QUOTE_MIN;
    return reject(c, old ? "quote is from already-dreamed context" : "quote not found in source");
  });
  if (!checked.length || !llmOn()) return { kept: checked, rejected };

  const { verdicts } = await call<{ verdicts: { i: number; verdict: string }[] }>("ground", "ground.v1", {
    sourceDate: unit.documentDate.toISOString(),
    source: unit.context ? `${unit.context}\n${unit.content}` : unit.content,
    claims: checked.map((c, i) => ({ i, claim: c.content, quote: c.quote })),
  }, groundSchema);
  const unsupported = new Set(verdicts.filter((v) => v.verdict === "unsupported").map((v) => v.i));
  const kept = checked.filter((c, i) => !unsupported.has(i) || reject(c, "not supported by the source"));
  return { kept, rejected };
}
