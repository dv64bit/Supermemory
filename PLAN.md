# supermem roadmap

supermem is a personal, self-hosted memory engine for AI tools. You feed it notes, links and files. It turns them into small, evolving memories, and serves them to chat, MCP clients and the browser. Everything runs on one machine: Bun + Hono, Postgres with pgvector, local embeddings, and a local OpenAI-compatible LLM (Ollama by default).

## Architecture

```
ingest -> chunk -> embed -> dream -> memories + relations -> hybrid search / profile / chat / MCP / UI
```

| Stage | What it does | Code |
| --- | --- | --- |
| Ingest | Text, URL (Readability), and files (PDF, DOCX, Markdown, CSV, JSON, HTML, code). A stable `customId` and a content hash make re-sending a document an update, or a no-op if unchanged. Documents carry a status (`queued` to `done` or `failed`). | `app.ts`, `extract.ts` |
| Worker | Postgres-backed loop in the API process. It claims the oldest queued document with `FOR UPDATE SKIP LOCKED`. Ingest is serialized per namespace so "which fact came first" is well defined. An hourly sweep runs expiry and episode decay. | `worker.ts` |
| Chunk | Structure-aware: Markdown headings, whole code fences, sentence packing with ~200 characters of overlap. | `chunk.ts` |
| Embed | Local `bge-base-en-v1.5` (768d, quantized) via transformers.js. The dimension is fixed in the schema. | `embed.ts` |
| Dream | Three LLM passes per document: extract atomic memories (fact, preference or episode, with optional expiry), relate each to its nearest existing memories, derive inferences. Relations are `updates` (old version stops being latest, history kept), `extends`, `derives` (flagged as inference). Near-identical candidates count as duplicates and strengthen the existing memory. | `dream.ts`, `memories.ts` |
| Search | Vector + full-text fused with reciprocal-rank fusion, over memories and chunks (`hybrid`, `memories` or `chunks`). Threshold, limit, a metadata filter tree, related-memory expansion, and latest/non-forgotten gating by default. | `search.ts`, `filter.ts` |
| Profile | Computed from live memories on read, with no LLM: static (durable facts and preferences) and dynamic (recent episodes and changes). Custom buckets are assigned during dreaming. | `profile.ts` |
| Forgetting | Soft-forget by ID, or by meaning with a dry run and a cap. Expiry is swept. Episode strength decays at 0.98/day and is computed on read from `updated_at`, so restarts cannot over-decay. Inferences go through a review queue. Restore is supported. | `forget.ts` |
| Chat | Streams (SSE) answers grounded in search results from the namespace. | `chat.ts` |
| MCP | Streamable HTTP at `/mcp` in the same server: `search_memory`, `add_memory`, `forget_memory`, `get_profile`, `list_documents`, `get_document`, `list_memories`, `list_spaces`, `select_space`, `who_am_i`. | `mcp.ts` |
| Web UI | React 19: chat, graph, documents, memories (with restore), review, search, profile, settings. | `web/` |
| Extension | Chrome (WXT): save a page, recall memories inside AI chats. Talks to `/v3` and `/v4` compatibility routes. Server URL and API key are set in the popup. | `extension/`, `server/src/legacy.ts` |

Auth is a single bearer key (`SUPERMEM_API_KEY`). The server binds to `127.0.0.1`. Namespaces separate memory spaces. Postgres is the only store, including the graph, which is plain SQL over `memory_edges`.

## Testing

`cd server && bun run test` runs three seams against fresh databases with a scripted fake LLM:

- **Contract:** the HTTP API through a generated client, including the legacy routes.
- **Engine:** memory formation scenarios (update chain, duplicate strengthening, expiry, decay, review, semantic forget).
- **MCP:** a real MCP client against `/mcp`.

## Status

| Area | State |
| --- | --- |
| Ingest, chunk, embed, hybrid search, filters | done |
| Dreaming, relations, versioning | done |
| Profiles, buckets, expiry/decay, semantic forget, review | done |
| MCP | done |
| Web UI | done |
| Files: PDF, DOCX, Markdown, text, CSV, JSON, HTML, code | done |
| v3/v4 compat routes (`legacy.ts`) | done, covered by contract tests |
| Extension: build and typecheck | done |
| Extension: verified in a real browser | not yet |
| Connectors | not started |
| Scanned-PDF OCR, images, audio/video | not started |

## Next steps

1. **Verify the extension in a real browser.** Load `.output/chrome-mv3`, check the popup connect form, save-page, and auto-recall in ChatGPT and Claude. Fix selector drift as found.
2. **Connectors: Notion, Google Drive, Gmail.** Each needs its own OAuth app registered by the owner. Plan: a provider interface `{ authorize, listChanges(cursor), fetch(item) }`, a first full import, a periodic reconcile in the worker, per-connector document limits, and tokens encrypted at rest.
3. **Images.** Describe and OCR with a local vision model, then feed the text through the normal pipeline.
4. **Audio and video.** Transcribe with whisper, then ingest the transcript.
5. **Tuning.** Decay constants, duplicate similarity and the extraction prompts need real-data evaluation. Add a small personal eval set run against the real model, separate from the gating tests.
6. **Optional.** Cross-encoder rerank, an LLM rollup per profile bucket.
