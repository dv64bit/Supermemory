# P1 baseline (current engine, before v2 changes)

All P1 numbers in one place: the starting point that P2–P6 must improve. Each number links to its run in `eval/runs/`. Taken on 2026-10-22/23 at commit `8568292` (engine unchanged since P1-D).

**Setup**
- **LLM:** `qwen3:4b-instruct` (Q4_K_M) on local Ollama, **CPU only**, 4,096-token context. The same model does extract, relate and judge.
- **Embeddings:** local bge (unchanged).
- **Machine:** 12 CPUs, WSL2.
- **Test sets:** hand-written by Claude in P1 and spot-checked by the owner on 2026-10-23.

## Summary

| Area | Headline | Budget / target | Run |
|---|---|---|---|
| E1 mechanics | 33 pass, 0 unexpected failures, 16 todo, 12 targets open | 0 unexpected failures | `2026-10-22T13-43-47Z-e1-suite` |
| Retrieval | recall@10 **0.844**, recall@1 0.714, MRR 0.770 | — | `2026-10-23T09-54-00Z-e2-retrieval` |
| Extraction | F1 **0.672** (P 0.606, R 0.754); forbidden-fact rate **0.667** | — | `2026-10-23T09-54-28Z-e2-extraction` |
| Relation | accuracy **0.617**; false-UPDATE rate 0.125; missed updates 0.333 | — | `2026-10-23T10-12-29Z-e2-relation` |
| Grounding | judge accuracy **0.889**; unsupported-memory rate **0.183** | — | `2026-10-23T10-17-18Z-e2-grounding` |
| Latency 10k | search p95 202 ms (memories) / 309 ms (hybrid); profile p95 63 ms | search < 300, profile < 50 | `2026-10-22T13-05-56Z-latency-10k` |
| Latency 100k | search p95 989 / 1,376 ms; profile p95 673 ms | search < 300, profile < 50 | `2026-10-22T13-06-44Z-latency-100k` |

## Can we trust the judge?

Mostly. On the 45 labelled grounding pairs it gets 40 right (0.889): unsupported recall 0.917, precision 0.880.
- **Too lenient (2):** g08 (hearsay presented as fact) and g34 (scope widened). It passes claims that it should flag.
- **Too strict (3):** g15 (relative date correctly resolved), g20 (episode) and g33 (opinion correctly attributed).

So extraction precision and the unsupported-memory rate are good to within a few points. The judge is also the extractor's own model, so it may be lenient towards its own output. Hearsay is exactly the miss we saw above. A bigger judge (for example `qwen3:8b`) would tighten this, if the machine can run it.

## Findings by area

**Extraction.** The extractor finds most real facts (recall 0.754) but stores far too much:
- **Forbidden facts in 2 of 3 units that have any.** It stores assistant suggestions the user never accepted (0.80), facts the assistant stated (1.0), hypotheticals (1.0) and questions (1.0) as user facts.
- **Empty units:** only 3 of 7 (0.429) correctly produce nothing.
- **6 relative dates left unresolved** ("next Friday" stored as is).
- This is the P3 Dreamer v2 work: speaker attribution, source grounding and date resolution.

**Relation.** 
- **0.92 near-duplicate shortcut:** this is the same finding as P1-D and doesn't depend on the model. It decides 10 of 60 cases before any LLM runs, and gets 5 wrong. It discards all 3 numeric updates (children 2→3, rent 38k→42k, age 5→6) as duplicates. That is the whole 0.333 "update swallowed as duplicate" figure.
- **The relate LLM:** apart from those 3 numeric updates, it gets 8 of 9 true updates. But it makes a false UPDATE on half of the hearsay (2 of 4) and older-event (2 of 4) traps. The engine has no CONFLICT or HISTORICAL ops and ignores dates, so those 8 cases can at best be "not UPDATE".
- This is P3 work: remove the shortcut, add the v2 ops and pass dates into relate.

**Grounding.** 18.3% of extracted facts (13 of 71) are not supported by their source. They cluster in:
- relative dates (3 of 4);
- hypotheticals (2 of 4);
- assistant suggestions, third-party claims and preferences (1 in 3 each).

User facts, document notes and episodes are clean (0%). The P3 grounder must bring this down.

**Retrieval.** All 13 misses in the top 10 are paraphrase, preference or multi-memory queries; entity, keyword and temporal queries are perfect. This is P4 hybrid/rerank work.

**Latency.** Over budget at 100k on everything. Search scans every row and never uses HNSW; profile loads every live memory into JS. This is P4 work.

## Cost (real-model runs)

| Run | LLM calls | Wall time |
|---|---|---|
| Extraction | 40 (0 failed, 0 repaired) | 18 min |
| Relation | ~50 (the shortcut decides the other 10) | 5 min |
| Grounding | 116 | 8 min |

- **Extraction tokens:** 12.8k in, 2.2k out for the extract calls. The 18 minutes also include the judge calls.
- **JSON output:** structured JSON output on Ollama needed no repair retries.

## In simple words

We tested the memory engine as it is today, before any v2 changes, using a small AI model (Qwen) on this computer. This is the starting score. Every later phase has to beat it.

- **Finding memories:** good. When you ask something, the right memory comes up 84% of the time. It misses when you ask in different words from the ones the memory used.
- **Saving memories:** too eager. It saves things that aren't really facts about you: ideas the assistant suggested, "what if" questions, and plain questions. Only about 6 in 10 saved items are correct.
- **Updating memories:** right about 6 in 10 times. Its biggest mistake is throwing away real changes, like "rent went from 38k to 42k", because the sentences look nearly the same.
- **Making things up:** about 1 in 5 saved memories adds something that wasn't actually said. This is worst with dates like "next Friday".
- **Speed:** fine with a small number of memories, but too slow once there are 100,000.
- **The checker:** the AI that marks these answers was right 89% of the time, so the scores are fairly reliable.
- **The test questions:** written by Claude and checked by the owner.

**What fixes what:** P3 fixes saving, updating and making things up. P4 fixes finding and speed.
