# Evals

Measure, don't claim. Every quality or speed claim in this repo should point at a run in `eval/runs/`.

Run everything from `server/` (the eval scripts live there and import server modules). Each eval needs Postgres with pgvector and a role that can create databases. Point at it with `EVAL_DATABASE_URL`; otherwise `TEST_DATABASE_URL` or `postgres://localhost/postgres` is used.

| Command | Layer | What it measures | Needs a real LLM? |
|---|---|---|---|
| `bun run eval:e1` | E1 mechanics | The server test suite (fake LLM): pass/fail/todo, and how many **targets** (known bugs and unbuilt v2 behaviour) are still open vs fixed. Exits non-zero on any unexpected failure | no |
| `bun run eval:e2 [--only <name>]` | E2 components | **retrieval:** recall@1/5/10 and MRR on `data/retrieval.v1.json` plus 1,500 generated hard negatives, per category. **extraction:** the engine's extract + ground steps (D1, D2) on `data/extraction.v1.json`; what survives grounding is what would be stored, and an LLM judge matches it to the expected facts. Reports precision, recall, F1, forbidden-fact rate (e.g. an assistant suggestion stored as the user's fact), speaker accuracy, how many candidates grounding rejected, unresolved relative dates, and LLM calls and tokens. **relation:** the engine's relate steps (D4 neighbours, D5 relate call, D6 policy) on `data/relation.v1.json`. Reports accuracy, **false-UPDATE rate**, missed updates, updates swallowed as duplicates and missed links. **grounding:** the judge's accuracy on `data/grounding.v1.json`, the share of stored (grounded) facts the judge finds unsupported by their source, and the engine's own grounder on the labelled pairs | retrieval: no; the rest: yes (skipped if `LLM_BASE_URL` doesn't answer; `EVAL_FAKE_LLM=1` = smoke test, not recorded) |
| `bun run eval:latency [sizes]` | speed | p50/p95 of search (memories and hybrid), profile and list at 10k and 100k memories, against the PRD.v2 budgets (search < 300 ms, profile < 50 ms) | no |
| `bun run eval:compare [A] [B]` | — | Metric deltas between two runs. With no arguments it compares the last two runs of each kind; with one (e.g. `e2-retrieval`) the last two of that kind | — |
| (E3 end-to-end) | E3 | **Deferred**, see `docs/v2/DEFERRED.md` #2: MemoryBench needs paid APIs as published | — |

## Files

- `runs/<time>-<layer>-<name>.json` and `.md`: one record per run, with the git commit (and whether the tree had uncommitted changes), config, metrics, per-group metrics and per-item details. Runs are committed: they are the history of the numbers.
- `data/`: synthetic, hand-written datasets (committed). They are versioned (`retrieval.v1.json`); never edit a released version in place, add `v2` instead, so old runs stay comparable.
- `private/`: **git-ignored.** Personal data and any run over it (`private/runs/`). Nothing in it may be committed: the repository is public.

## Notes

- **Test sets:** `retrieval`, `extraction` (40 units), `relation` (60 cases) and `grounding` (45 pairs) were written by hand (Claude, P1) and spot-checked by the owner (2026-10-23). Retrieval distractors come from a fixed seed, so a run is deterministic apart from timings.
- **The judge:** the `judge` role is an LLM (`LLM_MODEL_JUDGE`, default `LLM_MODEL`). If it is the same model as the extractor, it may be lenient towards its own output. The grounding eval's `judge_accuracy` on labelled pairs says how far to trust its other verdicts. With the LLM cache on, re-running unchanged evals costs nothing.
- **Latency vectors:** the latency corpus uses random vectors generated in SQL. Today every search scans every row, so cost depends on row count, not vector content. Revisit if retrieval starts using the HNSW index.
- **Machine noise:** timings depend on the machine and on what else is running. Compare latency runs from the same machine only, and don't run evals in parallel with each other.
