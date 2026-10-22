// E2 extraction: run the engine's extraction step (dream.ts extractCandidates, same prompt and schema) on each unit
// of data/extraction.v1.json (eval:e2 has already created and migrated the database), then an LLM judge matches predicted facts to expected ones and flags forbidden ones.
import { mean, ROOT, type Metrics } from "../lib";

type Unit = { id: string; category: string; documentDate: string; content: string; expected: { fact: string; speaker: string }[]; forbidden: string[] };
export type ExtractionData = { version: number; units: Unit[] };

const matchSchema = {
  type: "object", additionalProperties: false, required: ["matches", "forbidden_hits"],
  properties: {
    matches: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["expected", "predicted"], properties: { expected: { type: "integer" }, predicted: { type: "integer" } } },
    },
    forbidden_hits: { type: "array", items: { type: "integer" } },
  },
};

// Relative time words left in a stored fact mean the date was never resolved (failure mode 1).
const UNRESOLVED = /\b(today|tomorrow|yesterday|tonight|this (week|month|year|weekend|saturday|sunday|monday|tuesday|wednesday|thursday|friday)|next (week|month|year|saturday|sunday|monday|tuesday|wednesday|thursday|friday|april)|last (week|month|year|night)|in (two|three|\d+) (days|weeks|months|years))\b/i;

/** Runs extraction for every unit; shared with the grounding eval (identical calls hit the LLM cache). */
export async function extractAll(data: ExtractionData) {
  const { extractCandidates } = await import("../../server/src/dream");
  const out: { unit: Unit; predicted: string[]; error?: string }[] = [];
  for (const unit of data.units) {
    try {
      const { cands } = await extractCandidates("eval_extraction", { content: unit.content, documentDate: new Date(unit.documentDate), supportingContext: null });
      out.push({ unit, predicted: cands.map((c) => c.content) });
    } catch (e) {
      out.push({ unit, predicted: [], error: String((e as Error).message) });
    }
  }
  return out;
}

export async function loadExtractionData(): Promise<ExtractionData> {
  return Bun.file(`${ROOT}/eval/data/extraction.v1.json`).json();
}

export async function runExtraction() {
  const data = await loadExtractionData();
  const { sql } = await import("../../server/src/db");
  const { call } = await import("../../server/src/llm");

  type Row = { id: string; category: string; expected: number; predicted: number; matched: number; forbiddenHits: number;
    unresolvedDates: number; error?: string; predictions: string[] };
  const per: Row[] = [];
  for (const { unit, predicted, error } of await extractAll(data)) {
    let matched = 0;
    let forbiddenHits = 0;
    if (predicted.length && (unit.expected.length || unit.forbidden.length)) {
      const j = await call<{ matches: { expected: number; predicted: number }[]; forbidden_hits: number[] }>("judge", "judge-match.v1", {
        source: unit.content,
        sourceDate: unit.documentDate,
        expected: unit.expected.map((e, i) => ({ i, fact: e.fact })),
        forbidden: unit.forbidden.map((f, i) => ({ i, statement: f })),
        predicted: predicted.map((p, i) => ({ i, fact: p })),
      }, matchSchema);
      // Enforce one-to-one and valid indices in code; the judge only proposes.
      const usedE = new Set<number>(), usedP = new Set<number>();
      for (const m of j.matches) {
        if (m.expected in unit.expected && m.predicted in predicted && !usedE.has(m.expected) && !usedP.has(m.predicted)) {
          usedE.add(m.expected); usedP.add(m.predicted); matched++;
        }
      }
      forbiddenHits = new Set(j.forbidden_hits.filter((p) => p in predicted && !usedP.has(p))).size;
    }
    per.push({
      id: unit.id, category: unit.category, expected: unit.expected.length, predicted: predicted.length, matched, forbiddenHits,
      unresolvedDates: predicted.filter((p) => UNRESOLVED.test(p)).length, error, predictions: predicted,
    });
  }
  const llm = await sql`select count(*)::int as calls, count(*) filter (where not ok)::int as failed, count(*) filter (where attempts = 2)::int as repaired,
    coalesce(sum(tokens_in), 0)::int as tokens_in, coalesce(sum(tokens_out), 0)::int as tokens_out from llm_calls where role = 'extract'`;

  const agg = (rows: typeof per): Metrics => {
    const p = rows.reduce((s, r) => s + r.predicted, 0), e = rows.reduce((s, r) => s + r.expected, 0), m = rows.reduce((s, r) => s + r.matched, 0);
    const precision = p ? m / p : rows.every((r) => r.expected === 0) ? 1 : 0;
    const recall = e ? m / e : 1;
    const withForbidden = rows.filter((r) => data.units.find((u) => u.id === r.id)!.forbidden.length);
    return {
      n: rows.length, precision, recall, f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0,
      forbidden_hit_rate: withForbidden.length ? withForbidden.filter((r) => r.forbiddenHits > 0).length / withForbidden.length : 0,
    };
  };
  const empties = per.filter((r) => r.expected === 0);
  const groups: Record<string, Metrics> = {};
  for (const c of [...new Set(per.map((r) => r.category))].sort()) groups[c] = agg(per.filter((r) => r.category === c));
  return {
    config: { dataset: `extraction.v${data.version}`, units: data.units.length, expected_facts: data.units.reduce((s, u) => s + u.expected.length, 0), prompt: "extract.v1" },
    metrics: {
      ...agg(per),
      empty_unit_accuracy: empties.length ? empties.filter((r) => r.predicted === 0).length / empties.length : 1,
      unresolved_relative_dates: per.reduce((s, r) => s + r.unresolvedDates, 0),
      predicted_per_unit: mean(per.map((r) => r.predicted)),
      extract_errors: per.filter((r) => r.error).length,
      llm_calls: llm[0].calls, llm_failed: llm[0].failed, llm_repaired: llm[0].repaired, tokens_in: llm[0].tokens_in, tokens_out: llm[0].tokens_out,
    },
    groups,
    details: per,
  };
}
