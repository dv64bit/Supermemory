---
title: Personal Supermemory v2 — truthful, time-aware, measurable memory engine
labels: [ready-for-agent]
created: 2026-10-22
supersedes: PRD.md (Problem, Solution, Implementation, Testing); user stories 1–113 of PRD.md remain in force except where amended below
related: PLAN.v2.md, NEXT.v2.md
---

## Problem Statement

v1 (PRD.md) set the right goal: a self-hosted memory server that speaks Supermemory's v5 API so the whole ecosystem works against it. The capture, API, MCP, web-app and connector stories are sound.

What v1 underspecifies is the part that makes memory *useful or harmful*: deciding what is true. A memory engine that stores a wrong fact is worse than one that stores nothing, because every assistant then repeats the error confidently. The known failure modes are:

1. **Time confusion.** An old document ingested late overwrites a newer fact. "Tomorrow" gets stored literally and is never resolved.
2. **Wrong speaker.** The assistant's suggestion ("you could use Postgres") is stored as the user's decision.
3. **Hallucinated memories.** The extraction model writes a fact the source never said.
4. **Missed links.** "Alex joined Stripe" doesn't find "Alex works at Google" because the two sentences aren't similar enough as vectors, so both stay "latest."
5. **Silent overwrites.** A low-confidence update supersedes a true fact with no human ever seeing it.
6. **No way to improve.** When prompts or models get better, the existing memory stays as bad as it was.
7. **No measurement.** Without benchmarks, "as good as Supermemory" can't be checked.

v2 fixes these. It also adds capabilities upstream doesn't offer: provenance, time-travel queries, a conflict inbox, re-dreaming, and eventually our own distilled extraction model.

## Goals and success metrics

| Goal | Metric | Target |
|---|---|---|
| Parity or better on memory QA | MemoryBench LongMemEval-S / LoCoMo / ConvoMem accuracy, **same LLM** for both | ≥ Supermemory local overall; ≥ on the *knowledge-update* and *temporal-reasoning* categories |
| Better than plain RAG | Same benchmarks vs a chunk-only baseline | Clear win on knowledge-update and multi-session |
| Truthfulness | Unsupported-memory rate (E2 grounding set) | < 2% |
| Safe updates | False-UPDATE rate (E2 relation set) | < 3% |
| Speaker correctness | Assistant-suggestion-stored-as-fact rate | 0 on the E1 suite; < 2% on E2 |
| Privacy | Secrets stored in memories (secret corpus) | 0 |
| Speed | p95 search (no rerank/rewrite) / `x/context` / profile, at ≤100k memories | < 300 ms / < 400 ms / < 50 ms |
| Compatibility | Official `supermemory` SDK contract test | 100% green, always |

## Solution

Keep v1's architecture (v5 API contract, Postgres + pgvector, pg-boss, forked MCP, web app and extension, connectors). Replace the memory engine and retrieval with the v2 design in PLAN.v2.md §3–4:

- **Bi-temporal memories:** event time vs learned time, with relative dates resolved.
- **Speaker attribution** on every memory.
- A **grounding pass**: every memory carries a source quote that must exist in the source and support the fact.
- **Entity resolution** as a neighbour channel, plus a **batched relation step** whose safety rules are enforced in code.
- A **conflict inbox** for uncertain updates, in addition to the inference review queue.
- An explicit **lifecycle model** per memory kind, in config.
- **Retrieval v2:** temporal query understanding, an entity channel, score blending, MMR, a token-budgeted **context endpoint**, and `as_of` time travel.
- **Re-dream:** replay all sources through an improved pipeline into a shadow namespace, diff, then swap.
- **An eval harness, built before the new engine:** mechanics gate, component evals, and end-to-end benchmarks against the upstream oracle and a RAG baseline.
- **Learner-lite:** a small fine-tuned model for extraction and relation, distilled from a strong teacher.

All v2 additions are **additive** to the v5 contract: extra response fields, extension routes under `/ns/{ns}/x/…`, extension params. Unmodified official clients keep working.

## Amended user stories (from PRD.md)

- **#12 (amended):** As the owner, I want the date a document is from to anchor both temporal reasoning *and* the resolution of relative dates ("tomorrow", "last week") into absolute dates, so that time-based facts stay correct later.
- **#24 (amended):** As the owner, I want a newer contradicting fact to supersede an older one only when it is newer in *event time*, so that ingesting an old document late never overwrites the present.
- **#26 (amended):** As the owner, I want inferences to require at least two supporting memories, link to each of them, and wait for my review before they rank like trusted facts, so that guesses are traceable and contained.
- **#31 (amended):** As the owner, I want units within a namespace processed in event-time order, with arrival order as the tie-breaker, so that "which came first" reflects reality.
- **#35 (amended):** As the owner, I want the review queue to include uncertain updates and contradictions as well as inferences, so that no low-confidence change silently rewrites my memory.
- **#51 (amended):** As the owner, I want each result to also carry speaker, confidence, the source quote and `valid_from`/`valid_to`, so that I can judge trust at a glance.
- **#55 (amended):** As the owner, I want the latency targets in the metrics table above, measured at p95 by the eval harness, so that speed is verified, not assumed.
- **#60 (amended):** As the owner, I want profile updates to be incremental (only the affected sections rewritten), so that rebuilds stay cheap and stable.

## New user stories

### Truthfulness and provenance
114. As the owner, I want every memory to store the exact source quote and location it came from, so that I can verify it.
115. As the owner, I want memories whose quote can't be found in the source, or doesn't support the fact, to be rejected and logged, so that hallucinated facts never enter memory.
116. As the owner, I want to ask "why do you know this?" for any memory (web app and MCP `explain_memory`) and see its quote, date, speaker, relations and the run that created it, so that I can trust or correct it.
117. As the owner, I want a full audit log of every change to a memory (who: engine or me; what; why), so that I can reconstruct how it evolved.

### Speakers
118. As the owner, I want statements by the assistant to never become facts about me unless I confirmed them, so that AI suggestions don't pose as my decisions.
119. As the owner, I want claims made by other people stored as attributed claims ("Ravi said…"), so that hearsay isn't mistaken for fact.
120. As the owner, I want a third-party or assistant statement never to supersede something I said myself, so that my own words win.

### Time
121. As the owner, I want to search my memory as of a past date ("where did I work in March 2025?"), so that history is queryable.
122. As the owner, I want temporal questions ("what did I use before X?") to automatically include superseded history, so that I get the timeline instead of only the latest fact.
123. As the owner, I want superseded facts to keep their validity interval, so that the timeline view is accurate.

### Conflicts and curation
124. As the owner, I want low-confidence updates and contradictions held in a conflict inbox with both versions visible, so that I decide which is true.
125. As the owner, I want to resolve a conflict as keep-old, keep-new, keep-both (different contexts) or merge-edit, so that resolution matches reality.
126. As the owner, I want memories I write or edit to be pinned and never auto-superseded, so that my corrections stick.
127. As the owner, I want entities merged and aliased ("my manager" = "Priya"), with a UI to merge or split them, so that facts about the same person connect.

### Improving the engine without losing data
128. As the owner, I want to re-dream a namespace through the current pipeline into a shadow copy, so that better prompts or models improve old memories.
129. As the owner, I want a diff report (added, removed, changed memories and relations) before a re-dream is swapped in, so that improvements are reviewed, not blind.
130. As the owner, I want pinned memories and my past review decisions carried through a re-dream, so that curation is never lost.
131. As the owner, I want every memory tagged with the pipeline version that produced it, so that I can trace quality to a version.

### Privacy
132. As the owner, I want API keys, tokens, passwords and card-like numbers redacted before any LLM sees the text, so that secrets never enter memory or model logs.
133. As the owner, I want memories labelled by sensitivity, and a per-namespace policy controlling whether sensitive ones are injected into assistant context, so that private topics don't leak into every chat.

### Retrieval for agents
134. As the owner, I want one endpoint that returns a ready-to-inject context block (profile, memories, source chunks with citations) under a token budget I set, so that every integration gets well-packed context.
135. As the owner, I want near-duplicate memories collapsed in results (diversity), so that context isn't wasted on paraphrases.
136. As the owner, I want unapproved inferences ranked below trusted facts, so that guesses don't dominate context.

### Measurement
137. As the owner, I want one command to run the mechanics, component and end-to-end evals and print a summary with deltas against the last run, so that I know whether a change helped.
138. As the owner, I want the end-to-end eval to run my server, Supermemory local (same LLM) and a plain-RAG baseline side by side, so that "as good as Supermemory" is a number.
139. As the owner, I want prompt or model changes blocked if they regress the component evals or the benchmark slice, so that quality only moves forward.
140. As the owner, I want every LLM call logged (role, model, tokens, latency, cache hit), so that I can see cost and failure rates.

### Model ownership
141. As the owner, I want to choose a model per role (extract, ground, relate, derive, profile, rewrite, judge), so that I can spend capability where it matters.
142. As the owner, I want a pipeline to distil a small local extraction-and-relation model from a strong teacher, so that quality stays high while running cheaply and offline.

### Agent and data ownership extras
143. As the owner, I want my Claude Code sessions automatically scoped to a per-repository namespace (from the git remote), with context injected at session start and transcripts captured at the end, so that each project has its own memory.
144. As the owner, I want conventions and corrections I give coding agents stored as procedure memories and exportable as a generated section of the repo's CLAUDE.md/AGENTS.md, so that agents follow my rules everywhere.
145. As the owner, I want a local-folder / Obsidian-vault connector, so that my notes sync without any cloud.
146. As the owner, I want to export a namespace as a readable Markdown vault (one file per entity, linked), so that my memory is never locked in the server.
147. As the owner, I want a health dashboard (counts by kind, review backlog, conflict rate, stale facts, daily LLM cost, eval trend), so that I can see the state of my memory at a glance.

## Implementation Decisions

Everything in PRD.md "Implementation Decisions" stands, with these changes. Details are in PLAN.v2.md.

- **Contract rule:** v2 features are additive. Extra JSON fields go on existing responses; new routes live under `/ns/{ns}/x/…`; new optional params. The unmodified official SDK contract test is the guardrail.
- **New and changed modules (deep, small interfaces):**
  - **LLM router:** `call(role, input, schema) → typed output`. Owns per-role model config, structured output, Zod validation, one repair retry, the response cache, and `llm_calls` logging. Prompts are versioned files; `PIPELINE_VERSION` derives from them.
  - **Guard:** `(text) → {redacted, findings}`. Secret scanning before any model call.
  - **Extractor (LLM):** `(unit) → candidates[]`, with speaker, subject, entities, absolute dates, confidence and source quote.
  - **Grounder:** `(candidate, source) → supported | rejected(reason)`. Fuzzy quote match, then an NLI or LLM check.
  - **EntityResolver:** `(entity strings, ns) → entity ids`. Alias → embedding → LLM tie-break; records aliases.
  - **Relator:** `(candidates, neighbours) → ops[]`. One batched LLM call.
  - **Policy (code):** applies the event-time, confidence, pinned and speaker invariants; produces final writes and review items. **The only place memory state changes.**
  - **Lifecycle:** the per-kind strength/decay/expiry model, from `lifecycle.yaml`.
  - **Retriever v2:** query understanding, channels, fusion, rerank, MMR, expansion, `as_of`.
  - **ContextAssembler:** `(ns, query, budget) → block`.
  - **Redreamer:** shadow-namespace replay, diff, swap.
  - **Evaluator:** E1/E2/E3 runners and the reporting/compare CLI.
- **Storage:** the v1 tables plus the PLAN.v2 §2 columns and tables (bi-temporal fields, speaker, confidence, source span, sensitivity, status, pinned, pipeline version; entities, memory_entities, memory_events, dream_runs, llm_calls, review_items). Migrations are forward-only and reversible in development; v1 data is backfilled (`valid_from = coalesce(doc_date, created_at)`, `speaker = 'document'`, `confidence = 0.7`).
- **Determinism:** temperature 0, the response cache, and a fake LLM for gating tests. The real-model evals are separate.

## Testing Decisions

PRD.md's seams stay: the SDK contract test, engine scenarios through the API with a fake LLM, MCP, connectors, and Playwright smoke tests. v2 adds:

- **E1 additions (gating):**
  - late-arriving old fact becomes historical, not latest;
  - relative date resolved;
  - assistant suggestion not stored, but stored once the user confirms;
  - third-party attribution;
  - third party can't supersede the user;
  - low-confidence update → conflict item, both active;
  - pinned memory protected;
  - hallucinated candidate rejected by grounding;
  - secret redacted before the fake LLM receives it (assert on what the fake server received);
  - entity alias links facts with low vector similarity;
  - `as_of` query correctness;
  - MMR removes paraphrase duplicates;
  - re-dream diff and swap keep pinned memories and review decisions;
  - a property test that no two latest memories with the same subject and slot have overlapping validity.
- **E2 (non-regression gate for prompt/model changes):** extraction P/R and speaker accuracy, relation per-class accuracy with the false-UPDATE rate, grounding rejection precision and recall, retrieval recall@k/MRR. Datasets are synthetic (committed) plus personal (git-ignored).
- **E3 (tracked; a 50-question slice gates releases):** MemoryBench over LongMemEval-S, LoCoMo and ConvoMem, comparing ours, Supermemory local with the same LLM, and plain RAG. Report per-category accuracy, latency and tokens.
- **Rule:** a test asserts on observable behaviour (API responses, MCP results, what the fake LLM received), never on prompt wording.

## Out of Scope

Everything in PRD.md "Out of Scope" still applies. Also out of scope:

- Decompiling, copying or redistributing the closed Supermemory local binary. It is used only as a black-box oracle through its API, within its licence terms.
- Training models from scratch, or fine-tuning in CI. Learner-lite is trained manually, offline.
- Multi-user conflict resolution or shared namespaces.

## Further Notes

- **Order of work:** P0 audit, then P1 eval baseline on the *current* engine, then the v2 engine. Without the baseline, no v2 change can be shown to help.
- **Verify before forking:** the upstream repo paths, commit `4d8a4ebf` contents and licences, and the app.supermemory.ai redirect were reported in v1 but must be rechecked. Keep MIT notices in all forked code.
- **Biggest risks:** relation quality (false updates) and small-model JSON reliability. Both are named metrics in E2 and visible in `llm_calls`.
