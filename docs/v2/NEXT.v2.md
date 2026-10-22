# Where we are now (v2)

This file is overwritten as work moves. History lives in `DEVLOG.md`; things skipped on purpose live in `DEFERRED.md`. Supersedes `NEXT.md`.

## Current state (2026-10-22)

- **Phase:** P1, eval baseline on the current engine. All P1 code is done; P1 closes once the real-model E2 numbers are in.
- **Checkpoints:**
  - A is committed and pushed.
  - B, C and D are done, waiting for the owner to commit and push them together.
- **Tests:** E1 has 33 passing, 0 unexpected failures, 16 todos and 12 open targets. Web 1/1.
  - The targets are `target()` / `test.failing`.
  - `SHOW_TARGETS=1 bun test` shows why each one fails.
- **Baselines so far (current engine):**
  - Retrieval: recall@10 0.844, MRR 0.770.
  - Latency at 100k memories: search p95 989 ms (memories) and 1,376 ms (hybrid), profile p95 673 ms. All over budget.
  - The 0.92 near-duplicate shortcut is wrong on 5 of the 10 relation cases it decides; 3 of those are true numeric updates it throws away.

  See DEVLOG and `eval/runs/`.
- **LLM:** fake only. The owner is setting up local Ollama. No paid APIs.
- **Branch:** `v2-dev` (tracks `origin/v2-dev`). The owner commits and pushes; Claude proposes the commands.
- **Owner to do:** spot-check the four hand-written sets in `eval/data/` (retrieval, extraction, relation, grounding).

## Next

- **When Ollama is up:** `cd server && LLM_BASE_URL=http://localhost:11434/v1 LLM_MODEL=<model> bun run eval:e2`. Check the judge's accuracy on the grounding set before trusting the judge's other numbers.
- **Then:** write `docs/v2/BASELINE.md` (all P1 numbers in one place). That ends P1.
- **After that:** P2 (schema v2 migrations + migration runner, audit tables, secret guard).

## Standing decisions

- **v5 mismatches (5):** profile `buckets`, `include=documents`, chunk `isLatest`/`isInference`, `list?sort=` and list returning only one array get fixed in the phase that touches them (mostly P4). Each has a `test.failing`, plus an entry in `KNOWN_V5_MISMATCHES` (`server/test/v5-schema.ts`) that you remove once it's fixed.
- **Deleted or edited documents:** their memories are kept as history with `valid_to` set (P3 Policy).
- **Deferred** (`DEFERRED.md`): #1 the Supermemory local oracle comparison, after building; #2 the E3 end-to-end benchmark (MemoryBench needs paid APIs).

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
- **Evals:** from `server/`, run `bun run eval:e1`, `eval:e2 [--only name]`, `eval:latency`, `eval:compare`. See `eval/README.md`.
