// Review inbox and provenance (PLAN.v2 P5). Dreaming queues what it shouldn't decide alone (review_items):
//  - inference      : a conclusion drawn from >= 2 memories, pending until approved;
//  - conflict       : a new memory contradicts one it may not supersede (hearsay, pinned target, model said CONFLICT);
//  - low_confidence : an update the model wasn't sure enough of.
// A person resolves each one; every change is a memory_event in the same transaction.
import type { SQL } from "bun";
import { sql, toVector } from "./db";
import { embed, EMBED_MODEL } from "./embed";
import { logEvents, type MemoryEvent } from "./events";

export type Resolution =
  | { action: "approve" | "reject" } // inferences
  | { action: "keep_new" | "keep_old" | "keep_both" } // conflicts
  | { action: "merge"; content: string }; // conflicts: one edited memory replaces both

export class ReviewError extends Error {
  constructor(public status: 400 | 404 | 409, message: string) {
    super(message);
  }
}

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);
const brief = (m: any) => m && {
  id: m.id, memory: m.content, kind: m.kind, speaker: m.speaker, confidence: m.confidence, quote: m.source_span?.quote ?? null,
  validFrom: iso(m.valid_from), validTo: iso(m.valid_to), isLatest: m.is_latest, status: m.status, pinned: m.pinned,
  document: m.doc_id ? { id: m.doc_id, title: m.doc_title } : null,
};
const withDoc = `select m.*, d.id as doc_id, d.title as doc_title from memories m left join documents d on d.pk = m.source_document_pk`;

/** Review items with both memories side by side (and, for inferences, the memories they were drawn from). */
export async function listReview(ns: string, status = "open") {
  const items = await sql`select * from review_items where ns = ${ns} and status = ${status} order by created_at desc limit 200`;
  const pks = [...new Set(items.flatMap((r: any) => [r.memory_pk, r.related_memory_pk, ...(r.payload?.from ?? [])]).filter(Boolean))];
  const mems = pks.length ? await sql.unsafe(`${withDoc} where m.pk = any($1::bigint[])`, [`{${pks.join(",")}}`]) : [];
  const byPk = new Map(mems.map((m: any) => [Number(m.pk), m]));
  return items.map((r: any) => ({
    id: r.id, kind: r.kind, status: r.status, createdAt: iso(r.created_at), resolvedAt: iso(r.resolved_at),
    reason: r.payload?.reason ?? null, confidence: r.payload?.confidence ?? null, resolution: r.payload?.resolution ?? null,
    memory: brief(byPk.get(Number(r.memory_pk))),
    related: brief(byPk.get(Number(r.related_memory_pk))) ?? null,
    from: (r.payload?.from ?? []).map((pk: number) => brief(byPk.get(Number(pk)))).filter(Boolean),
  }));
}

export async function resolveReview(ns: string, itemId: string, res: Resolution) {
  return sql.begin(async (tx) => {
    const [item] = await tx`select * from review_items where ns = ${ns} and id = ${itemId} for update`;
    if (!item) throw new ReviewError(404, "Review item not found");
    const inference = item.kind === "inference";
    if (inference !== (res.action === "approve" || res.action === "reject")) {
      throw new ReviewError(400, inference ? "an inference takes approve or reject" : "a conflict takes keep_new, keep_old, keep_both or merge");
    }
    if (item.status !== "open") throw new ReviewError(409, `Review item is already ${item.status}`);
    const [m] = await tx`select * from memories where pk = ${item.memory_pk}`;
    const [old] = item.related_memory_pk ? await tx`select * from memories where pk = ${item.related_memory_pk}` : [];
    if (!m) throw new ReviewError(404, "The memory under review no longer exists");
    const events: MemoryEvent[] = [];
    const user = (memoryPk: number, action: MemoryEvent["action"], reason: string, after?: Record<string, unknown>) =>
      events.push({ memoryPk, action, actor: "user", reason, after: after ?? null });
    let status = "approved";
    let result = m;

    if (res.action === "approve" || res.action === "keep_both") {
      [result] = await tx`update memories set status = 'active', is_inference = false, updated_at = now() where pk = ${m.pk} returning *`;
      user(m.pk, "approve", res.action === "approve" ? "inference review" : "conflict review: both stay");
    } else if (res.action === "reject" || res.action === "keep_old") {
      status = "rejected";
      [result] = await tx`update memories set status = 'rejected', is_forgotten = true, forget_reason = 'declined in review',
          valid_to = coalesce(valid_to, now()), updated_at = now() where pk = ${m.pk} returning *`;
      user(m.pk, "reject", res.action === "reject" ? "inference review" : "conflict review: kept the older memory");
    } else if (res.action === "keep_new") {
      if (!old) throw new ReviewError(409, "The memory it conflicts with no longer exists");
      [result] = await supersede(tx, m, old, events);
    } else if (res.action === "merge") {
      if (!old) throw new ReviewError(409, "The memory it conflicts with no longer exists");
      status = "merged";
      result = await merge(tx, ns, res.content, m, old, events);
    }
    await tx`update review_items set status = ${status}, resolved_at = now(),
        payload = payload || ${{ resolution: res.action, ...(res.action === "merge" && { merged_into: result.id }) }}
      where id = ${item.id}`;
    await logEvents(events, tx);
    return { item: itemId, status, memory: { id: result.id, memory: result.content } };
  });
}

/** The newer memory takes over: it becomes the next version in the old memory's chain, the old one ends. */
async function supersede(tx: SQL, m: any, old: any, events: MemoryEvent[]) {
  const from = m.valid_from ?? new Date();
  await tx`update memories set is_latest = false, valid_to = greatest(coalesce(valid_from, ${from}), ${from}), updated_at = now() where pk = ${old.pk}`;
  await tx`insert into memory_edges (src, dst, rel) values (${m.pk}, ${old.pk}, 'updates') on conflict do nothing`;
  events.push(
    { memoryPk: m.pk, action: "update", actor: "user", reason: "conflict review: the newer memory replaces the older", after: { updates: old.id } },
    { memoryPk: old.pk, action: "supersede", actor: "user", reason: `replaced by ${m.id} in review`, before: { is_latest: true }, after: { is_latest: false } },
  );
  return tx`update memories set status = 'active', version = ${old.version + 1}, root_id = ${old.root_id ?? old.id}, updated_at = now()
    where pk = ${m.pk} returning *`;
}

/** One memory written by the user replaces both sides; it is pinned, so dreaming won't overwrite it. */
async function merge(tx: SQL, ns: string, content: string, m: any, old: any, events: MemoryEvent[]) {
  const [vec] = await embed([content]);
  const [made] = await tx`
    insert into memories (ns, content, kind, version, root_id, metadata, source_document_pk, embedding, valid_from, speaker, subject, slot,
                          confidence, sensitivity, status, pinned, embedding_model)
    values (${ns}, ${content}, ${m.kind}, ${Math.max(m.version, old.version) + 1}, ${old.root_id ?? old.id}, ${m.metadata}, null,
            ${toVector(vec)}::vector, now(), 'user', ${m.subject ?? old.subject}, ${m.slot ?? old.slot}, 1,
            ${m.sensitivity === "sensitive" || old.sensitivity === "sensitive" ? "sensitive" : m.sensitivity ?? old.sensitivity}, 'active', true, ${EMBED_MODEL})
    returning *`;
  for (const side of [old, m]) {
    await tx`update memories set is_latest = false, valid_to = now(), updated_at = now() where pk = ${side.pk}`;
    await tx`insert into memory_edges (src, dst, rel) values (${made.pk}, ${side.pk}, 'updates') on conflict do nothing`;
    events.push({ memoryPk: side.pk, action: "supersede", actor: "user", reason: `merged into ${made.id} in review`, before: { is_latest: true }, after: { is_latest: false } });
  }
  events.push({ memoryPk: made.pk, action: "edit", actor: "user", reason: "conflict review: merged", after: { content, merges: [old.id, m.id] } });
  return made;
}

/** "Why do I know this?": the source, who said it, which run learned it, its versions and everything that happened to it. */
export async function explainMemory(ns: string, id: string) {
  const [m] = await sql.unsafe(`${withDoc} where m.ns = $1 and m.id = $2`, [ns, id]);
  if (!m) return null;
  const [run] = m.dream_run_id
    ? await sql`select r.id, r.pipeline_version, r.started_at,
        (select array_agg(distinct c.model) from llm_calls c where c.dream_run_id = r.id) as models
      from dream_runs r where r.id = ${m.dream_run_id}` : [];
  const [versions, events, reviews, derivedFrom] = await Promise.all([
    sql`select id, content, version, is_latest, valid_from, valid_to from memories where ns = ${ns} and root_id = ${m.root_id ?? m.id} order by version, created_at`,
    sql`select action, actor, reason, before, after, at from memory_events where memory_pk = ${m.pk} order by at, id`,
    sql`select id, kind, status, payload, created_at, resolved_at from review_items where memory_pk = ${m.pk} or related_memory_pk = ${m.pk} order by created_at`,
    sql`select s.id, s.content from memory_edges e join memories s on s.pk = e.dst where e.src = ${m.pk} and e.rel = 'derives'`,
  ]);
  const source = brief(m);
  const said = m.speaker === "user" ? "you said" : m.speaker === "third_party" ? "someone else said (as you reported it)"
    : m.speaker === "assistant" ? "the assistant said" : "a document says";
  const summary = [
    m.is_inference ? `Inferred from ${derivedFrom.length} other memories${m.status === "pending_review" ? ", not yet confirmed" : ""}.`
      : m.pinned && !m.source_document_pk ? "Written or edited by you." : `Learned because ${said}${source.quote ? `: "${source.quote}"` : ""}.`,
    source.document ? `Source: ${source.document.title ? `"${source.document.title}" (document ${source.document.id})` : `document ${source.document.id}`}.` : null,
    m.valid_from ? `True since ${iso(m.valid_from)!.slice(0, 10)}${m.valid_to ? `, until ${iso(m.valid_to)!.slice(0, 10)}` : ""}.` : null,
    m.confidence != null ? `Confidence ${Number(m.confidence).toFixed(2)}.` : null,
    versions.length > 1 ? `Version ${m.version} of ${versions.length}.` : null,
    m.pinned ? "Pinned: dreaming won't overwrite it." : null,
  ].filter(Boolean).join(" ");
  return {
    summary,
    memory: { ...source, version: m.version, isInference: m.is_inference, learnedAt: iso(m.learned_at ?? m.created_at) },
    learnedBy: run ? { dreamRun: run.id, pipelineVersion: run.pipeline_version, models: run.models ?? [], at: iso(run.started_at) } : null,
    derivedFrom: derivedFrom.map((d: any) => ({ id: d.id, memory: d.content })),
    versions: versions.map((v: any) => ({ id: v.id, memory: v.content, version: v.version, isLatest: v.is_latest, validFrom: iso(v.valid_from), validTo: iso(v.valid_to) })),
    history: events.map((e: any) => ({ action: e.action, actor: e.actor, reason: e.reason, before: e.before, after: e.after, at: iso(e.at) })),
    reviews: reviews.map((r: any) => ({ id: r.id, kind: r.kind, status: r.status, resolution: r.payload?.resolution ?? null, createdAt: iso(r.created_at), resolvedAt: iso(r.resolved_at) })),
  };
}
