import { sql, toVector } from "./db";
import { extract } from "./extract";
import { chunk } from "./chunk";
import { embed, EMBED_MODEL } from "./embed";
import { dream } from "./dream";
import { sweep } from "./forget";
import { redact } from "./guard";

const BUSY = ["extracting", "chunking", "embedding", "indexing"];

// Claim the oldest queued document whose namespace has nothing in flight:
// ingest is serialized per namespace because order decides which fact "came first".
async function claim() {
  const [doc] = await sql`
    update documents set status = 'extracting', error = null, updated_at = now()
    where pk = (
      select d.pk from documents d
      where d.status = 'queued'
        and not exists (select 1 from documents x where x.ns = d.ns and (x.status in ${sql(BUSY)} or x.dreaming_status = 'dreaming'))
      order by d.created_at
      limit 1
      for update skip locked
    )
    returning pk, ns, raw, content_hash, task_type`;
  return doc as { pk: number; ns: string; raw: string; content_hash: string | null; task_type: string } | undefined;
}

const setStatus = (pk: number, status: string) => sql`update documents set status = ${status}, updated_at = now() where pk = ${pk}`;

export async function processOne(): Promise<boolean> {
  const doc = await claim();
  if (!doc) return false;
  try {
    const ex = await extract(doc.raw);
    // Fetched pages, and raw kept under STORE_RAW_SECRETS, can still hold secrets: chunks and memories never do.
    const guarded = redact(ex.text);
    ex.text = guarded.text;
    const hash = new Bun.CryptoHasher("sha256").update(ex.text).digest("hex");
    const [{ n }] = await sql`select count(*)::int as n from chunks where document_pk = ${doc.pk}`;
    if (hash === doc.content_hash && n > 0) {
      await setStatus(doc.pk, "done"); // unchanged re-ingest is a no-op
      return true;
    }
    // Plain-text extraction keeps the type set at upload (pdf, docx, code...).
    const found = Object.keys(guarded.findings).length ? guarded.findings : null;
    await sql`update documents set content = ${ex.text}, redactions = coalesce(${found}::jsonb, redactions), type = case when ${ex.type} = 'text' then type else ${ex.type} end, url = ${ex.url},
      title = coalesce(title, ${ex.title}), status = 'chunking', updated_at = now() where pk = ${doc.pk}`;
    const pieces = chunk(ex.text);
    await setStatus(doc.pk, "embedding");
    const vectors = await embed(pieces);
    await setStatus(doc.pk, "indexing");
    await sql.begin(async (tx) => {
      await tx`delete from chunks where document_pk = ${doc.pk}`;
      for (const [i, content] of pieces.entries()) {
        await tx`insert into chunks (document_pk, ns, position, content, embedding, embedding_model)
          values (${doc.pk}, ${doc.ns}, ${i}, ${content}, ${toVector(vectors[i])}::vector, ${EMBED_MODEL})`;
      }
      const dreaming = doc.task_type === "memory" ? "dreaming" : "done";
      await tx`update documents set status = 'done', dreaming_status = ${dreaming}, content_hash = ${hash}, updated_at = now() where pk = ${doc.pk}`;
    });
  } catch (e) {
    await sql`update documents set status = 'failed', error = ${String((e as Error).message ?? e)}, updated_at = now() where pk = ${doc.pk}`;
    return true;
  }
  if (doc.task_type === "memory") await runDream(doc.pk);
  return true;
}

// Chunks are searchable before this runs; memories land when it finishes.
// ponytail: `dreaming: dynamic` and `instant` both dream right after indexing; batching across documents is the upgrade.
async function runDream(pk: number) {
  try {
    await dream(pk);
    await sql`update documents set dreaming_status = 'done', updated_at = now() where pk = ${pk}`;
  } catch (e) {
    await sql`update documents set dreaming_status = 'done', error = ${"dreaming: " + String((e as Error).message ?? e)}, updated_at = now() where pk = ${pk}`;
  }
}

export async function drain() {
  while (await processOne());
}

// ponytail: one in-process loop, concurrency 1. Fan out per-namespace workers if ingest backs up.
export function startWorker(intervalMs = 500) {
  let stopped = false;
  (async () => {
    // Recover from a crash: re-run interrupted ingests; interrupted dreams re-run by re-queueing the doc.
    await sql`update documents set status = 'queued', content_hash = null, dreaming_status = 'done'
      where status in ${sql(BUSY)} or dreaming_status = 'dreaming'`;
    let lastSweep = 0;
    while (!stopped) {
      if (Date.now() - lastSweep > 3600_000) {
        // ponytail: in-loop hourly sweep (expiry + episode decay); a real scheduler if more cron jobs appear.
        await sweep().catch((e) => console.error("sweep", e));
        lastSweep = Date.now();
      }
      if (!(await processOne().catch((e) => (console.error("worker", e), false)))) await Bun.sleep(intervalMs);
    }
  })();
  return () => void (stopped = true);
}
