// "Dreaming": turn an indexed document into atomic memories linked to what the namespace already knew.
// Three LLM passes per document: extract -> relate (to nearest existing memories) -> derive (inferences).
import { sql, toVector } from "./db";
import { embed, EMBED_MODEL } from "./embed";
import { logEvents, type MemoryEvent } from "./events";
import { call, pipelineVersion, withDreamRun } from "./llm";

const NEIGHBORS = 5;
const NEIGHBOR_MIN_SIM = 0.55;
const MAX_CANDIDATES = 30;
const DUPLICATE_SIM = 0.92; // ponytail: embedding near-identity as "already known"; tune on real data
// The current engine doesn't attribute speakers or score confidence; these are the PRD.v2 backfill values for
// v1-engine memories, so everything written before Dreamer v2 (P3) looks the same.
const LEGACY_SPEAKER = "document";
const LEGACY_CONFIDENCE = 0.7;

type Kind = "fact" | "preference" | "episode";
type Candidate = { content: string; kind: Kind; expiresAt: string | null; bucket?: string | null };
type Neighbor = { pk: number; id: string; content: string; version: number; root_id: string | null; sim: number };

const str = { type: "string" };
const extractSchema = {
  type: "object", additionalProperties: false, required: ["memories"],
  properties: {
    memories: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["content", "kind", "expiresAt"],
        properties: { content: str, kind: { type: "string", enum: ["fact", "preference", "episode"] }, expiresAt: { type: ["string", "null"] } },
      },
    },
  },
};
const relateSchema = {
  type: "object", additionalProperties: false, required: ["decisions"],
  properties: {
    decisions: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["i", "relation", "target"],
        properties: { i: { type: "integer" }, relation: { type: "string", enum: ["new", "duplicate", "updates", "extends"] }, target: { type: ["integer", "null"] } },
      },
    },
  },
};
const deriveSchema = {
  type: "object", additionalProperties: false, required: ["inferences"],
  properties: {
    inferences: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["content", "from"], properties: { content: str, from: { type: "array", items: { type: "integer" } } } },
    },
  },
};

const withBucket = (names: string[]) => {
  const item = extractSchema.properties.memories.items;
  return { ...extractSchema, properties: { memories: { type: "array", items: {
    ...item, required: [...item.required, "bucket"],
    properties: { ...item.properties, bucket: { type: ["string", "null"], enum: [...names, null] } },
  } } } };
};

const validDate = (s: string | null) => (s && !Number.isNaN(Date.parse(s)) ? new Date(s) : null);
// An expiry at or before the moment the content was written is a model mistake, not a deadline: ignore it.
const expiry = (s: string | null, docDate: Date) => {
  const d = validDate(s);
  return d && d > docDate ? d : null;
};

/** Extraction as the engine runs it (D1 today): one call over the whole unit, capped at MAX_CANDIDATES. */
export async function extractCandidates(ns: string, unit: { content: string; documentDate: Date; supportingContext: string | null }) {
  // Custom profile buckets ride along with extraction; "preferences" is assigned by kind.
  const custom = await sql`select name, description from profile_buckets where ns = ${ns} order by name`;
  const { memories } = await call<{ memories: Candidate[] }>(
    "extract",
    custom.length ? "extract-buckets.v1" : "extract.v1",
    {
      supportingContext: unit.supportingContext, documentDate: unit.documentDate.toISOString(), content: unit.content,
      ...(custom.length && { buckets: Object.fromEntries(custom.map((b: any) => [b.name, b.description])) }),
    },
    custom.length ? withBucket(custom.map((b: any) => b.name)) : extractSchema,
  );
  const bucketNames = new Set<string>(custom.map((b: any) => b.name));
  return { cands: memories.filter((m) => m.content?.trim()).slice(0, MAX_CANDIDATES), bucketNames };
}

/**
 * Relation decisions as the engine makes them today: per candidate, the nearest live memories (vector top-k above a
 * similarity floor), a near-duplicate shortcut, then one batched LLM call. `target` indexes into `neighbors`.
 */
export async function relateCandidates(ns: string, cands: { content: string }[], vecs: number[][]) {
  // Nearest live memories per candidate, numbered globally so the LLM can point at them.
  const neighbors: Neighbor[] = [];
  const neighborIdx = new Map<number, number>();
  const candNeighbors: number[][] = [];
  for (const v of vecs) {
    const rows = (await sql`
      select pk, id, content, version, root_id, 1 - (embedding <=> ${toVector(v)}::vector) as sim from memories
      where ns = ${ns} and is_latest and not is_forgotten
        and 1 - (embedding <=> ${toVector(v)}::vector) >= ${NEIGHBOR_MIN_SIM}
      order by embedding <=> ${toVector(v)}::vector limit ${NEIGHBORS}`) as Neighbor[];
    candNeighbors.push(rows.map((r) => {
      if (!neighborIdx.has(r.pk)) neighborIdx.set(r.pk, neighbors.push(r) - 1);
      return neighborIdx.get(r.pk)!;
    }));
  }

  const decisions = new Map<number, { relation: string; target: number | null }>();
  // Near-identical to something already known: a duplicate, no LLM needed (small models miss these).
  const nearDup = (i: number) => (candNeighbors[i].length && neighbors[candNeighbors[i][0]].sim >= DUPLICATE_SIM ? candNeighbors[i][0] : null);
  const toRelate = cands.map((c, i) => ({ i, content: c.content, neighbors: candNeighbors[i].map((j) => ({ j, content: neighbors[j].content })) }))
    .filter((c) => c.neighbors.length && nearDup(c.i) === null);
  for (const i of cands.keys()) if (nearDup(i) !== null) decisions.set(i, { relation: "duplicate", target: nearDup(i) });
  if (toRelate.length) {
    const out = await call<{ decisions: { i: number; relation: string; target: number | null }[] }>(
      "relate", "relate.v1", { candidates: toRelate }, relateSchema,
    );
    for (const d of out.decisions) {
      // Only trust targets that were actually offered for that candidate.
      if (d.relation === "new" || (d.target !== null && candNeighbors[d.i]?.includes(d.target))) decisions.set(d.i, d);
    }
  }

  return { neighbors, candNeighbors, decisions };
}

type Stats = { candidates: number; added: number; updated: number; extended: number; duplicates: number; inferences: number };
type Run = { id: string; pv: string; stats: Stats };
type Doc = { pk: number; ns: string; content: string; metadata: unknown; ctx: string | null; doc_date: Date };

/** One dream run per document: recorded in dream_runs, and every LLM call and memory event points at it. */
export async function dream(docPk: number) {
  const [doc] = await sql`
    select d.pk, d.ns, d.content, d.metadata, coalesce(d.supporting_context, n.supporting_context) as ctx,
           coalesce(d.doc_date, d.created_at) as doc_date
    from documents d join namespaces n on n.id = d.ns where d.pk = ${docPk}`;
  if (!doc?.content?.trim()) return;
  const pv = pipelineVersion();
  const [{ id }] = await sql`insert into dream_runs (ns, document_pks, pipeline_version) values (${doc.ns}, array[${doc.pk}]::bigint[], ${pv}) returning id`;
  const run: Run = { id, pv, stats: { candidates: 0, added: 0, updated: 0, extended: 0, duplicates: 0, inferences: 0 } };
  try {
    await withDreamRun(id, () => dreamDoc(doc as Doc, run));
    await sql`update dream_runs set status = 'done', stats = ${run.stats}, finished_at = now() where id = ${id}`;
  } catch (e) {
    await sql`update dream_runs set status = 'failed', stats = ${run.stats}, error = ${String((e as Error).message ?? e)}, finished_at = now() where id = ${id}`;
    throw e;
  }
}

async function dreamDoc(doc: Doc, run: Run) {
  const { cands, bucketNames } = await extractCandidates(doc.ns, { content: doc.content, documentDate: doc.doc_date, supportingContext: doc.ctx });
  run.stats.candidates = cands.length;
  if (!cands.length) return;
  const vecs = await embed(cands.map((c) => c.content));
  const { neighbors, candNeighbors, decisions } = await relateCandidates(doc.ns, cands, vecs);
  const ev = (e: Omit<MemoryEvent, "actor" | "pipelineVersion" | "dreamRunId">): MemoryEvent =>
    ({ ...e, actor: "dreamer", pipelineVersion: run.pv, dreamRunId: run.id });

  const inserted: { pk: number; content: string; related: number[] }[] = [];
  await sql.begin(async (tx) => {
    const events: MemoryEvent[] = [];
    const insert = async (c: Candidate, v: number[], extra: { version?: number; root_id?: string | null; is_inference?: boolean } = {}) => {
      const bucket = c.bucket && bucketNames.has(c.bucket) ? c.bucket : null;
      const expires = expiry(c.expiresAt ?? null, doc.doc_date);
      const [m] = await tx`
        insert into memories (ns, content, kind, bucket, forget_after, version, root_id, is_inference, metadata, source_document_pk, embedding,
                              valid_from, valid_to, speaker, confidence, pipeline_version, dream_run_id, embedding_model)
        values (${doc.ns}, ${c.content}, ${c.kind}, ${bucket}, ${expires}, ${extra.version ?? 1}, ${extra.root_id ?? null},
                ${extra.is_inference ?? false}, ${doc.metadata}, ${doc.pk}, ${toVector(v)}::vector,
                ${doc.doc_date}, ${expires}, ${LEGACY_SPEAKER}, ${LEGACY_CONFIDENCE}, ${run.pv}, ${run.id}, ${EMBED_MODEL})
        returning pk, id`;
      if (!extra.root_id) await tx`update memories set root_id = id where pk = ${m.pk}`;
      return m as { pk: number; id: string };
    };

    for (const [i, c] of cands.entries()) {
      const d = decisions.get(i) ?? { relation: "new", target: null };
      const target = d.target !== null ? neighbors[d.target] : undefined;
      if (d.relation === "duplicate" && target) {
        const [t] = await tx`update memories set strength = strength + 1, updated_at = now() where pk = ${target.pk} returning strength`;
        events.push(ev({ memoryPk: target.pk, action: "strengthen", reason: `duplicate: ${c.content}`, before: { strength: t.strength - 1 }, after: { strength: t.strength } }));
        run.stats.duplicates++;
        continue;
      }
      if (d.relation === "updates" && target) {
        const m = await insert(c, vecs[i], { version: target.version + 1, root_id: target.root_id ?? target.id });
        // ponytail: an older document can still supersede a newer fact (P3 fixes the order); valid_to never precedes valid_from.
        await tx`update memories set is_latest = false, valid_to = greatest(coalesce(valid_from, ${doc.doc_date}), ${doc.doc_date}), updated_at = now()
          where pk = ${target.pk}`;
        await tx`insert into memory_edges (src, dst, rel) values (${m.pk}, ${target.pk}, 'updates')`;
        events.push(
          ev({ memoryPk: m.pk, action: "update", after: { content: c.content, updates: target.id } }),
          ev({ memoryPk: target.pk, action: "supersede", reason: `updated by ${m.id}`, before: { is_latest: true }, after: { is_latest: false, superseded_by: m.id } }),
        );
        run.stats.updated++;
        inserted.push({ pk: m.pk, content: c.content, related: [] });
        continue;
      }
      const m = await insert(c, vecs[i]);
      if (d.relation === "extends" && target) {
        await tx`insert into memory_edges (src, dst, rel) values (${m.pk}, ${target.pk}, 'extends')`;
        events.push(ev({ memoryPk: m.pk, action: "extend", after: { content: c.content, extends: target.id } }));
        run.stats.extended++;
      } else {
        events.push(ev({ memoryPk: m.pk, action: "create", after: { content: c.content, kind: c.kind } }));
        run.stats.added++;
      }
      inserted.push({ pk: m.pk, content: c.content, related: candNeighbors[i].map((j) => neighbors[j].pk) });
    }
    await logEvents(events, tx);
  });

  await derive(doc, inserted, run);
}

// Inferences over the touched cluster: new memories plus the live neighbors they landed next to.
async function derive(doc: Doc, inserted: { pk: number; content: string; related: number[] }[], run: Run) {
  if (!inserted.length) return;
  const pks = [...new Set([...inserted.map((m) => m.pk), ...inserted.flatMap((m) => m.related)])];
  const pool = (await sql`
    select pk, content from memories where pk in ${sql(pks)} and is_latest and not is_forgotten order by pk limit 15`) as { pk: number; content: string }[];
  if (pool.length < 2) return;
  const { inferences } = await call<{ inferences: { content: string; from: number[] }[] }>(
    "derive", "derive.v1", { memories: pool.map((m, j) => ({ j, content: m.content })) }, deriveSchema,
  );
  const valid = inferences.filter((x) => x.content?.trim() && x.from.filter((j) => pool[j]).length >= 2).slice(0, 3);
  if (!valid.length) return;
  const vecs = await embed(valid.map((x) => x.content));
  await sql.begin(async (tx) => {
    for (const [k, x] of valid.entries()) {
      // The same cluster gets re-derived as neighbors recur; skip anything the namespace already knows.
      const [{ known }] = await tx`select exists (select 1 from memories where ns = ${doc.ns} and is_latest and not is_forgotten
        and 1 - (embedding <=> ${toVector(vecs[k])}::vector) >= ${DUPLICATE_SIM}) as known`;
      if (known) continue;
      // Inferences wait for review (approve/decline).
      const [m] = await tx`
        insert into memories (ns, content, kind, is_inference, status, metadata, source_document_pk, embedding,
                              valid_from, speaker, confidence, pipeline_version, dream_run_id, embedding_model)
        values (${doc.ns}, ${x.content}, 'fact', true, 'pending_review', ${doc.metadata}, ${doc.pk}, ${toVector(vecs[k])}::vector,
                ${doc.doc_date}, ${LEGACY_SPEAKER}, ${LEGACY_CONFIDENCE}, ${run.pv}, ${run.id}, ${EMBED_MODEL})
        returning pk`;
      await tx`update memories set root_id = id where pk = ${m.pk}`;
      const from = [...new Set(x.from)].filter((j) => pool[j]).map((j) => pool[j].pk);
      await logEvents([{ memoryPk: m.pk, action: "derive", actor: "dreamer", after: { content: x.content, from }, pipelineVersion: run.pv, dreamRunId: run.id }], tx);
      run.stats.inferences++;
      for (const j of new Set(x.from)) {
        if (pool[j]) await tx`insert into memory_edges (src, dst, rel) values (${m.pk}, ${pool[j].pk}, 'derives') on conflict do nothing`;
      }
    }
  });
}
