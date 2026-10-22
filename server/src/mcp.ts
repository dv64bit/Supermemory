// MCP endpoint with upstream supermemory's tool names, so prompts/instructions written for it carry over.
// Stateless: a fresh server + transport per request. Tools call our own v5 routes in-process (no logic duplicated).
import type { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { sql } from "./db";

const DEFAULT_SPACE = process.env.SUPERMEM_DEFAULT_SPACE ?? "sm_project_default";
const nsSchema = z.string().max(100).regex(/^[a-zA-Z0-9_:-]+$/).optional()
  .describe("Space (namespace) to use. Omit to use the active space; resolve names with list_spaces.");

async function activeSpace() {
  const [row] = await sql`select value from settings where key = 'active_space'`;
  return (row?.value as string) ?? DEFAULT_SPACE;
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

function buildServer(call: (method: string, path: string, body?: unknown) => Promise<any>) {
  const server = new McpServer({ name: "supermem", version: "0.1.0" });
  const space = async (ns?: string) => ns ?? (await activeSpace());
  const ro = { readOnlyHint: true };

  server.registerTool("search_memory", {
    description: "Search memories in one space with a natural-language query. Returns matching memories (with IDs for forget_memory) and source document IDs (for get_document). For who-the-user-is, call get_profile.",
    inputSchema: { query: z.string().min(1).max(1000), namespace: nsSchema },
    annotations: ro,
  }, async ({ query, namespace }) => {
    const ns = await space(namespace);
    const res = await call("POST", `/ns/${ns}/search`, { query, searchMode: "memories", limit: 10, include: { documents: true } });
    if (!res.results?.length) return text(`No matching memories found in "${ns}".`);
    return text(["## Matching memories", ...res.results.map((r: any) =>
      `- ${r.id} [${Math.round(r.similarity * 100)}%] ${r.memory}${r.included?.document ? ` (document: ${r.included.document.id})` : ""}`)].join("\n"));
  });

  server.registerTool("get_profile", {
    description: "Get the standing profile of the user for a space: durable facts (static), recent context (dynamic) and topical buckets. Call at the start of a conversation.",
    inputSchema: { namespace: nsSchema },
    annotations: ro,
  }, async ({ namespace }) => {
    const ns = await space(namespace);
    const { profile } = await call("POST", `/ns/${ns}/profile`, {});
    const list = (xs: any[]) => (xs.length ? xs.map((m) => `- ${m.memory}`).join("\n") : "- (none)");
    const buckets = Object.entries(profile.buckets as Record<string, any[]>).filter(([, v]) => v.length)
      .map(([k, v]) => `## ${k}\n${list(v)}`);
    return text([`# Profile (${ns})`, `## Static\n${list(profile.static)}`, `## Dynamic\n${list(profile.dynamic)}`, ...buckets].join("\n\n"));
  });

  server.registerTool("add_memory", {
    description: "Save something worth remembering (a fact, preference, decision or note, or a URL to ingest) in the active space. To remove outdated information use forget_memory.",
    inputSchema: { content: z.string().min(1).max(200_000), namespace: nsSchema },
  }, async ({ content, namespace }) => {
    const ns = await space(namespace);
    const res = await call("POST", `/ns/${ns}/document`, { content, metadata: { source: "mcp" } });
    return text(`Saved (document ID: ${res.id}, space: ${ns}). Memories form in the background.`);
  });

  server.registerTool("forget_memory", {
    description: "Forget memories by ID (find them with search_memory). If only content is given, the closest memories are listed so you can pick IDs; nothing is forgotten.",
    inputSchema: { ids: z.array(z.string().min(1)).min(1).max(100).optional(), content: z.string().max(2000).optional(), namespace: nsSchema },
  }, async ({ ids, content, namespace }) => {
    const ns = await space(namespace);
    if (ids?.length) {
      const res = await call("DELETE", `/ns/${ns}/memories`, { ids });
      return text(`Forgot ${res.count} memor${res.count === 1 ? "y" : "ies"}.${res.errors.length ? ` Not found: ${res.errors.map((e: any) => e.id).join(", ")}` : ""}`);
    }
    if (!content) return text("Pass ids (from search_memory) or content.");
    const res = await call("POST", `/ns/${ns}/search`, { query: content, searchMode: "memories", limit: 5, threshold: 0 });
    return text(["Nothing was forgotten yet. Closest memories:", ...res.results.map((r: any) => `- ${r.id} [${Math.round(r.similarity * 100)}%] ${r.memory}`),
      "Call forget_memory again with the ids to forget."].join("\n"));
  });

  server.registerTool("list_documents", {
    description: "List documents saved in a space, newest first.",
    inputSchema: { page: z.number().int().min(1).default(1), limit: z.number().int().min(1).max(50).default(20), namespace: nsSchema },
    annotations: ro,
  }, async ({ page, limit, namespace }) => {
    const ns = await space(namespace);
    const res = await call("POST", `/ns/${ns}/list/documents?page=${page}&limit=${limit}`, {});
    return text(res.documents.map((d: any) => `- ${d.id} [${d.type}, ${d.system.status}, ${d.system.memoryCount} memories] ${d.title ?? ""}`).join("\n")
      + `\n(page ${res.pagination.currentPage}/${Math.max(1, res.pagination.totalPages)})`);
  });

  server.registerTool("get_document", {
    description: "Get a document's full content and the memories extracted from it.",
    inputSchema: { documentId: z.string().min(1), namespace: nsSchema },
    annotations: ro,
  }, async ({ documentId, namespace }) => {
    const ns = await space(namespace);
    const d = await call("GET", `/ns/${ns}/document/${encodeURIComponent(documentId)}?include=memories`);
    if (d.error) return text(d.error);
    return text([`# ${d.title ?? d.id} (${d.type}, ${d.system.status})`, d.content ?? "", "## Memories",
      ...(d.memories ?? []).map((m: any) => `- ${m.id} ${m.memory}`)].join("\n\n"));
  });

  server.registerTool("list_memories", {
    description: "List the latest memories in a space, most recently updated first.",
    inputSchema: { page: z.number().int().min(1).default(1), limit: z.number().int().min(1).max(100).default(30), namespace: nsSchema },
    annotations: ro,
  }, async ({ page, limit, namespace }) => {
    const ns = await space(namespace);
    const res = await call("POST", `/ns/${ns}/list/memories?page=${page}&limit=${limit}`, {});
    return text(res.memories.map((m: any) => `- ${m.id}${m.isInference ? " [inferred]" : ""} ${m.memory}`).join("\n") || "No memories yet.");
  });

  server.registerTool("list_spaces", {
    description: "List spaces (namespaces) with document and memory counts, and which one is active.",
    inputSchema: {},
    annotations: ro,
  }, async () => {
    const [res, active] = await Promise.all([call("GET", `/ns?limit=100`), activeSpace()]);
    return text(res.namespaces.map((n: any) => `- ${n.id}${n.id === active ? " (active)" : ""}: ${n.documentCount} documents, ${n.memoryCount} memories`).join("\n")
      || `No spaces yet. Active space: ${active}`);
  });

  server.registerTool("select_space", {
    description: "Set the active space used when a tool call omits namespace.",
    inputSchema: { namespace: z.string().max(100).regex(/^[a-zA-Z0-9_:-]+$/) },
  }, async ({ namespace }) => {
    await sql`insert into settings (key, value) values ('active_space', ${namespace}) on conflict (key) do update set value = excluded.value`;
    return text(`Active space is now "${namespace}".`);
  });

  server.registerTool("who_am_i", {
    description: "Describe this memory server and the active space.",
    inputSchema: {},
    annotations: ro,
  }, async () => text(`Personal supermem server (single user). Active space: ${await activeSpace()}.`));

  server.registerResource("profile", "supermemory://profile", { mimeType: "application/json", description: "Profile of the active space" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await call("POST", `/ns/${await activeSpace()}/profile`, {})) }] }));
  server.registerResource("spaces", "supermemory://spaces", { mimeType: "application/json", description: "All spaces" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await call("GET", `/ns?limit=100`)) }] }));

  server.registerPrompt("context", { description: "Load the user's profile from the active space as conversation context." }, async () => {
    const ns = await activeSpace();
    const { profile } = await call("POST", `/ns/${ns}/profile`, {});
    const facts = [...profile.static, ...profile.dynamic].map((m: any) => `- ${m.memory}`).join("\n") || "- (nothing yet)";
    return { messages: [{ role: "user", content: { type: "text", text: `What you know about me (space "${ns}"):\n${facts}` } }] };
  });

  return server;
}

export function mountMcp(app: Hono, apiKey: string) {
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    return res.json();
  };
  app.all("/mcp", async (c) => {
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await buildServer(call).connect(transport);
    return transport.handleRequest(c.req.raw);
  });
}
