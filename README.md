# supermem

Personal, self-hosted memory engine for your AI tools: ingest notes, links and files, turn them into evolving memories, and recall them from chat, MCP clients and the browser.

- `server/`: Bun + Hono + Postgres (pgvector). It handles ingest, chunking, local embeddings, memory formation ("dreaming") with a local LLM, hybrid search, profiles, forgetting and MCP.
- `web/`: React 19 UI built with [affectUI](https://www.affectui.com)'s free components and design language. See `web/README.md`.
- `extension/`: Chrome extension (save pages, recall memories inside AI chats).
- `PLAN.md` and `PRD.md` describe the v1 roadmap. `docs/v2/` holds the v2 plan, PRD, resume notes and gap report; v2 wins where they conflict. `ref/` holds the upstream OpenAPI specs and docs.

## Run

```sh
./start.sh   # starts Postgres + Ollama services, API (:6767) and UI (:5173); Ctrl-C stops the app
```

Manual setup, first time or without the script:

```sh
brew install postgresql@17 pgvector ollama
brew services start postgresql@17 && brew services start ollama
createdb supermem && ollama pull qwen3:8b

cd server && cp .env.example .env   # set SUPERMEM_API_KEY
bun install && bun start            # http://127.0.0.1:6767

cd ../web && bun install && bun run dev   # http://localhost:5173
```

## Use from other tools

- **HTTP:** `curl -X POST http://127.0.0.1:6767/ns/personal/search -H "Authorization: Bearer $SUPERMEM_API_KEY" -H "content-type: application/json" -d '{"query":"what do I drink?"}'`
- **MCP:** `claude mcp add --transport http supermem http://127.0.0.1:6767/mcp --header "Authorization: Bearer $SUPERMEM_API_KEY"`

## Test

`cd server && bun run test` runs three seams against fresh databases with a scripted fake LLM:

- **Contract:** the HTTP API, through a generated client.
- **Engine:** memory formation.
- **MCP:** a real MCP client.

## Status

| Phase | State |
| --- | --- |
| 1. Ingest, chunk, embed, hybrid chunk search, filters | done |
| 2. Dreaming: extract → updates/extends/duplicate → derive; versioning | done |
| 3. Profiles and buckets, expiry/decay sweep, semantic forget, inference review | done |
| 4. MCP (`/mcp`) | done |
| 5. Web UI (affectUI): chat with memory (SSE), graph, documents, memories and restore, review, search, profile | done |
| 6. Files: PDF, DOCX, Markdown, text, CSV, JSON, HTML, code | done. Not yet: scanned-PDF OCR, images (vision), audio/video (whisper) |
| 7. Connectors | not started |
| 8–10. Extension, plugins, extras | not started |
