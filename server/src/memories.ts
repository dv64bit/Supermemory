import { sql } from "./db";
import { compileFilter, type Filter } from "./filter";

const iso = (d: Date) => d.toISOString();

// A memory is "live" when it is the latest version, not forgotten and not past its expiry.
export const LIVE = (m = "m") => `${m}.is_latest and not ${m}.is_forgotten and (${m}.forget_after is null or ${m}.forget_after > now())`;

export function memoryJson(r: any) {
  return {
    id: r.id,
    memory: r.content,
    metadata: r.metadata,
    isStatic: r.kind === "fact" && !r.is_inference,
    isInference: r.is_inference,
    isLatest: r.is_latest,
    isForgotten: r.is_forgotten || (r.forget_after != null && r.forget_after <= new Date()),
    version: r.version,
    system: { createdAt: iso(r.created_at), updatedAt: iso(r.updated_at) },
  };
}

/** parents = memories this one updates/extends/derives from; children = memories pointing at this one. */
export async function related(pks: number[], limit = 10) {
  const out = new Map<number, { parents: any[]; children: any[]; siblings: any[] }>();
  for (const pk of pks) out.set(pk, { parents: [], children: [], siblings: [] });
  if (!pks.length) return out;
  const rows = await sql`
    select 'parents' as side, e.src as owner, e.rel, m.* from memory_edges e join memories m on m.pk = e.dst where e.src in ${sql(pks)}
    union all
    select 'children', e.dst, e.rel, m.* from memory_edges e join memories m on m.pk = e.src where e.dst in ${sql(pks)}
    order by owner, side, pk`;
  for (const r of rows as any[]) {
    const list = out.get(r.owner)![r.side as "parents" | "children"];
    if (list.length < limit) {
      list.push({ id: r.id, relation: r.rel, version: r.version, memory: r.content, metadata: r.metadata, system: { updatedAt: iso(r.updated_at) } });
    }
  }
  return out;
}

export type MemoryRow = { pk: number; similarity: number; kw_hit: boolean; [k: string]: any };

/** Hybrid (vector + full-text, RRF) retrieval over live memories. */
export async function searchMemories(ns: string, qvec: string, query: string, opts: { filter?: Filter; forgotten: boolean; pool: number }) {
  const params: unknown[] = [ns, qvec, query, opts.pool];
  const where = opts.filter ? `and ${compileFilter(opts.filter, "m.metadata", params)}` : "";
  const live = opts.forgotten ? "m.is_latest" : LIVE();
  return (await sql.unsafe(
    `with base as (
       select m.*, 1 - (m.embedding <=> $2::vector) as similarity from memories m where m.ns = $1 and ${live} ${where}
     ),
     vec as (select pk, row_number() over (order by similarity desc) as r from base order by similarity desc limit $4),
     kw as (select pk, row_number() over (order by ts_rank_cd(fts, websearch_to_tsquery('english', $3)) desc) as r
            from base where fts @@ websearch_to_tsquery('english', $3) limit $4),
     fused as (
       select pk, sum(1.0 / (60 + r)) as score, bool_or(src = 'kw') as kw_hit
       from (select pk, r, 'vec' as src from vec union all select pk, r, 'kw' from kw) u group by pk
     )
     select b.*, f.score, f.kw_hit from fused f join base b using (pk) order by f.score desc`,
    params,
  )) as MemoryRow[];
}
