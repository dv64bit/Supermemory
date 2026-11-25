# V1 vs V2 benchmark (e3 end-to-end)

> Run by a collaborator on their own machine on 2026-11-21, with their own e3 harness. The harness and the two run files it
> links are **not in this repo**: this report is all we have. It measured P3 as committed (`b1dde6d`). The fixes it led to
> are in DEVLOG 2026-11-25.

V2 was compared with V1 on the same scenarios, with the same model, repeated 3 times. All 3 repeats gave identical results on both builds (deterministic model output), so repeats do not measure noise. Differences show consistent behaviour on these specific scenarios, not statistical significance. V2 scored higher (noise not measured) on: v2-goal (+17). V2 scored lower (noise not measured) on: fetch (-24), save (-43), update (-5), basic (-16). Too few distinct checks to call either way: dedupe: anecdotal (n=3), 0; forget: anecdotal (n=3), -33; profile: anecdotal (n=2), 0; isolation: anecdotal (n=2), 0. Points are percentage points; `~` means the V1 and V2 ranges overlap, so the gap may be noise; `?` means noise not measured (repeats identical on both builds). Ingest p50/p95: V1 2511/6037 ms, V2 7533/23594 ms.

- V1: `920a64a`, run `2026-11-21T05-59-58Z-e3-e2e-v1` (not in repo)
- V2: `b1dde6d`, run `2026-11-21T06-13-15Z-e3-e2e-v2` (not in repo)
- model: `qwen3:4b-instruct`, repeats: 3 (V1) / 3 (V2)
- date: 2026-11-21

## Pass rate by area

Area rows use basic-tier checks only; `basic` and `v2-goal` are the tier totals. Mean of per-repeat pass rates. Delta is V2 minus V1 in points; `?` = noise not measured (repeats identical on both builds). k/n checks = passed/total check runs, pooled over repeats. Known dataset defects are excluded.

| area | V1 | V2 | delta | V1 k/n checks | V2 k/n checks |
|---|---|---|---|---|---|
| fetch (tiny namespace; retriever identical in V1/V2 — measures extraction + answer, not ranking) | 0.76 | 0.53 | -24? | 39/51 | 27/51 |
| save | 1.00 | 0.57 | -43? | 21/21 | 12/21 |
| update | 0.50 | 0.45 | -5? | 33/66 | 30/66 |
| dedupe | 1.00 | 1.00 | 0? | 9/9 | 9/9 |
| forget | 1.00 | 0.67 | -33? | 9/9 | 6/9 |
| profile | 0.50 | 0.50 | 0? | 3/6 | 3/6 |
| isolation | 1.00 | 1.00 | 0? | 6/6 | 6/6 |
| basic | 0.71 | 0.55 | -16? | 120/168 | 93/168 |
| v2-goal | 0.67 | 0.83 | +17? | 12/18 | 15/18 |

### v2-goal checks by area

| area | V1 | V2 | delta | V1 k/n checks | V2 k/n checks |
|---|---|---|---|---|---|
| save | 0.00 | 0.50 | +50? | 0/6 | 3/6 |
| update | 1.00 | 1.00 | 0? | 12/12 | 12/12 |

### Paired by scenario

Scenarios where one build passes and the other fails (a scenario passes when its mean pass rate over repeats is >= 0.5).

- fetch: V2 pass / V1 fail: 0; V1 pass / V2 fail: 3
- save: V2 pass / V1 fail: 0; V1 pass / V2 fail: 1
- update: V2 pass / V1 fail: 2; V1 pass / V2 fail: 4
- dedupe, profile, isolation: no difference
- forget: V2 pass / V1 fail: 0; V1 pass / V2 fail: 1
- overall: V2 pass / V1 fail: 3; V1 pass / V2 fail: 9

## Latency (ms)

| metric | V1 | V2 |
|---|---|---|
| ingest p50 | 2511 | 7533 |
| ingest p95 | 6037 | 23594 |
| search p50 | 18 | 20 |
| chat p50 | 718 | 821 |

Same machine; other harness work ran during the V1 run; timed-out ingests are excluded from p95.

## Diagnostics

- stepErrors (one step error fails every check in its scenario): V1 9, V2 3
- checkErrors, chatErrors, timeouts, dreamingErrors: 0 on both
- judge/token disagreements: V1 16, V2 14

## Grounding rejections in V2 (from the collaborator's summary)

D2 rejected 104 of 379 candidates (27%), many of them correct ("flying to Kochi on AI-302", "now employed at Northwind Labs", the passport expiry date):

| reason | count |
|---|---|
| quote is the assistant's words | 43 |
| quote not found in source | 25 |
| not supported by the source | 20 |
| said by the assistant | 10 |
| unresolved relative date | 6 ("moved to Pune last week") |

## Known dataset defects

Excluded from every pass rate above.

- `update-rent.2`: search must-token "rent", but a correct rewrite reads "User pays 42,000 rupees monthly for the flat." (no "rent")
- `update-rent.3`: chat must-token "rent", but a correct answer reads "You pay 42,000 rupees monthly for the flat." (no "rent")

## Failed checks

(n/3) = repeats in which the check failed.

### V1

- fetch-kw-ticket.1: no result has all required tokens (3/3)
- fetch-pref-style.1: no result has all required tokens (3/3)
- fetch-temporal-visa.2: "Your visa appointment is on 2027-01-05." (3/3)
- fetch-multi-anika.1: no result has all required tokens (3/3)
- save-no-assistant-suggestion.1: no live memory has all tokens (3/3)
- save-no-assistant-suggestion.2: stored "User considers using Postgres for their side project." (3/3)
- update-job.1: isLatest=true; .2: forbidden token in "User works at Contoso Retail."; .3: "Contoso Retail." (3/3)
- update-city.2: forbidden token in "Assistant calls Bengaluru a great city for food." (3/3)
- update-rent.2/.3: known dataset defect
- update-age.1–3: step error: capture old: no live memory matching ["Anika","five|5"] (3/3)
- update-manager.1: isLatest=true; .2: no result has all required tokens; .3: "Your manager is Daniel." (3/3)
- update-car.2: forbidden token in "Assistant calls Maruti Swift a reliable little car." (3/3)
- profile-after-update.1: forbidden token in "User works at Contoso Retail." (3/3)

### V2

- fetch-para-dog.1: no result has all required tokens; .2: "I don't know what breed your dog is…" (3/3)
- fetch-kw-ticket.1: no result has all required tokens; .2: answered OPS-4821 instead of PAY-4821 (3/3)
- fetch-kw-flight.1: no result has all required tokens; .2: "I don't have information about a flight to Kochi…" (3/3)
- fetch-temporal-visa.2: "Your visa appointment is on 2027-01-05." (3/3)
- fetch-multi-anika.1: no result has all required tokens (3/3)
- save-employer-city.1: "The user moved to Pune for a new job at Northwind Labs" (3/3)
- save-volunteer.1, save-rent-landlord.2, save-no-assistant-suggestion.1: no live memory has all tokens (3/3)
- update-job.1: isLatest=true; .2: forbidden token in "The user works at Contoso Retail as a data scientist"; .3: "I work at Contoso Retail as a data scientist." (3/3)
- update-city.1: isLatest=true; .2: no result has all required tokens; .3: "Bengaluru. You live near Indiranagar." (3/3)
- update-children.1: isLatest=true; .2: no result has all required tokens; .3: "Kim has two children." (3/3)
- update-rent.1: isLatest=true; .2/.3: known dataset defect ("You pay 38,000 rupees a month in rent.")
- update-pref-editor.1: isLatest=true; .2: forbidden token in "The user codes in VS Code with the Vim plugin." (3/3)
- forget-restore.1: step error: capture p: no live memory matching ["passport"] (3/3)
- profile-after-update.1: forbidden token in "The user works at Contoso Retail." (3/3)

## Caveats

- The same 4B model is extractor and judge; the judge may be lenient.
- Scenarios derive from datasets written around v2 goals; read `basic` and `v2-goal` rows separately.
- Fetch scenarios hold ~6–8 memories against a top-5 search, and search.ts is identical in both builds, so the fetch row does not test ranking.
