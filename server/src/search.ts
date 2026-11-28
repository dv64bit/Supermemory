import { sql, toVector } from "./db";
import { embed } from "./embed";
import { compileFilter, type Filter } from "./filter";
import { memoryJson, related } from "./memories";
import { understand } from "./query";
import { nearest, retrieveMemories, type Visibility } from "./retrieve";

export type SearchInput = {
  query: string;
  searchMode: "hybrid" | "memories" | "chunks";
  limit: number;
  threshold: number;
  filter?: Filter;
  include: { documents: boolean; related: boolean; forgotten: boolean };
  /** Extensions (x/search): what was valid at this time; or also search superseded history. */
  asOf?: Date;
  history?: boolean;
  /** Internal callers that inject results into a prompt: leave sensitive memories out unless the namespace allows it. */
  injectable?: boolean;
  /** Internal callers: add each memory's validFrom (not part of the v5 response). */
  dates?: boolean;
};

const RRF_K = 60;
const POOL = 50; // candidates pulled from each retriever before fusion

type Row = {
  id: string; content: string; similarity: number; created_at: Date; updated_at: Date;
  doc_id: string; title: string | null; type: string; metadata: Record<string, unknown>;
  doc_created: Date; doc_updated: Date;
};

// Hybrid chunk retrieval: vector (cosine) + full-text (any query term), fused with reciprocal rank fusion.
// Threshold gates on vector similarity; keyword-only hits survive if they share a query term.
async function searchChunks(ns: string, q: SearchInput, text: string, qvec: number[]): Promise<(Row & { score: number })[]> {
  const params: unknown[] = [ns, toVector(qvec), text, POOL];
  // Injected context: a document that taught a sensitive memory isn't quoted either, unless the namespace allows it.
  const sensitive = q.injectable
    ? ` and ((select inject_sensitive from namespaces where id = $1) or not exists (select 1 from memories sm
         where sm.source_document_pk = d.pk and sm.sensitivity = 'sensitive'))` : "";
  const where = `c.ns = $1${sensitive}${q.filter ? ` and ${compileFilter(q.filter, "d.metadata", params)}` : ""}`;
  // Same params as the main query; $3 (keywords) is only typed here.
  const vec = await nearest(`select c.id as key from chunks c join documents d on d.pk = c.document_pk where ${where}
    and $3::text is not null order by c.embedding <=> $2::vector limit $4`, params, POOL);
  params.push(`{${vec.join(",")}}`);
  const rows = await sql.unsafe(
    `with vec as (select id, r from unnest($${params.length}::bigint[]) with ordinality as t(id, r)),
     q as (select replace(plainto_tsquery('english', $3)::text, '&', '|') as t),
     kw as (select c.id, row_number() over (order by ts_rank_cd(c.fts, to_tsquery('english', q.t)) desc) as r
            from chunks c join documents d on d.pk = c.document_pk, q
            where q.t <> '' and c.fts @@ to_tsquery('english', q.t) and ${where} order by r limit $4),
     fused as (
       select id, sum(1.0 / (${RRF_K} + r)) as score, bool_or(src = 'kw') as kw_hit
       from (select id, r, 'vec' as src from vec union all select id, r, 'kw' from kw) u group by id
     )
     select c.id, c.content, c.created_at, d.created_at as doc_created, d.updated_at as doc_updated,
            d.id as doc_id, d.title, d.type, d.metadata, d.updated_at,
            1 - (c.embedding <=> $2::vector) as similarity, f.score, f.kw_hit
     from fused f join chunks c using (id) join documents d on d.pk = c.document_pk order by f.score desc`,
    params,
  );
  return (rows as (Row & { kw_hit: boolean; score: number })[]).filter((r) => r.similarity >= q.threshold || r.kw_hit);
}

const docIncluded = (r: { doc_id: string; title: string | null; type: string; metadata: unknown; doc_created: Date; doc_updated: Date }) => ({
  id: r.doc_id, title: r.title, type: r.type, metadata: r.metadata, summary: null,
  system: { createdAt: r.doc_created.toISOString(), updatedAt: r.doc_updated.toISOString() },
});

export async function search(ns: string, q: SearchInput) {
  const started = performance.now();
  const u = understand(q.query);
  const [qvec] = await embed([u.text], "query");
  const visibility: Visibility = q.include.forgotten ? { mode: "forgotten" }
    : q.asOf ? { mode: "as_of", at: { from: q.asOf, to: new Date(q.asOf.getTime() + 1) } }
    : q.history || u.history ? { mode: "history" } : { mode: "live" };

  // Chunks are raw text, not dated facts: as_of doesn't apply to them.
  const chunkHits = q.searchMode === "memories" ? [] : (await searchChunks(ns, q, u.text, qvec)).map((r) => ({
    score: Number(r.score),
    out: {
      id: String(r.id), chunk: r.content, similarity: Number(r.similarity), metadata: r.metadata,
      isLatest: true, isInference: false,
      system: { createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString() },
      ...(q.include.documents && { included: { document: docIncluded(r) } }),
    } as Record<string, any>,
  }));

  const memRows = q.searchMode === "chunks" ? []
    : (await retrieveMemories(ns, toVector(qvec), u, { filter: q.filter, visibility, pool: POOL, limit: q.limit, threshold: q.threshold, injectable: q.injectable })).slice(0, q.limit);
  const rel = q.include.related ? await related(memRows.map((r) => r.pk)) : undefined;
  const docPks = memRows.map((r) => r.source_document_pk).filter(Boolean);
  const docs = q.include.documents && docPks.length
    ? new Map<number, any>((await sql`select pk, id as doc_id, title, type, metadata, created_at as doc_created, updated_at as doc_updated
        from documents where pk in ${sql(docPks)}`).map((d: any) => [d.pk, d]))
    : undefined;
  const memHits = memRows.map((r) => {
    const { isStatic, isForgotten, version, ...m } = memoryJson(r);
    const doc = docs?.get(r.source_document_pk);
    const included = { ...(rel && { related: rel.get(r.pk) }), ...(doc && { document: docIncluded(doc) }) };
    const validFrom = q.dates ? { validFrom: r.valid_from ? new Date(r.valid_from).toISOString() : null } : {};
    return { score: r.score, out: { ...m, similarity: Number(r.similarity), ...validFrom, ...(Object.keys(included).length && { included }) } };
  });

  // Hybrid: memories (in MMR order) and chunks merged by fused score; both are RRF-based, so they share a scale.
  // ponytail: cross-encoder rerank ("order") is the upgrade; see DEFERRED.
  const results = q.searchMode === "hybrid"
    ? [...memHits, ...chunkHits].sort((a, b) => b.score - a.score).slice(0, q.limit).map((h) => h.out)
    : [...memHits, ...chunkHits].slice(0, q.limit).map((h) => h.out);
  return { results, searchTime: Math.round(performance.now() - started) };
}
