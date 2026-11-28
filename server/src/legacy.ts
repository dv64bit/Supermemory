// Thin v3/v4 adapters over the v5 routes, for older clients (the browser extension, older plugins).
// Only the shapes those clients actually send/read are covered.
import type { Hono } from "hono";
import { z } from "zod";

const DEFAULT_PROJECT = "sm_project_default";
const tag = z.string().max(100).regex(/^[a-zA-Z0-9_:-]+$/);

// v3 metadata allowed anything; v5 takes string | number | boolean | string[]. Coerce the rest to JSON strings.
const toV5Meta = (m: Record<string, unknown> = {}) => Object.fromEntries(Object.entries(m).filter(([, v]) => v != null).map(([k, v]) => [k,
  typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v
    : Array.isArray(v) && v.every((x) => typeof x === "string") ? v : JSON.stringify(v)]));

const v3Doc = z.object({
  content: z.string().min(1),
  containerTag: tag.optional(),
  containerTags: z.array(tag).optional(),
  customId: z.string().min(1).max(255).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).passthrough();
const nsOf = (d: { containerTag?: string; containerTags?: string[] }) => d.containerTags?.[0] ?? d.containerTag ?? DEFAULT_PROJECT;

export function mountLegacy(app: Hono, apiKey: string) {
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: await res.json() };
  };

  app.get("/v3/projects", async (c) => {
    const { body } = await call("GET", "/ns?limit=1100");
    return c.json({
      projects: body.namespaces.map((n: any) => ({
        id: n.id, name: n.id, containerTag: n.id, documentCount: n.documentCount,
        createdAt: n.system.createdAt, updatedAt: n.system.updatedAt,
      })),
    });
  });

  app.post("/v3/documents", async (c) => {
    const d = v3Doc.parse(await c.req.json());
    const r = await call("POST", `/ns/${nsOf(d)}/document`, { content: d.content, id: d.customId, metadata: toV5Meta(d.metadata) });
    return c.json(r.body, r.status as 200);
  });

  app.post("/v3/documents/batch", async (c) => {
    const body = z.object({ documents: z.array(v3Doc).min(1).max(600), metadata: z.record(z.string(), z.unknown()).optional() })
      .passthrough().parse(await c.req.json());
    // v5 batches are per namespace; group v3 documents by their first container tag.
    const groups = new Map<string, typeof body.documents>();
    for (const d of body.documents) groups.set(nsOf(d), [...(groups.get(nsOf(d)) ?? []), d]);
    const results: unknown[] = [];
    let failed = 0;
    for (const [ns, docs] of groups) {
      const r = await call("POST", `/ns/${ns}/document/batch`, {
        documents: docs.map((d) => ({ content: d.content, id: d.customId, metadata: toV5Meta({ ...body.metadata, ...d.metadata }) })),
      });
      if (r.status !== 200) return c.json(r.body, r.status as 400);
      results.push(...r.body.results);
      failed += r.body.failed;
    }
    return c.json({ results, count: results.length - failed, failed });
  });

  app.post("/v4/search", async (c) => {
    const b = z.object({
      q: z.string().min(1),
      containerTag: tag.optional(),
      limit: z.number().int().min(1).max(100).optional(),
      // ponytail: v4 defaulted to 0.6; our embedding scale differs, so the v5 default (0.3) is used unless sent.
      threshold: z.number().min(0).max(1).optional(),
      include: z.object({ relatedMemories: z.boolean().optional(), documents: z.boolean().optional(), forgottenMemories: z.boolean().optional() }).passthrough().optional(),
    }).passthrough().parse(await c.req.json());
    const started = performance.now();
    const r = await call("POST", `/ns/${b.containerTag ?? DEFAULT_PROJECT}/search`, {
      query: b.q, searchMode: "memories", limit: b.limit ?? 10, ...(b.threshold !== undefined && { threshold: b.threshold }),
      include: { related: !!b.include?.relatedMemories, documents: !!b.include?.documents, forgotten: !!b.include?.forgottenMemories },
    });
    if (r.status !== 200) return c.json(r.body, r.status as 400);
    return c.json({ results: r.body.results, total: r.body.results.length, timing: Math.round(performance.now() - started) });
  });

  // v4 profile, optionally with search results for `q` in the same call (what /v5 profile dropped).
  app.post("/v4/profile", async (c) => {
    const b = z.object({
      containerTag: tag,
      q: z.string().min(1).optional(),
      threshold: z.number().min(0).max(1).optional(),
      include: z.array(z.enum(["static", "dynamic", "buckets"])).optional(),
      buckets: z.array(z.string()).optional(),
    }).passthrough().parse(await c.req.json());
    const started = performance.now();
    const [p, s] = await Promise.all([
      call("POST", `/ns/${b.containerTag}/profile`, b.buckets ? { buckets: b.buckets } : {}),
      b.q ? call("POST", `/ns/${b.containerTag}/search`, { query: b.q, searchMode: "memories", limit: 10, ...(b.threshold !== undefined && { threshold: b.threshold }) }) : null,
    ]);
    if (p.status !== 200) return c.json(p.body, p.status as 400);
    if (s && s.status !== 200) return c.json(s.body, s.status as 400);
    const want = (k: "static" | "dynamic" | "buckets") => !b.include || b.include.includes(k);
    const strings = (xs: { memory: string }[]) => xs.map((m) => m.memory);
    const profile = {
      ...(want("static") && { static: strings(p.body.profile.static) }),
      ...(want("dynamic") && { dynamic: strings(p.body.profile.dynamic) }),
      ...(want("buckets") && { buckets: Object.fromEntries(Object.entries(p.body.profile.buckets as Record<string, { memory: string }[]>).map(([k, v]) => [k, strings(v)])) }),
    };
    return c.json({
      profile,
      ...(s && {
        searchResults: {
          results: s.body.results.map((r: any) => ({ id: r.id, memory: r.memory, metadata: r.metadata ?? null, updatedAt: r.system.updatedAt, similarity: r.similarity })),
          total: s.body.results.length,
          timing: Math.round(performance.now() - started),
        },
      }),
    });
  });
}
