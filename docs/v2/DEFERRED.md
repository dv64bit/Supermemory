# Deferred items

Things we have decided to skip for now and must come back to. Each entry says why it was deferred and when to pick it up. When an item is done, move it to the "Done" section with the date and a link to the commit or report.

## Open

### 1. Benchmark against Supermemory local (the "oracle")

- **Added:** 2026-10-22
- **What:** Run Supermemory's free, closed-source engine ("Supermemory local", via `npx supermemory local` or its Docker image) next to our server. Feed both the same MemoryBench conversations and questions (LongMemEval-S, LoCoMo, ConvoMem), with both pointed at the same local Ollama model, and compare accuracy per category, latency and tokens. This is how "match or beat Supermemory" becomes a number (PRD.v2 metrics table, PLAN.v2 §5 E3).
- **Why deferred:** The owner chose to do it once building is done.
- **Until then:** E3 compares our engine only against a plain chunk-RAG baseline and against our own earlier runs.
- **Before running it, check:**
  - whether it works with an Ollama endpoint;
  - whether it needs an account or contacts Supermemory's servers;
  - its licence terms.
- **Rules:** Use it only as a black box through its public API, never decompile or copy it. Run it on a different port from ours (both default to 6767).
- **When:** After the v2 engine and retrieval are built (after P6 at the earliest).

### 2. E3 end-to-end benchmark (MemoryBench: LongMemEval-S, LoCoMo, ConvoMem)

- **Added:** 2026-10-22 (P1-D)
- **What:** Ingest each benchmark's conversations into our server, answer its questions from retrieved memory, and judge the answers. Report accuracy per category (knowledge update, temporal reasoning, multi-session, abstention), latency and tokens. Do the same for a plain-RAG baseline. PLAN.v2 §5 E3; it is also the harness the oracle comparison (#1) needs.
- **Why deferred:** The owner's call. As published, MemoryBench (`github.com/supermemoryai/memorybench`, MIT, checked 2026-10-22) cannot run without paid APIs, which this project doesn't use:
  - Its answering and judge models are hard-wired to OpenAI, Anthropic or Google, with fixed model IDs (`src/utils/models.ts`, `src/orchestrator/phases/answer.ts`, `src/judges/*`).
  - Its `rag` baseline uses OpenAI embeddings.
  - Its `supermemory` provider already speaks the v5 API and honours `SUPERMEMORY_BASE_URL`, so it can target our server without changes.
  - Datasets download at run time (LongMemEval-S from Hugging Face `xiaowu0162/longmemeval-cleaned`).
- **Options found** (pick one when this is picked up):
  - **a.** A small runner of our own in `eval/e3/`. It would use the same datasets and ingest sessions the way MemoryBench's supermemory provider does. Answering and judging run on Ollama through our LLM router, reusing MemoryBench's answer and judge prompts with their MIT notice. The plain-RAG baseline is our server in chunks-only mode.
  - **b.** Fork MemoryBench's `src/` (MIT notice kept) and patch it for an OpenAI-compatible endpoint. This stays closest to upstream, but brings ~70 files and new dependencies.
- **Until then:** quality is measured by E2 (extraction, relation, grounding, retrieval) only. There is no end-to-end QA accuracy number, and no "≥ Supermemory" claim can be made.
- **When:** Once local Ollama is running and E2 has a real-model baseline; at the latest before the oracle benchmark (#1).

## Done

(none yet)
