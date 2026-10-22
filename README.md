# supermem

Personal, self-hosted rebuild of [supermemory.ai](https://supermemory.ai). It speaks Supermemory's v5 API, so the official SDKs and MCP-style tooling work against it.

- `server/`: Bun + Hono + Postgres (pgvector). It handles ingest, chunking, local embeddings, memory formation ("dreaming") with a local LLM, hybrid search, profiles, forgetting and MCP.
- `web/`: React 19 UI built with [affectUI](https://www.affectui.com)'s free components and design language. See `web/README.md`.
- `PLAN.md` and `PRD.md` describe the roadmap. `ref/` holds the upstream OpenAPI specs and docs.

## Run

```sh
brew install postgresql@17 pgvector ollama
brew services start postgresql@17 && brew services start ollama
createdb supermem && ollama pull qwen3:8b

cd server && cp .env.example .env   # set SUPERMEM_API_KEY
bun install && bun start            # http://127.0.0.1:6767

cd ../web && bun install && bun run dev   # http://localhost:5173
```

## Use from other tools

- **SDK:** `new Supermemory({ apiKey, baseUrl: "http://127.0.0.1:6767" })`, then `client.add("personal", { content })` and `client.search("personal", { query })`.
- **MCP:** `claude mcp add --transport http supermem http://127.0.0.1:6767/mcp --header "Authorization: Bearer $SUPERMEM_API_KEY"`

## Test

`cd server && bun run test` runs three seams against fresh databases with a scripted fake LLM:

- **Contract:** the official SDK.
- **Engine:** memory formation.
- **MCP:** a real MCP client.

## Status

| Phase | State |
| --- | --- |
| 1. Ingest, chunk, embed, hybrid chunk search, filters | done |
| 2. Dreaming: extract → updates/extends/duplicate → derive; versioning | done |
| 3. Profiles and buckets, expiry/decay sweep, semantic forget, inference review | done |
| 4. MCP (`/mcp`, upstream tool names) | done |
| 5. Web UI (affectUI): chat with memory (SSE), graph, documents, memories and restore, review, search, profile | done |
| 6. Files: PDF, DOCX, Markdown, text, CSV, JSON, HTML, code | done. Not yet: scanned-PDF OCR, images (vision), audio/video (whisper) |
| 7. Connectors | not started |
| 8–10. Extension, plugins, extras | not started |
