// E2 grounding, two parts:
//   A. judge check: the LLM judge on data/grounding.v1.json's labelled (source, claim) pairs. Its accuracy tells us
//      how far to trust part B (and is the baseline the P3 grounder must beat).
//   B. unsupported-memory rate: every fact the current extractor produces on data/extraction.v1.json, judged against
//      its source. The engine has no grounding step yet, so this is the rate at which unsupported memories get stored.
import { mean, ROOT, type Metrics } from "../lib";
import { extractAll, loadExtractionData } from "./extraction";

const supportSchema = {
  type: "object", additionalProperties: false, required: ["verdict", "quote"],
  properties: { verdict: { type: "string", enum: ["supported", "unsupported"] }, quote: { type: "string" } },
};

export async function runGrounding() {
  const pairs: { version: number; pairs: { id: string; type: string; source: string; claim: string; supported: boolean }[] } =
    await Bun.file(`${ROOT}/eval/data/grounding.v1.json`).json();
  const { call } = await import("../../server/src/llm"); // eval:e2 created and migrated the database
  const judge = (source: string, claim: string) =>
    call<{ verdict: "supported" | "unsupported"; quote: string }>("judge", "judge-support.v1", { source, claim }, supportSchema);

  // A. judge on labelled pairs
  const a = [];
  for (const p of pairs.pairs) {
    const v = await judge(p.source, p.claim).catch(() => null);
    a.push({ id: p.id, type: p.type, gold: p.supported, pred: v ? v.verdict === "supported" : null });
  }
  const answered = a.filter((r) => r.pred !== null);
  const goldUnsupported = answered.filter((r) => !r.gold);
  const predUnsupported = answered.filter((r) => r.pred === false);

  // B. current extractor's outputs, judged against their sources
  const data = await loadExtractionData();
  const b = [];
  for (const { unit, predicted } of await extractAll(data)) {
    for (const fact of predicted) {
      const v = await judge(`Source date: ${unit.documentDate}\n${unit.content}`, fact).catch(() => null);
      b.push({ unit: unit.id, category: unit.category, fact, supported: v ? v.verdict === "supported" : null });
    }
  }
  const judgedB = b.filter((r) => r.supported !== null);
  const groups: Record<string, Metrics> = {};
  for (const c of [...new Set(judgedB.map((r) => r.category))].sort()) {
    const rows = judgedB.filter((r) => r.category === c);
    groups[`extracted:${c}`] = { n: rows.length, unsupported_rate: mean(rows.map((r) => (r.supported ? 0 : 1))) };
  }
  return {
    config: { judge_set: `grounding.v${pairs.version}`, pairs: pairs.pairs.length, extraction_set: `extraction.v${data.version}`, prompt: "judge-support.v1" },
    metrics: {
      judge_accuracy: mean(answered.map((r) => (r.pred === r.gold ? 1 : 0))),
      judge_unsupported_recall: goldUnsupported.length ? goldUnsupported.filter((r) => r.pred === false).length / goldUnsupported.length : 0,
      judge_unsupported_precision: predUnsupported.length ? predUnsupported.filter((r) => !r.gold).length / predUnsupported.length : 0,
      judge_errors: a.length - answered.length,
      extracted_facts: b.length,
      unsupported_memory_rate: judgedB.length ? mean(judgedB.map((r) => (r.supported ? 0 : 1))) : 0,
      unjudged_facts: b.length - judgedB.length,
    },
    groups,
    details: { judge: a, extracted: b },
  };
}
