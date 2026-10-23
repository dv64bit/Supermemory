---
title: "supermem: a personal, self-hosted memory engine"
labels: [ready-for-agent]
created: 2026-10-22
related: PLAN.md
---

## Problem Statement

I use several AI tools every day: Claude, ChatGPT, Cursor, Claude Code and others. None of them remembers anything about me across sessions or across tools. Everything I save (notes, links, PDFs, Notion pages, Drive files, emails) sits in separate silos, and my assistants can't see any of it.

I want one memory I own: it turns everything I feed it into atomic facts that evolve over time, keeps a standing profile of me, and serves that memory to any model through an HTTP API, MCP and a browser extension. My personal data should stay on my own machine, with no metering and no plan gates.

## Solution

supermem is a self-hosted personal memory server with a web UI, an MCP endpoint and a browser extension.

- **Memory engine:** ingests text, URLs, files and (later) connector data, then:
  - extracts atomic, typed memories;
  - links them through `updates` / `extends` / `derives` relations, with versioning and soft-forgetting;
  - computes a static/dynamic user profile;
  - serves hybrid search over memories and chunks.
- **Web UI:** notes, links, uploads, spaces, chat over memories, graph view, documents, memories with restore, and inferred-memory review.
- **MCP endpoint:** mounted at `/mcp` on the same server, so Claude Desktop, Claude Code, Cursor and others can search and write memory.
- **Browser extension:** save a page and auto-recall inside ChatGPT, Claude, Gemini and Grok, talking to the server through v3/v4 compatibility routes.
- **Connectors (planned):** Notion, Google Drive and Gmail, each keeping my sources in sync.

Everything runs on one machine with Postgres and a local or OpenAI-compatible LLM. There is no billing, no orgs and no plan gates.

## User Stories

### Capture
1. As the owner, I want to add a plain-text note, so that a thought becomes memory.
2. As the owner, I want to add a URL and have the page content extracted with boilerplate removed, so that articles I read become searchable.
3. As the owner, I want to upload a PDF, so that its text (OCR'd if scanned) is chunked and remembered.
4. As the owner, I want to upload DOCX, XLSX and PPTX files, so that office documents are ingested.
5. As the owner, I want to upload images, so that their OCR text and a generated description become searchable.
6. As the owner, I want to upload audio and video, so that they are transcribed and remembered.
7. As the owner, I want to add Markdown, code, JSON and CSV, so that technical material is chunked by its structure.
8. As the owner, I want to add a tweet or YouTube link, so that its text or transcript is captured with a rich preview.
9. As the owner, I want to batch-add up to 600 documents in one call, so that bulk imports are fast.
10. As the owner, I want to attach a stable custom ID to a document, so that re-sending it updates it instead of duplicating it.
11. As the owner, I want re-ingesting unchanged content to be a no-op, so that repeat syncs cost nothing.
12. As the owner, I want to set the date the content is from, so that temporal reasoning uses when it happened, not when I saved it.
13. As the owner, I want to attach metadata to documents, so that I can filter by it later.
14. As the owner, I want to give a namespace supporting context (up to 1,500 characters), so that extraction knows whose memory it is building and what matters.
15. As the owner, I want to choose RAG-only ingest (`taskType: superrag`) for some documents, so that reference material is searchable without generating memories.
16. As the owner, I want to request `instant` dreaming, so that the next call sees new facts immediately.
17. As the owner, I want to see each document's processing status (queued, extracting, chunking, embedding, indexing, done, failed), so that I know when it is ready.
18. As the owner, I want failed ingestion to show an error reason, so that I can fix or retry it.
19. As the owner, I want to send a conversation (a list of messages with a conversation ID), so that chat transcripts become memory.
20. As the owner, I want to replace or patch an existing document or file, so that corrections flow into memory.
21. As the owner, I want to delete one or many documents, so that I control what is remembered.

### Memory formation
22. As the owner, I want one input to become many atomic, self-contained memories, so that facts are retrievable on their own.
23. As the owner, I want each memory typed as a fact, preference or episode, so that it gets the right lifetime.
24. As the owner, I want a new fact that contradicts an old one to supersede it (old one marked not-latest, history kept), so that memory reflects the present without losing the past.
25. As the owner, I want a new fact that adds detail to link to the old one as `extends`, so that both stay valid and connected.
26. As the owner, I want the system to infer derived facts from clusters of memories, marked as inferences, so that it learns things I never stated outright.
27. As the owner, I want repeated preferences to strengthen, so that consistent habits rank higher.
28. As the owner, I want episodes to decay unless they are significant, so that trivia fades.
29. As the owner, I want temporary facts ("exam tomorrow") to expire automatically, so that stale context disappears.
30. As the owner, I want casual chatter filtered out during extraction, so that memory isn't polluted.
31. As the owner, I want ingestion within a namespace processed in order, so that "which came first" is correct for updates.
32. As the owner, I want to create a memory directly, without a source document, so that I can state facts explicitly.
33. As the owner, I want to edit a memory, creating a new version, so that I can correct the engine.
34. As the owner, I want to set an explicit expiry and reason on a memory, so that I control its lifetime.

### Review and forgetting
35. As the owner, I want a review queue of inferred memories, so that I approve or decline what the engine guessed.
36. As the owner, I want approving an inference to clear its inference flag, so that it becomes a trusted fact.
37. As the owner, I want declining an inference to forget it, so that wrong guesses disappear.
38. As the owner, I want to forget memories by ID, so that I can remove specific facts.
39. As the owner, I want to forget by meaning ("forget everything about my old job"), with a dry run first, so that bulk forgetting is safe.
40. As the owner, I want a cap on how many memories one semantic forget can remove, so that a vague query can't wipe everything.
41. As the owner, I want forgetting to be soft and recoverable through an include-forgotten option, so that mistakes are reversible.

### Retrieval
42. As the owner, I want hybrid search over memories and chunks, so that I get both distilled facts and source passages.
43. As the owner, I want memories-only and chunks-only modes, so that I can choose precision or raw context.
44. As the owner, I want search to return only the latest, non-forgotten memories by default, so that answers are current.
45. As the owner, I want a similarity threshold and a result limit (up to 100), so that I can tune recall against noise.
46. As the owner, I want metadata filters (eq, neq, gt, gte, lt, lte, contains, notContains, arrayContains, arrayNotContains, combined with and/or up to 5 levels deep), so that I can scope results precisely.
47. As the owner, I want optional cross-encoder reranking, so that the best results come first.
48. As the owner, I want optional aggregate mode, so that related memories are merged into one answer.
49. As the owner, I want optional query rewriting, so that vague queries still find relevant memories.
50. As the owner, I want search results to include related memories through graph edges, so that I get connected context.
51. As the owner, I want each result to carry its source document, similarity, isLatest and isInference flags, and timestamps, so that I can judge trust.
52. As the owner, I want to fetch one memory with its version history, connected memories and source document, so that I can see how a fact evolved.
53. As the owner, I want paginated, sortable lists of documents, chunks and memories, so that I can browse everything.
54. As the owner, I want memory counts per document, so that I can see what each source produced.
55. As the owner, I want search latency under about 300ms at personal scale without rerank or rewrite, so that assistants stay snappy.

### Profiles
56. As the owner, I want a static profile (stable facts about me), so that every assistant knows who I am without searching.
57. As the owner, I want a dynamic profile (my recent state), so that assistants know what I'm working on now.
58. As the owner, I want custom profile buckets (name and description), so that topics like "health" or "work" get their own summaries.
59. As the owner, I want a default preferences bucket, so that formatting and style preferences are always attached.
60. As the owner, I want the profile rebuilt automatically when memory changes, so that it never goes stale.
61. As the owner, I want profile reads to be near-instant, so that they can go on every turn.
62. As the owner, I want profiles filterable by metadata, so that I can get a scoped picture.

### Namespaces (spaces)
63. As the owner, I want multiple namespaces (personal, work, project-x), so that memory stays separated.
64. As the owner, I want to list, rename and update the context of namespaces, so that I can organise them.
65. As the owner, I want to delete a namespace or move its content into another, so that I can reorganise without losing data.
66. As the owner, I want a default namespace, so that clients without one still work.

### Connectors
67. As the owner, I want to connect Notion with one OAuth click, so that my pages sync into memory.
68. As the owner, I want to connect Google Drive (Docs, Sheets, Slides), so that my files sync.
69. As the owner, I want to connect Gmail with push notifications and incremental sync, so that email becomes memory within minutes.
70. As the owner, I want to connect OneDrive, so that Microsoft files sync.
71. As the owner, I want to connect GitHub with a repo picker, so that chosen repositories are indexed.
72. As the owner, I want to connect Granola with an API key, so that meeting notes sync.
73. As the owner, I want to connect S3 or an S3-compatible bucket, so that stored files sync.
74. As the owner, I want a web crawler connector (a start URL, recrawling, robots.txt respected), so that a site stays indexed.
75. As the owner, I want the first sync to import everything, so that I start with full history.
76. As the owner, I want webhooks to deliver changes within seconds, so that memory stays current.
77. As the owner, I want a sync every four hours to catch anything webhooks missed, so that nothing drifts.
78. As the owner, I want only changed content re-processed, so that syncs are cheap.
79. As the owner, I want a per-connector document limit (1–10,000), so that a big source can't flood memory.
80. As the owner, I want to trigger a manual sync, and be refused while one is already running, so that syncs don't collide.
81. As the owner, I want sync history per connector, so that I can see what was imported and when.
82. As the owner, I want disconnecting to optionally delete the imported documents, so that I control cleanup.
83. As the owner, I want connector tokens encrypted at rest, so that a database leak doesn't expose my accounts.

### Integrations (AI tools)
84. As the owner, I want a plain HTTP API with a bearer key, so that any script, SDK or tool can call my server.
85. As the owner, I want an MCP server exposing search_memory, add_memory, forget_memory, get_profile, list_documents, get_document, list_memories, list_spaces and who_am_i, so that Claude Desktop, Claude Code, Cursor and others can use my memory.
86. As the owner, I want MCP resources for my profile and spaces, and a context prompt, so that clients can preload who I am.
87. As the owner, I want the MCP server to remember my active space, so that I don't pass a namespace on every call.
88. As the owner, I want my own apps to be able to fetch my profile and search results over HTTP, so that they can inject them into prompts and save conversations.
89. As the owner, I want Claude Code and Cursor to use the MCP endpoint to capture and recall, so that my coding assistants remember my projects.
90. As the owner, I want v3/v4 compatibility routes for the endpoints the browser extension calls, so that the extension works without changes to the main API.

### Web UI
91. As the owner, I want a rich-text note editor with slash commands, so that writing memories is pleasant.
92. As the owner, I want a grid of my documents with type-specific previews (tweet, YouTube, Notion, Google Docs, website, PDF, image), so that I can browse my knowledge.
93. As the owner, I want a command palette over my documents, so that I can jump to anything fast.
94. As the owner, I want to create, edit and switch spaces in the UI, so that I can manage namespaces visually.
95. As the owner, I want an interactive memory graph view, so that I can see how facts connect and evolve.
96. As the owner, I want a timeline view, so that I can see memory over time.
97. As the owner, I want to chat with my memories, with related-memory cards, model selection and attachments, so that I can ask questions over everything I know.
98. As the owner, I want the review modal for inferred memories in the UI, so that curation is easy.
99. As the owner, I want a settings screen for API keys, connectors, profile buckets and the ingest filter prompt, so that I can configure everything without curl.
100. As the owner, I want the UI installable as a PWA, so that it works like a native app on my phone.

### Browser extension
101. As the owner, I want a save button on any web page, so that capture is one click.
102. As the owner, I want related memories surfaced automatically while I type in ChatGPT, Claude, Gemini, Grok or T3 chat, so that those tools get my context.
103. As the owner, I want to import my X/Twitter bookmarks in bulk, so that saved tweets become memory.
104. As the owner, I want to pick the target space from the extension, so that captures land in the right place.

### Extras
105. As the owner, I want an Apple Shortcut that posts to my server, so that I can capture from iOS share sheets.
106. As the owner, I want Raycast commands for add, search and project search, so that I can capture from my desktop launcher.
107. As the owner, I want to mount a namespace as a read-only filesystem (or a grep tool over it), so that agents can grep my memory.

### Operations
108. As the owner, I want the whole system to start with one command (`./start.sh`), so that setup is trivial.
109. As the owner, I want to choose any OpenAI-compatible LLM (Ollama, OpenRouter, Anthropic-compatible), so that I control cost and privacy.
110. As the owner, I want local embeddings by default, so that ingest works offline and free.
111. As the owner, I want the server bound to localhost (or Tailscale) and protected by an API key, so that my memory isn't exposed.
112. As the owner, I want a health endpoint, so that I can monitor it.
113. As the owner, I want database backups to be plain Postgres dumps, so that recovery is standard.

## Implementation Decisions

- **HTTP API is the spine.** Routes live under `/ns/{namespace}/…`: document, document/batch, document/file, search, profile, profile/buckets, memories, memories/semantic, list/{documents|chunks|memories}, graph, plus `/ns` for namespaces. Auth is `Authorization: Bearer <api key>`.
- **Compatibility routes** for the browser extension live in `server/src/legacy.ts`. They are thin adapters over the main handlers: v3 documents and search, v4 search, profile and memories, v3 projects and health.
- **Modules (deep, small interfaces):**
  - **Extractor:** `(input: text | url | file) → { text, type, title, url }`. Readability for HTML; parsers for PDF, DOCX and other text formats. Images (vision) and audio/video (whisper) are planned behind the same function.
  - **Chunker:** `(text) → chunks[]`. Structure-aware: Markdown headings, whole code fences, sentence boundaries with about 200 characters of overlap.
  - **Embedder:** `(texts) → vectors`. Local bge-base-en-v1.5 at 768 dimensions, overridable by env. The dimension is fixed in the schema, so changing models means re-embedding.
  - **Dreamer (memory formation):** `(document, namespace) → memory writes and edges`. Three LLM passes: extract typed atomic facts, relate each candidate to its nearest latest memories (new, duplicate, updates or extends), then derive inferences. Applies versioning, strength and expiry.
  - **Retriever:** `(namespace, searchRequest) → results`. Hybrid vector + full-text with reciprocal-rank fusion, the filter-tree compiler, threshold, latest/forgotten gating and related-edge expansion. Rerank, aggregate and query rewriting are not built.
  - **Profiler:** `(namespace) → { static, dynamic, buckets }`. Computed from live memories on read, with no LLM: static is durable facts and preferences, dynamic is recent episodes and changes. The built-in `preferences` bucket is classified by kind; custom buckets are assigned during dreaming.
  - **Forgetter:** expiry sweep, episode decay, ID-based soft-forget, semantic forget with dry run and a cap, restore.
  - **LLM client:** a single OpenAI-compatible client with JSON outputs. Every LLM-dependent module goes through it, which is the seam for the fake LLM in tests.
  - **Connector framework (planned):** one provider interface `{ authorize, listChanges(cursor), fetch(item) }`, a first full import, a periodic reconcile, a per-connector document limit, and tokens encrypted at rest.
- **Storage:** Postgres with pgvector (HNSW, cosine) and tsvector. Tables: namespaces, documents (unique on namespace and public ID, content hash for no-op re-ingest), chunks, memories (kind, is_latest, is_inference, is_forgotten, forget_after, strength, version chain, metadata), memory_edges (updates, extends, derives) and profile_buckets. No separate graph database; graph traversal uses SQL.
- **Jobs:** no job queue library. A Postgres-backed worker loop runs in the API process and claims the oldest queued document with `FOR UPDATE SKIP LOCKED`. Ingest is serialized per namespace, because order decides which fact came first. Dreaming runs after indexing. An in-loop hourly sweep handles expiry and episode decay.
- **Decay:** episodes lose strength at 0.98 per day and are soft-forgotten below 0.25. Effective strength is computed on read from the last-reinforced time rather than stored, so restarts cannot over-decay. A duplicate bumps strength and resets the clock. Facts persist until updated. The constants are tunable.
- **MCP:** Streamable HTTP mounted at `/mcp` in the same server, using the same API key. Tools: `search_memory`, `add_memory`, `forget_memory`, `get_profile`, `list_documents`, `get_document`, `list_memories`, `list_spaces`, `select_space` and `who_am_i`.
- **Web UI:** React 19 with Vite. Pages: chat (SSE), graph, documents, memories, review, search, profile and settings.
- **Browser extension:** a WXT Chrome extension with a connect form for the server URL and API key. No analytics, and host permissions are limited to localhost.
- **Single user:** one static API key from env. No orgs, seats, roles, billing, rate limiting or telemetry.
- **Runtime:** Bun + TypeScript + Hono, one process. `start.sh` runs Postgres and Ollama services, the API and the UI. The server binds to 127.0.0.1 by default.

## Testing Decisions

- **A good test** exercises externally observable behaviour through a public seam: HTTP responses, MCP tool results, rows visible through list endpoints. It never asserts on internal function calls, prompt text or intermediate tables. Tests should survive a rewrite of the internals.
- **Seam 1, API contract:** a generated test client runs against a real Postgres. It covers add, batch, file upload, get, patch, delete, search (modes, filters, threshold, include options), profile and buckets, memories get, forget and semantic forget, list endpoints, namespaces and the v3/v4 compatibility routes.
- **Seam 2, engine scenarios:** run through the same API, with a fake OpenAI-compatible LLM that returns scripted outputs keyed on the input. Scenarios:
  - an update chain produces `updates`, `extends` and `derives`; the old fact is not latest; the inference is flagged;
  - a duplicate preference strengthens;
  - a temporary fact expires after its date;
  - an episode decays to forgotten;
  - an unchanged re-ingest under the same custom ID is a no-op;
  - ordering within a namespace is respected;
  - review approve and decline;
  - semantic forget dry run, then for real, with the cap;
  - forgotten memories are hidden by default and returned with include-forgotten;
  - the profile reflects the latest state after an update.
- **Seam 3, MCP:** an MCP SDK client connects to `/mcp` and calls every tool. It checks results, active-space persistence across calls, and error handling.
- **Planned:** a fixture HTTP server per connector provider (OAuth exchange, first import, incremental update, document limit). A small real-model eval set, run separately and not gating, tracks extraction quality.
- **Not tested directly:** the web UI (build and typecheck only) and the browser extension (build and typecheck, plus the server routes it calls). Real-browser verification of the extension is still to do.

## Out of Scope

- Billing, credits, metering, plans and plan gates.
- Multi-user: orgs, seats, roles, SSO, 2FA.
- Compliance work (SOC 2, HIPAA, GDPR tooling).
- Rate limiting, SLAs, status page, analytics and telemetry.
- A marketing site, docs site, blog and changelog.
- Team and workplace features such as Slack integration or automations.
- A hosted or public deployment. Localhost or Tailscale only.

## Further Notes

- **Not verified:** the extension in a real browser (loading, popup connect form, save-page, auto-recall in ChatGPT and Claude), and the decay constants on real data.
- **Biggest risk:** extraction and relation quality is the product. The fake-LLM scenarios guarantee the mechanics; only a real-model eval set guarantees usefulness.
- **Delivery order:**
  1. Ingest and chunk search. (done)
  2. The Dreamer, with memories and hybrid search. (done)
  3. Profiles and forgetting. (done)
  4. MCP. (done)
  5. The web UI. (done)
  6. Rich file types. (done for PDF, DOCX and text formats; images and audio are not started)
  7. The extension. (built; real-browser verification pending)
  8. Connectors: Notion, Drive, Gmail, each needing its own OAuth app.
  9. Images (vision model) and audio (whisper).
  10. The extras: Apple Shortcut, Raycast, filesystem view.
