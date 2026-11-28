# P0 gap report: supermem v1 as built vs PLAN.md / PLAN.v2.md

Audited 2026-10-22. Every source file in `server/` and `web/` was read, along with all six planning docs, `ref/v5.json` and `ref/v4.json`. The tests were run locally (§5). Six of the engine claims below were also checked with a throwaway probe test through the public API; the probe has since been deleted. Each of those claims is marked **[verified]**.

---

## 1. What exists

### Processes

There is a single Bun process, `server/src/index.ts`:

- it runs `migrate()`;
- it starts an in-process worker loop;
- it serves Hono on `127.0.0.1:6767`.

There is no pg-boss, no second worker process and no docker-compose. The web app (`web/`) is a separate Vite dev server on :5173. It proxies `/api` to the API server.

### Modules (`server/src/`)

| File | Role |
|---|---|
| `index.ts` | Bootstrap: API key check, migrate, `startWorker()`, `Bun.serve` |
| `db.ts` | `Bun.SQL` client; `migrate()` = run `schema.sql` (idempotent `create … if not exists` / `add column if not exists`, no versioned migrations) |
| `schema.sql` | Tables `namespaces`, `documents`, `chunks`, `memories`, `memory_edges`, `profile_buckets`, `settings` |
| `app.ts` | All v5 routes, plus custom `/graph`, `/memories/:id/restore`, `/memories/:id/review`. Mounts chat, legacy and MCP |
| `worker.ts` | Polling queue: claims the oldest `queued` doc whose namespace is idle, then runs extract → chunk → embed → index → `dream()`. Hourly `sweep()` in the same loop |
| `extract.ts` | URL → Readability (linkedom). Files: PDF (unpdf), DOCX (mammoth), HTML, md/txt/csv/json/code. Images, audio, xlsx and pptx are rejected |
| `chunk.ts` | Markdown heading split, fence-aware; sentence packing at 1200 chars with 200 overlap; hard split as a fallback |
| `embed.ts` | `Xenova/bge-base-en-v1.5` q8, CLS pooling, query prefix applied to queries only (the PLAN.v2 §1 concern is already handled) |
| `dream.ts` | Memory formation: extract → near-dup check → relate → apply → derive (§4) |
| `memories.ts` | `LIVE` predicate, `memoryJson`, `related()` (1-hop edges), `searchMemories()` (vector + FTS, RRF) |
| `search.ts` | `/search`: chunk and memory retrieval, then a merge by raw cosine |
| `filter.ts` | v5 filter tree, compiled to SQL over jsonb (all 10 operators, depth ≤ 5) |
| `profile.ts` | Profile computed per request from live memories, with **no LLM and no cache table** |
| `forget.ts` | Semantic forget (LLM pick), expiry and episode-decay sweep |
| `llm.ts` | `llmJson()` (OpenAI-compatible, `json_schema` strict, temperature 0) and `llmStream()` for chat |
| `chat.ts` | `POST /chat` SSE: profile + search → system prompt → stream. Saves the transcript as doc `chat-<cid>` |
| `legacy.ts` | `GET /v3/projects`, `POST /v3/documents`, `/v3/documents/batch`, `/v4/search` |
| `mcp.ts` | `/mcp`, stateless streamable HTTP. Ten tools (upstream names + `select_space`), 2 resources, 1 prompt. Written from scratch, **not forked** from `apps/mcp` |

### Data flow, ingest to search

1. `POST /ns/{ns}/document` (`app.ts:106`) runs `upsertDoc` (`app.ts:54`): an upsert on `(ns,id)` with `status='queued'`.
2. `worker.claim()` (`worker.ts:12`) takes the oldest queued doc by **`created_at`** (arrival order), one at a time per namespace.
3. `processOne` (`worker.ts:29`) does the following:
   - `extract`, then a sha256 of the text; same hash with existing chunks is a no-op;
   - `chunk`, `embed` and insert the chunks;
   - set `status='done'` and `dreaming_status='dreaming'`.
4. `runDream` → `dream(pk)` (`dream.ts:88`):
   1. One `extract` LLM call over the **whole document**, capped at 30 candidates.
   2. Embed the candidates.
   3. Fetch neighbours per candidate: vector top-5, sim ≥ 0.55, live memories only.
   4. Candidates at sim ≥ 0.92 to a neighbour are marked duplicate without an LLM call.
   5. One batched `relate` call for the rest.
   6. One transaction applies inserts, supersedes, edges and strength bumps.
   7. A separate `derive` LLM call and transaction.
5. `POST /ns/{ns}/search` (`search.ts:55`):
   - Embed the query (with the prefix).
   - Chunks: vector + FTS → RRF pool, filtered by `threshold OR keyword hit`.
   - Memories: the same over `LIVE()` rows.
   - Merge both lists by **raw cosine similarity** and cut to `limit`.

### Web (`web/`)

React 19 + Vite + react-router + d3-force with affectUI components. It is **not** a fork of upstream `apps/web`.

- **Pages:** Chat (SSE), Memories (+ detail with the version chain), Documents, Graph, Review (inference inbox), Search, Profile, Settings.
- **API usage:** 16 calls, all via `req()` in `web/src/api.ts`. It uses three non-v5 routes: `/chat`, `/ns/{ns}/graph` and `/ns/{ns}/memories/{id}/review`, plus `?inference=true` on `list/memories`.
- **What the UI has no concept of:** pinned, confidence, speaker, provenance quotes and conflicts.

---

## 2. Status against the plans

### PLAN.md (v1)

| § | Item | Status | Evidence |
|---|---|---|---|
| 0 | Clone the v5 shape | partial | Core document/search/profile/memories/list routes exist; 13 spec routes are missing (§3) |
| 1 | Bun + TS + Hono | done | `server/package.json` |
| 1 | Postgres 17 + pgvector HNSW + tsvector | partial | HNSW indexes exist (`schema.sql:43,71`), but queries compute distance over every namespace row in a CTE, so the index is never used (`memories.ts:50`, `search.ts:30`). Runs fine on PG16 + pgvector 0.6 |
| 1 | pg-boss queue, separate worker process | missing (by design) | SQL `for update skip locked` claim loop inside the API process (`worker.ts:12,80`) |
| 1 | Local bge-base embeddings | done | `embed.ts` |
| 1 | Reranker bge-reranker-base | missing | `rerank` accepted and ignored (`app.ts:203`) |
| 1 | Extractors | partial | URL, PDF, DOCX, HTML, text and code are done. Missing: officeparser (xlsx, pptx), OCR, vision, whisper, tweet and YouTube (`extract.ts:30`) |
| 1 | Web app = fork of upstream Next.js app | diverged | Custom Vite app (`web/`) |
| 1 | docker-compose | missing | No compose file; the README uses brew |
| 2 | Data model | partial | Missing tables `profiles` and `connectors`. Missing columns: `temporal_context` and `content_hash` on memories. `documents.content_hash` exists. Memories got `bucket` and the `settings` table was added |
| 3.1 | Extract + content-hash no-op | done | `worker.ts:34-38` |
| 3.2 | Structure-aware chunking | partial | Markdown and prose done; no code-symbol or contextual chunking |
| 3.3 | Embed + index | done | `worker.ts:45-55` |
| 3.4.1–3 | Extract / neighbours / relate (new, dup, updates, extends) | done | `dream.ts`. The plan says one call per candidate; the code already batches into one call |
| 3.4.4 | Derive → review queue | partial | Inferences are inserted live with `is_inference=true`. **They rank in search like any memory**; only the profile excludes them (`profile.ts:31`) |
| 3.4.5 | `forget_after` for temporary facts | done | `dream.ts:83-86,148` |
| 3.5 | Hourly cron: expiry, decay | done | `forget.ts:40`, `worker.ts:88` |
| 3.5 | Profile rebuild on change | n/a | The profile is computed on read, with no cache |
| 3 | Profile = LLM summary, cached | diverged | Ranked lists, no LLM, no `aggregated_` items (`profile.ts:22`) |
| 3 | Search: modes, latest/forgotten gating, threshold, filters | done | `search.ts`, `filter.ts` |
| 3 | Search: rerank order/aggregate, rewriteQuery | missing | `app.ts:203` |
| 3 | Search: include.related | done | `memories.ts:19` |
| 3 | Semantic forget with dryRun and cap | done | `forget.ts:18` (cap 100, fixed) |
| 4 | v5 must-have routes | partial | See §3 |
| 4 | Legacy shims | partial | `/v3/projects`, `/v3/documents(+batch)`, `/v4/search` and `/v3/health` exist. Missing: `/v3/search`, `/v4/profile`, `/v4/memories*` |
| 4 | Zod types generated from `ref/v5.json`, responses validated | missing | Hand-written Zod in `app.ts`; no response validation in tests |
| 5 P1–P3 | Ingest, dream, profiles, forgetting | done (with defects in §4) | Tests pass |
| 5 P4 | MCP | done (rewritten, not forked) | `mcp.ts`, `test/mcp.test.ts` |
| 5 P5 | Consumer app | partial | No notes editor, spaces CRUD, timeline, command palette or PWA |
| 5 P6 | Files | partial | See §1 above |
| 5 P7–P10 | Connectors, extension, plugins, extras | missing | No code |

### PLAN.v2.md

| § | Item | Status | Evidence / note |
|---|---|---|---|
| 0 | Additive-only, extensions under `/ns/{ns}/x/…` | violated today | Existing extensions are outside `/x/`: `/ns/{ns}/graph`, `/memories/{id}/restore`, `/memories/{id}/review`, `/chat`, and `?inference=true` |
| 0 | Oracle (Supermemory local) | missing | Nothing wired up |
| 1 | `embedding_model` column + re-embed job | missing | The dimension is hard-coded at `vector(768)` |
| 1 | Query instruction prefix | **done** | `embed.ts:5,13` |
| 1 | pgvector ≥ 0.8 iterative scan / exact-scan benchmark | n/a today | Queries already do exact scans (the HNSW index is never used). Locally installed pgvector is 0.6.0 |
| 1 | LLM router: roles, per-role config, Zod, repair retry | missing | `llm.ts:6` is one function: one model, no Zod (`JSON.parse` cast, `llm.ts:23`), no retry |
| 1 | LLM cache | missing | — |
| 1 | Prompt files + `PIPELINE_VERSION` | missing | Prompts are string constants (`dream.ts:16,27,34`, `forget.ts:9`) |
| 1 | Secret scanner | missing | Raw text goes to the LLM |
| 2 | Bi-temporal, speaker, subject, confidence, source_span, sensitivity, status, pinned, pipeline_version, dream_run_id | missing | `schema.sql:50-70` |
| 2 | Tables `entities`, `memory_entities`, `memory_events`, `dream_runs`, `llm_calls`, `review_items` | missing | — |
| 2 | Migration framework (forward-only, reversible) | missing | `schema.sql` is one idempotent file |
| 2 | `is_latest` interval invariant | **violated** | Two latest versions can come out of one update chain **[verified]**, §4 |
| 3 | Units, debounce, event-time ordering | missing | Per document, arrival order (`worker.ts:19`); `dynamic` behaves the same as `instant` (`worker.ts:65`) |
| 3 | D0 Guard | missing | — |
| 3 | D1 Extract with speaker/subject/entities/dates/quote | partial | Only `content`, `kind`, `expiresAt` and `bucket` |
| 3 | D2 Ground | missing | — |
| 3 | D3 Entities | missing | — |
| 3 | D4 Neighbours (subject, entity, vector, FTS; cap 30) | partial | Vector top-5 per candidate only |
| 3 | D5 Batched relate | done (shape) | One call; ops are `new/duplicate/updates/extends`, with no confidence and no CONFLICT |
| 3 | D6 Invariants in code | missing | Only target-was-offered validation (`dream.ts:138`) |
| 3 | D7 Apply in one transaction | partial | Apply and derive are separate transactions; no events or review items |
| 3 | D8 Derive (≥ 2 supporters, ≤ 3, `derives` edges, pending) | partial | ≥ 2 and ≤ 3 are enforced in code (`dream.ts:188`); there is no pending status |
| 3 | D9 Incremental profile | n/a | No LLM profile exists to make incremental |
| 3 | `lifecycle.yaml` | missing | Constants in `forget.ts:37-38`, `dream.ts:7-10` |
| 3 | Re-dream | missing | — |
| 4.1–4.6 | Query understanding, entity channel, score blend, rerank, MMR, expansion | missing (except 1-hop `include.related`) | `search.ts` |
| 4.7 | `x/context`; does v5 `/profile` take a query? | missing / **answered** | v5 `POST /profile` accepts only `{filter, buckets}`, no query. **v4 `POST /v4/profile` does** (`q`, `threshold`, returns search results). That is the shape to shim |
| 4.8 | `as_of` | missing | — |
| 5 | E1 extended / E2 / E3 | missing | No `eval/` directory. E1 v1 scenarios exist (§5) |
| 6 | Learner-lite | missing | — |
| 7.1–7.10 | Beyond upstream | missing, except review of inferences (partial 7.2) and the Graph view | — |

---

## 3. API contract vs `ref/v5.json` (spec version 5.0.0, 33 operations)

### Implemented (20 of 33)

- `POST`/`DELETE /ns/{ns}/document`
- `POST document/batch`, `POST document/file`
- `GET`/`PATCH document/{id}`
- `POST search`, `POST profile`
- `GET`/`PUT`/`DELETE profile/buckets`
- `DELETE memories`, `DELETE memories/semantic`, `GET memories/{id}`
- `POST list/{type}`
- `GET /ns`, `GET /namespaces`

### Missing (13)

| Route | Impact |
|---|---|
| `POST`/`PATCH /ns/{ns}/document/file/{id}` | File replace (PRD #20) |
| `GET`/`PATCH`/`DELETE /ns/{ns}` (`moveTo`) | **Namespace `supportingContext` cannot be set through any API** (PRD #14, #64, #65) |
| `POST /ns/{ns}/list/documents/memory-counts` | Small |
| `GET /connectors`, and `POST`/`GET`/`PATCH`/`DELETE /ns/{ns}/connectors[/{id}]`, `POST …/sync` (6 ops) | Phase 7 |
| `GET`/`PATCH /organization`, `POST /feedback` | Out of scope (single user); could be stubs |

### Shape mismatches (all **[verified]** through the API)

1. **`POST /profile` rejects `buckets`.** The spec allows `buckets: string[]` (select sections). The server's `.strict()` schema returns **400** (`app.ts:265`). An SDK call with `buckets` fails.
2. **`GET /memories/{id}?include=documents` returns no document.** The spec enum is `related|documents`; the code checks `"document"` (singular, `app.ts:216`). The document is only included when `include` is omitted.
3. **Chunk results in `/search` lack `isLatest` and `isInference`.** The spec marks both as required on every result. Chunk hits return `{id, chunk, similarity, metadata, system}` (`search.ts:62`).
4. **`list/{type}?sort=` is ignored.** The spec offers `createdAt|updatedAt|position`. Memories always sort by `updated_at` and documents by `created_at` (`app.ts:311,317`).
5. **The `list` limit max is 1100; the spec says 100** (`app.ts:292`). This is lenient, not breaking.
6. **Multipart `group`, `fileType` and `mimeType` are dropped.** `group` is also accepted and unused on JSON adds (`app.ts:22`).

The SDK contract test passes anyway because it never exercises (1)–(4).

> **Addendum (P1-B, 2026-10-22):** checking every response against `ref/v5.json` found a mismatch this audit missed.
>
> 7. **`list/{type}` returns only the requested array.** The spec requires `documents`, `chunks`, `memories` and `pagination` on every list response, with the unrequested arrays empty (`app.ts:312,318,326`).
>
> All five shape mismatches (1–4 and 7) now have `test.failing` tests, scheduled for P4.

### Extensions that should live under `/ns/{ns}/x/…` per v2

- `GET /ns/{ns}/graph`
- `POST /ns/{ns}/memories/{id}/restore`
- `POST /ns/{ns}/memories/{id}/review`
- `POST /chat`
- `list/memories?inference=true`

### v4 features worth noting

- `/v4/profile` takes `q` (profile + search in one call).
- `/v4/memories` `POST`/`PATCH` create and edit memories directly (PRD #32, #33, which have no v5 equivalent).
- `/v4/conversations` ingests conversations (PRD #19).

None are shimmed.

---

## 4. The engine as built

### LLM call sites (all through `llm.ts`)

| # | Where | Prompt | Schema out | Notes |
|---|---|---|---|---|
| 1 | `dream.ts:97` extract | `EXTRACT` (`dream.ts:16-25`): atomic third-person facts; first person = "the user"; kind fact/preference/episode; `expiresAt` only for upcoming items, relative dates resolved against `documentDate`; skip small talk. Optional `bucket` | `{memories:[{content,kind,expiresAt,bucket?}]}` | Whole document in one call; input is `{supportingContext, documentDate, content, buckets?}` |
| 2 | `dream.ts:133` relate | `RELATE` (`dream.ts:27-32`): duplicate / updates / extends / new against numbered neighbours | `{decisions:[{i,relation,target}]}` | One batched call; no confidence; no reason |
| 3 | `dream.ts:185` derive | `DERIVE` (`dream.ts:34-39`): ≤ 3 new conclusions from ≥ 2 memories | `{inferences:[{content,from[]}]}` | Pool = new memories + neighbours, ≤ 15 |
| 4 | `forget.ts:23` semantic forget | `PICK` (`forget.ts:9-11`) | `{forget:[int]}` | Pool 30 via hybrid search |
| 5 | `chat.ts:58` chat | System prompt `chat.ts:16-29` | stream | `LLM_CHAT_MODEL` override |

These are not LLM calls: profile, query rewrite, rerank, aggregate and contextual chunking.

All calls go out with `temperature: 0`, `reasoning_effort: "none"` and `response_format: json_schema strict`.

- There is no Zod validation, retry, cache, logging or token accounting.
- The fake LLM routes on the literal `TASK: <name>` first line of each system prompt (`test/fake-llm.ts:22`). The tests are therefore coupled to prompt text, which goes against PRD.v2's "never on prompt wording" rule.

### Schema

The table list is in §1. The memory columns are:

- `kind`, `is_latest`, `is_inference`, `is_forgotten`
- `forget_after`, `forget_reason`
- `strength`, `version`, `root_id`
- `metadata` (copied from the document), `source_document_pk`, `bucket`
- `embedding`, `fts`

Edges are `(src,dst,rel)` with `rel ∈ updates|extends|derives`.

### How it actually behaves

**Dreaming**
- One document at a time per namespace, in arrival order.
- The near-duplicate shortcut (sim ≥ 0.92) bypasses the LLM, and `strength+1` is applied to the target **regardless of kind**.
- `updates` inserts version `target.version+1` and flips the target's `is_latest`. This happens unconditionally: no event-time, confidence, speaker or pinned check.

**Relations**
- Neighbours are only the vector top-5 with sim ≥ 0.55.
- A candidate with no neighbour above 0.55 is never related at all: it becomes "new".
- Candidates in the same document are never compared with each other.

**Forgetting**
- Soft-forget by ID, by semantic pick, by expiry (`forget_after`) or by decay (episodes, `strength·0.98^days < 0.25`).
- Restore clears `forget_after`.
- Declining in review forgets the memory.

**Profiles**
- Live, non-inference memories ordered by strength.
- `dynamic` = episodes, plus facts with `version>1` updated in the last 30 days.
- `static` = the rest (40 max).
- Buckets come from `kind=preference` or the extraction-time `bucket`.

**Inferences**
- Searchable immediately at full rank.
- Approving clears the flag; declining forgets.

### Defects found (each mapped to a PRD.v2 failure mode)

| FM | Weakness | Evidence |
|---|---|---|
| **1 Time** | Arrival-order processing; an old document ingested late supersedes a newer fact | `worker.ts:19`, `dream.ts:165-167` |
| 1 | `doc_date` only feeds the prompt and expiry; there is no `valid_from`/`valid_to`. Relative dates in `content` ("tomorrow") are not resolved; only `expiresAt` is | `dream.ts:90-100` |
| 1 | Re-sending a doc without `date` nulls `doc_date` (`doc_date = excluded.doc_date`) | `app.ts:65` |
| **2 Speaker** | No speaker field. Chat transcripts are saved as `User: …/Assistant: …` and the prompt only says "first person = user", so assistant suggestions can become user facts | `chat.ts:69-71`, `dream.ts:20` |
| 2 | Chat re-ingests the **whole transcript every turn** under the same id: full re-extract each turn, and every repeated fact gets `strength+1` per turn | `chat.ts:68-71` |
| **3 Hallucination** | No source quote, no grounding | `dream.ts:97-106` |
| 3 | Inferences rank like facts in search before review | `search.ts:68`, `memories.ts:47` |
| 3 | Whole document in one extract call. Long docs may be silently truncated by the model's context window (Ollama defaults are small), and only 30 candidates are kept per doc | `dream.ts:9,97` |
| **4 Missed links** | Vector-only neighbours, top-5, floor 0.55; no FTS/entity channel; no intra-document comparison | `dream.ts:7-8,114-124` |
| **5 Silent overwrites** | Any `updates` supersedes, with no confidence threshold or review | `dream.ts:165-170` |
| 5 | **Near-duplicate shortcut swallows real updates [verified].** "Kim has 3 children" after "Kim has 2 children" scores cosine 0.934 ≥ 0.92, so it is discarded as a duplicate, strength goes to 2, and the old number stays latest | `dream.ts:10,128` |
| 5 | **Version fork [verified].** Two candidates updating the same target both insert `version=2, is_latest=true` | `dream.ts:163-170` |
| 5 | **Deleting a document leaves its memories live in search [verified]** (`on delete set null`). Updating a doc's content re-dreams it, but the old version's memories are never retracted | `schema.sql:65`, `app.ts:192` |
| 5 | No `pinned` concept; no direct memory create or edit API | — |
| **6 No re-dream** | No `pipeline_version`; nothing records which prompt or model made a memory. Crash recovery re-queues and clears the hash, so the doc is re-dreamt into duplicates and strength bumps | `worker.ts:84` |
| 6 | Dream failures are recorded only as `documents.error` with `dreaming_status='done'`; nothing can retry them | `worker.ts:71` |
| **7 No measurement** | No eval harness, no `llm_calls`, no latency measurement | — |

### Retrieval defects (not tied to a single failure mode)

- **FTS pool without ORDER BY.** The `kw` CTE takes `limit 50` without ordering, so above 50 keyword hits the pool is an arbitrary subset (`memories.ts:55`, `search.ts:39`).
- **RRF fusion is computed, then thrown away.** The final list is sorted by raw cosine (`search.ts:84`), so keyword-only hits sink, and memory-vs-chunk ordering is cosine-vs-cosine across different text granularities.
- **No index use.** The full namespace is scanned per query (`base` CTE). Fine at small N; latency has never been measured.

---

## 5. Tests

### Environment

To run the tests, I installed bun 1.3.5 and `postgresql-16-pgvector` (0.6.0), and created a local `root` Postgres superuser with password `root`. The tests hard-code `postgres://localhost/postgres` and need a superuser to `create database`. The first run downloads the bge model from Hugging Face, so the "gating" tests need network access.

### Results (real)

| Suite | Tests | Result |
|---|---|---|
| `server/test/contract.test.ts` | 9 | 9 pass warm. **The file-upload test failed 3 of the first 4 runs** (3 of 9 default-timeout runs overall): it timed out at bun's default 5 s on a cold start. Warm, it takes ~0.5–0.8 s |
| `server/test/engine.test.ts` | 15 | 15 pass |
| `server/test/mcp.test.ts` | 4 | 4 pass |
| `web/test/sse.test.ts` | 1 | 1 pass |
| `tsc` (server, web) | — | clean |
| `oxlint` (web) | — | 0 errors, 3 warnings |

**28 server tests**, which matches NEXT.md's "28", plus 1 web test. `bun run test` stops at the first failing file, so a cold-start flake in the contract test hides the engine and MCP results.

### Covered

- **SDK (`supermemory@5.0.2`, unmodified):** add, update, batch, get (+chunks), delete, chunk search with filters, the auth error, a 400.
- **Raw fetch:** file upload (pdf, md, png rejected) and the legacy shims.
- **Engine through the SDK and API:**
  - update chain, extends, derive, duplicate preference, expiry;
  - forget by id, restore, semantic forget, decay sweep;
  - profile static/dynamic/buckets, custom buckets;
  - review approve, inference filter, graph;
  - chat SSE, bogus-expiry guard.
- **MCP:** all tools, resources, the prompt, the 401.

### Not covered

- Response bodies validated against `ref/v5.json`. PRD v1 promised this; its absence is why the §3 mismatches went unnoticed.
- SDK calls for `profile` with `buckets`, `memories.get` with `include`, `list` with `sort`, and hybrid result shapes.
- Ordering within a namespace (a v1 seam-2 scenario that was never written).
- Doc delete/update → memory consequences.
- Concurrent workers.
- The rerank/rewrite flags.
- Failure paths (LLM down, invalid JSON).
- **All E1 v2 scenarios.**
- Web: no `test` script, no Playwright.
- The fake LLM does not record requests (needed for the redaction test).

---

## 6. Where docs and code disagree

1. **v2 doc location.** The docs and your brief reference `docs/v2/*.md`; the files are untracked at the repo root.
2. **NEXT.md branch.** NEXT.md says branch `browser-extension`; the shims are on `main` (019c55a). Ignored per your instruction.
3. **README "Phase 2/3 done".** It omits that rerank, rewriteQuery and aggregate are no-ops. The comment at `app.ts:203` ("until phase 2") is stale.
4. **Profile design.** PLAN/PRD v1 describe an LLM-summarised profile cached in a `profiles` table. The code computes ranked lists on read, with no table and no LLM. PLAN.v2 D9 ("incrementally update affected sections") and the "< 50 ms cached row" target assume the v1 design.
5. **Queue.** PLAN v1 and v2 §1 ("stack unchanged") say pg-boss and two processes. The code uses a SQL claim loop in one process.
6. **Web and MCP forks.** PLAN v1 calls them forks of upstream. Both were written fresh, so no MIT notices are needed today. Forks only start with P7 (the extension).
7. **"Run fine on Postgres 17 + pgvector ≥ 0.8".** PLAN.v2 §1 recommends iterative scans. Nothing uses the HNSW index, so the post-filter recall concern doesn't apply yet; latency does.
8. **v1 relate.** PLAN v1 §3 describes one LLM call per candidate; the code already batches. PLAN.v2's "What changed" table credits batching as new.
9. **Inferences "go to the review queue"** (PLAN v1 §3.4.4). In practice they are live and searchable at full rank immediately.
10. **PLAN.v2 §4.7.** It asks whether v5 `/profile` takes a query. It doesn't, but `/v4/profile` does (`q`); see §3.
11. **PLAN.v2 says nothing about document deletion or updates.** It has no rule for retracting memories whose source changed or was deleted. This is a real gap in the v2 design, not only in the code.
12. **PRD.v2 "Keep v1's architecture (… pg-boss, forked MCP, web app and extension, connectors)".** Of these, only the API contract and Postgres exist.
13. **The contract-test claim "if the SDK passes, the plugins pass too".** It only holds for the SDK methods actually exercised; four spec mismatches pass silently today.
14. **The PRD.v2 metrics table targets "Supermemory local … same LLM".** Running the oracle requires Docker or `npx supermemory local` plus an LLM endpoint that can run three benchmarks. That cost and infrastructure decision is not yet made (P1 blocker; see §7).

---

## 7. Recommended adjustments to the v2 phase plan

**P0.5: hygiene before the baseline (small; contract-preserving).** Needs your OK where marked.

1. Move `PLAN.v2.md`, `PRD.v2.md` and `NEXT.v2.md` into `docs/v2/`.
2. Make the tests hermetic and stable:
   - `DATABASE_ADMIN_URL` env with the current default;
   - a longer timeout on the upload test;
   - the test script runs all files and reports all results;
   - document the embedding-model cache.
3. Add a **v5 response-schema check** to the contract test: validate every SDK response against `ref/v5.json` with a JSON-schema validator. This is additive and test-only. It will go red on mismatches 1–3, so…
4. …fix contract mismatches 1–4 from §3: profile `buckets`, `include=documents`, chunk `isLatest`/`isInference`, list `sort`. These move the server *toward* the spec, but they touch the v5 surface, so **I want your OK first**.

**P1: eval baseline. Pull part of P2 forward.**

- Do the **LLM router + cache + `llm_calls` logging** at the start of P1, with zero behaviour change: the existing prompts move verbatim into `prompts/*.v1.md`, and the fake LLM routes on role, not prompt text. Without the cache, E3 baseline runs are expensive and not reproducible; without `llm_calls`, the baseline has no cost or failure data.
- E1 v2 scenarios as `test.todo`. Add the four **[verified]** defects from §4 as todo regressions:
  - version fork;
  - numeric update swallowed by the near-dup shortcut;
  - deleted-doc memories still live;
  - chat strength inflation.
- E2: start with relation and extraction sets (the false-UPDATE rate matters most, given §4).
- E3: **blocked on decisions (see the questions at the end)**: which LLM endpoint (cost), and whether Docker/`npx supermemory local` is acceptable as new infrastructure.

**P2: schema + guard.** Add a minimal **numbered migration runner** first: `schema.sql` can't express reversible migrations. Backfill as PRD.v2 specifies. Also add `embedding_model`.

**P3: Dreamer v2.** Add to scope:

- a document update/delete → retract rule (decision needed: forget, or keep as history with `valid_to`);
- conversation-unit debounce, which also fixes the chat re-ingest problem;
- removal of the 0.92 auto-duplicate shortcut, or restricting it to exact normalised text;
- intra-batch candidate dedupe;
- a single-successor guard on `updates`.

**P4: Retrieval v2.**

- Fix the FTS `ORDER BY` and use the fused score for ranking, before adding new channels, and measure each step separately.
- Implement the **`/v4/profile` shim with `q`** alongside `x/context`.
- Benchmark an exact scan vs HNSW at 100k.

**P5.** Move the existing extension routes under `/ns/{ns}/x/` and keep old aliases until the web app is updated. This is a surface change, so I'll ask first.

**Profile decision (P3/P4).** Keep the LLM-free ranked profile as the default (it is fast and deterministic). Treat D9 LLM summaries as optional `aggregated_` items, to be measured, not assumed.

**Keep the SQL claim worker** instead of adding pg-boss, unless you want it. It already works and fewer dependencies is better for a personal box.

### Owner decisions (2026-10-22)

1. **v5 shape mismatches:** fix each one inside the phase that builds that area (mostly P4), not in a separate P0.5 step.
2. **LLM:** local Ollama only; no paid APIs. E2/E3 wait until it is set up.
3. **Oracle (Supermemory local):** deferred until building is done; tracked in `docs/v2/DEFERRED.md`.
4. **Deleted or edited documents:** memories are kept as history with `valid_to` set, not forgotten (P3 Policy rule).


### Summary of main gap findings in v1
Main findings:
- Doc location: the v2 docs aren't in docs/v2/. They're untracked files at the repo root.
- Engine bugs: I confirmed each of these through the API with a temporary probe test, since deleted:
  - Updates silently swallowed: "Kim has 3 children" after "Kim has 2 children" is thrown away as a duplicate, because
    the two embed at 0.934 and the cutoff is 0.92. The old fact stays as the latest.
  - Two "latest" versions: when two new facts both update the same old one, both become the latest version.
  - Deleted documents keep their memories: memories from a deleted document still show up in search.
- Other engine weaknesses (from reading the code, not probed): all seven failure modes in PRD.v2 are present. Notably:
  - processing follows arrival order, not event time;
  - the engine has no idea who said what;
  - chat re-ingests the whole transcript every turn;
  - inferences rank like facts before anyone reviews them.
- Search bugs:
  - The keyword pool takes 50 rows with no ordering, so once there are more than 50 matches it's an arbitrary subset.
  - The combined ranking score is computed and then ignored; results are sorted by raw similarity instead.
- v5 contract: 20 of the spec's 33 operations are implemented. There are four shape mismatches the SDK test never
  exercises:
  - profile with buckets returns a 400;
  - memories/{id}?include=documents returns no document;
  - chunk search results are missing the required isLatest and isInference;
  - list?sort= is ignored.
- Ignored search options: rerank and rewriteQuery are accepted but do nothing.
- Infrastructure and LLM calls: there's no LLM router, cache, eval harness or migration framework. The existing extension routes (/graph, /chat, /review, /restore) aren't under /x/.
- Answer to PLAN.v2 §4.7: v5 /profile doesn't take a query, but /v4/profile does (q). A v4 shim is the way to offer profile plus search in one call.
