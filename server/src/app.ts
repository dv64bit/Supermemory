import { Hono, type Context } from "hono";
import { z, ZodError } from "zod";
import { sql, toVector } from "./db";
import { embed } from "./embed";
import { search } from "./search";
import { compileFilter, filterSchema } from "./filter";
import { LIVE, memoryJson, related } from "./memories";
import { buckets, BUILTIN_BUCKETS, profile } from "./profile";
import { forgetSemantic } from "./forget";
import { mountMcp } from "./mcp";
import { mountChat } from "./chat";
import { mountLegacy } from "./legacy";
import { extractFile, MAX_FILE, UnsupportedFile } from "./extract";
import { redact, storeRawSecrets } from "./guard";
import { logEvents } from "./events";

const nsParam = z.string().max(100).regex(/^[a-zA-Z0-9_:-]+$/);
const metaValue = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]);
const meta = z.record(z.string(), metaValue);
const docFields = {
  content: z.string(),
  id: z.string().min(1).max(255).optional(),
  supportingContext: z.string().max(1500).optional(),
  metadata: meta.optional(),
  group: meta.optional(), // ponytail: accepted, unused until dreaming groups documents
  date: z.string().optional(),
};
const taskFields = { taskType: z.enum(["memory", "superrag"]).optional(), dreaming: z.enum(["dynamic", "instant"]).optional() };
const addBody = z.object({ ...docFields, ...taskFields }).strict();
const batchBody = z.object({ documents: z.array(z.object(docFields).strict()).min(1).max(600), ...taskFields }).strict();
const patchBody = addBody.omit({ id: true }).partial();
const deleteBody = z.object({ ids: z.array(z.string().min(1).max(255)).min(1).max(100) }).strict();
const searchBody = z.object({
  query: z.string().min(1),
  searchMode: z.enum(["hybrid", "memories", "chunks"]).default("hybrid"),
  limit: z.number().int().min(1).max(100).default(10),
  threshold: z.number().min(0).max(1).default(0.3),
  filter: filterSchema.optional(),
  include: z.object({ documents: z.boolean().default(false), related: z.boolean().default(false), forgotten: z.boolean().default(false) }).strict().default({ documents: false, related: false, forgotten: false }),
  rerank: z.enum(["none", "order", "aggregate"]).default("none"),
  rewriteQuery: z.boolean().default(false),
}).strict();

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const parseDate = (s?: string) => {
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new ZodError([{ code: "custom", message: "invalid date", path: ["date"], input: s }]);
  return d;
};

async function ensureNs(ns: string) {
  await sql`insert into namespaces (id) values (${ns}) on conflict do nothing`;
}

type DocIn = z.infer<typeof addBody>;
async function upsertDoc(ns: string, d: DocIn, file?: { title: string; type: string }) {
  const id = d.id ?? crypto.randomUUID();
  const guarded = redact(d.content);
  const raw = storeRawSecrets() ? d.content : guarded.text;
  const redactions = Object.keys(guarded.findings).length ? guarded.findings : null;
  // Re-sending a known id updates in place; the worker skips re-indexing if extracted text is unchanged.
  const [row] = await sql`
    insert into documents (ns, id, raw, redactions, metadata, supporting_context, doc_date, task_type, dreaming, status, title, type)
    values (${ns}, ${id}, ${raw}, ${redactions}, ${d.metadata ?? {}}, ${d.supportingContext ?? null}, ${parseDate(d.date)},
            ${d.taskType ?? "memory"}, ${d.dreaming ?? "dynamic"}, 'queued', ${file?.title ?? null},
            ${file?.type ?? (/^https?:\/\/\S+$/i.test(d.content.trim()) ? "webpage" : "text")})
    on conflict (ns, id) do update set
      title = coalesce(excluded.title, documents.title), type = excluded.type,
      raw = excluded.raw, redactions = excluded.redactions, metadata = excluded.metadata, supporting_context = excluded.supporting_context,
      doc_date = excluded.doc_date, task_type = excluded.task_type, dreaming = excluded.dreaming,
      status = 'queued', updated_at = now()
    returning id, status`;
  return row as { id: string; status: string };
}

function docJson(r: any, withContent = true) {
  return {
    // ponytail: summary is a leading snippet, not an LLM summary; enough for list previews.
    id: r.id, title: r.title, type: r.type, url: r.url,
    summary: (r.content ?? r.raw)?.replace(/\s+/g, " ").trim().slice(0, 200) || null,
    ...(withContent && { content: r.content ?? r.raw }),
    metadata: r.metadata,
    system: {
      status: r.status,
      dreamingStatus: r.dreaming_status ?? "done",
      createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
    },
  };
}

export function createApp(apiKey: string) {
  const app = new Hono();

  app.get("/v3/health", (c) => c.json({ status: "ok" }));

  app.use("*", async (c, next) => {
    if (c.req.header("authorization") !== `Bearer ${apiKey}`) return c.json({ error: "Unauthorized" }, 401);
    await next();
  });

  app.onError((e, c) => {
    if (e instanceof ZodError) {
      return c.json({ success: false, error: e.issues.map((i) => ({ message: i.message, path: i.path })) }, 400);
    }
    console.error(e);
    return c.json({ error: "Internal error", details: String((e as Error).message) }, 500);
  });

  const ns = (c: Context) => nsParam.parse(c.req.param("namespace"));

  app.post("/ns/:namespace/document", async (c) => {
    const n = ns(c);
    const body = addBody.parse(await c.req.json());
    await ensureNs(n);
    return c.json(await upsertDoc(n, body));
  });

  app.post("/ns/:namespace/document/batch", async (c) => {
    const n = ns(c);
    const { documents, ...task } = batchBody.parse(await c.req.json());
    await ensureNs(n);
    const results = [];
    let failed = 0;
    for (const d of documents) {
      try {
        results.push(await upsertDoc(n, { ...d, ...task }));
      } catch (e) {
        failed++;
        results.push({ id: d.id ?? "", status: "error", error: String((e as Error).message) });
      }
    }
    return c.json({ results, count: results.length - failed, failed });
  });

  // Files are extracted at upload time; the stored text then flows through the normal ingest pipeline.
  app.post("/ns/:namespace/document/file", async (c) => {
    const n = ns(c);
    const form = await c.req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return c.json({ error: "file is required" }, 400);
    if (file.size > MAX_FILE) return c.json({ error: "file exceeds 50MB" }, 400);
    const str = (k: string) => (typeof form.get(k) === "string" ? (form.get(k) as string) : undefined);
    let ex;
    try {
      ex = await extractFile(file);
    } catch (e) {
      if (e instanceof UnsupportedFile) return c.json({ error: e.message }, 400);
      throw e;
    }
    if (!ex.text.trim()) return c.json({ error: "file has no text" }, 400);
    const fields = addBody.parse({
      content: ex.text,
      metadata: str("metadata") ? JSON.parse(str("metadata")!) : undefined,
      supportingContext: str("supportingContext"), date: str("date"),
      taskType: str("taskType"), dreaming: str("dreaming"),
    });
    await ensureNs(n);
    return c.json(await upsertDoc(n, fields, { title: ex.title ?? file.name, type: ex.type }));
  });

  app.get("/ns/:namespace/document/:id", async (c) => {
    const n = ns(c);
    const [doc] = await sql`select * from documents where ns = ${n} and id = ${c.req.param("id")}`;
    if (!doc) return c.json({ error: "Document not found" }, 404);
    const include = (c.req.queries("include") ?? []).flatMap((s) => s.split(","));
    const out: Record<string, unknown> = docJson(doc);
    if (include.includes("chunks")) {
      const rows = await sql`select id, position, content, created_at from chunks where document_pk = ${doc.pk} order by position`;
      out.chunks = rows.map((r: any) => ({
        id: String(r.id), position: r.position, content: r.content, type: "text", metadata: {},
        system: { createdAt: iso(r.created_at) },
      }));
    }
    if (include.includes("memories")) {
      out.memories = (await sql`select * from memories where source_document_pk = ${doc.pk} order by pk`).map(memoryJson);
    }
    return c.json(out);
  });

  app.patch("/ns/:namespace/document/:id", async (c) => {
    const n = ns(c);
    const id = c.req.param("id");
    const body = patchBody.parse(await c.req.json());
    const [doc] = await sql`select * from documents where ns = ${n} and id = ${id}`;
    if (!doc) return c.json({ error: "Document not found" }, 404);
    return c.json(await upsertDoc(n, {
      id,
      content: body.content ?? doc.raw,
      metadata: body.metadata ?? doc.metadata,
      supportingContext: body.supportingContext ?? doc.supporting_context ?? undefined,
      date: body.date ?? doc.doc_date?.toISOString(),
      taskType: body.taskType ?? doc.task_type,
      dreaming: body.dreaming ?? doc.dreaming,
    }));
  });

  app.delete("/ns/:namespace/document", async (c) => {
    const n = ns(c);
    const { ids } = deleteBody.parse(await c.req.json());
    // Memories a deleted document taught us stay as history: their validity ends now, so default search drops them.
    const gone = await sql.begin(async (tx) => {
      const ended = await tx`update memories m set valid_to = now(), updated_at = now() from documents d
        where d.ns = ${n} and d.id in ${sql(ids)} and m.source_document_pk = d.pk and (m.valid_to is null or m.valid_to > now())
        returning m.pk`;
      await logEvents(ended.map((r: any) => ({ memoryPk: r.pk, action: "expire" as const, actor: "api" as const, reason: "source document deleted" })), tx);
      return tx`delete from documents where ns = ${n} and id in ${sql(ids)} returning id`;
    });
    const found = new Set(gone.map((r: any) => r.id));
    return c.json({ count: found.size, errors: ids.filter((i) => !found.has(i)).map((id) => ({ id, error: "not found" })) });
  });

  app.post("/ns/:namespace/search", async (c) => {
    const n = ns(c);
    const body = searchBody.parse(await c.req.json());
    // ponytail: rerank / rewriteQuery accepted and ignored until phase 2 adds the reranker + LLM.
    return c.json(await search(n, body));
  });

  app.get("/ns/:namespace/memories/:id", async (c) => {
    const n = ns(c);
    const [m] = await sql`select * from memories where ns = ${n} and id = ${c.req.param("id")}`;
    if (!m) return c.json({ error: "Memory not found" }, 404);
    const include = (c.req.queries("include") ?? []).flatMap((s) => s.split(","));
    const limit = z.coerce.number().int().min(1).max(100).default(10).parse(c.req.query("relatedLimit"));
    const out: Record<string, any> = memoryJson(m);
    const included: Record<string, unknown> = {};
    if (!include.length || include.includes("related")) included.related = (await related([m.pk], limit)).get(m.pk);
    if ((!include.length || include.includes("document")) && m.source_document_pk) {
      const [d] = await sql`select * from documents where pk = ${m.source_document_pk}`;
      if (d) included.document = { id: d.id, title: d.title, type: d.type, metadata: d.metadata, summary: null,
        system: { createdAt: iso(d.created_at), updatedAt: iso(d.updated_at) } };
    }
    out.included = included;
    return c.json(out);
  });

  // Soft forget: the memory stays (retrievable with include.forgotten) but drops out of search and profiles.
  app.delete("/ns/:namespace/memories", async (c) => {
    const n = ns(c);
    const { ids } = z.object({ ids: z.array(z.string().min(1)).min(1).max(500) }).strict().parse(await c.req.json());
    const rows = await sql`update memories set is_forgotten = true, forget_reason = 'forgotten by id', updated_at = now()
      where ns = ${n} and id in ${sql(ids)} returning pk, id, content`;
    await logEvents(rows.map((r: any) => ({ memoryPk: r.pk, action: "forget", actor: "api", reason: "forgotten by id" })));
    const found = new Set(rows.map((r: any) => r.id));
    return c.json({
      count: rows.length,
      errors: ids.filter((i) => !found.has(i)).map((id) => ({ id, error: "not found" })),
      matches: rows.map((r: any) => ({ id: r.id, memory: r.content })),
    });
  });

  app.delete("/ns/:namespace/memories/semantic", async (c) => {
    const n = ns(c);
    const { query, dryRun } = z.object({ query: z.string().min(1).max(2000), dryRun: z.boolean() }).strict().parse(await c.req.json());
    return c.json(await forgetSemantic(n, query, dryRun));
  });

  app.post("/ns/:namespace/memories/:id/restore", async (c) => {
    const [m] = await sql`update memories set is_forgotten = false, forget_reason = null, forget_after = null, updated_at = now()
      where ns = ${ns(c)} and id = ${c.req.param("id")} returning *`;
    if (!m) return c.json({ error: "Memory not found" }, 404);
    await logEvents([{ memoryPk: m.pk, action: "restore", actor: "api" }]);
    return c.json(memoryJson(m));
  });

  // Inferred-memory review (not in v5; v3 had it): approve keeps it as a trusted fact, decline forgets it.
  app.post("/ns/:namespace/memories/:id/review", async (c) => {
    const n = ns(c);
    const { action } = z.object({ action: z.enum(["approve", "decline"]) }).strict().parse(await c.req.json());
    const [m] = action === "approve"
      ? await sql`update memories set is_inference = false, status = 'active', updated_at = now()
          where ns = ${n} and id = ${c.req.param("id")} and is_inference returning *`
      : await sql`update memories set is_forgotten = true, forget_reason = 'declined in review', status = 'rejected', updated_at = now()
          where ns = ${n} and id = ${c.req.param("id")} and is_inference returning *`;
    if (!m) return c.json({ error: "Inferred memory not found" }, 404);
    await logEvents([{ memoryPk: m.pk, action: action === "approve" ? "approve" : "reject", actor: "user", reason: "inference review" }]);
    await sql`update review_items set status = ${action === "approve" ? "approved" : "rejected"}, resolved_at = now()
      where memory_pk = ${m.pk} and kind = 'inference' and status = 'open'`;
    return c.json(memoryJson(m));
  });

  app.post("/ns/:namespace/profile", async (c) => {
    const n = ns(c);
    const body = z.object({ filter: filterSchema.optional() }).strict().parse(await c.req.json().catch(() => ({})));
    return c.json(await profile(n, body.filter));
  });

  const bucketName = z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/);
  app.get("/ns/:namespace/profile/buckets", async (c) => c.json({ buckets: await buckets(ns(c)) }));
  app.put("/ns/:namespace/profile/buckets", async (c) => {
    const n = ns(c);
    const body = z.object({ buckets: z.record(bucketName, z.string().max(2000)) }).strict().parse(await c.req.json());
    await ensureNs(n);
    for (const [name, description] of Object.entries(body.buckets)) {
      if (name in BUILTIN_BUCKETS) continue; // built-ins are protected
      await sql`insert into profile_buckets (ns, name, description) values (${n}, ${name}, ${description})
        on conflict (ns, name) do update set description = excluded.description`;
    }
    return c.json({ buckets: await buckets(n) });
  });
  app.delete("/ns/:namespace/profile/buckets", async (c) => {
    const n = ns(c);
    const body = z.object({ buckets: z.array(bucketName).min(1).max(50) }).strict().parse(await c.req.json());
    await sql`delete from profile_buckets where ns = ${n} and name in ${sql(body.buckets)}`;
    await sql`update memories set bucket = null where ns = ${n} and bucket in ${sql(body.buckets)}`;
    return c.json({ buckets: await buckets(n) });
  });

  const listQuery = z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(1100).default(10),
    order: z.enum(["asc", "desc"]).default("desc"),
  });
  const listBody = z.object({
    filter: filterSchema.optional(),
    include: z.object({ content: z.boolean().default(false), memoryCount: z.boolean().default(true), forgotten: z.boolean().default(false) }).partial().optional(),
  }).strict();

  app.post("/ns/:namespace/list/:type", async (c) => {
    const n = ns(c);
    const type = z.enum(["documents", "chunks", "memories"]).parse(c.req.param("type"));
    const q = listQuery.parse(c.req.query());
    const body = listBody.parse(await c.req.json().catch(() => ({})));
    const params: unknown[] = [n, q.limit, (q.page - 1) * q.limit];
    const where = body.filter ? `and ${compileFilter(body.filter, "d.metadata", params)}` : "";
    const dir = q.order === "asc" ? "asc" : "desc";
    if (type === "memories") {
      const live = (body.include?.forgotten ? "m.is_latest" : LIVE()) + (c.req.query("inference") === "true" ? " and m.is_inference" : "");
      const rows = await sql.unsafe(`select m.*, count(*) over () as total from memories m where m.ns = $1 and ${live}
        ${where.replaceAll("d.metadata", "m.metadata")} order by m.updated_at ${dir} limit $2 offset $3`, params);
      return c.json({ memories: rows.map(memoryJson), pagination: page(q, Number(rows[0]?.total ?? 0)) });
    }
    if (type === "documents") {
      const rows = await sql.unsafe(`select d.*, count(*) over () as total,
          (select count(*)::int from memories m where m.source_document_pk = d.pk and ${LIVE()}) as memory_count
        from documents d where d.ns = $1 ${where} order by d.created_at ${dir} limit $2 offset $3`, params);
      return c.json({
        documents: rows.map((r: any) => ({ ...docJson(r, !!body.include?.content), system: { ...docJson(r).system, memoryCount: r.memory_count } })),
        pagination: page(q, Number(rows[0]?.total ?? 0)),
      });
    }
    const rows = await sql.unsafe(`select c.id, c.position, c.content, c.created_at, d.id as doc_id, d.metadata,
        count(*) over () as total from chunks c join documents d on d.pk = c.document_pk where c.ns = $1 ${where}
        order by c.created_at ${dir}, c.position limit $2 offset $3`, params);
    return c.json({
      chunks: rows.map((r: any) => ({
        id: String(r.id), position: r.position, content: r.content, type: "text", metadata: r.metadata,
        documentId: r.doc_id, system: { createdAt: iso(r.created_at) },
      })),
      pagination: page(q, Number(rows[0]?.total ?? 0)),
    });
  });

  const nsList = async (c: Context) => {
    const q = listQuery.parse(c.req.query());
    const rows = await sql`
      select n.*, (select count(*)::int from documents d where d.ns = n.id) as doc_count,
        (select count(*)::int from memories m where m.ns = n.id and m.is_latest and not m.is_forgotten) as mem_count,
        count(*) over () as total
      from namespaces n order by n.created_at desc limit ${q.limit} offset ${(q.page - 1) * q.limit}`;
    return c.json({
      namespaces: rows.map((r: any) => ({
        id: r.id, namespace: r.id, description: r.supporting_context, documentCount: r.doc_count, memoryCount: r.mem_count,
        system: { createdAt: iso(r.created_at), updatedAt: iso(r.updated_at) },
      })),
      pagination: page(q, Number(rows[0]?.total ?? 0)),
    });
  };
  app.get("/ns", nsList);
  app.get("/namespaces", nsList);

  // Graph for the UI: non-forgotten memories (old versions too, so update chains show) + their documents.
  app.get("/ns/:namespace/graph", async (c) => {
    const n = ns(c);
    const limit = z.coerce.number().int().min(1).max(2000).default(300).parse(c.req.query("limit"));
    const mems = await sql`select pk, id, content, kind, is_latest, is_inference, version, created_at, source_document_pk
      from memories where ns = ${n} and not is_forgotten order by updated_at desc limit ${limit}`;
    const pks = mems.map((m: any) => m.pk);
    const docPks = [...new Set(mems.map((m: any) => m.source_document_pk).filter(Boolean))];
    const [docs, edges] = await Promise.all([
      docPks.length ? sql`select pk, id, title, type, raw, created_at from documents where pk in ${sql(docPks)}` : [],
      pks.length ? sql`select e.rel, s.id as src, d.id as dst from memory_edges e join memories s on s.pk = e.src join memories d on d.pk = e.dst
        where e.src in ${sql(pks)} and e.dst in ${sql(pks)}` : [],
    ]);
    const docId = new Map(docs.map((d: any) => [d.pk, `doc:${d.id}`]));
    return c.json({
      nodes: [
        ...docs.map((d: any) => ({ id: `doc:${d.id}`, type: "document", label: d.title ?? d.raw.slice(0, 80), kind: d.type, createdAt: iso(d.created_at) })),
        ...mems.map((m: any) => ({ id: m.id, type: "memory", label: m.content, isLatest: m.is_latest, isInference: m.is_inference,
          isForgotten: false, kind: m.kind, version: m.version, createdAt: iso(m.created_at) })),
      ],
      edges: [
        ...edges.map((e: any) => ({ source: e.src, target: e.dst, relation: e.rel })),
        ...mems.filter((m: any) => docId.has(m.source_document_pk)).map((m: any) => ({ source: m.id, target: docId.get(m.source_document_pk), relation: "source" })),
      ],
    });
  });

  // v2 extensions (not in v5). Editing a memory pins it: dreaming never supersedes a pinned memory on its own.
  app.patch("/ns/:namespace/x/memories/:id", async (c) => {
    const n = ns(c);
    const body = z.object({ content: z.string().min(1).max(2000).optional(), pinned: z.boolean().optional() }).strict()
      .refine((b) => b.content !== undefined || b.pinned !== undefined, { message: "content or pinned is required" }).parse(await c.req.json());
    const [old] = await sql`select pk, content, pinned from memories where ns = ${n} and id = ${c.req.param("id")}`;
    if (!old) return c.json({ error: "Memory not found" }, 404);
    const pinned = body.pinned ?? true;
    const vec = body.content !== undefined ? toVector((await embed([body.content]))[0]) : null;
    const [m] = await sql`update memories set content = coalesce(${body.content ?? null}, content), pinned = ${pinned},
        embedding = coalesce(${vec}::vector, embedding), speaker = case when ${body.content !== undefined} then 'user' else speaker end,
        updated_at = now()
      where pk = ${old.pk} returning *`;
    await logEvents([{ memoryPk: old.pk, action: "edit", actor: "user", before: { content: old.content, pinned: old.pinned }, after: { content: m.content, pinned } }]);
    return c.json({ ...memoryJson(m), pinned: m.pinned });
  });

  app.patch("/ns/:namespace/x/settings", async (c) => {
    const n = ns(c);
    const body = z.object({ injectSensitive: z.boolean() }).strict().parse(await c.req.json());
    await ensureNs(n);
    await sql`update namespaces set inject_sensitive = ${body.injectSensitive}, updated_at = now() where id = ${n}`;
    return c.json({ injectSensitive: body.injectSensitive });
  });

  mountChat(app, apiKey);
  mountLegacy(app, apiKey);
  mountMcp(app, apiKey);
  return app;
}

const page = (q: { page: number; limit: number }, total: number) => ({
  currentPage: q.page, limit: q.limit, totalItems: total, totalPages: Math.ceil(total / q.limit),
});
