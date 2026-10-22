# Personal Supermemory rebuild: plan

Researched 2026-10-22. Sources: REA browser capture of supermemory.ai (/, /product, /pricing, app.supermemory.ai), the live OpenAPI specs (`api.supermemory.ai/v4/openapi`, `/v5/openapi`), docs `llms-full.txt`, and the GitHub repo (MIT). Copies of the specs and docs are in `./ref/`.

## 0. What the product actually is

| Layer | What it is | Open? |
|---|---|---|
| Marketing site | Astro on Cloudflare. PostHog analytics proxied through `api.supermemory.ai/orange` | n/a |
| Memory engine and API | Ingest → extract → chunk → embed → "dream" (atomic memories plus a relation graph) → hybrid search, profiles, forgetting | **Closed.** You rebuild this. |
| API | v5 `/ns/{namespace}/...`; v3/v4 legacy still served | Spec is public (`ref/v5.json`), so you can clone the shape |
| MCP server | Cloudflare Worker with OAuth and Durable Objects (`apps/mcp`) | **MIT**, fork it |
| Memory graph UI | React + d3-force (`packages/memory-graph`) | **MIT**, fork it |
| AI SDK tools | `withSupermemory` middleware and `supermemoryTools` (`packages/tools`) | **MIT**, point at your `baseUrl` |
| Consumer app | Notes, links, files, chat ("Nova"), spaces, graph, timeline, review queue. Removed from the repo on 2026-09-07; app.supermemory.ai now redirects to console.supermemory.ai | **MIT** at commit `4d8a4ebf`, fork it |
| Browser extension | WXT + React. Save button and auto-recall inside ChatGPT, Claude, Gemini, Grok and X; Twitter bookmarks import | **MIT** at commit `4d8a4ebf` |
| Connectors | Drive, Gmail, Notion, OneDrive, GitHub, Granola, S3, web crawler. Webhooks plus a 4-hour cron | Closed, rebuild |
| Coding plugins | claude-supermemory, cursor-supermemory and others (separate repos). They talk to the API | Open, point at your `baseUrl` |

**Key strategy: clone the v5 API shape exactly.** Then the official SDKs (`npm i supermemory`, `pip install supermemory`), `@supermemory/tools`, the forked MCP server, the extension and the coding plugins all work by changing `baseURL`. Your own work then shrinks to the closed parts: the engine and the connectors.

**Check before building:** "Supermemory local" (`npx supermemory local`, Docker `supermemory/supermemory:0.0.9`) is free within its lite license and speaks the same API. It covers the engine but not connectors or MCP. Run it as a reference oracle to diff your engine's output against, or use it outright and build only the missing parts.

## 1. Stack (single box, docker-compose)

- **Runtime:** Bun + TypeScript, Hono (same as upstream). One process for the API and one for the worker.
- **DB:** Postgres 17 with `pgvector` (HNSW cosine) and `tsvector` full-text search. A single store holds docs, chunks, memories, edges and jobs. No separate graph DB: edges go in a table, and a recursive CTE covers personal scale.
- **Queue:** `pg-boss` (on Postgres). Skipped Redis; add it if throughput ever matters.
- **Embeddings:** local `bge-base-en-v1.5` (768d) through `@huggingface/transformers` (ONNX). Matches upstream and is free. Swap to `bge-m3` for multilingual (the dimension locks once data exists).
- **LLM:** any OpenAI-compatible endpoint (Ollama, OpenRouter, Anthropic via its compat layer). Used for extraction, relations, profile, query rewrite and semantic forget.
- **Reranker:** `bge-reranker-base` (ONNX, local).
- **Extractors:**
  - URLs: `@mozilla/readability` + `jsdom`
  - PDFs: `unpdf`
  - Office files: `officeparser`
  - Images: a vision LLM call
  - Audio and video: `whisper.cpp` / faster-whisper
  - Tweets and YouTube: oEmbed plus transcript
- **Auth:** one static API key in `.env` (personal use). Skipped better-auth and orgs; add them only if you share with others.
- **Web app:** Next.js, forked from the old `apps/web` and trimmed (billing, orgs and "company brain" removed).

## 2. Data model

```sql
namespaces(id text pk, supporting_context text, created_at)
documents(id text pk, ns text, custom_id text, content text, url text, type text,
          status text,              -- queued|extracting|chunking|embedding|indexing|done|failed
          metadata jsonb, doc_date timestamptz, content_hash text, created_at, updated_at,
          unique(ns, custom_id))
chunks(id, document_id, ns, idx int, content text, embedding vector(768), fts tsvector)
memories(id, ns, content text, embedding vector(768), fts tsvector,
         kind text,                 -- fact|preference|episode
         is_latest bool, is_inference bool, is_forgotten bool,
         forget_after timestamptz, forget_reason text,
         strength real,             -- preferences strengthen on repeat; episodes decay
         version int, root_id uuid, -- version chain
         metadata jsonb, temporal_context jsonb, source_document_id, created_at, updated_at)
memory_edges(src uuid, dst uuid, rel text)   -- updates|extends|derives
profiles(ns pk, static jsonb, dynamic jsonb, buckets jsonb, built_at)
profile_buckets(ns, name, description)
connectors(id, ns, provider, config jsonb, tokens jsonb /*encrypted*/, document_limit, cursor jsonb, last_sync_at)
```

## 3. Engine pipeline (the actual work)

Ingest job, one per document, run **sequentially per namespace** (order decides which fact "came first"):

1. **Extract:** produce text by type. Store `content_hash`. If an existing `custom_id` has the same hash, stop there (this is upstream's "diff billing" behaviour: unchanged content is a no-op).
2. **Chunk:** structure-aware. Markdown splits by heading and keeps code fences whole. Prose splits on sentence boundaries with about 200 characters of overlap. Code splits by top-level symbols (tree-sitter, later). Optionally add contextual chunking: an LLM writes a one-line document context that is prepended to each chunk before embedding.
3. **Embed and index** the chunks. Set `status=done`. Search over chunks works from here.
4. **Dream** (memory formation, async after done; `dreaming: instant` runs it inline):
   1. The LLM extracts atomic, self-contained facts, each with `kind`, from the document plus `supporting_context` plus `doc_date`.
   2. For each candidate, take the top-k similar latest memories in the namespace (vector + FTS).
   3. A second LLM call classifies each candidate against those neighbours: `new | duplicate | updates(id) | extends(id)`.
      - **Duplicate:** bump `strength` (this is how preferences strengthen) and drop the candidate.
      - **Updates:** insert the new memory, set `is_latest=false` on the old one, add an `updates` edge.
      - **Extends:** insert the new memory plus an `extends` edge.
   4. A **derive** pass over the touched cluster: the LLM proposes inferences. Insert them with `is_inference=true` and `derives` edges. They go to the review queue (approve clears the flag; decline forgets the memory).
   5. Temporary facts ("exam tomorrow") get `forget_after` set from `doc_date`.
5. **Cron (hourly):**
   - Soft-forget memories past `forget_after`.
   - Decay episode `strength`; below a threshold, set `is_forgotten`.
   - Rebuild profiles for namespaces that changed.

ponytail: no decay formula is published upstream. Start with `strength *= 0.98/day` for episodes and tune it against your own data.

**Profile:** the LLM summarises the latest non-forgotten memories into `static` (stable facts) and `dynamic` (recent state), plus custom buckets. The result is cached in `profiles` and rebuilt on change, so reads are a single row fetch.

**Search (`POST /ns/{ns}/search`):**
- `chunks`, `memories` or `hybrid` mode. Hybrid runs a vector query and an FTS query, then merges with RRF.
- Filter on `is_latest AND NOT is_forgotten` unless `include.forgotten` is set.
- Apply `threshold`, and the metadata filter tree compiled to SQL over `jsonb`. The operators are `eq`, `neq`, `gt(e)`, `lt(e)`, `contains`, `notContains`, `arrayContains`, `arrayNotContains`, combined with `and`/`or`.
- Options:
  - `rerank=order`: cross-encoder.
  - `rerank=aggregate`: LLM merges results.
  - `rewriteQuery`: LLM writes 3 rewrites, search each in parallel, then RRF.
  - `include.related`: 1-hop edges.

**Semantic forget:** search, then the LLM picks matches, with `dryRun` support and a cap from `maxForget`.

## 4. API surface to implement (v5 first)

Must-have, because the SDK, the tools and MCP need them:

```
POST   /ns/{ns}/document            POST /ns/{ns}/document/batch     POST /ns/{ns}/document/file
GET    /ns/{ns}/document/{id}       PATCH /ns/{ns}/document/{id}      DELETE /ns/{ns}/document
POST   /ns/{ns}/search              POST /ns/{ns}/profile             GET|PUT|DELETE /ns/{ns}/profile/buckets
GET    /ns/{ns}/memories/{id}       DELETE /ns/{ns}/memories          DELETE /ns/{ns}/memories/semantic
POST   /ns/{ns}/list/{documents|chunks|memories}
GET    /ns   GET|PATCH|DELETE /ns/{ns}
POST|GET|PATCH|DELETE /ns/{ns}/connectors[/{id}]   POST /ns/{ns}/connectors/{id}/sync
```

Legacy shims, added only when a client needs them (the old extension and the coding plugins may still call v3/v4): `/v3/documents`, `/v3/search`, `/v4/search`, `/v4/profile`, `/v4/memories*`, `/v3/projects`, `/v3/health`. These are thin adapters over the v5 handlers.

**Contract test:** generate Zod types from `ref/v5.json` (`openapi-zod-client`). Run the official `supermemory` npm SDK against your server in one test file. If the SDK passes, the plugins pass too.

## 5. Phases

| # | Deliverable | Done when |
|---|---|---|
| 1 | Postgres schema, `/document` (text and URL), chunk, embed, `/search` in chunks mode | The SDK `add` then `search` round-trips |
| 2 | Dream pipeline (extract, relate, derive), memories and hybrid search, `isLatest` versioning | The "Alex Google → Stripe" example from /product yields `updates` + `extends` + `derives` |
| 3 | Profiles and buckets, forgetting (expiry, decay, semantic), review queue | `/profile` returns static/dynamic; an expired fact vanishes from search |
| 4 | **Fork the MCP server** (`apps/mcp`): replace the CF OAuth with an API-key header and point it at your API. Run it locally (wrangler dev) or port it to plain Hono. Tools: `search_memory`, `add_memory`, `forget_memory`, `get_profile`, `list_documents`, `get_document`, `list_memories`, `list_spaces`, `who_am_i` | Claude Desktop, Claude Code and Cursor can add, search and fetch the profile |
| 5 | **Fork the consumer app** from `4d8a4ebf`: notes (Tiptap), links, uploads, spaces, `memory-graph`, timeline, review modal, chat (AI SDK `useChat` + `withSupermemory`) | Feature parity with the old app.supermemory.ai |
| 6 | Files: PDF, Office, images (vision), audio and video (whisper) | Each type ingests and is searchable |
| 7 | Connectors: Notion, Drive, Gmail (Pub/Sub), GitHub, OneDrive, web crawler, S3, Granola. OAuth apps are your own; the first sync imports everything; webhooks plus a 4-hour cron; `documentLimit` | Edit a Notion page and the memory updates within minutes |
| 8 | **Fork the browser extension** from `4d8a4ebf` and repoint its API base | Save and auto-recall work in ChatGPT and Claude |
| 9 | Coding plugins: set `SUPERMEMORY_*` base URL env vars, or fork claude-supermemory if the URL is hard-coded | Claude Code captures and recalls from your server |
| 10 | Extras: Apple Shortcuts (it is just `POST /document`), Raycast (fork the removed extension), SMFS (FUSE or a `grep` tool over `/list`), X bookmarks import | As needed |

Phases 1–4 give a usable personal memory for your AI tools. Everything after that is UI and coverage.

## 6. Deliberately skipped (personal use)

These cover billing and credits (Autumn), orgs, seats, per-tag access, SOC2/HIPAA, SSO, rate limits, multi-tenant isolation, the analytics proxy, the status page and the marketing site. Add them only if this ever serves more than one user.

## 7. Risks and open questions

- **Extraction quality is the whole product.** Upstream runs tuned proprietary models. Keep a 50-sample eval set from your own notes, and use MemoryBench (open, in their GitHub org) to compare prompts and models.
- **Console UI** (console.supermemory.ai) needs a login, so it was not captured. If you have an account, rerun the REA capture with a session cookie to diff the current UI against the forked `4d8a4ebf` app.
- **Connector OAuth** needs your own Google, Notion and Microsoft apps. Gmail push needs a GCP Pub/Sub topic.
- **Unverified:** Memory Router / "infinite chat" proxy appears deprecated (its docs redirect to the AI SDK page); `withSupermemory` replaces it. Whether a Chrome extension is still published is unknown.
- **Security:** connector tokens must be encrypted at rest (AES-GCM, key in env). Bind the API to localhost or Tailscale; never expose it unauthenticated.
