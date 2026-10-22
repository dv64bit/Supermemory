# Where we are now (v2)

This file is overwritten as work moves. History lives in `DEVLOG.md`; things skipped on purpose live in `DEFERRED.md`. Supersedes `NEXT.md`.

## Current state (2026-10-22)

- **Phase:** P1, eval baseline on the current engine. P0 (`GAP_REPORT.md`) is done.
- **Checkpoint:** A (LLM router, cache, call log, fake-LLM upgrades, test fixes) is done. Waiting for the owner to commit it.
- **Tests:** server 33/33 green, web 1/1.
- **LLM:** fake only. The owner is setting up local Ollama, and real-model evals wait for their go. No paid APIs.
- **Branch:** `main`. The owner commits from their own terminal using the message Claude proposes at each checkpoint.

## Next

- **B.** E1 v2 scenarios (PRD.v2 Testing) and the confirmed bugs from the gap report, as `todo` tests. Check contract responses against `ref/v5.json`, with the 4 known mismatches allowed until P4.
- **C.**
  - `eval/` folder, `bun run eval:*` scripts, run files in `eval/runs/` and a compare command;
  - `eval/private/` ignored by git (the repo is public);
  - retrieval eval with baseline numbers;
  - latency test at 10k and 100k memories.
- **D.** E2 labelled sets (extraction, relation, grounding) and the MemoryBench runner against ours and a plain-RAG baseline, smoke-tested with the fake LLM.
- **Once Ollama is ready:** run E2/E3 and write `docs/v2/BASELINE.md`.

## Standing decisions

- **v5 mismatches:** profile `buckets`, `include=documents`, chunk `isLatest`/`isInference` and `list?sort=` get fixed in the phase that touches them (mostly P4).
- **Deleted or edited documents:** their memories are kept as history with `valid_to` set (P3 Policy).
- **Oracle:** benchmarking against Supermemory local happens after building (`DEFERRED.md` #1).

## After P1

P2 schema + migrations + guard → P3 Dreamer v2 → P4 Retrieval v2 + context + `as_of` → P5 review/conflict UI + explain → P6 re-dream → P7 extension → P8 files + connectors → P9 learner-lite → P10 extras. Detail is in PLAN.v2.md §8.

## Parked: P7 browser extension fork (steps from v1, still valid)

- **Source:** upstream MIT source is at commit `4d8a4ebfddadc3430f7f59a752cd374670833f50`, path `apps/browser-extension` (WXT + React). **Verify the licence and contents first.**
  Fetch with: `gh api repos/supermemoryai/supermemory/tarball/<sha> > repo.tgz && tar -xzf repo.tgz '*/apps/browser-extension/*'`
- **Setup:** copy it to `extension/` and keep the MIT notice. Then:
  1. In `utils/constants.ts`, make the API base come from storage (`serverUrl`, default `http://127.0.0.1:6767`). `utils/api.ts` already sends `Authorization: Bearer <bearerToken>`.
  2. In the popup (`entrypoints/popup/App.tsx` ~L280, ~L1349) and `welcome/Welcome.tsx`, replace the cloud login with a form for server URL + API key, validated via `GET /v3/projects`.
  3. In `entrypoints/content/shared.ts` ~L128, remove the token capture from app.supermemory.ai.
  4. Stub `utils/posthog.ts` (no analytics). In `wxt.config.ts`, drop the supermemory/posthog hosts and add `http://127.0.0.1/*` and `http://localhost/*`.
  5. Optional: restyle the popup with affectUI tokens (`web/src/index.css`).
  6. New in v2: auto-recall calls `POST /ns/{ns}/x/context` with a small token budget instead of raw search.

## Running

- **API:** `cd server && SUPERMEM_API_KEY=dev bun --watch src/index.ts` (127.0.0.1:6767).
- **Web:** `cd web && bun run dev` (localhost:5173). On first open, enter the API key in Settings.
- **MCP:** `claude mcp add --scope user --transport http supermem http://127.0.0.1:6767/mcp --header "Authorization: Bearer dev"`
- **Tests:** `cd server && bun run test`. This needs Postgres with pgvector and a role that can create databases. Set `TEST_DATABASE_URL` if the default `postgres://localhost/postgres` doesn't work. The first run downloads the bge embedding model.
- **Evals (built in P1):** `bun run eval:e1`, `bun run eval:e2`, `bun run eval:e3 --slice 50`, `bun run eval:compare <runA> <runB>`.
