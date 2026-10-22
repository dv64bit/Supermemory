import { sql, toVector } from "./db";
import { embed } from "./embed";
import { llmJson } from "./llm";
import { searchMemories } from "./memories";

const SEMANTIC_POOL = 30;
const MAX_FORGET = 100;

const PICK = `TASK: forget
The user wants to forget memories matching their request. From the numbered candidates, pick ONLY the ones the request
is clearly about. When unsure, leave it out.`;
const pickSchema = {
  type: "object", additionalProperties: false, required: ["forget"],
  properties: { forget: { type: "array", items: { type: "integer" } } },
};

/** Forget by meaning: retrieve candidates, let the LLM pick, soft-forget (or just report on dryRun). */
export async function forgetSemantic(ns: string, query: string, dryRun: boolean) {
  const [qvec] = await embed([query], "query");
  // No similarity floor: requests like "forget everything about X" embed poorly; the LLM is the judge.
  const cands = (await searchMemories(ns, toVector(qvec), query, { forgotten: false, pool: SEMANTIC_POOL })).slice(0, SEMANTIC_POOL);
  if (!cands.length) return { count: 0, errors: [], matches: [] };
  const { forget } = await llmJson<{ forget: number[] }>(
    PICK, JSON.stringify({ request: query, candidates: cands.map((c, j) => ({ j, content: c.content })) }), pickSchema,
  );
  const picked = [...new Set(forget)].filter((j) => cands[j]).slice(0, MAX_FORGET).map((j) => cands[j]);
  if (!dryRun && picked.length) {
    await sql`update memories set is_forgotten = true, forget_reason = ${"semantic: " + query}, updated_at = now()
      where pk in ${sql(picked.map((p) => p.pk))}`;
  }
  return { count: picked.length, errors: [], matches: picked.map((p) => ({ id: p.id, memory: p.content })) };
}

// Episodes fade unless reinforced (a duplicate bumps strength by 1 and resets updated_at). Facts persist until updated.
// Effective strength = strength * DECAY^(days since last reinforced): computed, not stored, so restarts can't over-decay.
// ponytail: 0.98/day, forget below 0.25 (~68 days for a one-off). Tune on real data.
const DECAY_PER_DAY = 0.98;
const FORGET_BELOW = 0.25;

export async function sweep() {
  await sql`update memories set is_forgotten = true, forget_reason = 'expired', updated_at = now()
    where not is_forgotten and forget_after is not null and forget_after <= now()`;
  await sql`update memories set is_forgotten = true, forget_reason = 'decayed', updated_at = now()
    where kind = 'episode' and not is_forgotten
      and strength * power(${DECAY_PER_DAY}::float8, extract(epoch from now() - updated_at) / 86400) < ${FORGET_BELOW}`;
}
