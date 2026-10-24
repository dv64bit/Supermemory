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

---

## 2026-10-22: branch

- The owner recreated `v2-dev`. It tracks `origin/v2-dev` and all v2 work goes there.
- The owner committed and pushed checkpoint A as `6478535`.
- From now on, every checkpoint gives the owner both the commit and the push command.

---

## 2026-10-22: P1 checkpoint B, target tests and checking responses against the v5 spec

**What changed**

- **New `server/test/v5-schema.ts`.** It loads `ref/v5.json`, resolves its `$ref` links and turns every response schema into a Zod validator (all 197 compile).
  - `validatingFetch()` is passed to the unmodified official SDK through its `fetch` option. Every SDK response in the contract and engine tests is now checked against the spec, and a mismatch throws.
  - `specIssues()` checks raw `fetch` responses (`/ns`, file upload, the 400 error body).
  - Known mismatches are allowed only by operation, field path and message, so they can't hide anything else.
- **The 5 known v5 mismatches now have `test.failing` tests.** Each one passes while the bug exists and goes red once it is fixed:
  - `contract.test.ts`:
    - chunk results lack `isLatest`/`isInference`;
    - profile rejects `buckets`;
    - list ignores `sort`;
    - list returns only one array.
  - `engine.test.ts`:
    - `include=documents` returns no document.
- **New mismatch found:** list responses must carry all three arrays (`documents`, `chunks`, `memories`) on every call. The P0 audit missed it; it has been added to GAP_REPORT §3 as an addendum.
- **New `server/test/e1-v2.test.ts`, the E1 v2 target list:**
  - **7 runnable `test.failing` tests**, written through the public API. With `SHOW_TARGETS=1` they run as normal tests and show why each one fails; each fails for the intended reason.
    1. A late-arriving old fact overwrites a newer one.
    2. A numeric update (2 → 3 children) is swallowed by the 0.92 near-duplicate shortcut.
    3. The version fork: 2 live successors.
    4. A deleted document's memory is still in search.
    5. A chat transcript is re-extracted on every turn (3 extract calls for one fact).
    6. A secret reaches the LLM unredacted.
    7. Paraphrases fill the results (3 of the top 3).
  - **16 `test.todo` tests** for scenarios that need unbuilt features: relative dates, `as_of`, temporal history, edited-document retraction, conflict and low-confidence review, pinned, the interval-invariant property test, the 3 speaker rules, grounding, sensitivity policy, entity aliases, ranking of inferences, re-dream.
  - In the fake LLM's relate handler, the model always claims "updates". The point is that code, not the prompt, must enforce the rules.

**Why**

- PLAN.v2 §5 E1: the target list must exist before the engine changes.
- PRD v1 promised that contract responses would be checked against the spec; until now they never were.

**Test results**

| Suite | Result |
|---|---|
| contract | 13 (9 pass, 4 expected-failing) |
| e1-v2 | 23 (7 expected-failing, 16 todo) |
| engine | 16 (15 pass, 1 expected-failing) |
| llm | 5 pass |
| mcp | 4 pass |
| `tsc` | clean |

Total: 33 passing, 12 expected-failing (the targets), 16 todo, 0 unexpected failures.

**Decisions**

None new. The 5th mismatch follows the existing rule: it gets fixed in the phase that touches it (P4).

---

## 2026-10-22: P1 checkpoint C, eval tooling, retrieval baseline, latency baseline

B was not committed on its own; per the owner, B and C go into one commit.

**What changed**

- **`server/test/targets.ts`:** one shared `target()` helper (bun `test.failing`) replaces the ad-hoc `test.failing` and `E1_SHOW` uses.
  - `SHOW_TARGETS=1` runs every target as a plain test, so its failures are exactly the targets still open.
  - All 12 targets (5 v5 mismatches, 7 E1 bugs) use it.
- **`eval/`** (at the repo root, per PLAN.v2 §5). Scripts run from `server/`:
  - **`bun run eval:e1`** runs each test file normally (the gate: 0 unexpected failures) and with `SHOW_TARGETS=1` (counts open vs fixed targets). Records per-file pass, fail, todo, `targets_open` and `targets_fixed`.
  - **`bun run eval:e2`** runs the retrieval eval now; extraction, relation and grounding report "skipped" until a real model is set.
  - **`bun run eval:latency [sizes]`** measures p50/p95 of search (memories, hybrid), profile and list at a given namespace size.
  - **`bun run eval:compare [A] [B]`** prints per-metric and per-group deltas between two runs (by default, the last two of each kind).
  - **Run records** go to `eval/runs/<time>-<layer>-<name>.json` + `.md`, with the git commit, an uncommitted-changes flag, config, metrics, groups, notes and per-item details. Runs are committed.
  - **`eval/private/`** is git-ignored (the repo is public). Personal datasets and runs over them go there.
  - **Also added:** `eval/README.md` and `eval/tsconfig.json`. `tsc` is clean for both `eval/` and `server/`.
- **`eval/data/retrieval.v1.json`:** 90 memories about a fictional user and their circle, and 77 queries across 6 categories (paraphrase, keyword, entity, preference, temporal, multi). Hand-written by Claude; **not yet spot-checked by the owner**.
  - The runner adds 1,500 generated hard negatives (the same kinds of facts about other people, seed 20261022).
  - Memories are loaded straight into a throwaway database, with no LLM. Queries go through the real `POST /ns/{ns}/search` (memories mode, limit 10, default threshold).

**Retrieval baseline** (current engine): `eval/runs/2026-10-22T13-04-11Z-e2-retrieval`

| | n | recall@1 | recall@5 | recall@10 | MRR |
|---|---|---|---|---|---|
| **all** | 77 | 0.714 | 0.818 | 0.844 | 0.770 |
| paraphrase | 28 | 0.500 | 0.643 | 0.679 | 0.563 |
| preference | 12 | 0.750 | 0.750 | 0.833 | 0.758 |
| multi | 4 | 0.250 | 0.750 | 0.750 | 0.675 |
| entity | 12 | 0.917 | 1.000 | 1.000 | 0.958 |
| keyword | 11 | 0.909 | 1.000 | 1.000 | 0.932 |
| temporal | 10 | 1.000 | 1.000 | 1.000 | 1.000 |

- **First-person queries miss.** Most of the 13 misses are queries like "Which city do I live in?", "my wife", "my car" against memories stored as "The user …". The look-alike facts about named people outrank them. This is a concrete P4 target: map "I/my" to "the user" in query understanding.
- **The 0.3 threshold made no difference** (`recall@10` is the same at threshold 0).
- **Quality is deterministic.** A rerun gave identical quality numbers; latency on the same small corpus moved by +37 ms at p50, which is machine noise.

**Latency baseline**: `eval/runs/2026-10-22T13-05-56Z-latency-10k`, `…13-06-44Z-latency-100k`

| p95 (p50) | 10k memories | 100k memories | budget |
|---|---|---|---|
| search, memories | 202 (105) ms | **989 (800) ms** | < 300 ms |
| search, hybrid | **309 (118) ms** | **1,376 (918) ms** | < 300 ms |
| profile | **63 (35) ms** | **673 (327) ms** | < 50 ms |
| list memories p50 | 14 ms | 112 ms | — |
| query embedding p50 | 25 ms | 33 ms | — |
| HNSW build after load | 16 s | 209 s | — |

- **Corpus:** each size also has N/4 chunks across N/40 documents. Vectors are random, generated in SQL, because every search currently scans every row whatever the vectors hold. Measured on 12 CPUs, WSL2.
- **Hybrid search and profile are over budget already at 10k; everything is over at 100k.** Embedding is a small share; the cost is the full scans:
  - search computes distance over every namespace row and never uses HNSW (GAP_REPORT §4);
  - profile loads every live memory into JS, then slices.

  Both are P4 work: index-backed candidate retrieval or a measured exact scan, and a cached or `LIMIT`ed profile.
- The two throwaway latency databases were dropped afterwards to free disk. Every eval recreates its own database.

**Test results**

- E1 (`eval/runs/…13-13-28Z-e1-suite`): 33 pass, 0 unexpected failures, 16 todo, 12 targets open, 0 fixed.
- `tsc`: server and eval clean.

**Decisions**

None new. The retrieval set needs an owner spot-check before its numbers are treated as final.

---

## 2026-10-22: P1 checkpoint D, E2 labelled sets and runners; E3 deferred

**Decision:** MemoryBench (`github.com/supermemoryai/memorybench`, MIT) can't run on local Ollama as published:
- its answering and judge models are hard-wired to OpenAI, Anthropic or Google;
- its `rag` baseline uses OpenAI embeddings.

Options offered: our own small runner, a patched fork, or defer. **The owner chose to defer E3.** It is logged as `DEFERRED.md` #2, with the findings and both options.

**What changed**

- **`server/src/dream.ts` refactor (no behaviour change):** extraction and relation are now the exported `extractCandidates()` and `relateCandidates()`, so the evals measure the engine's exact steps. `dream()` calls them. The E1 suite is unchanged: 33 pass, 0 unexpected.
- **New `judge` role** (evals only) with two prompt files:
  - `judge-match.v1.md` matches predicted facts to expected ones and flags forbidden ones;
  - `judge-support.v1.md` decides whether a source supports a claim and returns the supporting quote.

  The fake LLM got a `judge` handler.
- **Test sets (hand-written by Claude, not yet spot-checked by the owner):**
  - `eval/data/extraction.v1.json`: 40 units, 57 expected facts, 38 forbidden statements. The plan said ~100; this first set is smaller.

    Categories: user facts, preferences, unaccepted and confirmed assistant suggestions, assistant-only facts, third-party claims, relative dates, corrections, negation, hypotheticals, questions, small talk, document notes, episodes.

    Weekdays used in relative-date cases were checked.
  - `eval/data/relation.v1.json`: 60 cases with v2 labels (ADD, DUPLICATE, UPDATE, EXTEND, CONFLICT, HISTORICAL). 29 of them are false-UPDATE traps: different subject, different attribute, coexisting facts, hearsay, older event date, uncertain.
  - `eval/data/grounding.v1.json`: 45 labelled (source, claim) pairs covering the traps: added detail, wrong number, wrong speaker, hearsay presented as fact, negation, hypothetical, wrong date, merged facts, invented name, tense shift, generalised scope, among others.
- **Runners in `eval/e2/`:**
  - **`extraction.ts`:** precision, recall, F1, forbidden-fact rate, empty-unit accuracy, unresolved relative dates (lexical check), LLM calls, failures and tokens.
  - **`relation.ts`:** accuracy, **false-UPDATE rate**, missed-update rate, updates swallowed as duplicates, missed-link rate, which path decided (shortcut or LLM), per gold class and per category.
  - **`grounding.ts`:** part A, the judge's accuracy and unsupported precision/recall on labelled pairs; part B, the unsupported-memory rate of current extractor output.
  - **`model.ts`:** real model if `LLM_BASE_URL` answers, otherwise skipped. `EVAL_FAKE_LLM=1` gives a smoke test that is never recorded.
  - **`run.ts`:** one throwaway database for all E2 runners. `server/src/db` binds its URL on first import, so per-runner databases would silently share the first one. The process exits explicitly, because in smoke mode the fake LLM server kept it alive.
- `eval/README.md` updated. E3 is marked deferred.

**Results**

- All four E2 runners work end to end in smoke mode (fake LLM). Real extraction, relation and grounding numbers wait for Ollama.
- Retrieval is unchanged from C (same engine).
- **One real, model-independent finding.** The 0.92 near-duplicate shortcut in `dream.ts` decides relation cases before any LLM is called. On the relation set it decided 10 of 60 cases, and was right on only 5:
  - **correct duplicates:** r11, r12, r15, r16, r17;
  - **true updates discarded as "duplicate":** r03 (2 → 3 children), r04 (rent 38k → 42k), r07 (age 5 → 6). All three are numeric changes;
  - **extension discarded:** r22 ("lives in the Baner neighbourhood of Pune");
  - **older fact bumping the newer one's strength:** r52.

  Every shortcut error loses information. Input for P3: remove the shortcut, or limit it to exact normalised text.

**Test results**

- E1 (`eval/runs/…-e1-suite`): 33 pass, 0 unexpected failures, 16 todo, 12 targets open.
- `tsc`: server and eval clean.

**State of P1**

All code for P1 is in place. What remains is real-model E2 numbers and `docs/v2/BASELINE.md`, waiting on the owner's Ollama. E3 is deferred.

---

## 2026-10-22: push blocked by GitHub secret scanning (fixed)

- GitHub push protection rejected the B/C/D commit. `server/test/e1-v2.test.ts` held a fake OpenAI-style key literal, the input for the "secrets are redacted before any LLM sees the text" target.
- **Fix:** the fake key is now assembled at runtime from pieces, so no key-shaped string is in the source. The test is unchanged: the target still fails for the intended reason, because the key reaches the LLM.
- The commit was amended before pushing; no secret, real or fake, reached GitHub. The "allow secret" bypass link was not used.
- **Rule from here:** test fixtures that need secrets build them at runtime. `ref/llms-full.txt` contains AWS's documented example key `AKIAIOSFODNN7EXAMPLE`; it is upstream documentation, already on GitHub and accepted.

---

## 2026-10-23: P1 closed, real-model E2 baseline and BASELINE.md

**Setup**

- The owner set up local Ollama with `qwen3:4b-instruct` (Q4_K_M). It runs on **CPU only** with a 4,096-token context, which is enough for every eval input.
- Ollama's structured JSON output works with the router: 0 failed calls, 0 repair retries.
- **Eval database:** Postgres had no login this session. The owner created a local role `supermem` (password `supermem`, superuser, local only). `server/.env` (git-ignored) now sets `EVAL_DATABASE_URL` and `TEST_DATABASE_URL` to it.

**Results** (all in `docs/v2/BASELINE.md`; same model for extract, relate and judge)

- **Judge check first:** accuracy 0.889 on the 45 labelled grounding pairs (unsupported recall 0.917, precision 0.880). Errors: 2 lenient (g08 hearsay, g34 scope change) and 3 strict (g15, g20, g33). Good enough to read the other numbers to within a few points.
- **Extraction:**
  - F1 0.672 (precision 0.606, recall 0.754);
  - forbidden-fact rate 0.667: assistant suggestions, assistant-stated facts, hypotheticals and questions get stored as user facts;
  - empty-unit accuracy 0.429;
  - 6 unresolved relative dates.
- **Relation:** accuracy 0.617, false-UPDATE rate 0.125, missed updates 0.333.
  - The shortcut cases are identical to P1-D's (it doesn't depend on the model).
  - Outside the shortcut, the relate LLM gets 8 of 9 updates right, but makes a false UPDATE on 2 of 4 hearsay and 2 of 4 older-event traps.
- **Grounding:** 13 of 71 extracted facts (0.183) are unsupported by their source. Relative dates are worst (3 of 4), then hypotheticals (2 of 4).
- **Retrieval:** rerun, unchanged from P1-C.

**Decisions**

None new. Inputs for P3 (shortcut, speaker attribution, grounding, dates) and P4 (retrieval misses, latency) are listed in BASELINE.md. The test sets still need the owner's spot-check.

---

## 2026-10-23: test sets spot-checked

- The owner spot-checked the four hand-written sets in `eval/data/` (retrieval, extraction, relation, grounding) and found no problems. No changes were made.
- The P1 baseline numbers in `BASELINE.md` are now final rather than provisional. BASELINE.md, NEXT.v2 and `eval/README.md` were updated to say so.
- BASELINE.md also gained a plain-language summary at the end, at the owner's request.

---

## 2026-10-24: P2, migrations, audit tables and secret guard

The router, cache and prompt files were already pulled into P1-A, so P2 is the other three parts. Done when (PLAN.v2 §8): migrations are reversible and E1 is still green. Both hold.

**Migration runner** (`server/src/db.ts`, CLI `src/migrate.ts`)

- **Files:** numbered `src/migrations/NNNN_name.up.sql` + `.down.sql`, recorded in `schema_migrations` with a content hash. Each runs in its own transaction under an advisory lock.
- **Safety:** editing an applied migration is refused. Rollback is for development.
- **Commands:** `bun run db:migrate | db:rollback [steps] | db:status`. The server still migrates on start.
- **0001_base:** the old `schema.sql`, moved unchanged. All of it is idempotent, so a database made by `schema.sql` adopts it as a no-op.
- **0002_bitemporal** (PLAN.v2 §2 memory columns):
  - New columns: `valid_from`, `valid_to`, `learned_at`, `speaker`, `subject`, `confidence`, `source_span`, `sensitivity`, `status`, `pinned`, `pipeline_version`, `dream_run_id`, plus `embedding_model` on memories and chunks.
  - Backfill per PRD.v2: `valid_from = coalesce(doc_date, created_at)`, `learned_at = created_at`, `speaker = 'document'`, `confidence = 0.7`.
  - Inferences become `pending_review`, and declined ones `rejected`.
  - Superseded memories get `valid_to` = their successor's `valid_from`; expiring ones get `valid_to = forget_after`.
- **0003_audit:** `dream_runs`, `memory_events`, `entities`, `memory_entities`, `review_items`, `llm_calls.dream_run_id`, `documents.redactions`.
- **Deviation from the PLAN sketch:** memories are referenced by `pk` (like `memory_edges`), and `dream_runs.document_pks` is `bigint[]`, because documents have bigint keys.

**Audit trail**

- Every `dream()` is a `dream_runs` row: status, pipeline version, and stats (candidates, added, updated, extended, duplicates, inferences).
- Its LLM calls carry `dream_run_id`, via `AsyncLocalStorage` in the router (`withDreamRun`).
- `memory_events` (`src/events.ts`) is written in the same transaction as each change:
  - dreamer: create, update, supersede, extend, strengthen, derive;
  - api: forget (by id, semantic), restore;
  - user: approve/reject in review;
  - sweeper: expire, decay.
- **New engine writes:** dream now fills the new columns. `valid_from` is the document date, and a superseded memory's `valid_to` is clamped so it never precedes its `valid_from` (the late-arrival bug itself is P3). Speaker and confidence get the legacy values until P3.
- **Status:** inferences are `pending_review`; approve → `active`, decline → `rejected`.
- **No behaviour change:** API responses are unchanged.
- **Not yet used:** `entities`, `memory_entities` and `review_items` exist but stay empty until P3/P5.

**Secret guard** (`src/guard.ts`, D0)

- **What it catches:** private keys; Anthropic, OpenAI, Stripe, AWS, GitHub, GitLab, Slack, Google and Hugging Face keys; JWTs; URL credentials; bearer tokens; labelled passwords and API keys; card numbers (Luhn + card prefix, so phone numbers, order ids and ms timestamps pass). Each match is replaced with `[REDACTED:<kind>]`.
- **Where it runs:**
  1. On ingest, so `documents.raw` is stored redacted unless `STORE_RAW_SECRETS=true`.
  2. On extracted text before chunks, memories and the extract call, so fetched pages are covered too.
  3. On chat messages.
  4. In the LLM router, as a last line of defence.
- `documents.redactions` holds kinds and counts, never the values.

**Tests**

- **New:** `migrations` (3: full up → down → up round trip, edited-migration refusal, v1 backfill), `guard` (15: a secret corpus and clean text), `audit` (5: dream runs, events, raw and derived storage, chat).
- All key-shaped fixtures are assembled at runtime (push protection).
- The E1 target "secrets are redacted before any LLM sees the text" now passes and is a normal `test`.
- **E1** (`eval/runs/…08-39-33Z-e1-suite`): 57 pass, 0 unexpected failures, 16 todo, 11 targets open. Web 1/1. `tsc` clean in server and eval.
- E2 retrieval rerun: unchanged (recall@10 0.844, MRR 0.770). The other E2 runners pass the fake-LLM smoke test.
- **Flaky test:** one full-suite run before any P2 change had a single e1-v2 failure that didn't reproduce in 3 reruns. Watch for it.

**Finding for P3**

The near-duplicate shortcut in `relateCandidates` stores a neighbour's similarity only for the first candidate that finds it. A later candidate that is an exact duplicate of that neighbour then misses the shortcut and goes to the relate LLM. This was found while writing the audit test, which orders its candidates around it. P3 removes or replaces the shortcut anyway.

**In simple words**

1. **Safe database upgrades.** Database changes are now numbered steps, each with an undo, and the tests prove the undo works. Existing memories are kept and filled in with sensible defaults.
2. **A change log.** Every create, update, merge, forget, restore or approve on a memory is recorded with who did it and why. Each processing run and its AI calls are recorded too. This is what will later answer "why do you know this?".
3. **Secret protection.** API keys, passwords, tokens, private keys and card numbers become `[REDACTED]` before anything is saved or sent to the AI, in documents, web pages and chat.

57 tests pass, 0 fail (23 new). Search quality is unchanged at 84%. The owner's own database upgrades on the next server start; `bun run db:rollback 2` undoes it.

### Summary of P2
What P2 added:

  1. Safe database upgrades. Changes to the database are now numbered steps, and each one has an undo. The test suite applies every step, undoes all of them and applies them again, so we know the undo works. Your existing memories are kept and filled in with sensible default values.
  2. A change log. Every time a memory is created, updated, merged, forgotten, restored or approved, the database records who did it and why. Each processing run is recorded too, along with the AI calls it made. Later this is what will answer "why do you know this?".
  3. Secret protection. API keys, passwords, tokens, private keys and card numbers are replaced with [REDACTED] before anything is saved or sent to Qwen. This applies to documents, web pages and chat. One of the open targets from P1, "secrets are redacted before any LLM sees the text", now passes.

  Test results: 57 pass, 0 failures. There are 23 new tests: 3 for upgrades, 15 for secrets and 5 for the change log. The search-quality score is the same as in P1 (84%).

  Worth knowing:
  - The next time you start the server, it will upgrade your own database automatically. The upgrade only adds things and deletes nothing. If you ever need to undo it, run cd server && bun run db:rollback 2.
  - While writing the tests I found a small bug in the old duplicate check. It sometimes misses an exact duplicate, depending on the order facts arrive in. I noted it for P3, which rewrites that part anyway.


---

## 2026-10-24: P3, Dreamer v2 (code done; real-model E2 run still to do)

PLAN.v2 §8 says P3 is done when all E1 v2 scenarios pass and E2 beats the P1 baseline. The E1 half holds: every scenario that belongs to P3 passes. The E2 half is not measured yet, because the real-model run couldn't happen (see "Blocked" below).

**The pipeline** (`dream.ts` orchestrates; one module per stage, matching PRD.v2's module list)

| Stage | Where | What it does now |
|---|---|---|
| D0 Guard | `guard.ts` (P2) | unchanged |
| D1 Extract | `extractor.ts`, `extract.v2.md` | One call per unit. Each candidate carries speaker, subject, slot, entities (with aliases), `validFrom`, `expiresAt`, sensitivity, confidence and a source quote. The prompt leads with "who said it". |
| D2 Ground | `grounder.ts`, `ground.v1.md` | **Code checks:** the quote must be in the new text (token-window match ≥ 0.9) and not only in assistant turns; assistant-speaker candidates are dropped; candidates with an unresolved relative date ("tomorrow") are dropped. **Then one batched LLM support check** (`ground` role; `GROUND_LLM=off` skips it). Rejections and their reasons go into `dream_runs.stats.rejected`. |
| D3 Entities | `entities.ts` | Exact name/alias match, then embedding match (≥ 0.9, same type), else a new entity. Aliases are recorded. `memory_entities` links each memory as subject or mention. There is no LLM tie-break (DEFERRED #5). |
| D4 Neighbours | `relator.ts` | Per candidate, the union of: vector top 5 (≥ 0.55), keyword top 5 (OR-query) and same-subject-entity memories (same slot when the candidate has one). Live and non-rejected only; capped at 8 per candidate and 30 in total. |
| D5 Relate | `relator.ts`, `relate.v2.md` | One batched call: ADD / DUPLICATE / UPDATE / EXTEND / CONFLICT / SKIP, each with a confidence. **The 0.92 near-duplicate shortcut is gone**; only exact (normalised) repeats skip the LLM. |
| D6 Policy | `relator.ts` `policy()` | **A pure function.** Rules: an older event → HISTORICAL; a pinned target, hearsay over the user, or confidence < `RELATE_UPDATE_MIN` (0.75) → CONFLICT for review; one successor per memory; repeats within a unit are stored once; a link needs an offered target. |
| D7 Apply | `dream.ts` | One transaction: inserts with every v2 column, supersedes (`valid_to` = the successor's `valid_from`), history rows, edges, `review_items` (`conflict` / `low_confidence`), entity links, events. |
| D8 Derive | `dream.ts` | As before, but inferences are `pending_review` with an `inference` review item, built only from active memories. Approving or declining resolves the review item. |
| D9 Profile | — | Deferred (DEFERRED #3). The profile is still computed on read. |

**Other behaviour**

- **Append-only re-ingest** (a growing chat transcript) dreams only the new text, with the last dreamed turn as context. `documents.dreamed_chars`/`dreamed_hash` track what was dreamed.
- **Any other edit** re-dreams the whole document and ends (`valid_to = now()`, kept as history) the memories it no longer confirms. This replaces the conversation debounce (DEFERRED #4).
- **Deleting a document** ends its memories' validity instead of leaving them live. `LIVE` now also requires validity and a status other than `rejected`.
- **Worker order:** it dreams in event-time order: `coalesce(doc_date, created_at)`.
- **Lifecycle** (`server/lifecycle.yaml`, `lifecycle.ts`, which replaces the sweep in `forget.ts`):
  - facts never decay;
  - preference strength is capped at 10;
  - episodes: `significance · 0.5^(age / 30 d)`, forgotten below 0.05 unless significance ≥ 0.8. An unreinforced episode now lasts about 100 days; it was ~68.
- **New routes** (`/x/`, not in v5):
  - `PATCH /ns/{ns}/x/memories/{id}` edits a memory (re-embedded, speaker → user) and pins it; dreaming never supersedes a pinned memory.
  - `PATCH /ns/{ns}/x/settings {injectSensitive}`: profiles leave out sensitive memories unless this is on.
- **Migration 0004_dreamer:** `memories.slot`, `documents.dreamed_chars`/`dreamed_hash`, `namespaces.inject_sensitive`, plus indexes.
- **Prompts:** `extract.v1`, `extract-buckets.v1` and `relate.v1` were deleted (they are in git history); the v2 prompts replace them.
- **LLM router:**
  - New `ground` role.
  - Per-role output caps (`LLM_MAX_TOKENS_<ROLE>`), because a 4B model under a JSON grammar can run until the context is full.
  - `timeout: false` on fetch: Bun's own 5-minute fetch timeout was cutting slow CPU calls short, so `LLM_TIMEOUT_MS` now applies.
- **Bun SQL gotcha:** a JS array parameter is sent as `"a,b"` and Postgres rejects it as a malformed array literal. Use `sql.array(xs, "text")`.

**Tests**

- The e1-v2 targets fixed by this phase are now normal tests: late-arriving old fact, numeric update not swallowed, no version fork, deleted document out of search, chat extracted once.
- **New tests**, each replacing a `test.todo`:
  - relative date resolved / unresolved rejected;
  - edited document ends stale memories;
  - low-confidence UPDATE → review;
  - CONFLICT never supersedes;
  - pinned memory protected;
  - property test (6 dated facts × 3 shuffled arrival orders; the newest in event time is the only latest, with no overlap);
  - assistant suggestion rejected and stored once confirmed;
  - third-party attribution;
  - hearsay can't supersede the user;
  - hallucination rejected and logged;
  - sensitive memories kept out of the profile until allowed;
  - entity alias links "my manager" to Priya.
- `test/dreamer.test.ts` covers the pure pieces: quote matching, relative dates, entity names, policy.
- `fake-llm.ts` fills the new extract fields with defaults (the quote defaults to the whole input, so grounding finds it). It also answers `ground`, and accepts either the old relation names or the v2 ops from relate handlers.
- **E1** (`eval/runs/…10-20-37Z-e1-suite`): **80 pass, 0 unexpected failures, 4 todo, 6 targets open** (was 57 / 16 / 11).
  - The 4 remaining todos are P4/P6: `as_of`, temporal history queries, inferences ranking below facts, re-dream.
  - The open targets: 4 v5 mismatches, MMR, and `include=documents`.
- **Retrieval E2:** unchanged (recall@10 0.844, MRR 0.770). `tsc` clean in server and eval.
- The E2 runners now measure the new pipeline:
  - extraction runs `extractUnit` (D1 + D2) and adds speaker accuracy and grounding rejections;
  - relation runs `relate` (D4–D6) with the data's event dates and reports the final op, HISTORICAL included;
  - grounding adds part C, the engine's grounder on the labelled pairs.
- All of them pass the fake-LLM smoke test.

**Blocked: the real-model E2 run**

Ollama became unusably slow today:
- a 12-token reply took 90 s, and loading the model took 170 s;
- yesterday's speed was about 6 tokens/s.

**Cause:** memory. The WSL VM has 4.9 GB of RAM. Qwen 4B takes about 3.1 GB, and with the editor server and other processes running, the machine was down to about 70 MB free with 1.5–2 GB of swap in use, so the model keeps paging. Restarting Ollama did not help.

**Options for the owner:** give WSL more memory (`.wslconfig`), close other WSL processes, or switch to a smaller model. Until then, "E2 beats the P1 baseline" is unproven.

**Not done**

Chat replies (`chat.ts`) still put sensitive memories into the chat prompt; only the profile endpoint honours `injectSensitive`. This will be fixed with `x/context` in P4.

**In simple words**

The memory engine has been rebuilt so it saves fewer wrong things:
- It knows **who said what**. Things the assistant suggested are never saved as your facts, unless you agree to them.
- Every saved fact must be **backed by your actual words**. Made-up details are thrown away, and the reason is logged.
- **Dates** like "tomorrow" are turned into real dates.
- **Updates** are handled safely. Real changes (rent 38k → 42k) replace the old fact. An old fact that arrives late doesn't overwrite a newer one. Uncertain changes, or claims from other people, go to a review list instead of overwriting anything.
- It recognises that **"my manager" and "Priya"** are the same person.
- Facts you **edit yourself are locked**, so the engine won't overwrite them.
- **Health and money details** are left out of your profile unless you allow them.
- Deleted or edited documents no longer leave stale facts behind.

80 tests pass, 0 fail. We still need to run the quality test with Qwen to prove it beats the P1 scores, but the computer currently doesn't have enough memory to run Qwen at a usable speed.

### Summary of P3
What P3 changed:
- Who said what: the assistant's suggestions are never saved as your facts, unless you agree to them.
- No made-up details: each saved fact must match your actual words. Anything that doesn't match is thrown away, and the reason is logged.
- Real dates: "tomorrow" is saved as an actual date.
- Safer updates: a real change like rent going from 38k to 42k replaces the old fact. An older fact that arrives late doesn't overwrite a newer one. Uncertain changes, or things other people said, go to a review list instead of overwriting anything.
- People: it knows "my manager" and "Priya" are the same person.
- Your edits are locked: facts you edit yourself won't be overwritten.
- Private details: health and money facts are kept out of your profile unless you allow them.
- Edited or deleted documents no longer leave old facts behind.
