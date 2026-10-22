# Personal Supermemory rebuild: plan v2

Supersedes `PLAN.md` (v1). v1 got the product map, API-contract strategy, stack and forks right, and those carry over. v2 rebuilds the part that actually decides quality, the memory engine, around the known ways memory systems fail. It also makes evaluation a first-class phase and adds features upstream doesn't have.

## What changed from v1

| Area | v1 | v2 |
|---|---|---|
| Time | One timestamp; "which came first" = arrival order | **Bi-temporal**: event time (`valid_from`/`valid_to`) vs learned time (`learned_at`). Relative dates resolved to absolute. Late-arriving old facts can't overwrite newer ones |
| Who said it | Not modelled | **Speaker attribution** (user / assistant / third party / document). Assistant suggestions never become user facts |
| Hallucinated memories | Not addressed | **Grounding pass**: every memory carries a source quote that must exist in the source and support the fact |
| Finding related memories | Vector + FTS top-k | Adds **entity resolution**, so "Alex @ Google" is found when "Alex @ Stripe" arrives even when vector similarity is weak |
| Relation step | One LLM call per candidate | **One batched call per unit**; invariants enforced in code, not prompts; uncertain updates go to a **conflict inbox** |
| Decay | `strength *= 0.98/day` placeholder | Explicit per-kind lifecycle model with config, measured by eval |
| Retrieval | RRF + optional rerank | Query understanding (temporal intent), entity channel, score blend, MMR diversity, **token-budgeted context assembly**, `as_of` time travel |
| Changing prompts/models | Not addressed | `pipeline_version` + **re-dream** into a shadow namespace with a diff before swap |
| Evaluation | Fake-LLM scenarios + "50-sample set" | **Eval-first phase**: mechanics gate, component evals (extraction / relation / grounding / retrieval), MemoryBench end-to-end vs the upstream local oracle and a plain-RAG baseline |
| Observability | None | `llm_calls`, `dream_runs` and `memory_events` audit tables; "why do you know this" provenance |
| Models | Any OpenAI-compatible endpoint | Per-role routing, LLM response cache, and a later phase that **distils our own small learner model** |

## 0. Product map

The product table and key strategy from v1 §0 still hold. **Clone the v5 API shape exactly** so the official SDKs, `@supermemory/tools`, the forked MCP server, the extension and the coding plugins all work by changing `baseURL`.

Everything v2 adds goes in **additive** fields and routes:
- Extra response fields are allowed because clients ignore unknown keys.
- Extra routes live under `/ns/{ns}/x/...`.
- The contract test must stay green against the unmodified official SDK.

**Reference oracle:** run "Supermemory local" (`npx supermemory local`) with the same LLM endpoint, and compare it to our engine only through its public API. Its server binary is closed and under a lite licence, so do not decompile or copy it.

## 1. Stack

Unchanged from v1 (Bun + TS + Hono, Postgres 17 + pgvector + tsvector, pg-boss, local ONNX embeddings and reranker, docker-compose, single API key, localhost/Tailscale only), with these changes:

- **Embeddings:**
  - Store `embedding_model` alongside every vector, and add a re-embed job, so the model choice is never permanent.
  - Default: `bge-base-en-v1.5` (768d), for parity with upstream local.
  - Use `bge-m3` if the corpus has meaningful Hindi, Telugu or other non-English text.
  - Apply the model's **query instruction prefix** on query embeddings only (bge: `Represent this sentence for searching relevant passages: `). Forgetting it is a common silent recall bug.
- **pgvector filtering:** HNSW plus a `WHERE is_latest AND NOT is_forgotten AND ns = $1` filter loses recall through post-filtering. Use pgvector ≥0.8 iterative scans (`SET hnsw.iterative_scan = relaxed_order`). At personal scale (<200k rows), also benchmark an exact scan. It may be fast enough and has perfect recall.
- **LLM router:** roles `extract`, `ground`, `relate`, `derive`, `profile`, `rewrite`, `judge`, each with its own model, temperature (0 by default), max tokens and timeout in config.
  - Structured output through JSON schema (Ollama `format`, or OpenAI `response_format`), validated with Zod.
  - One repair retry, then fail the step with the raw output saved.
- **LLM cache:** key = `hash(role, model, prompt_version, schema, input)`. It makes eval reruns and re-dreams cheap and deterministic. Bypass it with `LLM_CACHE=off`.
- **Prompts as files:** `server/src/prompts/<role>.v<N>.md`. `PIPELINE_VERSION` is derived from the active prompt versions plus model IDs.
- **Secret scanner:** regex rules (gitleaks-style: API keys, tokens, private keys, card-like numbers) run on raw input **before** any LLM call. Matches are redacted to `[REDACTED:<kind>]` in memories. The raw document is kept only if `STORE_RAW_SECRETS=true` (off by default).

## 2. Data model v2

Additive to v1. Write it as migrations; never drop v1 columns without a migration plan.

```sql
memories(
  ...v1 columns...,
  valid_from timestamptz,          -- when the fact became true in the world (event time)
  valid_to timestamptz,            -- when it stopped being true (set on supersede or expiry)
  learned_at timestamptz,          -- when we ingested it (transaction time)
  speaker text,                    -- user | assistant | third_party | document
  subject text,                    -- who/what the fact is about (canonical entity name)
  confidence real,                 -- 0..1 from extract/relate
  source_span jsonb,               -- {document_id, start, end, quote}
  sensitivity text,                -- none | personal | sensitive
  status text,                     -- active | pending_review | rejected
  pinned bool default false,       -- user-authored/edited; survives re-dream untouched
  pipeline_version text,
  dream_run_id uuid
)
entities(id uuid, ns, canonical_name, type, aliases text[], embedding vector, created_at)
memory_entities(memory_id, entity_id, role)        -- role: subject | object | mention
memory_events(id, memory_id, action, actor, reason, before jsonb, after jsonb, pipeline_version, at)
                                                   -- action: create|update|supersede|extend|derive|strengthen|decay|forget|restore|approve|reject|edit
dream_runs(id, ns, document_ids uuid[], pipeline_version, status, stats jsonb, error, started_at, finished_at)
llm_calls(id, role, model, prompt_version, input_hash, tokens_in, tokens_out, latency_ms, cached bool, dream_run_id, at)
review_items(id, ns, kind, memory_id, related_memory_id, payload jsonb, status, created_at, resolved_at)
                                                   -- kind: inference | conflict | low_confidence
```

**Invariant:** for a given (ns, subject, slot), at most one `is_latest` memory may have an overlapping `[valid_from, valid_to)`. Add a property test for it.

## 3. Engine v2: the Dreamer

Runs per **unit**. A unit is a conversation (by `conversation_id`), a document, or a section window of a long document carrying a doc summary as context.

**Dynamic dreaming:** debounce per `conversation_id`/`custom_id` (idle 120s, or an explicit end marker). `instant` bypasses the debounce. Units are serialised per namespace and ordered by **event time**, not arrival.

| Stage | What it does | Who decides |
|---|---|---|
| D0 Guard | Secret scan + redaction; size and language detection | Code |
| D1 Extract | One structured call → candidates `{content, kind, speaker, subject, entities[], valid_from, valid_to?, expires_at?, confidence, source_quote}` | LLM (`extract`) |
| D2 Ground | Check `source_quote` exists in the source (normalised fuzzy match ≥0.9); then check the quote supports `content` (NLI cross-encoder, or LLM `ground` for borderline cases). Drop unsupported candidates and log them | Code + model |
| D3 Resolve entities | Map entity strings to `entities`: exact/alias → embedding sim ≥ τ → LLM tie-break for ambiguous ones. Record new aliases ("my manager" → Priya when the text says so) | Code + LLM |
| D4 Neighbours | Union of: memories sharing a subject or entity, vector top-k, and FTS top-k, all restricted to `is_latest AND status='active'`. Cap at 30 | Code |
| D5 Relate (batched) | **One call** with all candidates + neighbours → ops `ADD`, `DUPLICATE(id)`, `UPDATE(id)`, `EXTEND(id)`, `CONFLICT(id)`, `SKIP`, each with confidence | LLM (`relate`) |
| D6 Enforce | Code applies the invariants below, whatever the LLM said | Code |
| D7 Apply | One transaction: inserts, supersedes, edges, `memory_events`, `review_items` | Code |
| D8 Derive | Per touched entity cluster: at most 3 inferences, each citing ≥2 supporting memory IDs, with `derives` edges to every supporter. Status `pending_review` | LLM (`derive`) |
| D9 Profile | Incrementally update the affected profile sections only | LLM (`profile`) |

**D1 extraction rules** (in the prompt, and checked in tests):
- Facts are self-contained and third-person: "the user", or the named subject.
- Only `speaker=user` statements (or documents the user authored) become first-person facts about the user.
- Assistant suggestions produce nothing unless the user confirms them in the same unit. The confirmation is the fact.
- Third-party claims are attributed: "Ravi said the deadline moved to Friday".
- Relative dates are resolved against the unit's `doc_date`/message timestamp and stored as absolute ISO dates.
- Questions, hypotheticals, brainstorms and small talk produce nothing.

**D6 invariants (code, not prompt):**
- `UPDATE(old)` supersedes only if `candidate.valid_from >= old.valid_from`. Otherwise the candidate is inserted as historical (`is_latest=false`, `valid_to = old.valid_from`) with an `updates` edge pointing at the newer memory. This fixes late-arriving old documents.
- An `UPDATE` with confidence < `RELATE_UPDATE_MIN` (default 0.75), and any `CONFLICT`, does **not** supersede. It creates a `review_items(kind=conflict)`, and both memories stay active until resolved.
- `DUPLICATE`: a preference gains `strength`; a fact refreshes `learned_at`; an episode gains significance.
- `pinned` memories are never superseded automatically. A conflicting candidate goes to review.
- A third-party or assistant `speaker` can never supersede a `speaker=user` fact.

**Lifecycle (config: `lifecycle.yaml`):**
- **fact:** no decay. Ends only on supersede or explicit expiry.
- **preference:** `strength = min(cap, s + 1)` on each duplicate. Ranking uses `log1p(strength)`.
- **episode:** `score = significance · 0.5^(age_days / half_life)`, with `half_life` 30d by default. Soft-forget below `0.05` unless `significance ≥ 0.8`.
- **expiring:** `valid_to = expires_at`, swept hourly.
- All constants are tuned with the eval in §5, not by guessing.

**Re-dream:** `POST /ns/{ns}/x/redream` replays all documents in event-time order through the current pipeline into a shadow namespace. It produces a diff report (added / removed / changed memories, relation changes) and swaps only on approval. Pinned memories and user review decisions are carried over.

## 4. Retrieval v2

1. **Query understanding** (rules first, LLM only if `rewriteQuery`):
   - Detect temporal intent ("in 2024", "used to", "before", "history of", "when did") → `as_of`, or include history.
   - Extract query entities.
2. **Candidates:** memories (vector, FTS, entity channel) and chunks (vector, FTS). Each channel returns its top 50.
3. **Fuse:** RRF (k=60) per corpus, then `score = rrf · w_kind · recency(kind) · f(strength) · confidence`.
   - Weights live in config and are tuned by the retrieval eval.
   - Inferences are down-weighted until approved.
4. **Rerank** (optional): cross-encoder on the top 50 → top N. Measure its latency on your hardware and keep it off the default path if it breaks the p95 budget.
5. **Diversify:** MMR (λ=0.7) so five paraphrases of one fact don't fill the context.
6. **Expand** (`include.related`): 1-hop edges. `updates` history is returned only with temporal intent or when asked.
7. **Context assembly:** first check whether the v5 spec's `/profile` already accepts a query and returns search results. If so, implement that shape exactly. Separately, add `POST /ns/{ns}/x/context {query, budget_tokens}`, which returns a ready-to-inject block:
   - static profile, then dynamic profile;
   - top memories with dates and IDs, then top chunks with citations;
   - packed greedily under the token budget.

   The MCP server and coding hooks use this.
8. **`as_of`** (extension param): returns memories with `valid_from ≤ t < coalesce(valid_to, ∞)`. This answers "where did I work in March 2025?".

Latency budget at personal scale, p95 measured in an eval:
- `search` without rerank/rewrite: < 300ms
- `x/context`: < 400ms
- `profile`: < 50ms (cached row)

## 5. Evaluation (new, first-class, built before Dreamer v2)

| Layer | What | Gate? |
|---|---|---|
| E1 Mechanics | Fake OpenAI-compatible LLM with scripted outputs; the v1 seam-2 scenarios **plus**: late-arriving old fact, assistant-suggestion-not-stored, third-party attribution, low-confidence update → conflict review, pinned memory protected, secret redacted, the `is_latest` interval invariant (property test), re-dream diff | **Yes**, CI |
| E2 Component (real models) | **Extraction**: about 100 hand-labelled units → precision/recall via LLM-judge matching, plus speaker accuracy. **Relation**: about 150 labelled (candidate, neighbour) pairs → per-class accuracy, tracking the **false-UPDATE rate** in particular (the most damaging error). **Grounding**: unsupported-memory rate. **Retrieval**: recall@5/10 and MRR on query → expected memory IDs | Non-regression gate for prompt/model changes |
| E3 End-to-end | MemoryBench on LongMemEval-S, LoCoMo and ConvoMem against (a) our server, (b) the upstream local oracle **with the same LLM**, (c) plain chunk-RAG. Report QA accuracy by category (knowledge update, temporal reasoning, multi-session, abstention), p50/p95 latency, tokens per question and cost | Tracked; a 50-question slice gates releases |

Datasets:
- Synthetic sets (generated with a strong model, then hand-checked) live in `eval/data/`.
- **Personal data** lives in `eval/private/`, which is git-ignored.
- `bun run eval:<layer>` writes `eval/runs/<timestamp>.json` plus a markdown summary. Comparing two runs prints the deltas.

## 6. Learner-lite: our own extraction model (later phase)

The upstream moat is a tuned model, so we build a small one.

1. **Teacher:** the best prompt + strongest API model available, run over synthetic conversations, public dialogue datasets (check their licences) and personal notes (private).
2. **Filter:** keep only labels that pass grounding and agree across 2 samples (self-consistency).
3. **Student:** QLoRA fine-tune of a ~2–4B instruct model (pick a current model with a permissive licence at the time) on two tasks, `extract` and `relate`, with JSON outputs. Train on a rented/free cloud GPU; a 4 GB local GPU is too small for training.
4. **Export:** GGUF Q4 for Ollama/llama.cpp. Route the `extract`/`relate` roles to it.
5. **Accept** when E2 relation accuracy ≥ 95% of the teacher and false-UPDATE rate ≤ the teacher's, at much lower latency and cost.

## 7. Beyond upstream (ranked by value per effort)

1. **Provenance**: every memory shows its source quote, date, speaker and the dream run that made it. New MCP tool `explain_memory(id)`, and an "Explain" panel in the web app.
2. **Conflict inbox**: uncertain updates are reviewed, not only inferences.
3. **Time travel**: the `as_of` search param and a timeline scrubber in the UI.
4. **Re-dream with diff**: improve the pipeline without losing curation.
5. **Speaker-aware memory**: the assistant's ideas don't become your facts.
6. **Privacy policy per namespace**: secret redaction always on. Sensitive-category memories (`sensitivity=sensitive`) are excluded from profile injection unless the namespace policy allows it.
7. **Local folder / Obsidian connector + Markdown export**: watch a folder; export a namespace as a Markdown vault (one file per entity, with links). Your data stays readable without the server.
8. **Procedural memory for coding agents**: corrections and stated conventions from coding sessions become `kind=procedure` memories scoped to a repo namespace. They are exported as a generated section of the repo's `CLAUDE.md`/`AGENTS.md`.
9. **Repo-aware Claude Code hooks**: `SessionStart` injects `x/context` for the repo namespace (derived from the git remote); `Stop`/`PreCompact` sends the transcript with a `conversation_id`.
10. **Memory health dashboard**: memory counts by kind, review backlog, conflict rate, stale facts, LLM tokens/cost per day, and eval trend.

## 8. Phases (from the current repo state)

The repo has already done roughly v1 phases 1–4 plus the web app and the legacy shims (see `NEXT.md`). P0 confirms that.

| # | Deliverable | Done when |
|---|---|---|
| P0 | Understand the codebase and audit: `docs/v2/GAP_REPORT.md` (architecture map; implemented / partial / missing per v1 and v2 section, with file refs; real test results). No feature code | Report reviewed by the owner |
| P1 | Eval harness: E1 extended scenarios (failing tests allowed and marked `todo`), E2 scaffolding + first labelled sets, E3 MemoryBench wired to ours, the oracle and plain RAG | Baseline numbers for the **current** engine recorded |
| P2 | Schema v2 migrations, audit tables, LLM router + cache + prompt files, secret guard | Migrations reversible; E1 still green |
| P3 | Dreamer v2 (D0–D9) + lifecycle config | All E1 v2 scenarios pass; E2 beats the P1 baseline |
| P4 | Retrieval v2 + `x/context` + `as_of` | E2 retrieval and E3 slice beat baseline; latency budget met |
| P5 | Review/conflict inbox + provenance UI + `explain_memory` MCP tool | Approve/reject/merge from the UI; explain works from Claude Code |
| P6 | Re-dream with shadow diff | Prompt change → diff report → swap |
| P7 | Browser extension fork (resume `NEXT.md` v1 steps) | Save + auto-recall in ChatGPT and Claude |
| P8 | Files (PDF/Office/image/audio), then connectors: local folder/Obsidian first, then Notion, Drive, Gmail, GitHub… | Per v1 phase 6–7 criteria |
| P9 | Learner-lite | §6 acceptance |
| P10 | Extras: procedural memory, repo hooks, vault export, health dashboard, Shortcuts, Raycast | As needed |

## 9. Risks

- **Extraction and relation quality is still the product.** v2 makes it *measurable* (E2/E3) and *fixable without data loss* (re-dream).
- **False UPDATEs silently corrupt memory.** They are mitigated by a confidence threshold, the conflict inbox and event-time rules, and tracked as a named metric.
- **Small local models** follow JSON schemas less reliably. Use grammar-constrained output where the backend supports it, plus repair retries. Watch the failure rate in `llm_calls`.
- **Ecosystem drift:** upstream may change v5. Re-download the spec monthly and rerun the contract test.
- **Unverified upstream claims** carried from v1 (app redirect, extension status, the `4d8a4ebf` contents, the MIT licence of specific paths) must be checked before forking. Keep MIT notices.
