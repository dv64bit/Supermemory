# Where we are now (v2)

This file is overwritten as work moves. History lives in `DEVLOG.md`; things skipped on purpose live in `DEFERRED.md`. Supersedes `NEXT.md`.

## Current state (2026-11-25)

- **Phase:** P4 (Retrieval v2, `x/context`, `as_of`, latency, v5 mismatches) is done and waits for the owner's commit. P3 fixes were committed as `1b8f0e7`.
- **Numbers:**
  - retrieval recall@10 0.955 (P1 0.844);
  - latency in budget at 100k (search p95 209 / 98 ms, profile 34 ms, `x/context` 222 ms).
  - Details: BASELINE.md, "P4 results".
- **Tests:** E1 97 pass, 0 fail, 1 todo (re-dream, P6), 0 targets open. Web 1/1.
- **Not measured:** P3's LLM steps with a real model since the fixes. This machine (WSL, 4.9 GB RAM) can't run `qwen3:4b-instruct` usefully.
- **Open risk:** DEFERRED #9, the Bun SQL parameter mix-up. It is mitigated, but the root cause isn't confirmed.
- **LLM:** local Ollama only. **DB:** local role `supermem`, URLs in `server/.env`.

## Next

- **P5 (in progress):** server side done (review inbox, explain, `explain_memory`, routes under `/x/`). Left: the web review screen with keep new / keep old / keep both / merge, a "Why do I know this?" panel on memory details, and `/chat` under `/x/`.
- **When a machine can run the 4b model:**
  - re-run `eval:e2` (extraction, relation, grounding) and compare with P1;
  - add the entity retrieval set (DEFERRED #7).
- **Soon:** a minimal repro for DEFERRED #9, and a check on a newer Bun.

## Standing decisions

- **v5 mismatches:** all 5 fixed in P4; every response in the contract test is validated against `ref/v5.json` with no allowances.
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
- **Database:** the server applies pending migrations on start. By hand: `bun run db:status`, `db:migrate`, `db:rollback [steps]` (rollback is for development). Migrations live in `server/src/migrations/NNNN_name.{up,down}.sql`. Never edit one that has been applied; add a new one.
- **Tests:** `cd server && bun run test`. This needs Postgres with pgvector and a role that can create databases. Set `TEST_DATABASE_URL` if the default `postgres://localhost/postgres` doesn't work. The first run downloads the bge embedding model.
- **Evals:** from `server/`, run `bun run eval:e1`, `eval:e2 [--only name]`, `eval:latency`, `eval:compare`. See `eval/README.md`.
- **Retrieval extensions:** `POST /ns/{ns}/x/search` (v5 body + `asOf`, `history`), `POST /ns/{ns}/x/context` (`query`, `budgetTokens`). Ranking weights are in `server/lifecycle.yaml` (`retrieval`).
