# Resume notes v2 (2026-10-22)

Supersedes `NEXT.md`. Priority changed: **engine quality and evaluation come before the browser extension.** The extension work isn't lost; it's parked as P7 with v1's exact steps kept below.

## Where things stand (from v1 notes; P0 verifies)

- The owner works on their own branch; ignore branches and git history.
- v1 notes report v3/v4 legacy shims in `server/src/legacy.ts`, tested in `test/contract.test.ts`, with 28 tests passing. Verify this by running the suite.
- Running pieces: API (Bun, :6767), web app (:5173), MCP over HTTP at `/mcp`.

## P0 status (2026-10-22): report written, decisions recorded

`docs/v2/GAP_REPORT.md` is done. Real test count: 28 server tests (9 contract, 15 engine, 4 MCP) + 1 web test, all green when warm. The contract file-upload test flakes on a cold start (5 s default timeout).

Owner decisions:
1. **v5 shape mismatches** (profile `buckets` → 400; `memories/{id}?include=documents` ignored; chunk search hits missing `isLatest`/`isInference`; `list?sort=` ignored): fix them inside the phase that touches that code, not as a separate step. `include`/`buckets` → P4 (retrieval/profile); chunk result fields → P4; `sort` → P4 (or earlier if a list endpoint is touched).
2. **LLM:** local Ollama only, no paid APIs. The owner is setting it up; E2/E3 wait for a go.
3. **Oracle (Supermemory local):** deferred until building is done. Tracked in `docs/v2/DEFERRED.md` (the list of things we skip for now and must come back to). Until then, E3 compares against plain RAG and our own past runs.
4. **Deleted or edited documents:** their memories are kept as history with an end date (`valid_to`), not forgotten. Goes into P3 (Policy).
5. **v2 docs:** moved into `docs/v2/`.

## Done: P0, understand the codebase and audit (no feature code)

1. Read all docs, `ref/`, and all source (skip node_modules, build output, lockfiles, vendored code). Run the test suite and record the real pass/fail count.
2. Write `docs/v2/GAP_REPORT.md`:
   - An architecture map of what is actually built (processes, modules, ingest→search data flow), with file paths.
   - For each section of PLAN.md v1 and PLAN.v2.md: status `done | partial | missing`, with file paths.
   - Contract check: diff the implemented routes against `ref/v5.json` (missing routes, shape mismatches).
   - The current prompts and LLM call sites, with weaknesses mapped to the 7 failure modes in PRD.v2.
   - The current schema vs PLAN.v2 §2.
   - Test inventory and coverage gaps.
   - Where the docs disagree with the code, and recommended adjustments to the v2 phase plan.
3. Owner reviews the report before P1.

## Then: P1, eval baseline on the current engine

- Extend the fake LLM so it records every request it receives (needed to test secret redaction).
- Add the E1 v2 scenarios (PRD.v2 Testing) as `test.todo` or expected-fail, so they show up as the target list.
- Add `eval/` with E2 runners and the first synthetic sets (generated, then spot-checked), plus `eval/private/` (git-ignored).
- Wire MemoryBench (upstream, open source) against: our server, Supermemory local (`npx supermemory local`) with the same LLM endpoint, and a chunk-only RAG baseline.
- Record baseline numbers in `eval/runs/` and summarise them in `docs/v2/BASELINE.md`.

## After that

P2 schema + router + guard → P3 Dreamer v2 → P4 Retrieval v2 + context + `as_of` → P5 review/conflict UI + explain → P6 re-dream → P7 extension → P8 files + connectors → P9 learner-lite → P10 extras. Full detail is in PLAN.v2.md §8.

## Parked: P7 browser extension fork (steps from v1, still valid)

- Upstream MIT source is at commit `4d8a4ebfddadc3430f7f59a752cd374670833f50`, path `apps/browser-extension` (WXT + React). **Verify the licence and contents first.**
  Fetch with: `gh api repos/supermemoryai/supermemory/tarball/<sha> > repo.tgz && tar -xzf repo.tgz '*/apps/browser-extension/*'`
- Copy it to `extension/` and keep the MIT notice. Then:
  1. `utils/constants.ts`: make the API base come from storage (`serverUrl`, default `http://127.0.0.1:6767`). `utils/api.ts` already sends `Authorization: Bearer <bearerToken>`.
  2. Popup (`entrypoints/popup/App.tsx` ~L280, ~L1349) and `welcome/Welcome.tsx`: replace the cloud login with a form for server URL + API key, validated via `GET /v3/projects`.
  3. `entrypoints/content/shared.ts` ~L128: remove the token capture from app.supermemory.ai.
  4. Stub `utils/posthog.ts` (no analytics). In `wxt.config.ts`, drop the supermemory/posthog hosts and add `http://127.0.0.1/*` and `http://localhost/*`.
  5. Optional: restyle the popup with affectUI tokens (`web/src/index.css`).
  6. New in v2: auto-recall calls `POST /ns/{ns}/x/context` with a small token budget instead of raw search.

## Running

- API: `cd server && SUPERMEM_API_KEY=dev bun --watch src/index.ts` (127.0.0.1:6767)
- Web: `cd web && bun run dev` (localhost:5173). On first open, enter the API key in Settings.
- MCP: `claude mcp add --scope user --transport http supermem http://127.0.0.1:6767/mcp --header "Authorization: Bearer dev"`
- Oracle (P1+): `npx supermemory local`, with `OPENAI_BASE_URL`/`OPENAI_MODEL` set to the same model as ours. Run it on a different port from ours (6767 is the default for both).
- Evals (to be created in P1): `bun run eval:e1`, `bun run eval:e2`, `bun run eval:e3 --slice 50`, `bun run eval:compare <runA> <runB>`
