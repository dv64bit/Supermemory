import { sql, toVector } from "./db";
import { embed } from "./embed";
import { compileFilter, type Filter } from "./filter";
import { memoryJson, related, searchMemories } from "./memories";

export type SearchInput = {
  query: string;
  searchMode: "hybrid" | "memories" | "chunks";
  limit: number;
  threshold: number;
  filter?: Filter;
  include: { documents: boolean; related: boolean; forgotten: boolean };
};

const RRF_K = 60;
const POOL = 50; // candidates pulled from each retriever before fusion

type Row = {
  id: string; content: string; similarity: number; created_at: Date; updated_at: Date;
  doc_id: string; title: string | null; type: string; metadata: Record<string, unknown>;
  doc_created: Date; doc_updated: Date;
};

// Hybrid chunk retrieval: vector (cosine) + full-text, fused with reciprocal rank fusion.
// Threshold gates on vector similarity; keyword-only hits survive if they share a query term.
async function searchChunks(ns: string, q: SearchInput, qvec: number[]): Promise<Row[]> {
  const params: unknown[] = [ns, toVector(qvec), q.query, POOL];
  const where = q.filter ? `and ${compileFilter(q.filter, "d.metadata", params)}` : "";
  const rows = await sql.unsafe(
    `with base as (
       select c.id, c.content, c.created_at, d.created_at as doc_created, d.updated_at as doc_updated,
              d.id as doc_id, d.title, d.type, d.metadata, d.updated_at,
              1 - (c.embedding <=> $2::vector) as similarity, c.fts
       from chunks c join documents d on d.pk = c.document_pk
       where c.ns = $1 ${where}
     ),
     vec as (select id, row_number() over (order by similarity desc) as r from base order by similarity desc limit $4),
     kw as (select id, row_number() over (order by ts_rank_cd(fts, websearch_to_tsquery('english', $3)) desc) as r
            from base where fts @@ websearch_to_tsquery('english', $3) limit $4),
     fused as (
       select id, sum(1.0 / (${RRF_K} + r)) as score, bool_or(src = 'kw') as kw_hit
       from (select id, r, 'vec' as src from vec union all select id, r, 'kw' from kw) u group by id
     )
     select b.*, f.score, f.kw_hit from fused f join base b using (id) order by f.score desc`,
    params,
  );
  return (rows as (Row & { kw_hit: boolean })[]).filter((r) => r.similarity >= q.threshold || r.kw_hit);
}

const docIncluded = (r: { doc_id: string; title: string | null; type: string; metadata: unknown; doc_created: Date; doc_updated: Date }) => ({
  id: r.doc_id, title: r.title, type: r.type, metadata: r.metadata, summary: null,
  system: { createdAt: r.doc_created.toISOString(), updatedAt: r.doc_updated.toISOString() },
});

export async function search(ns: string, q: SearchInput) {
  const started = performance.now();
  const [qvec] = await embed([q.query], "query");

  const chunkHits = q.searchMode === "memories" ? [] : (await searchChunks(ns, q, qvec)).map((r) => ({
    similarity: Number(r.similarity),
    out: {
      id: String(r.id), chunk: r.content, similarity: Number(r.similarity), metadata: r.metadata,
      system: { createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString() },
      ...(q.include.documents && { included: { document: docIncluded(r) } }),
    } as Record<string, any>,
  }));

  const memRows = q.searchMode === "chunks" ? [] : (await searchMemories(ns, toVector(qvec), q.query, { filter: q.filter, forgotten: q.include.forgotten, pool: POOL }))
    .filter((r) => r.similarity >= q.threshold || r.kw_hit);
  const rel = q.include.related ? await related(memRows.slice(0, q.limit).map((r) => r.pk)) : undefined;
  const docs = q.include.documents && memRows.length
    ? new Map<number, any>((await sql`select pk, id as doc_id, title, type, metadata, created_at as doc_created, updated_at as doc_updated
        from documents where pk in ${sql(memRows.map((r) => r.source_document_pk).filter(Boolean))}`).map((d: any) => [d.pk, d]))
    : undefined;
  const memHits = memRows.map((r) => {
    const { isStatic, isForgotten, version, ...m } = memoryJson(r);
    const doc = docs?.get(r.source_document_pk);
    const included = { ...(rel && { related: rel.get(r.pk) }), ...(doc && { document: docIncluded(doc) }) };
    return { similarity: Number(r.similarity), out: { ...m, similarity: Number(r.similarity), ...(Object.keys(included).length && { included }) } };
  });

  // Hybrid: distilled memories and raw chunks in one list, best similarity first.
  // ponytail: plain similarity merge; cross-encoder rerank ("order") is the upgrade.
  const results = [...memHits, ...chunkHits].sort((a, b) => b.similarity - a.similarity).slice(0, q.limit).map((h) => h.out);
  return { results, searchTime: Math.round(performance.now() - started) };
}
