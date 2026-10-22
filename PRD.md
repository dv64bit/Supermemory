---
title: Personal Supermemory — self-hosted memory engine with full product parity
labels: [ready-for-agent]
created: 2026-10-22
source: REA capture of supermemory.ai + public OpenAPI v4/v5 (ref/) + MIT repo supermemoryai/supermemory
related: PLAN.md
---

## Problem Statement

I use several AI tools every day: Claude, ChatGPT, Cursor, Claude Code and others. None of them remembers anything about me across sessions or across tools. Everything I save (notes, links, PDFs, Notion pages, Drive files, emails) sits in separate silos, and my assistants can't see any of it.

Supermemory.ai solves this as a hosted product. It turns everything I feed it into atomic facts that evolve over time, keeps a standing profile of me, and serves that memory to any model through an API, MCP and plugins. I don't want to depend on it for three reasons:

- It is a paid, metered SaaS with plan-gated features. Gmail needs Max; GitHub, S3, the crawler and advanced PDF extraction need Scale.
- My personal data would live on someone else's infrastructure.
- Its consumer app and browser extension were pulled from the public repo in September 2026. app.supermemory.ai now only redirects to the developer console.

I want the same capabilities, owned and run by me, for my own use.

## Solution

A self-hosted personal memory server that implements Supermemory's public v5 API contract, so the official SDKs, the MIT-licensed MCP server, the AI SDK tools, the browser extension and the coding plugins all work against it by changing one base URL. On top of it:

- **Memory engine:** ingests text, URLs, files and connector data, then:
  - extracts atomic, typed memories;
  - links them through `updates` / `extends` / `derives` relations, with versioning and soft-forgetting;
  - keeps a static/dynamic user profile;
  - serves hybrid search over memories and chunks.
- **Forked consumer web app:** notes, links, uploads, spaces, chat over memories, graph view, timeline and inferred-memory review.
- **Forked browser extension:** save and auto-recall inside ChatGPT, Claude, Gemini and Grok, plus X bookmarks import.
- **Connectors:** Notion, Google Drive, Gmail, OneDrive, GitHub, Granola, S3 and a web crawler, each keeping my sources in sync automatically.

Everything runs on one machine with Postgres and a local or OpenAI-compatible LLM. There is no billing, no orgs and no plan gates: every feature is on.

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
15. As the owner, I want to choose RAG-only ingest (`superrag`) for some documents, so that reference material is searchable without generating memories.
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
84. As the owner, I want the official `supermemory` TypeScript and Python SDKs to work against my server by setting a base URL, so that I can reuse the whole ecosystem.
85. As the owner, I want an MCP server exposing search_memory, add_memory, forget_memory, get_profile, list_documents, get_document, list_memories, list_spaces and who_am_i, so that Claude Desktop, Claude Code, Cursor and others can use my memory.
86. As the owner, I want MCP resources for my profile and spaces, and a context prompt, so that clients can preload who I am.
87. As the owner, I want the MCP server to remember my active space, so that I don't pass a namespace on every call.
88. As the owner, I want `withSupermemory` AI SDK middleware to work against my server, so that any app I build injects my profile and saves conversations.
89. As the owner, I want the Claude Code and Cursor plugins to capture and recall against my server, so that my coding assistants remember my projects.
90. As the owner, I want legacy v3/v4 endpoints shimmed where my clients still call them, so that older plugins and the extension work.

### Consumer web app
91. As the owner, I want a rich-text note editor with slash commands, so that writing memories is pleasant.
92. As the owner, I want a grid of my documents with type-specific previews (tweet, YouTube, Notion, Google Docs, website, PDF, image), so that I can browse my knowledge.
93. As the owner, I want a command palette over my documents, so that I can jump to anything fast.
94. As the owner, I want to create, edit and switch spaces in the UI, so that I can manage namespaces visually.
95. As the owner, I want an interactive memory graph view, so that I can see how facts connect and evolve.
96. As the owner, I want a timeline view, so that I can see memory over time.
97. As the owner, I want to chat with my memories, with related-memory cards, model selection and attachments, so that I can ask questions over everything I know.
98. As the owner, I want the review modal for inferred memories in the UI, so that curation is easy.
99. As the owner, I want a settings screen for API keys, connectors, profile buckets and the ingest filter prompt, so that I can configure everything without curl.
100. As the owner, I want the app installable as a PWA, so that it works like a native app on my phone.

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
108. As the owner, I want the whole system to start with one docker-compose command, so that setup is trivial.
109. As the owner, I want to choose any OpenAI-compatible LLM (Ollama, OpenRouter, Anthropic-compatible), so that I control cost and privacy.
110. As the owner, I want local embeddings by default, so that ingest works offline and free.
111. As the owner, I want the server bound to localhost (or Tailscale) and protected by an API key, so that my memory isn't exposed.
112. As the owner, I want a health endpoint, so that I can monitor it.
113. As the owner, I want database backups to be plain Postgres dumps, so that recovery is standard.

## Implementation Decisions

- **API contract is the spine.** The server implements Supermemory's public v5 API (`/ns/{namespace}/…` routes for document, document/batch, document/file, search, profile, profile/buckets, memories, memories/semantic, list/{documents|chunks|memories}, namespaces and connectors). Request and response shapes follow the downloaded v5 OpenAPI spec exactly, with types generated from it. Auth is `Authorization: Bearer <api key>`.
- **Legacy v3/v4 routes** are thin adapters over the v5 handlers, added only when a real client needs them: v3 documents and search, v4 search, profile and memories, v3 projects and health.
- **Modules (deep, small interfaces):**
  - **Extractor:** `(input: text | url | file) → { text, type, title, previewMeta }`. Hides per-type logic: readability for HTML, PDF parsing and OCR, office parsing, vision LLM for images, whisper for audio and video, oEmbed and transcripts for tweets and YouTube.
  - **Chunker:** `(text, type) → chunks[]`. Structure-aware: markdown headings, whole code fences, sentence boundaries with about 200 characters of overlap, optional contextual prefix.
  - **Embedder:** `(texts) → vectors`. Local bge-base-en-v1.5 at 768 dimensions by default; the provider is swappable. The dimension is locked once data exists.
  - **Dreamer (memory formation):** `(document, namespace) → memory writes and edges`. Extracts typed atomic facts, retrieves the nearest latest memories, classifies each candidate as new, duplicate, updates or extends, then runs a derive pass. Applies versioning, strength and expiry.
  - **Retriever:** `(namespace, searchRequest) → results`. Hybrid vector + full-text with reciprocal-rank fusion, the filter-tree compiler, threshold and latest/forgotten gating, optional rerank, aggregate, rewrite and related-edge expansion.
  - **Profiler:** `(namespace) → { static, dynamic, buckets }`. LLM summary of the latest non-forgotten memories, cached per namespace and rebuilt on change.
  - **Forgetter:** expiry sweep, episode decay, ID-based soft-forget, semantic forget with dry run and a cap.
  - **Connector framework:** one provider interface `{ authorize, listChanges(cursor), fetch(item), verifyWebhook }`, with eight implementations. A scheduler runs the first full import, webhooks and a four-hour reconcile, honours the document limit, and stores tokens encrypted with AES-GCM.
  - **LLM client:** a single OpenAI-compatible client with JSON-schema structured outputs. Every LLM-dependent module goes through it, which is the seam for the fake LLM in tests.
- **Storage:** Postgres with pgvector (HNSW, cosine) and tsvector. Tables: namespaces, documents (unique on namespace and custom ID, content hash for no-op re-ingest), chunks, memories (kind, is_latest, is_inference, is_forgotten, forget_after, strength, version chain, temporal context, metadata), memory_edges (updates, extends, derives), profiles cache, profile_buckets, connectors and sync history. No separate graph database; graph traversal uses SQL.
- **Jobs:** pg-boss on the same Postgres. Ingest is serialised per namespace (a singleton key per namespace). Dreaming runs as a follow-on job unless `instant` is requested. An hourly cron handles expiry, decay and profile rebuilds; a four-hour cron reconciles connectors.
- **Decay:** episodes lose strength daily (start at a factor of 0.98/day) and are soft-forgotten below a threshold. Preferences gain strength on duplicate detection. Facts persist until updated. Upstream publishes no formula; the constants are tunable through config.
- **MCP:** fork the MIT `apps/mcp` server. Replace Cloudflare OAuth with API-key auth against this server. Keep the tool names and schemas, the resources (profile, spaces), the context prompt and active-space persistence.
- **Web app:** fork the MIT consumer app at upstream commit `4d8a4ebf`. Remove billing (Autumn), orgs and the "company brain" features. Repoint it to this API. Chat uses the AI SDK with `withSupermemory` middleware against this server.
- **Browser extension:** fork the MIT WXT extension at the same commit, with the API base made configurable.
- **Coding plugins:** use them unmodified through base-URL env vars where supported; fork only if the URL is hard-coded.
- **Single user:** one static API key from env. No orgs, seats, roles, billing, rate limiting or telemetry.
- **Runtime:** Bun + TypeScript + Hono. One API process and one worker process. docker-compose with Postgres. The server binds to 127.0.0.1 by default.

## Testing Decisions

- **A good test** exercises externally observable behaviour through a public seam: HTTP responses, MCP tool results, rows visible through list endpoints. It never asserts on internal function calls, prompt text or intermediate tables. Tests should survive a rewrite of the internals.
- **Seam 1, API contract (highest):** the official `supermemory` npm SDK runs against a live server with a real Postgres. It covers add, batch, file upload, get, patch, delete, search (all modes, filters, threshold, include options), profile and buckets, memories get, forget and semantic forget, list endpoints and namespaces. This proves compatibility with the ecosystem: if the SDK passes, the tools and plugins should pass too. Response bodies are also validated against the generated v5 schemas.
- **Seam 2, engine scenarios:** run through the same API, with a fake OpenAI-compatible LLM server that returns scripted structured outputs keyed on the input. Scenarios:
  - Google→Stripe update chain: `updates`, `extends` and `derives` produced; old fact not latest; inference flagged.
  - Duplicate preference strengthens.
  - Temporary fact expires after its date.
  - Episode decays to forgotten.
  - Unchanged re-ingest under the same custom ID is a no-op.
  - Ordering within a namespace is respected.
  - Review approve and decline.
  - Semantic forget dry run, then for real, with the cap.
  - Forgotten memories hidden by default and returned with include-forgotten.
  - Profile reflects the latest state after an update.
  
  A separate, non-gating eval job runs the same scenarios plus a personal 50-sample set against a real model to track extraction quality.
- **Seam 3, MCP:** an MCP SDK client connects to the forked server (backed by the live API) and calls every tool. It checks results, the active-space persistence across calls, resources and the context prompt.
- **Seam 4, connectors:** a fixture HTTP server per provider fakes the Notion, Drive, Gmail, OneDrive, GitHub, Granola and S3 APIs, OAuth token exchange and webhook delivery. Tests cover:
  - first import;
  - webhook-driven updates propagating to search;
  - reconcile catching a missed change;
  - document limit enforced;
  - 409 on a concurrent sync;
  - disconnect with and without deletion;
  - tokens unreadable in raw database rows.
  
  The web crawler is tested against a local static site with robots.txt.
- **Not tested directly:** the forked web app and extension get a small Playwright smoke test each (capture → appears in search), not unit tests.
- **Prior art:** none yet; this is a greenfield repo. Upstream's MIT `packages/tools` and `apps/mcp` tests serve as references for MCP and AI SDK behaviour, and MemoryBench (upstream, open) is the reference for the eval harness.

## Out of Scope

- Billing, credits, metering, plans and plan gates (Autumn).
- Multi-user: orgs, seats, roles, per-tag access, SSO, 2FA, team versus personal memory separation.
- Compliance work (SOC 2, HIPAA, GDPR tooling), air-gapped enterprise packaging.
- Rate limiting, custom metering, SLAs, status page, analytics and telemetry.
- The marketing site, docs site, blog and changelog.
- The "company brain" pivot features: Slack, skills, proactivity, automations.
- Matching upstream's proprietary extraction models one-to-one. Quality is pursued through prompts and model choice and measured with the eval set, not cloned.
- The Memory Router / "infinite chat" proxy (it appears deprecated upstream; `withSupermemory` covers the use case).
- A hosted or public deployment. Localhost or Tailscale only.

## Further Notes

- **Evidence base:**
  - REA captures of supermemory.ai /, /product and /pricing, and of app.supermemory.ai (which shows a "We moved" redirect to console.supermemory.ai).
  - The live OpenAPI v4 and v5 specs and the docs `llms-full.txt`, saved in `ref/`.
  - The MIT repo `supermemoryai/supermemory`, including history at `4d8a4ebf` (the last version with the consumer app and extension) and `5b35e3ea` (the old open backend: Postgres, pgvector 768d, HNSW, tsvector).
- **Not verified:**
  - The current console.supermemory.ai UI (it needs a login). Rerun the REA capture with a session cookie if an account exists, to diff it against the forked app.
  - Whether the Chrome extension is still published.
  - The exact decay algorithm.
- **Reference oracle:** upstream's free "Supermemory local" binary (`npx supermemory local`) speaks the same API. Run it side by side to compare engine outputs on identical inputs while tuning the Dreamer.
- **Biggest risk:** extraction and relation quality is the product. The fake-LLM scenarios guarantee the mechanics; only the real-model eval set guarantees usefulness.
- **Delivery order:**
  1. Ingest and chunk search.
  2. The Dreamer, with memories and hybrid search.
  3. Profiles and forgetting.
  4. MCP (a usable product from this point).
  5. The web app.
  6. Rich file types.
  7. Connectors.
  8. The extension.
  9. The plugins.
  10. The extras.
