// "Dreaming" (Dreamer v2, PLAN.v2 §3): turn the new part of an indexed document into grounded, attributed memories
// linked to what the namespace already knew.
//   D0 guard (worker, before this)  D1 extract  D2 ground  D3 entities  D4-D6 relate (neighbours, LLM, policy)
//   D7 apply (one transaction)  D8 derive (inferences for review)
// ponytail: D9 (incremental LLM profile) is not built; the profile is still computed from memories on read.
import { sql, toVector } from "./db";
import { embed, EMBED_MODEL } from "./embed";
import { resolveEntities } from "./entities";
import { logEvents, type MemoryEvent } from "./events";
import { extract, type Candidate, type Unit } from "./extractor";
import { ground, locate, type Rejection } from "./grounder";
import { lifecycle } from "./lifecycle";
import { call, pipelineVersion, withDreamRun } from "./llm";
import { relate, type Plan } from "./relator";

const DERIVED_KNOWN_SIM = 0.92; // an inference this close to a live memory is already known: skip it
const CONTEXT_CHARS = 1500;

type Stats = {
  candidates: number; rejected: Rejection[]; added: number; updated: number; extended: number; duplicates: number;
  conflicts: number; historical: number; skipped: number; ended: number; inferences: number;
};
type Run = { id: string; pv: string; stats: Stats };
type Doc = {
  pk: number; id: string; ns: string; content: string; metadata: unknown; ctx: string | null; doc_date: Date;
  dreamed_chars: number | null; dreamed_hash: string | null;
};

const sha = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");
const validDate = (s: string | null | undefined) => (s && !Number.isNaN(Date.parse(s)) ? new Date(s) : null);

/**
 * What to dream. An append-only re-ingest (a chat transcript growing turn by turn) dreams only the new text, with the
 * last already-dreamed turn as context. Any other change re-dreams everything and ends what the document no longer says.
 */
function unitOf(doc: Doc): { unit: Unit; offset: number; edited: boolean } {
  const base = { documentDate: doc.doc_date, supportingContext: doc.ctx };
  const n = doc.dreamed_chars;
  if (n !== null && doc.content.length >= n && sha(doc.content.slice(0, n)) === doc.dreamed_hash) {
    const before = doc.content.slice(0, n);
    const lastTurn = Math.max(before.lastIndexOf("\nUser:"), before.lastIndexOf("\nAssistant:"));
    const context = (lastTurn >= 0 ? before.slice(lastTurn + 1) : before.slice(-CONTEXT_CHARS)).trim().slice(-CONTEXT_CHARS);
    const rest = doc.content.slice(n);
    const lead = rest.length - rest.trimStart().length;
    return { unit: { ...base, content: rest.trim(), context: context || null }, offset: n + lead, edited: false };
  }
  return { unit: { ...base, content: doc.content, context: null }, offset: 0, edited: n !== null };
}

/** D1 + D2, as the engine runs them (shared with the E2 evals). */
export async function extractUnit(ns: string, unit: Unit) {
  const cands = await extract(ns, unit);
  const { kept, rejected } = await ground(unit, cands);
  return { candidates: cands, kept, rejected };
}

export { relate } from "./relator";

/** One dream run per document: recorded in dream_runs; every LLM call and memory event points at it. */
export async function dream(docPk: number) {
  const [doc] = (await sql`
    select d.pk, d.id, d.ns, d.content, d.metadata, coalesce(d.supporting_context, n.supporting_context) as ctx,
           coalesce(d.doc_date, d.created_at) as doc_date, d.dreamed_chars, d.dreamed_hash
    from documents d join namespaces n on n.id = d.ns where d.pk = ${docPk}`) as Doc[];
  if (!doc?.content?.trim()) return;
  const { unit, offset, edited } = unitOf(doc);
  const markDreamed = () => sql`update documents set dreamed_chars = ${doc.content.length}, dreamed_hash = ${sha(doc.content)} where pk = ${doc.pk}`;
  if (!unit.content) return void (await markDreamed());

  const pv = pipelineVersion();
  const [{ id }] = await sql`insert into dream_runs (ns, document_pks, pipeline_version) values (${doc.ns}, array[${doc.pk}]::bigint[], ${pv}) returning id`;
  const run: Run = {
    id, pv,
    stats: { candidates: 0, rejected: [], added: 0, updated: 0, extended: 0, duplicates: 0, conflicts: 0, historical: 0, skipped: 0, ended: 0, inferences: 0 },
  };
  try {
    await withDreamRun(id, () => dreamUnit(doc, unit, offset, edited, run));
    await markDreamed();
    await sql`update dream_runs set status = 'done', stats = ${run.stats}, finished_at = now() where id = ${id}`;
  } catch (e) {
    await sql`update dream_runs set status = 'failed', stats = ${run.stats}, error = ${String((e as Error).message ?? e)}, finished_at = now() where id = ${id}`;
    throw e;
  }
}

async function dreamUnit(doc: Doc, unit: Unit, offset: number, edited: boolean, run: Run) {
  const { candidates, kept, rejected } = await extractUnit(doc.ns, unit);
  run.stats.candidates = candidates.length;
  run.stats.rejected = rejected;
  const vecs = await embed(kept.map((c) => c.content));
  const resolved = await sql.begin((tx) => resolveEntities(tx, doc.ns, kept));
  const { neighbors, plans } = kept.length ? await relate(doc.ns, kept, vecs, resolved, doc.doc_date) : { neighbors: [], plans: [] as Plan[] };
  const ev = (e: Omit<MemoryEvent, "actor" | "pipelineVersion" | "dreamRunId">): MemoryEvent => ({ ...e, actor: "dreamer", pipelineVersion: run.pv, dreamRunId: run.id });
  const { strength_cap } = lifecycle().preference;

  const inserted: { pk: number; content: string; related: number[] }[] = [];
  await sql.begin(async (tx) => {
    const events: MemoryEvent[] = [];
    const touched = new Set<number>(); // existing memories this unit confirmed, extended or contested
    const made = new Map<number, { pk: number; id: string }>(); // candidate index -> its new memory

    const insert = async (i: number, c: Candidate, o: { latest?: boolean; validTo?: Date | null; status?: string; version?: number; rootId?: string | null } = {}) => {
      const expires = validDate(c.expiresAt);
      const validFrom = validDate(c.validFrom) ?? doc.doc_date;
      const lasting = expires && expires > validFrom ? expires : null; // an expiry at or before the fact began is a model mistake
      const hit = locate(c.quote, unit.content);
      const span = { document_id: doc.id, start: offset + hit.start, end: offset + hit.end, quote: c.quote };
      const [m] = await tx`
        insert into memories (ns, content, kind, bucket, forget_after, version, root_id, is_latest, metadata, source_document_pk, embedding,
                              valid_from, valid_to, speaker, subject, slot, confidence, sensitivity, source_span, status,
                              pipeline_version, dream_run_id, embedding_model)
        values (${doc.ns}, ${c.content}, ${c.kind}, ${c.bucket ?? null}, ${lasting}, ${o.version ?? 1}, ${o.rootId ?? null}, ${o.latest ?? true},
                ${doc.metadata}, ${doc.pk}, ${toVector(vecs[i])}::vector,
                ${validFrom}, ${o.validTo ?? lasting}, ${c.speaker}, ${c.subject}, ${c.slot}, ${c.confidence}, ${c.sensitivity}, ${span},
                ${o.status ?? "active"}, ${run.pv}, ${run.id}, ${EMBED_MODEL})
        returning pk, id`;
      if (!o.rootId) await tx`update memories set root_id = id where pk = ${m.pk}`;
      const r = resolved[i];
      if (r?.subject) await tx`insert into memory_entities (memory_pk, entity_id, role) values (${m.pk}, ${r.subject}, 'subject') on conflict do nothing`;
      for (const e of r?.mentions ?? []) await tx`insert into memory_entities (memory_pk, entity_id, role) values (${m.pk}, ${e}, 'mention') on conflict do nothing`;
      made.set(i, m);
      return { ...m, validFrom } as { pk: number; id: string; validFrom: Date };
    };
    const review = (kind: string, memoryPk: number, relatedPk: number, payload: Record<string, unknown>) =>
      tx`insert into review_items (ns, kind, memory_pk, related_memory_pk, payload) values (${doc.ns}, ${kind}, ${memoryPk}, ${relatedPk}, ${payload})`;

    for (const [i, c] of kept.entries()) {
      const p = plans[i];
      const t = p.target !== null ? neighbors[p.target] : undefined;
      const why = { op: p.op, reason: p.reason ?? null, confidence: p.confidence };
      if (p.op === "SKIP") {
        run.stats.skipped++;
        continue;
      }
      if (p.op === "DUPLICATE" && t) {
        // Reinforce: preferences strengthen (capped), facts are re-learned, episodes gain significance.
        const [r] = await tx`update memories set
            strength = case when kind = 'preference' then least(${strength_cap}::real, strength + 1) else strength + 1 end,
            learned_at = now(), updated_at = now()
          where pk = ${t.pk} returning strength`;
        events.push(ev({ memoryPk: t.pk, action: "strengthen", reason: `duplicate: ${c.content}`, after: { strength: r.strength } }));
        touched.add(t.pk);
        run.stats.duplicates++;
        continue;
      }
      if (p.op === "UPDATE" && t) {
        const m = await insert(i, c, { version: t.version + 1, rootId: t.root_id ?? t.id });
        await tx`update memories set is_latest = false, valid_to = greatest(coalesce(valid_from, ${m.validFrom}), ${m.validFrom}), updated_at = now() where pk = ${t.pk}`;
        await tx`insert into memory_edges (src, dst, rel) values (${m.pk}, ${t.pk}, 'updates')`;
        events.push(
          ev({ memoryPk: m.pk, action: "update", after: { content: c.content, updates: t.id } }),
          ev({ memoryPk: t.pk, action: "supersede", reason: `updated by ${m.id}`, before: { is_latest: true }, after: { is_latest: false, superseded_by: m.id } }),
        );
        touched.add(t.pk);
        run.stats.updated++;
        inserted.push({ pk: m.pk, content: c.content, related: [] });
        continue;
      }
      if (p.op === "HISTORICAL" && t) {
        // Older than what we know: kept as history (never latest), ending where the newer memory begins.
        const m = await insert(i, c, { latest: false, validTo: t.valid_from });
        await tx`insert into memory_edges (src, dst, rel) values (${t.pk}, ${m.pk}, 'updates') on conflict do nothing`;
        events.push(ev({ memoryPk: m.pk, action: "create", reason: p.reason, after: { content: c.content, historical_before: t.id } }));
        touched.add(t.pk);
        run.stats.historical++;
        continue;
      }
      if (p.op === "CONFLICT" && t) {
        // Both stay; a person decides. Against a pinned memory the newcomer waits in review.
        const m = await insert(i, c, { status: t.pinned ? "pending_review" : "active" });
        await review(p.reason?.startsWith("low-confidence") ? "low_confidence" : "conflict", m.pk, t.pk, why);
        events.push(ev({ memoryPk: m.pk, action: "create", reason: p.reason, after: { content: c.content, conflicts_with: t.id } }));
        touched.add(t.pk);
        run.stats.conflicts++;
        inserted.push({ pk: m.pk, content: c.content, related: [t.pk] });
        continue;
      }
      const m = await insert(i, c);
      const extendsPk = p.op === "EXTEND" ? (t?.pk ?? (p.targetCand !== undefined ? made.get(p.targetCand)?.pk : undefined)) : undefined;
      if (extendsPk) {
        await tx`insert into memory_edges (src, dst, rel) values (${m.pk}, ${extendsPk}, 'extends') on conflict do nothing`;
        events.push(ev({ memoryPk: m.pk, action: "extend", reason: p.reason, after: { content: c.content, extends_pk: extendsPk } }));
        if (t) touched.add(t.pk);
        run.stats.extended++;
      } else {
        events.push(ev({ memoryPk: m.pk, action: "create", reason: p.reason, after: { content: c.content, kind: c.kind, speaker: c.speaker } }));
        run.stats.added++;
      }
      inserted.push({ pk: m.pk, content: c.content, related: plans[i].target !== null && t ? [t.pk] : [] });
    }

    // An edited document: what its earlier versions taught us and this version no longer says ends now (kept as history).
    if (edited) {
      const ended = await tx`update memories set valid_to = now(), updated_at = now()
        where source_document_pk = ${doc.pk} and is_latest and not is_forgotten and (valid_to is null or valid_to > now())
          and (dream_run_id is null or dream_run_id <> ${run.id}) and not (pk = any(${tx.array([...touched], "int8")})) and not pinned
        returning pk`;
      for (const r of ended) events.push(ev({ memoryPk: r.pk, action: "expire", reason: "no longer in the edited document" }));
      run.stats.ended = ended.length;
    }
    await logEvents(events, tx);
  });

  await derive(doc, inserted, run);
}

const deriveSchema = {
  type: "object", additionalProperties: false, required: ["inferences"],
  properties: {
    inferences: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["content", "from"], properties: { content: { type: "string" }, from: { type: "array", items: { type: "integer" } } } },
    },
  },
};

// D8: inferences over the touched cluster (new memories plus the live neighbours they landed next to). At most 3,
// each citing at least 2 memories, all waiting for review.
async function derive(doc: Doc, inserted: { pk: number; content: string; related: number[] }[], run: Run) {
  if (!inserted.length) return;
  const pks = [...new Set([...inserted.map((m) => m.pk), ...inserted.flatMap((m) => m.related)])];
  const pool = (await sql`
    select pk, content from memories where pk in ${sql(pks)} and is_latest and not is_forgotten and status = 'active' order by pk limit 15`) as { pk: number; content: string }[];
  if (pool.length < 2) return;
  const { inferences } = await call<{ inferences: { content: string; from: number[] }[] }>(
    "derive", "derive.v1", { memories: pool.map((m, j) => ({ j, content: m.content })) }, deriveSchema,
  );
  const valid = inferences.filter((x) => x.content?.trim() && new Set(x.from.filter((j) => pool[j])).size >= 2).slice(0, 3);
  if (!valid.length) return;
  const vecs = await embed(valid.map((x) => x.content));
  await sql.begin(async (tx) => {
    for (const [k, x] of valid.entries()) {
      // The same cluster gets re-derived as neighbours recur; skip anything the namespace already knows.
      const [{ known }] = await tx`select exists (select 1 from memories where ns = ${doc.ns} and is_latest and not is_forgotten
        and 1 - (embedding <=> ${toVector(vecs[k])}::vector) >= ${DERIVED_KNOWN_SIM}) as known`;
      if (known) continue;
      const from = [...new Set(x.from)].filter((j) => pool[j]).map((j) => pool[j].pk);
      const [m] = await tx`
        insert into memories (ns, content, kind, is_inference, status, metadata, source_document_pk, embedding,
                              valid_from, speaker, confidence, pipeline_version, dream_run_id, embedding_model)
        values (${doc.ns}, ${x.content}, 'fact', true, 'pending_review', ${doc.metadata}, ${doc.pk}, ${toVector(vecs[k])}::vector,
                ${doc.doc_date}, null, 0.5, ${run.pv}, ${run.id}, ${EMBED_MODEL})
        returning pk`;
      await tx`update memories set root_id = id where pk = ${m.pk}`;
      for (const pk of from) await tx`insert into memory_edges (src, dst, rel) values (${m.pk}, ${pk}, 'derives') on conflict do nothing`;
      await tx`insert into review_items (ns, kind, memory_pk, payload) values (${doc.ns}, 'inference', ${m.pk}, ${{ from }})`;
      await logEvents([{ memoryPk: m.pk, action: "derive", actor: "dreamer", after: { content: x.content, from }, pipelineVersion: run.pv, dreamRunId: run.id }], tx);
      run.stats.inferences++;
    }
  });
}
