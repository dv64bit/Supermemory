// Re-dream (PLAN.v2 §3, P6): replay a namespace's documents, oldest event first, through the current pipeline into a
// shadow namespace, then report what would change before anything does.
//  1. start   : shadow = copy of the namespace settings, buckets and documents (not their memories), plus the user's
//               pinned memories, so dreaming relates against them exactly as it would live.
//  2. replay  : dream() each shadow document in event-time order (in the background; progress in `redreams`).
//  3. carry   : the user's past decisions are re-applied in the shadow: review resolutions (matched on the memories'
//               text), and memories the user forgot or rejected.
//  4. report  : added / removed / changed memories (changed = similar text, or same subject and slot), edge counts.
//  5. swap    : the old memories (with their reviews, entities and runs) move to an archive namespace, nothing is
//               deleted; the shadow's move in. Refused if documents changed since the run started.
//     discard : the shadow is dropped.
import { sql } from "./db";
import { dream } from "./dream";
import { pipelineVersion } from "./llm";
import { LIVE } from "./memories";
import { resolveReview, type Resolution } from "./review";

export class RedreamError extends Error {
  constructor(public status: 404 | 409, message: string) {
    super(message);
  }
}

const SIMILAR = 0.85; // a removed and an added memory this close (or with the same subject + slot) count as "changed"
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const shadowOf = (ns: string) => `${ns.slice(0, 92)}:shadow`;
const running = new Set<string>(); // runs replaying in this process; a "running" row not in here was interrupted

type Row = { id: string; ns: string; shadow_ns: string; status: string; pipeline_version: string; total: number; done: number;
  failed: number; report: Report | null; archive_ns: string | null; error: string | null; started_at: Date; finished_at: Date | null };

const view = (r: Row) => ({
  id: r.id, status: r.status === "running" && !running.has(r.id) ? "interrupted" : r.status, shadow: r.shadow_ns,
  pipelineVersion: r.pipeline_version, total: r.total, done: r.done, failed: r.failed, report: r.report, archive: r.archive_ns,
  error: r.error, startedAt: r.started_at.toISOString(), finishedAt: r.finished_at?.toISOString() ?? null,
});

export async function latestRedream(ns: string) {
  const [r] = (await sql`select * from redreams where ns = ${ns} order by started_at desc limit 1`) as Row[];
  return r ? view(r) : null;
}

/** Sets up the shadow and starts the replay in the background; `wait` (tests) returns once it has finished. */
export async function startRedream(ns: string, opts: { wait?: boolean } = {}) {
  const shadow = shadowOf(ns);
  const [busy] = await sql`select id from redreams where ns = ${ns} and status = 'running'`;
  if (busy && running.has(busy.id)) throw new RedreamError(409, "A re-dream is already running for this space");
  const [live] = await sql`select * from namespaces where id = ${ns}`;
  if (!live) throw new RedreamError(404, "Space not found");

  const row = await sql.begin(async (tx) => {
    if (busy) await tx`update redreams set status = 'failed', error = 'interrupted', finished_at = now() where id = ${busy.id}`;
    await tx`update redreams set status = 'discarded' where ns = ${ns} and status = 'ready'`;
    await tx`delete from namespaces where id = ${shadow}`; // an older shadow, with everything in it
    await tx`insert into namespaces (id, supporting_context, inject_sensitive) values (${shadow}, ${live.supporting_context}, ${live.inject_sensitive})`;
    await tx`insert into profile_buckets (ns, name, description) select ${shadow}, name, description from profile_buckets where ns = ${ns}`;
    // Documents as they are now, not yet dreamed. They are never queued, so the worker leaves them alone.
    await tx`insert into documents (ns, id, title, type, url, raw, content, content_hash, status, task_type, dreaming, supporting_context,
                                    metadata, doc_date, created_at, updated_at, dreaming_status, redactions, dreamed_chars, dreamed_hash)
      select ${shadow}, id, title, type, url, raw, content, content_hash, 'done', task_type, dreaming, supporting_context,
             metadata, doc_date, created_at, updated_at, 'done', redactions, 0, null
      from documents where ns = ${ns} and status = 'done' and content is not null`;
    // Pinned memories (written or edited by the user) go in first, unchanged.
    await tx.unsafe(`insert into memories (ns, content, kind, bucket, forget_after, version, is_latest, metadata, source_document_pk, embedding,
                                   valid_from, valid_to, learned_at, speaker, subject, slot, confidence, sensitivity, source_span, status,
                                   pinned, pipeline_version, embedding_model)
      select $1, m.content, m.kind, m.bucket, m.forget_after, 1, true, m.metadata, sd.pk, m.embedding,
             m.valid_from, m.valid_to, m.learned_at, m.speaker, m.subject, m.slot, m.confidence, m.sensitivity, m.source_span, m.status,
             true, m.pipeline_version, m.embedding_model
      from memories m left join documents d on d.pk = m.source_document_pk left join documents sd on sd.ns = $1 and sd.id = d.id
      where m.ns = $2 and m.pinned and ${LIVE()}`, [shadow, ns]);
    await tx`update memories set root_id = id where ns = ${shadow} and root_id is null`;
    const [{ n }] = await tx`select count(*)::int as n from documents where ns = ${shadow}`;
    const [r] = await tx`insert into redreams (ns, shadow_ns, pipeline_version, total) values (${ns}, ${shadow}, ${pipelineVersion()}, ${n}) returning *`;
    return r as Row;
  });

  running.add(row.id);
  const job = replay(row).finally(() => running.delete(row.id));
  if (opts.wait) await job;
  else job.catch((e) => console.error("redream", e));
  return latestRedream(ns);
}

async function replay(r: Row) {
  try {
    // Event-time order, like the worker: a fact learned later in the world is dreamed later.
    const docs = await sql`select pk from documents where ns = ${r.shadow_ns} order by coalesce(doc_date, created_at), pk`;
    for (const d of docs) {
      const ok = await dream(d.pk).then(() => true, (e) => (console.error("redream: dream failed", e), false));
      await sql`update redreams set done = done + 1, failed = failed + ${ok ? 0 : 1} where id = ${r.id}`;
    }
    await carryDecisions(r.ns, r.shadow_ns);
    const report = await diff(r.ns, r.shadow_ns);
    await sql`update redreams set status = 'ready', report = ${report}, finished_at = now() where id = ${r.id}`;
  } catch (e) {
    await sql`update redreams set status = 'failed', error = ${String((e as Error).message ?? e)}, finished_at = now() where id = ${r.id}`;
    throw e;
  }
}

/** The user's earlier calls, applied again to the same memories in the shadow (matched by text). */
async function carryDecisions(ns: string, shadow: string) {
  const resolved = await sql`
    select r.kind, r.status, r.payload, m.content as memory, rm.content as related, mm.content as merged
    from review_items r join memories m on m.pk = r.memory_pk left join memories rm on rm.pk = r.related_memory_pk
    left join memories mm on mm.id = r.payload->>'merged_into'
    where r.ns = ${ns} and r.status <> 'open' order by r.resolved_at`;
  const decision = new Map<string, Resolution>();
  for (const r of resolved as any[]) {
    const key = `${r.kind === "inference"}|${norm(r.memory)}|${norm(r.related ?? "")}`;
    const action = r.payload?.resolution ?? (r.status === "approved" ? "approve" : r.status === "rejected" ? "reject" : null);
    if (action === "merge" && r.merged) decision.set(key, { action, content: r.merged });
    else if (action && action !== "merge") decision.set(key, { action });
  }
  const open = await sql`
    select r.id, r.kind, m.content as memory, rm.content as related
    from review_items r join memories m on m.pk = r.memory_pk left join memories rm on rm.pk = r.related_memory_pk
    where r.ns = ${shadow} and r.status = 'open' order by r.created_at`;
  for (const r of open as any[]) {
    const d = decision.get(`${r.kind === "inference"}|${norm(r.memory)}|${norm(r.related ?? "")}`);
    if (d) await resolveReview(shadow, r.id, d).catch((e) => console.error("redream: carry review", e));
  }

  // Memories the user forgot or rejected outside the inbox stay gone.
  const gone = await sql`
    select distinct m.content from memories m join memory_events e on e.memory_pk = m.pk
    where m.ns = ${ns} and e.actor in ('user', 'api') and e.action in ('forget', 'reject') and (m.is_forgotten or m.status = 'rejected')`;
  const texts = [...new Set((gone as any[]).map((g) => norm(g.content)))];
  if (texts.length) {
    const hit = await sql.unsafe(`select pk, content from memories m where m.ns = $1 and ${LIVE()}`, [shadow]);
    const pks = (hit as any[]).filter((m) => texts.includes(norm(m.content))).map((m) => m.pk);
    if (pks.length) {
      await sql`update memories set is_forgotten = true, forget_reason = 'forgotten before the re-dream', updated_at = now() where pk in ${sql(pks)}`;
    }
  }
}

type Brief = { id: string; memory: string };
export type Report = {
  before: number; after: number; unchanged: number;
  added: Brief[]; removed: Brief[]; changed: { before: Brief; after: Brief }[];
  edges: Record<string, { before: number; after: number }>;
  openReviews: number;
};

/** What would change: live memories now vs live memories in the shadow. */
async function diff(ns: string, shadow: string): Promise<Report> {
  const live = async (n: string) => (await sql.unsafe(
    `select m.pk, m.id, m.content, m.subject, m.slot, m.embedding::text as e from memories m where m.ns = $1 and ${LIVE()} order by m.pk`, [n])) as any[];
  const [a, b] = await Promise.all([live(ns), live(shadow)]);
  const inB = new Set(b.map((m) => norm(m.content)));
  const inA = new Set(a.map((m) => norm(m.content)));
  const removed = a.filter((m) => !inB.has(norm(m.content)));
  const added = b.filter((m) => !inA.has(norm(m.content)));

  // Pair a removed with an added memory when they say much the same, or set the same subject's same slot.
  const vec = (m: any) => m.e.slice(1, -1).split(",").map(Number) as number[];
  const cos = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * y[i], 0);
  const changed: Report["changed"] = [];
  const used = new Set<number>();
  for (const r of removed) {
    const rv = vec(r);
    let best = -1, bestScore = 0;
    for (const [j, n] of added.entries()) {
      if (used.has(j)) continue;
      const slot = r.slot && r.subject && r.slot === n.slot && norm(r.subject) === norm(n.subject ?? "") ? 1 : 0;
      const score = Math.max(slot, cos(rv, vec(n)));
      if (score >= SIMILAR && score > bestScore) [best, bestScore] = [j, score];
    }
    if (best >= 0) {
      used.add(best);
      changed.push({ before: { id: r.id, memory: r.content }, after: { id: added[best].id, memory: added[best].content } });
    }
  }
  const pairedRemoved = new Set(changed.map((c) => c.before.id));
  const edges = await sql`
    select m.ns, e.rel, count(*)::int as n from memory_edges e join memories m on m.pk = e.src
    where m.ns in (${ns}, ${shadow}) group by 1, 2`;
  const edgeCounts: Report["edges"] = {};
  for (const e of edges as any[]) {
    edgeCounts[e.rel] ??= { before: 0, after: 0 };
    edgeCounts[e.rel][e.ns === ns ? "before" : "after"] = e.n;
  }
  const [{ n: openReviews }] = await sql`select count(*)::int as n from review_items where ns = ${shadow} and status = 'open'`;
  return {
    before: a.length, after: b.length, unchanged: a.length - removed.length,
    added: added.filter((_, j) => !used.has(j)).map((m) => ({ id: m.id, memory: m.content })),
    removed: removed.filter((m) => !pairedRemoved.has(m.id)).map((m) => ({ id: m.id, memory: m.content })),
    changed, edges: edgeCounts, openReviews,
  };
}

/** Swap: the old memories go to an archive namespace (nothing is deleted), the shadow's become the space's memories. */
export async function swapRedream(ns: string) {
  const [r] = (await sql`select * from redreams where ns = ${ns} order by started_at desc limit 1`) as Row[];
  if (!r || r.status !== "ready") throw new RedreamError(409, "No finished re-dream to swap in");
  const [moved] = await sql`select count(*)::int as n from documents d where d.ns = ${ns} and d.status = 'done' and d.content is not null
    and not exists (select 1 from documents s where s.ns = ${r.shadow_ns} and s.id = d.id and s.content_hash is not distinct from d.content_hash)`;
  const [gone] = await sql`select count(*)::int as n from documents s where s.ns = ${r.shadow_ns}
    and not exists (select 1 from documents d where d.ns = ${ns} and d.id = s.id)`;
  if (moved.n + gone.n > 0) {
    throw new RedreamError(409, `${moved.n + gone.n} document(s) were added, changed or deleted since the re-dream started; run it again`);
  }
  const archive = `${ns.slice(0, 70)}:archive-${r.id.slice(0, 8)}`;
  await sql.begin(async (tx) => {
    await tx`insert into namespaces (id, supporting_context) select ${archive}, supporting_context from namespaces where id = ${ns}`;
    for (const table of ["memories", "review_items", "entities", "dream_runs"]) {
      await tx.unsafe(`update ${table} set ns = $1 where ns = $2`, [archive, ns]);
    }
    // Shadow memories point at shadow documents; point them at the space's own documents before those are dropped.
    await tx`update memories m set source_document_pk = d.pk from documents s join documents d on d.ns = ${ns} and d.id = s.id
      where m.ns = ${r.shadow_ns} and m.source_document_pk = s.pk`;
    for (const table of ["memories", "review_items", "entities", "dream_runs"]) {
      await tx.unsafe(`update ${table} set ns = $1 where ns = $2`, [ns, r.shadow_ns]);
    }
    await tx`update documents d set dreamed_chars = s.dreamed_chars, dreamed_hash = s.dreamed_hash
      from documents s where s.ns = ${r.shadow_ns} and s.id = d.id and d.ns = ${ns}`;
    await tx`delete from namespaces where id = ${r.shadow_ns}`;
    await tx`update redreams set status = 'swapped', archive_ns = ${archive} where id = ${r.id}`;
  });
  return latestRedream(ns);
}

export async function discardRedream(ns: string) {
  const [r] = (await sql`select * from redreams where ns = ${ns} order by started_at desc limit 1`) as Row[];
  if (!r || (r.status !== "ready" && r.status !== "failed")) throw new RedreamError(409, "No finished re-dream to discard");
  await sql`delete from namespaces where id = ${r.shadow_ns}`;
  await sql`update redreams set status = 'discarded' where id = ${r.id}`;
  return latestRedream(ns);
}
