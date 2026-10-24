// Dreamer v2 pieces that need no database or model: quote matching (D2), entity names (D3) and the policy (D6).
import { expect, test } from "bun:test";
import { normName } from "../src/entities";
import type { Candidate } from "../src/extractor";
import { locate, RELATIVE_DATE } from "../src/grounder";
import { policy, type Neighbor } from "../src/relator";

test("locate finds a quote despite case, punctuation and a small slip; rejects one that isn't there", () => {
  const src = "User: Good call, I'll go with Postgres then.\n\nAssistant: Great choice!";
  expect(locate("i'll go with postgres then", src).score).toBe(1);
  expect(locate("I will go with Postgres then", src).score).toBeLessThan(0.9); // "will" is not in the source
  expect(locate("I'll go with Postgres", src)).toMatchObject({ score: 1, start: src.indexOf("I'll") });
  expect(locate("I like coffee", src).score).toBeLessThan(0.5);
});

test("relative dates are caught; absolute ones pass", () => {
  for (const s of ["exam tomorrow", "moved last month", "in two weeks", "this Friday", "3 days ago"]) expect(RELATIVE_DATE.test(s)).toBe(true);
  for (const s of ["exam on 2026-10-24", "moved in March 2026", "every Friday", "a two-week trip"]) expect(RELATIVE_DATE.test(s)).toBe(false);
});

test("entity names: 'my manager' and \"the user's manager\" are one key; articles drop", () => {
  expect(normName("My manager")).toBe("the user's manager");
  expect(normName("the user’s manager")).toBe("the user's manager");
  expect(normName("The Northwind Labs")).toBe("northwind labs");
  expect(normName("the user")).toBe("the user");
});

const cand = (content: string, extra: Partial<Candidate> = {}): Candidate => ({
  content, kind: "fact", speaker: "user", subject: null, slot: null, entities: [], validFrom: null, expiresAt: null,
  sensitivity: "none", confidence: 0.9, quote: content, ...extra,
});
const nb = (content: string, extra: Partial<Neighbor> = {}): Neighbor => ({
  pk: 1, id: "m1", content, kind: "fact", speaker: "user", subject: null, slot: null, valid_from: null, pinned: false,
  version: 1, root_id: null, sim: 0.8, ...extra,
});
const up = (target: number, confidence = 0.9) => ({ op: "UPDATE" as const, target, confidence, path: "llm" as const });
const NOW = new Date("2026-10-24T00:00:00Z");

test("policy: an UPDATE that is older in event time becomes HISTORICAL", () => {
  const [p] = policy([cand("Kim has 2 children", { validFrom: "2024-02-01" })], [up(0)], [nb("Kim has 3 children", { valid_from: new Date("2026-05-01") })], NOW);
  expect(p.op).toBe("HISTORICAL");
});

test("policy: low confidence, pinned targets and hearsay never supersede", () => {
  const n = [nb("The user works at Northwind")];
  expect(policy([cand("The user works at Hooli")], [up(0, 0.5)], n, NOW)[0]).toMatchObject({ op: "CONFLICT", reason: expect.stringContaining("low-confidence") });
  expect(policy([cand("The user works at Hooli")], [up(0)], [nb("The user works at Northwind", { pinned: true })], NOW)[0]).toMatchObject({ op: "CONFLICT", reason: "target is pinned" });
  expect(policy([cand("Daniel heard the user joins Hooli", { speaker: "third_party" })], [up(0)], n, NOW)[0].op).toBe("CONFLICT");
  expect(policy([cand("The user works at Hooli")], [up(0)], n, NOW)[0].op).toBe("UPDATE");
});

test("policy: one successor per memory; repeats in a unit are stored once; links need a valid target", () => {
  const plans = policy(
    [cand("Sam works at Globex"), cand("Sam is employed by Globex"), cand("Sam works at Globex"), cand("Sam likes tea")],
    [up(0), up(0), up(0), { op: "EXTEND", target: null, confidence: 0.9, path: "llm" }],
    [nb("Sam works at Acme")], NOW,
  );
  expect(plans.map((p) => p.op)).toEqual(["UPDATE", "EXTEND", "SKIP", "ADD"]);
  expect(plans[1].targetCand).toBe(0);
});
