// Retrieval v2 over memories (PLAN.v2 §4.2–4.5): three channels, RRF fusion, trust/recency weights, then MMR.
//  - vector: cosine top-k;  keyword: full-text, any query term, best rank first;  entity: memories linked to an
//    entity the query names ("my daughter" -> Anika).
//  - score = rrf · w_kind · recency · f(strength) · g(confidence) · (inference penalty until approved) · (period boost)
//  - MMR (λ) re-orders the head so paraphrases of one fact don't fill the results; near-identical ones are dropped.
// Weights live in lifecycle.yaml (`retrieval`) and are tuned by the retrieval eval.
import { sql } from "./db";
import { compileFilter, type Filter } from "./filter";
import { lifecycle } from "./lifecycle";
import { LIVE, type MemoryRow } from "./memories";
import type { Range, Understood } from "./query";

export type Visibility =
  | { mode: "live" } // the current state (default)
  | { mode: "forgotten" } // latest versions, forgotten ones included (v5 include.forgotten)
  | { mode: "history" } // live plus superseded versions (temporal questions)
  | { mode: "as_of"; at: Range }; // what was valid during the range, whatever happened since

export type Scored = MemoryRow & { score: number; ent_hit: boolean; vec: number[] };

const visible = (v: Visibility, params: unknown[]) => {
  const kept = "not m.is_forgotten and m.status <> 'rejected'";
  if (v.mode === "live") return LIVE();
  if (v.mode === "forgotten") return "m.is_latest";
  if (v.mode === "history") return `(${LIVE()} or (not m.is_latest and ${kept}))`;
  params.push(v.at.to, v.at.from);
  const to = `$${params.length - 1}::timestamptz`, from = `$${params.length}::timestamptz`;
  return `${kept} and coalesce(m.valid_from, m.created_at) < ${to} and (m.valid_to is null or m.valid_to > ${from})`;
};

// Bun's unsafe() params don't serialise JS arrays; send a Postgres array literal.
const textArray = (xs: string[]) => `{${xs.map((x) => `"${x.replace(/["\\]/g, "\\$&")}"`).join(",")}}`;
const parseVec = (s: string) => s.slice(1, -1).split(",").map(Number);
const dot = (a: number[], b: number[]) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

/**
 * Vector top-k keys, in order. pgvector 0.6's HNSW scan applies the WHERE after the index has picked its ef_search
 * candidates, so a small namespace beside a big one, or a narrow filter, can come back short. Then the scan is redone
 * exactly (index scans off); that is cheap precisely when few rows match.
 * ponytail: pgvector >= 0.8 iterative scans would make the fallback rare.
 */
export async function nearest(select: string, params: unknown[], k: number): Promise<number[]> {
  return sql.begin(async (tx) => {
    await tx.unsafe(`set local hnsw.ef_search = ${Math.max(100, 2 * k)}`);
    let rows = (await tx.unsafe(select, params)) as { key: number }[];
    if (rows.length < k) {
      await tx.unsafe("set local enable_indexscan = off");
      rows = (await tx.unsafe(select, params)) as { key: number }[];
    }
    return rows.map((r) => Number(r.key));
  });
}

export async function retrieveMemories(
  ns: string, qvec: string, q: Understood,
  opts: { filter?: Filter; visibility: Visibility; pool: number; limit: number; threshold: number; injectable?: boolean },
): Promise<Scored[]> {
  const w = lifecycle().retrieval;
  // "the user" is in nearly every memory: as a keyword it matches everything.
  const keywords = q.text.replace(/\bthe user('s)?\b/gi, " ");
  const params: unknown[] = [ns, qvec, keywords, opts.pool, textArray(q.names)];
  const sensitive = opts.injectable
    ? " and (m.sensitivity is distinct from 'sensitive' or (select inject_sensitive from namespaces where id = $1))" : "";
  const where = `m.ns = $1 and ${visible(opts.visibility, params)}${sensitive}${opts.filter ? ` and ${compileFilter(opts.filter, "m.metadata", params)}` : ""}`;
  // Same params as the main query (the WHERE's placeholders are numbered for it); $3 and $5 are only typed here.
  const vec = await nearest(`select m.pk as key from memories m where ${where} and $3::text is not null and $5::text[] is not null
    order by m.embedding <=> $2::vector limit $4`, params, opts.pool);
  params.push(`{${vec.join(",")}}`);
  // Keyword and entity channels rank their own top-k; the outer query returns only fused candidates' rows.
  const rows = (await sql.unsafe(
    `with vec as (select pk, r from unnest($${params.length}::bigint[]) with ordinality as t(pk, r)),
     q as (select replace(plainto_tsquery('english', $3)::text, '&', '|') as t),
     kw as (
       select m.pk, row_number() over (order by ts_rank_cd(m.fts, to_tsquery('english', q.t)) desc) as r
       from memories m, q where q.t <> '' and m.fts @@ to_tsquery('english', q.t) and ${where}
       order by r limit $4),
     ent as (
       select m.pk, row_number() over (order by min(m.embedding <=> $2::vector)) as r
       from entities e join memory_entities me on me.entity_id = e.id join memories m on m.pk = me.memory_pk
       where e.ns = $1 and cardinality($5::text[]) > 0
         and (lower(e.canonical_name) = any($5::text[]) or e.aliases && $5::text[] or split_part(lower(e.canonical_name), ' ', 1) = any($5::text[]))
         and ${where}
       group by m.pk order by r limit $4),
     fused as (
       select pk, sum(case src when 'vec' then ${w.channels.vector} when 'kw' then ${w.channels.keyword} else ${w.channels.entity} end::float8 / (${w.rrf_k} + r)) as rrf, bool_or(src = 'kw') as kw_hit, bool_or(src = 'ent') as ent_hit
       from (select pk, r, 'vec' as src from vec union all select pk, r, 'kw' from kw union all select pk, r, 'ent' from ent) u
       group by pk)
     select m.*, m.embedding::text as vec_text, 1 - (m.embedding <=> $2::vector) as similarity, f.rrf, f.kw_hit, f.ent_hit
     from fused f join memories m using (pk)`,
    params,
  )) as (MemoryRow & { rrf: number; ent_hit: boolean; vec_text: string })[];

  const now = Date.now();
  const scored: Scored[] = rows.map(({ vec_text, embedding: _e, ...r }) => {
    let s = Number(r.rrf) * (w.kind[r.kind as keyof typeof w.kind] ?? 1);
    if (r.kind === "episode") {
      const days = (now - new Date(r.valid_from ?? r.created_at).getTime()) / 864e5;
      s *= Math.max(w.recency_floor, 0.5 ** (Math.max(0, days) / lifecycle().episode.half_life_days));
    }
    s *= 1 + w.strength_weight * Math.log1p(Math.max(0, (r.strength ?? 1) - 1));
    s *= 1 - w.confidence_weight * (1 - (r.confidence ?? 1));
    if (r.is_inference && r.status === "pending_review") s *= w.unapproved_inference;
    if (q.range && overlaps(r, q.range)) s *= w.period_boost;
    return { ...r, score: s, vec: parseVec(vec_text) };
  });
  // The threshold gates on vector similarity; keyword and entity hits survive it.
  const kept = scored.filter((r) => r.similarity >= opts.threshold || r.kw_hit || r.ent_hit);
  return mmr(kept.sort((a, b) => b.score - a.score), opts.limit, w.mmr_lambda, w.collapse_above);
}

const overlaps = (r: MemoryRow, at: Range) =>
  new Date(r.valid_from ?? r.created_at) < at.to && (r.valid_to == null || new Date(r.valid_to) > at.from);

// Numbers and capitalised words: what tells "Kim has 2 children" from "Kim has 3 children". Two texts share their
// specifics when each one's numbers and names all appear (in any case) in the other.
const words = (text: string) => [...text.matchAll(/[\p{L}\p{N}]+/gu)].map((m) => m[0]);
export const sameSpecifics = (a: string, b: string) => {
  const has = (x: string, y: string) => {
    const lower = new Set(words(y).map((w) => w.toLowerCase()));
    return words(x).filter((w) => /\d|^\p{Lu}/u.test(w)).every((w) => lower.has(w.toLowerCase()));
  };
  return has(a, b) && has(b, a);
};

/**
 * Maximal marginal relevance over the head of the list (λ · relevance − (1 − λ) · max similarity to what is picked).
 * A paraphrase of a picked memory (similarity ≥ collapse_above, same numbers and names) is dropped.
 */
function mmr(rows: Scored[], limit: number, lambda: number, collapseAbove: number): Scored[] {
  const head = rows.slice(0, Math.max(limit * 3, limit));
  if (head.length < 2) return rows;
  const top = head[0].score;
  const picked: Scored[] = [];
  const left = [...head];
  while (left.length) {
    let best = 0, bestVal = -Infinity;
    for (const [i, r] of left.entries()) {
      const redundancy = picked.length ? Math.max(...picked.map((p) => dot(p.vec, r.vec))) : 0;
      const val = lambda * (r.score / top) - (1 - lambda) * redundancy;
      if (val > bestVal) [best, bestVal] = [i, val];
    }
    const [r] = left.splice(best, 1);
    if (picked.some((p) => dot(p.vec, r.vec) >= collapseAbove && sameSpecifics(p.content, r.content))) continue;
    picked.push(r);
  }
  return [...picked, ...rows.slice(head.length)];
}
