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

## Done

(none yet)
