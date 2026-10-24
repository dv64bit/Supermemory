import { sql, toVector } from "./db";
import { embed } from "./embed";
import { call } from "./llm";
import { searchMemories } from "./memories";

const SEMANTIC_POOL = 30;
const MAX_FORGET = 100;

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
  const { forget } = await call<{ forget: number[] }>(
    "forget", "forget.v1", { request: query, candidates: cands.map((c, j) => ({ j, content: c.content })) }, pickSchema,
  );
  const picked = [...new Set(forget)].filter((j) => cands[j]).slice(0, MAX_FORGET).map((j) => cands[j]);
  if (!dryRun && picked.length) {
    await sql`with f as (update memories set is_forgotten = true, forget_reason = ${"semantic: " + query}, updated_at = now()
        where pk in ${sql(picked.map((p) => p.pk))} returning pk)
      insert into memory_events (memory_pk, action, actor, reason) select pk, 'forget', 'api', ${"semantic: " + query} from f`;
  }
  return { count: picked.length, errors: [], matches: picked.map((p) => ({ id: p.id, memory: p.content })) };
}

// Episodes fade unless reinforced (a duplicate bumps strength by 1 and resets updated_at). Facts persist until updated.
// Effective strength = strength * DECAY^(days since last reinforced): computed, not stored, so restarts can't over-decay.
// ponytail: 0.98/day, forget below 0.25 (~68 days for a one-off). Tune on real data.
const DECAY_PER_DAY = 0.98;
const FORGET_BELOW = 0.25;

export async function sweep() {
  await sql`with f as (update memories set is_forgotten = true, forget_reason = 'expired', updated_at = now()
        where not is_forgotten and forget_after is not null and forget_after <= now() returning pk)
    insert into memory_events (memory_pk, action, actor, reason) select pk, 'expire', 'sweeper', 'expired' from f`;
  await sql`with f as (update memories set is_forgotten = true, forget_reason = 'decayed', updated_at = now()
        where kind = 'episode' and not is_forgotten
          and strength * power(${DECAY_PER_DAY}::float8, extract(epoch from now() - updated_at) / 86400) < ${FORGET_BELOW} returning pk)
    insert into memory_events (memory_pk, action, actor, reason) select pk, 'decay', 'sweeper', 'decayed' from f`;
}
