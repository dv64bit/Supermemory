// D2 Ground: a candidate survives only if (code) its quote is really in the new part of the source, outside the
// assistant's turns, with no unresolved relative date; then (LLM, one batched call) the source supports it.
// Everything rejected is returned with a reason, and the dream run records it.
import type { Candidate, Unit } from "./extractor";
import { call } from "./llm";

export type Rejection = { content: string; reason: string };

const QUOTE_MIN = 0.9;
// Relative time words left in a memory mean the date was never resolved: the memory would be wrong tomorrow.
export const RELATIVE_DATE =
  /\b(today|tonight|tomorrow|yesterday|this (morning|evening|week|weekend|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|next (week|weekend|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|last (night|week|weekend|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|in (a|one|two|three|four|five|\d+) (days?|weeks?|months?|years?)|(a|one|two|three|\d+) (days?|weeks?|months?|years?) ago)\b/i;

type Token = { t: string; start: number; end: number };
const tokens = (s: string): Token[] => [...s.matchAll(/[\p{L}\p{N}]+/gu)].map((m) => ({ t: m[0].toLowerCase(), start: m.index!, end: m.index! + m[0].length }));

/** Best match of `quote` in `source` by in-window token overlap: score 1 = every quote token present. */
export function locate(quote: string, source: string): { score: number; start: number; end: number } {
  const q = tokens(quote).map((x) => x.t);
  const s = tokens(source);
  if (!q.length || !s.length) return { score: 0, start: 0, end: 0 };
  const need = new Map<string, number>();
  for (const t of q) need.set(t, (need.get(t) ?? 0) + 1);
  const k = Math.min(q.length, s.length);
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
  const checked = cands.filter((c) => {
    if (c.speaker === "assistant") return reject(c, "said by the assistant");
    if (RELATIVE_DATE.test(c.content)) return reject(c, "unresolved relative date");
    const hit = locate(c.quote, unit.content);
    if (hit.score < QUOTE_MIN) {
      const old = unit.context && locate(c.quote, unit.context).score >= QUOTE_MIN;
      return reject(c, old ? "quote is from already-dreamed context" : "quote not found in source");
    }
    const overlapped = spans.filter((t) => t.start < hit.end && hit.start < t.end);
    if (overlapped.length && overlapped.every((t) => t.role === "assistant")) return reject(c, "quote is the assistant's words");
    return true;
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
