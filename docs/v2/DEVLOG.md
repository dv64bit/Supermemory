# Dev log (v2)

Permanent, append-only history of v2 work. Add one dated entry per step or checkpoint: what changed, why, test results and decisions. Never rewrite past entries; correct them with a new entry.

- For "where we are now", see `NEXT.v2.md`, which is overwritten as work moves.
- For things skipped on purpose, see `DEFERRED.md`.

---

## 2026-10-22: P0 audit and gap report

**What changed**

- Read all docs, `ref/` and every source file in `server/` and `web/`. The web UI was read by a subagent; its report was checked against `server/src/app.ts`.
- Wrote `docs/v2/GAP_REPORT.md`. It covers:
  - the architecture map;
  - per-section status against PLAN v1 and v2;
  - the v5 contract diff;
  - every LLM call site, mapped to the 7 failure modes;
  - the test inventory;
  - where docs and code disagree;
  - recommended plan changes.
- Six engine and contract claims were confirmed through the public API with a throwaway probe test, deleted afterwards:
  - **Version fork:** two candidates updating the same memory both become `version=2, is_latest=true`.
  - **Update swallowed:** "Kim has 3 children" after "Kim has 2 children" is discarded as a duplicate (cosine 0.934 ≥ the 0.92 near-duplicate shortcut). Strength goes up and the old fact stays latest.
  - **Deleted documents:** their memories stay live in search.
  - **`include=documents`:** `GET /memories/{id}?include=documents` returns no document (the code checks `"document"`).
  - **Profile `buckets`:** `POST /profile` with `buckets` returns 400 (strict schema).
  - **Chunk results:** chunk search results lack the spec-required `isLatest` and `isInference`.

**Why**

PLAN.v2 §8 P0: understand what exists before changing anything.

**Environment (local machine, not the repo)**

Installed bun 1.3.5 (npm global) and `postgresql-16-pgvector` 0.6.0 (apt). Created a Postgres superuser `root` with password `root`, because the tests connect as the OS user without a password.

**Test results**

| Suite | Result |
|---|---|
| server/contract | 9/9 warm. The file-upload test timed out at bun's 5 s default in 3 of the first 4 cold runs |
| server/engine | 15/15 |
| server/mcp | 4/4 |
| web/sse | 1/1 |
| `tsc` | clean |
| `oxlint` | 0 errors, 3 warnings |

28 server tests in total, which matches the v1 notes.

**Decisions**

None yet; questions raised for the owner.

---

## 2026-10-22: owner decisions on the gap report

1. **v5 shape mismatches** (profile `buckets`, `include=documents`, chunk `isLatest`/`isInference`, `list?sort=`): fix each inside the phase that builds that area (mostly P4), not as a separate step.
2. **LLM:** local Ollama only, no paid APIs. The owner is setting it up. Real-model evals wait.
3. **Supermemory local oracle:** benchmark against it only once building is done. Logged as entry 1 in the new `docs/v2/DEFERRED.md`.
4. **Deleted or edited documents:** their memories are kept as history with an end date (`valid_to`), not forgotten. This is a P3 Policy rule.
5. **Doc location:** the v2 docs moved from the repo root (untracked) into `docs/v2/`. The README now points there.

---

## 2026-10-22: branch and repo housekeeping

- **Repo:** `github.com/dv64bit/Supermemory`. It is **public**, owned by `dv64bit`. We are logged in as `sakshia08` with push access but not admin. Commits are authored as `sakshia08`.
- Created branch `v2-dev`, committed the P0 docs (`a2bc5a5`) and pushed it. The owner then asked for it to be deleted.
- Deleted `v2-dev` locally and on GitHub. The docs were first copied back onto `main` as uncommitted files, so nothing was lost.
- **Decision:** Claude does not commit. At each checkpoint, Claude proposes a commit message and the owner commits from their own terminal.
- The owner committed the P0 docs on `main` as `03f8ca0` ("gap findings and revised dev plan").

---

## 2026-10-22: P1 scope agreed

Build everything the fake LLM or local embeddings can exercise now, in four checkpoints:

- **A.** Plumbing.
- **B.** Target tests and contract validation.
- **C.** Eval tooling, retrieval baseline and latency.
- **D.** Labelled sets and the MemoryBench runner.

The real-model numbers (E2 extraction, relation and grounding; E3) wait for Ollama. The LLM router, cache and call log were pulled forward from P2 into P1, so that baseline runs are cheap, reproducible and logged.

---

## 2026-10-22: P1 checkpoint A, plumbing (no engine behaviour change)

**What changed**

- **`server/src/llm.ts` is now the LLM router.** Every model call goes through it.
  - Structured calls use `call(role, promptFile, input, schema)`. Chat uses `stream("chat", …)`.
  - Model per role: `LLM_MODEL_<ROLE>`, falling back to `LLM_MODEL`. Chat still honours `LLM_CHAT_MODEL`.
  - Timeout: `LLM_TIMEOUT_MS`.
  - The JSON schema is sent as structured output and also validated with Zod, via `z.fromJSONSchema`, so the schema has one source.
  - One repair retry: the bad reply is sent back to the model with the validation error. After that the call fails and the raw output is logged.
  - Response cache in the new table `llm_cache`. The key is a hash of role, model, prompt version, schema and input. `LLM_CACHE=off` bypasses it. Failures are never cached.
  - Every call is logged to the new table `llm_calls`: role, model, prompt version, input hash, tokens, latency, cached, ok, attempts, error, and the raw output on failure.
  - `pipelineVersion()` hashes all prompt versions plus the per-role models.
- **Prompts moved into `server/src/prompts/`:** `extract.v1.md`, `extract-buckets.v1.md`, `relate.v1.md`, `derive.v1.md` and `forget.v1.md`.
  - They were exported from the old string constants by script, not retyped, so the text the model sees is byte-identical.
  - The recorded prompt version is `<file>@<content hash>`.
- **`test/fake-llm.ts`:**
  - It routes on the router's `x-llm-role` header instead of the `TASK:` line in the prompt. Tests no longer depend on prompt wording, as PRD.v2 requires.
  - It records every request in `requests`.
  - It supports scripted raw replies, used for the repair tests.
  - It reports token usage.
  - It fills `bucket: null` when buckets are offered, as a schema-following model would.
  - `freshDb` honours `TEST_DATABASE_URL`.
- **Tests and scripts:**
  - New `test/llm.test.ts` (5 tests).
  - The upload test timeout is now 30 s, to stop the cold-start flake.
  - `bun run test` runs every file and fails if any file failed.
  - `web/package.json` gained a `test` script.
- `.env.example` documents the new settings.

**Why**

- PLAN.v2 §1: one router with roles, prompt files, validation, cache and logging.
- Pulled into P1 so the baseline is reproducible and its cost and failure rate are visible.

**Behaviour note**

Previously, a model reply that broke the schema was used unchecked. Now it gets one repair turn, and if it is still invalid that document's dream fails with a logged error. This does not affect the fake LLM.

**Test results**

- server: contract 9/9, engine 15/15, llm 5/5 (new), mcp 4/4, so **33/33**;
- web: 1/1;
- `tsc`: clean.

**Decisions and notes**

New tables are still added through the idempotent `schema.sql`. The numbered migration runner stays in P2.
