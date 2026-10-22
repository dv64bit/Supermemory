// bun run eval:latency [sizes...]   (default: 10000 100000)
// p50/p95 of the read paths PRD.v2 budgets (search < 300 ms without rerank/rewrite, profile < 50 ms), measured
// in-process through the real routes on a namespace of N memories (+ N/4 chunks across N/40 documents).
// Bulk rows get random vectors generated in SQL: today's queries scan every row whatever the vectors hold, so cost
// depends on N, not content. Text comes from the retrieval eval's sentence templates so full-text search does real work.
import { freshEvalDb, mean, percentile, ROOT, writeRun } from "../lib";
import { sentences } from "../e2/retrieval";

const sizes = process.argv.slice(2).map(Number).filter((n) => n > 0);
const SIZES = sizes.length ? sizes : [10_000, 100_000];
const NS = "eval_latency";
const QUERIES = ((await Bun.file(`${ROOT}/eval/data/retrieval.v1.json`).json()).queries as { q: string }[]).map((q) => q.q).slice(0, 40);

async function bench(n: number) {
  const started = Date.now();
  const startedAt = new Date().toISOString();
  await freshEvalDb(`supermem_eval_latency_${n}`);
  const db = await import(`../../server/src/db?n=${n}`); // fresh module per size: DATABASE_URL changed
  const { sql } = db as typeof import("../../server/src/db");
  await db.migrate();
  await sql`insert into namespaces (id) values (${NS})`;
  await sql`set maintenance_work_mem = '1GB'`;
  // Load without the HNSW indexes, then build them (as a restore would); build time is recorded.
  await sql`drop index if exists memories_embedding`;
  await sql`drop index if exists chunks_embedding`;

  const text = sentences(n);
  const t0 = performance.now();
  const BATCH = 5000;
  for (let i = 0; i < n; i += BATCH) {
    const rows = Array.from({ length: Math.min(BATCH, n - i) }, () => text());
    // random()-0.5 references t.c so Postgres re-evaluates the vector per row instead of once.
    await sql`
      insert into memories (ns, content, kind, strength, version, is_inference, embedding, created_at, updated_at)
      select ${NS}, t.c,
             (array['fact','fact','preference','episode'])[1 + floor(random() * 4)::int],
             1 + floor(random() * 4), 1 + floor(random() * 2)::int, random() < 0.03,
             (select array_agg(random() - 0.5 + 0 * length(t.c) + 0 * g) from generate_series(1, 768) g)::vector,
             now() - random() * interval '120 days', now() - random() * interval '90 days'
      from jsonb_array_elements_text(${JSON.stringify(rows)}::text::jsonb) as t(c)`;
  }
  await sql`update memories set root_id = id`;
  const docs = Math.max(1, Math.floor(n / 40));
  await sql`insert into documents (ns, id, raw, content, status) select ${NS}, 'doc-' || g, 'x', 'x', 'done' from generate_series(1, ${docs}) g`;
  const chunkRows = Array.from({ length: Math.floor(n / 4) }, () => `${text()}. ${text()}. ${text()}.`);
  for (let i = 0; i < chunkRows.length; i += BATCH) {
    await sql`
      insert into chunks (document_pk, ns, position, content, embedding)
      select (select min(pk) from documents) + (row_number() over () % ${docs}), ${NS}, 0, t.c,
             (select array_agg(random() - 0.5 + 0 * length(t.c) + 0 * g) from generate_series(1, 768) g)::vector
      from jsonb_array_elements_text(${JSON.stringify(chunkRows.slice(i, i + BATCH))}::text::jsonb) as t(c)`;
  }
  const loadMs = performance.now() - t0;
  const t1 = performance.now();
  await sql`create index memories_embedding on memories using hnsw (embedding vector_cosine_ops)`;
  await sql`create index chunks_embedding on chunks using hnsw (embedding vector_cosine_ops)`;
  const indexMs = performance.now() - t1;
  await sql`analyze`;

  const { createApp } = await import(`../../server/src/app?n=${n}`);
  const { embed } = await import("../../server/src/embed");
  const app = createApp("eval");
  const post = async (path: string, body: unknown) => {
    const t = performance.now();
    const res = await app.request(path, { method: "POST", headers: { authorization: "Bearer eval", "content-type": "application/json" }, body: JSON.stringify(body) });
    await res.json();
    if (res.status !== 200) throw new Error(`${path} -> ${res.status}`);
    return performance.now() - t;
  };
  const time = async (f: () => Promise<number>, reps: number) => {
    for (let i = 0; i < 3; i++) await f(); // warm up
    const xs: number[] = [];
    for (let i = 0; i < reps; i++) xs.push(await f());
    return xs;
  };
  let qi = 0;
  const nextQ = () => QUERIES[qi++ % QUERIES.length];
  const embedMs = await time(async () => { const t = performance.now(); await embed([nextQ()], "query"); return performance.now() - t; }, 40);
  const memSearch = await time(() => post(`/ns/${NS}/search`, { query: nextQ(), searchMode: "memories" }), 40);
  const hybridSearch = await time(() => post(`/ns/${NS}/search`, { query: nextQ() }), 40);
  const profile = await time(() => post(`/ns/${NS}/profile`, {}), 20);
  const list = await time(() => post(`/ns/${NS}/list/memories?limit=50`, {}), 20);
  await sql.close();

  const stats = (xs: number[]) => ({ p50: percentile(xs, 50), p95: percentile(xs, 95) });
  const m = {
    "search_memories_p50_ms": stats(memSearch).p50, "search_memories_p95_ms": stats(memSearch).p95,
    "search_hybrid_p50_ms": stats(hybridSearch).p50, "search_hybrid_p95_ms": stats(hybridSearch).p95,
    "query_embed_p50_ms": stats(embedMs).p50,
    "profile_p50_ms": stats(profile).p50, "profile_p95_ms": stats(profile).p95,
    "list_memories_p50_ms": stats(list).p50,
    "load_s": loadMs / 1000, "hnsw_build_s": indexMs / 1000,
  };
  const budget = (name: string, v: number, max: number) => `${name}: p95 ${v.toFixed(0)} ms vs budget ${max} ms -> ${v <= max ? "OK" : "OVER"}`;
  await writeRun({
    layer: "latency",
    name: n >= 1000 ? `${n / 1000}k` : String(n),
    startedAt,
    durationMs: Date.now() - started,
    config: { memories: n, chunks: chunkRows.length, documents: docs, vectors: "random (SQL)", queries: QUERIES.length, reps: "40 search / 20 profile", cpus: navigator.hardwareConcurrency },
    metrics: m,
    notes: [
      budget("search (memories)", m.search_memories_p95_ms, 300),
      budget("search (hybrid)", m.search_hybrid_p95_ms, 300),
      budget("profile", m.profile_p95_ms, 50),
      `mean hybrid search ${mean(hybridSearch).toFixed(0)} ms, of which query embedding ~${stats(embedMs).p50.toFixed(0)} ms`,
    ],
  });
}

for (const n of SIZES) await bench(n);
