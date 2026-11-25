# Where we are now (v2)

This file is overwritten as work moves. History lives in `DEVLOG.md`; things skipped on purpose live in `DEFERRED.md`. Supersedes `NEXT.md`.

## Current state (2026-11-25)

- **Phase:** P3 (Dreamer v2) is committed (`b1dde6d`), with fixes on top (DEVLOG 2026-11-25) after a collaborator's V1 vs V2 benchmark (`BENCH-v1-v2.md`). That benchmark showed V2 dropping too many correct facts.
- **Tests:** 91 pass, 0 fail, 4 todo (P4/P6). Web 1/1.
- **Not measured:** the fixes haven't been checked with a real model yet. This machine (WSL, 4.9 GB RAM) can't run `qwen3:4b-instruct` at a usable speed, and the collaborator's harness isn't in the repo.
- **LLM:** local Ollama only (`qwen3:4b-instruct`; `qwen3:1.7b` is installed but not comparable). No paid APIs.
- **Eval/test database:** local role `supermem`; the URLs are in `server/.env` (git-ignored).

## Next

- **When a machine can run the 4b model:**
  1. Run `cd server && LLM_MODEL=qwen3:4b-instruct bun run eval:e2`.
  2. Run `bun run eval:compare` against the P1 runs.
  3. Watch `rejected_by_grounding` and the false-UPDATE rate. The same-slot rule could raise false updates.
- **P4:** Retrieval v2, `x/context` (which also carries the D9 profile, DEFERRED #3, and the sensitive filter for chat), `as_of`, the latency budget (which now includes V2 ingest, ~3x V1), and the v5 mismatches.

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
- **Database:** the server applies pending migrations on start. By hand: `bun run db:status`, `db:migrate`, `db:rollback [steps]` (rollback is for development). Migrations live in `server/src/migrations/NNNN_name.{up,down}.sql`. Never edit one that has been applied; add a new one.
- **Tests:** `cd server && bun run test`. This needs Postgres with pgvector and a role that can create databases. Set `TEST_DATABASE_URL` if the default `postgres://localhost/postgres` doesn't work. The first run downloads the bge embedding model.
- **Evals:** from `server/`, run `bun run eval:e1`, `eval:e2 [--only name]`, `eval:latency`, `eval:compare`. See `eval/README.md`.
