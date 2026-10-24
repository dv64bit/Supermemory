// E1 v2 target list (PRD.v2 "Testing Decisions" + bugs confirmed in the P0 audit, docs/v2/GAP_REPORT.md §4).
// Everything goes through the public API with the fake LLM.
//   target(...)    : runnable today, currently FAILS on purpose (see ./targets.ts). When a phase fixes it, bun reports
//                    "marked as failing but it passed": switch it to `test`. SHOW_TARGETS=1 shows why each one fails.
//   test.todo(...) : needs a feature that doesn't exist yet (speaker, confidence, pinned, as_of, ...); written in its phase.
import { beforeAll, afterAll, expect, test } from "bun:test";
import { freshDb, startFakeLlm } from "./fake-llm";
import { target } from "./targets";

const has = (s: string, ...w: string[]) => w.every((x) => s.toLowerCase().includes(x.toLowerCase()));
// A fake OpenAI-style key, assembled at runtime so the source never holds a key-shaped literal
// (GitHub push protection blocks those, fake or not).
const SECRET = ["sk", "proj", "Zx81Kq0wVbT3B" + "lbkFJ4mN7pQ2rS9tU6vW1xY"].join("-");

// Per-test scripts: a marker in the document picks the extract reply; a phrase in the candidate picks the relate reply.
type Extracted = Record<string, unknown> & { content: string; kind: string; expiresAt: string | null };
const extractBy = new Map<string, (input: { content: string; context: string | null }) => Extracted[]>();
const relateBy = new Map<string, (c: { content: string; neighbors: { j: number; content: string }[] }) => { op: string; target: number | null; confidence?: number }>();
const groundBy = new Map<string, "supported" | "unsupported">();

const llm = startFakeLlm({
  extract: (input) => {
    const { content } = input;
    for (const [marker, f] of extractBy) if (content.includes(marker)) return f(input);
    if (has(content, "E1-LATE-NEW")) return [{ content: "Alex works at Stripe as a product manager", kind: "fact", expiresAt: null }];
    if (has(content, "E1-LATE-OLD")) return [{ content: "Alex works at Google as a software engineer", kind: "fact", expiresAt: null }];
    if (has(content, "E1-KIDS-2")) return [{ content: "Kim has 2 children", kind: "fact", expiresAt: null }];
    if (has(content, "E1-KIDS-3")) return [{ content: "Kim has 3 children", kind: "fact", expiresAt: null }];
    if (has(content, "E1-FORK-A")) return [{ content: "Sam works at Acme", kind: "fact", expiresAt: null }];
    if (has(content, "E1-FORK-B")) return [
      { content: "Sam works at Globex as an engineer", kind: "fact", expiresAt: null },
      { content: "Sam is employed by Globex in engineering", kind: "fact", expiresAt: null },
    ];
    if (has(content, "E1-DELETE")) return [{ content: "Lee lives in Paris", kind: "fact", expiresAt: null }];
    if (has(content, "E1-PARA")) return [
      { content: "Alex loves hiking in the mountains", kind: "preference", expiresAt: null },
      { content: "Alex enjoys mountain hiking", kind: "preference", expiresAt: null },
      { content: "Hiking in the mountains is Alex's favourite pastime", kind: "preference", expiresAt: null },
      { content: "Alex owns a red bicycle", kind: "fact", expiresAt: null },
    ];
    if (has(content, "green tea")) return [{ content: "The user drinks green tea", kind: "preference", expiresAt: null }];
    return [];
  },
  // By default the relate model claims the newcomer supersedes its closest neighbour: the policy in code must decide.
  relate: (c) => {
    for (const [phrase, f] of relateBy) if (c.content.includes(phrase)) return f(c);
    return c.neighbors.length ? { relation: "updates", target: c.neighbors[0].j } : { relation: "new", target: null };
  },
  ground: (claim) => groundBy.get(claim.claim) ?? "supported",
  chat: () => "Noted.",
});

await freshDb("supermem_test_e1v2");
const { migrate, sql } = await import("../src/db");
const { createApp } = await import("../src/app");
const { drain } = await import("../src/worker");
const { Supermemory } = await import("supermemory");

let server: ReturnType<typeof Bun.serve>;
let client: InstanceType<typeof Supermemory>;
beforeAll(async () => {
  await migrate();
  server = Bun.serve({ port: 0, fetch: createApp("k").fetch });
  client = new Supermemory({ apiKey: "k", baseUrl: `http://localhost:${server.port}`, maxRetries: 0 });
});
afterAll(() => (server.stop(true), llm.stop(true)));

const add = async (ns: string, content: string, extra: Record<string, unknown> = {}) => {
  await client.add(ns, { content, ...extra });
  await drain();
};
const live = async (ns: string) => (await client.list(ns, "memories", { limit: 100 })).memories!.map((m) => m.memory);
const api = (path: string, body: unknown, method = "POST") => fetch(`http://localhost:${server.port}${path}`, {
  method, headers: { authorization: "Bearer k", "content-type": "application/json" }, body: JSON.stringify(body),
});
const fact = (content: string, extra: Record<string, unknown> = {}): Extracted => ({ content, kind: "fact", expiresAt: null, ...extra });
const memRow = async (ns: string, content: string) => (await sql`select * from memories where ns = ${ns} and content = ${content}`)[0];
const reviews = async (ns: string) => [...await sql`select r.kind, r.payload, m.content as memory, rm.content as related from review_items r
  join memories m on m.pk = r.memory_pk left join memories rm on rm.pk = r.related_memory_pk where r.ns = ${ns} order by r.created_at`];

// ---------- Time ----------

test("late-arriving old fact becomes historical, not latest", async () => {
  await add("e1_late", "E1-LATE-NEW: Alex just started at Stripe as a PM.", { date: "2026-05-01T00:00:00Z" });
  await add("e1_late", "E1-LATE-OLD: Alex works at Google as an engineer.", { date: "2024-01-15T00:00:00Z" });
  const now = await live("e1_late");
  expect(now.some((m) => m.includes("Stripe"))).toBe(true);
  expect(now.some((m) => m.includes("Google"))).toBe(false);
});

test("relative date ('tomorrow') is resolved to an absolute valid_from; a memory still saying 'tomorrow' is rejected", async () => {
  extractBy.set("E1-REL", () => [
    fact("The user has a dentist appointment on 2026-03-11", { kind: "episode", validFrom: "2026-03-11" }),
    fact("The user has a dentist appointment tomorrow", { kind: "episode" }),
  ]);
  await add("e1_rel", "E1-REL: I have the dentist tomorrow.", { date: "2026-03-10T09:00:00Z" });
  const rows = await sql`select content, valid_from from memories where ns = 'e1_rel'`;
  expect(rows.map((r: any) => r.content)).toEqual(["The user has a dentist appointment on 2026-03-11"]);
  expect(rows[0].valid_from.toISOString()).toBe("2026-03-11T00:00:00.000Z");
});
test.todo("as_of: search as of a past date returns the memory valid then (valid_from <= t < valid_to)");
test.todo("temporal query ('where did I work before X') includes superseded history");

// ---------- Silent overwrites / invariants ----------

test("a numeric change is an update, not a duplicate (2 children -> 3 children)", async () => {
  await add("e1_kids", "E1-KIDS-2: Kim has two kids.");
  await add("e1_kids", "E1-KIDS-3: Kim had another baby, three kids now.");
  const now = await live("e1_kids");
  expect(now).toContain("Kim has 3 children");
  expect(now).not.toContain("Kim has 2 children");
});

test("one memory is superseded by at most one live successor (no version fork)", async () => {
  await add("e1_fork", "E1-FORK-A: Sam works at Acme.");
  await add("e1_fork", "E1-FORK-B: Sam moved to Globex, engineering team.");
  const sams = (await client.list("e1_fork", "memories", { limit: 100 })).memories!.filter((m) => m.memory.includes("Globex"));
  const successors = [];
  for (const m of sams) {
    const full = await client.memories.get("e1_fork", m.id, { include: ["related"] });
    if (full.included?.related?.parents?.some((p) => p.relation === "updates" && p.memory.includes("Acme"))) successors.push(m.id);
  }
  expect(successors).toHaveLength(1);
});

test("deleting a document keeps its memories as history, out of default search", async () => {
  await add("e1_delete", "E1-DELETE: Lee lives in Paris.", { id: "lee" });
  expect(await live("e1_delete")).toContain("Lee lives in Paris");
  await client.documents.delete("e1_delete", { ids: ["lee"] });
  const res = await client.search("e1_delete", { query: "where does Lee live?", searchMode: "memories", threshold: 0 });
  expect(res.results.map((r) => r.memory)).not.toContain("Lee lives in Paris");
});

test("editing a document ends (valid_to) the memories its old version produced that the new version no longer supports", async () => {
  extractBy.set("E1-EDIT-V1", () => [fact("Noor lives in Oslo"), fact("Noor plays the cello")]);
  extractBy.set("E1-EDIT-V2", () => [fact("Noor plays the cello")]);
  await add("e1_edit", "E1-EDIT-V1: Noor lives in Oslo and plays the cello.", { id: "noor" });
  await add("e1_edit", "E1-EDIT-V2: Noor plays the cello.", { id: "noor" });
  expect(await live("e1_edit")).toEqual(["Noor plays the cello"]);
  const oslo = await memRow("e1_edit", "Noor lives in Oslo");
  expect(oslo.valid_to).not.toBeNull(); // kept as history
  expect((await memRow("e1_edit", "Noor plays the cello")).strength).toBe(2); // confirmed again, not duplicated
});

test("low-confidence UPDATE creates a conflict review item; both memories stay active", async () => {
  extractBy.set("E1-LOW-A", () => [fact("Omar works at Hooli")]);
  extractBy.set("E1-LOW-B", () => [fact("Omar works at Initech")]);
  relateBy.set("Omar works at Initech", (c) => ({ op: "UPDATE", target: c.neighbors[0].j, confidence: 0.5 }));
  await add("e1_low", "E1-LOW-A: Omar works at Hooli.");
  await add("e1_low", "E1-LOW-B: Omar might be at Initech now.");
  expect((await live("e1_low")).sort()).toEqual(["Omar works at Hooli", "Omar works at Initech"]);
  expect(await reviews("e1_low")).toMatchObject([{ kind: "low_confidence", memory: "Omar works at Initech", related: "Omar works at Hooli" }]);
});

test("CONFLICT op never supersedes; it creates a conflict review item", async () => {
  extractBy.set("E1-CONF-A", () => [fact("Omar lives in Cairo")]);
  extractBy.set("E1-CONF-B", () => [fact("Omar lives in Doha")]);
  relateBy.set("Omar lives in Doha", (c) => ({ op: "CONFLICT", target: c.neighbors[0].j, confidence: 0.9 }));
  await add("e1_conf", "E1-CONF-A: Omar lives in Cairo.");
  await add("e1_conf", "E1-CONF-B: Omar lives in Doha.");
  expect((await live("e1_conf")).sort()).toEqual(["Omar lives in Cairo", "Omar lives in Doha"]);
  expect(await reviews("e1_conf")).toMatchObject([{ kind: "conflict", memory: "Omar lives in Doha", related: "Omar lives in Cairo" }]);
});

test("pinned (user-written or edited) memory is never superseded automatically; the conflicting candidate goes to review", async () => {
  extractBy.set("E1-PIN-A", () => [fact("Pia works at Umbrella")]);
  extractBy.set("E1-PIN-B", () => [fact("Pia works at Vought")]);
  await add("e1_pin", "E1-PIN-A: Pia works at Umbrella.");
  const pia = await memRow("e1_pin", "Pia works at Umbrella");
  expect((await api(`/ns/e1_pin/x/memories/${pia.id}`, { pinned: true }, "PATCH")).status).toBe(200);
  await add("e1_pin", "E1-PIN-B: Pia works at Vought."); // the default relate reply: UPDATE the nearest memory
  expect(await live("e1_pin")).toContain("Pia works at Umbrella");
  expect((await memRow("e1_pin", "Pia works at Umbrella")).is_latest).toBe(true);
  expect((await memRow("e1_pin", "Pia works at Vought")).status).toBe("pending_review");
  expect(await reviews("e1_pin")).toMatchObject([{ kind: "conflict", memory: "Pia works at Vought", related: "Pia works at Umbrella", payload: { reason: "target is pinned" } }]);
});

test("property: for any (ns, subject, slot), latest memories never have overlapping [valid_from, valid_to), whatever the arrival order", async () => {
  // Six jobs with distinct event dates, ingested in three shuffled orders; relate always says UPDATE.
  const jobs = [2019, 2020, 2021, 2022, 2023, 2024].map((y, k) => ({ company: `Company${k}`, date: `${y}-0${(k % 9) + 1}-01T00:00:00Z` }));
  let seed = 7;
  const rand = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
  for (const run of [0, 1, 2]) {
    const ns = `e1_prop_${run}`;
    const order = [...jobs].sort(() => rand() - 0.5);
    for (const [k, j] of order.entries()) {
      extractBy.set(`E1-PROP-${run}-${k}`, () => [fact(`Quinn works at ${j.company}`, { subject: "Quinn", slot: "employer", validFrom: j.date })]);
      await add(ns, `E1-PROP-${run}-${k}: Quinn works at ${j.company}.`, { date: j.date });
    }
    const latest = await sql`select content, valid_from, valid_to from memories where ns = ${ns} and subject = 'Quinn' and slot = 'employer' and is_latest`;
    for (const [a, x] of latest.entries()) for (const y of latest.slice(a + 1)) {
      const overlap = x.valid_from < (y.valid_to ?? Infinity) && y.valid_from < (x.valid_to ?? Infinity);
      expect(overlap).toBe(false);
    }
    expect(latest.map((r: any) => r.content)).toEqual(["Quinn works at Company5"]); // the newest in event time wins
  }
}, 60_000);

// ---------- Speakers ----------

test("assistant suggestion is not stored as a user fact; it is stored once the user confirms it", async () => {
  extractBy.set("E1-SUGG", () => [
    fact("The user uses Postgres", { quote: "You could use Postgres" }), // the assistant's words, labelled as the user's
    fact("Postgres has great JSON support", { speaker: "assistant", quote: "it has great JSON support" }),
  ]);
  extractBy.set("E1-YES", () => [fact("The user decided to use Postgres for the side project", { quote: "I'll go with Postgres then" })]);
  await add("e1_sugg", "User: E1-SUGG I need a database for my side project.\n\nAssistant: You could use Postgres, it has great JSON support.\n\nUser: I'll think about it.");
  expect(await live("e1_sugg")).toEqual([]);
  await add("e1_sugg", "User: E1-YES which database then?\n\nAssistant: You could use Postgres.\n\nUser: Good call, I'll go with Postgres then.");
  expect(await live("e1_sugg")).toEqual(["The user decided to use Postgres for the side project"]);
});

test("third-party claim is stored attributed ('Ravi said ...'), not as the user's fact", async () => {
  extractBy.set("E1-RAVI", () => [fact("Ravi said the launch deadline moved to 2026-10-30", { speaker: "third_party", subject: "Ravi", quote: "Ravi told me the deadline moved to the 30th" })]);
  await add("e1_ravi", "User: E1-RAVI Ravi told me the deadline moved to the 30th.", { date: "2026-10-20T00:00:00Z" });
  const m = await memRow("e1_ravi", "Ravi said the launch deadline moved to 2026-10-30");
  expect(m).toMatchObject({ speaker: "third_party", subject: "Ravi" });
});

test("a third-party or assistant statement cannot supersede a speaker=user memory", async () => {
  extractBy.set("E1-HEAR-A", () => [fact("The user works at Northwind Labs", { subject: "the user", slot: "employer" })]);
  extractBy.set("E1-HEAR-B", () => [fact("Daniel heard the user is joining Razorpay", { speaker: "third_party", subject: "the user", slot: "employer", quote: "Daniel heard I'm joining Razorpay" })]);
  relateBy.set("Daniel heard", (c) => ({ op: "UPDATE", target: c.neighbors[0].j, confidence: 0.95 }));
  await add("e1_hear", "User: E1-HEAR-A I work at Northwind Labs.");
  await add("e1_hear", "User: E1-HEAR-B funny, Daniel heard I'm joining Razorpay.");
  expect((await memRow("e1_hear", "The user works at Northwind Labs")).is_latest).toBe(true);
  expect(await live("e1_hear")).toContain("The user works at Northwind Labs");
  expect(await reviews("e1_hear")).toMatchObject([{ kind: "conflict", memory: "Daniel heard the user is joining Razorpay", payload: { reason: expect.stringContaining("cannot supersede the user") } }]);
});

test("a chat conversation is extracted once, not re-extracted in full on every turn", async () => {
  const cid = "e1-chat-1";
  const turns = ["I drink green tea every morning.", "What else should I know?", "Thanks, that's all."];
  const messages: { role: string; content: string }[] = [];
  for (const t of turns) {
    messages.push({ role: "user", content: t });
    await (await api("/chat", { namespace: "e1_chat", conversationId: cid, messages })).text();
    messages.push({ role: "assistant", content: "Noted." });
    await drain();
  }
  const extractsWithTurn1 = llm.requests.filter((r) => r.role === "extract" && r.body.messages[1].content.includes("green tea every morning"));
  expect(extractsWithTurn1).toHaveLength(1);
});

// ---------- Hallucination / privacy ----------

test("hallucinated candidate (quote not found in, or not supported by, the source) is rejected and logged", async () => {
  extractBy.set("E1-HALLU", () => [
    fact("The user likes coffee", { kind: "preference", quote: "I like coffee" }),
    fact("The user likes tea and owns a teapot", { kind: "preference", quote: "I like tea" }),
    fact("The user likes tea", { kind: "preference", quote: "I like tea" }),
  ]);
  groundBy.set("The user likes tea and owns a teapot", "unsupported");
  await add("e1_hallu", "User: E1-HALLU I like tea.");
  expect(await live("e1_hallu")).toEqual(["The user likes tea"]);
  const [run] = await sql`select stats from dream_runs where ns = 'e1_hallu'`;
  expect(run.stats.rejected).toEqual([
    { content: "The user likes coffee", reason: "quote not found in source" },
    { content: "The user likes tea and owns a teapot", reason: "not supported by the source" },
  ]);
});

test("secrets are redacted before any LLM sees the text", async () => {
  await add("e1_secret", `My OpenAI key is ${SECRET} and I like green tea.`);
  const sent = llm.requests.filter((r) => JSON.stringify(r.body.messages).includes(SECRET));
  expect(sent).toHaveLength(0);
});

test("sensitive memories are excluded from profile injection unless the namespace policy allows it", async () => {
  extractBy.set("E1-SENS", () => [fact("The user has type 2 diabetes", { sensitivity: "sensitive" }), fact("The user likes jazz", { kind: "preference" })]);
  await add("e1_sens", "User: E1-SENS I have type 2 diabetes. I love jazz.");
  const facts = async () => { const p = (await client.profile("e1_sens", {})).profile; return [...p.static, ...p.dynamic].map((m) => m.memory).sort(); };
  expect(await facts()).toEqual(["The user likes jazz"]);
  expect((await api("/ns/e1_sens/x/settings", { injectSensitive: true }, "PATCH")).status).toBe(200);
  expect(await facts()).toEqual(["The user has type 2 diabetes", "The user likes jazz"]);
});

// ---------- Links / retrieval ----------

test("entity alias links facts with low vector similarity ('my manager' = Priya)", async () => {
  extractBy.set("E1-ALIAS-A", () => [fact("Priya Raman is the user's manager", { subject: "Priya Raman", entities: [{ name: "Priya Raman", type: "person", aliases: ["my manager"] }] })]);
  extractBy.set("E1-ALIAS-B", () => [fact("Status reports go out every Friday afternoon", { subject: "my manager", kind: "preference" })]);
  relateBy.set("Status reports", () => ({ op: "ADD", target: null }));
  await add("e1_alias", "User: E1-ALIAS-A Priya Raman is my manager.");
  llm.requests.length = 0;
  await add("e1_alias", "User: E1-ALIAS-B my manager wants status reports every Friday afternoon.");
  const links = await sql`select m.content, me.entity_id from memory_entities me join memories m on m.pk = me.memory_pk where m.ns = 'e1_alias' and me.role = 'subject'`;
  expect(links).toHaveLength(2);
  expect(links[0].entity_id).toBe(links[1].entity_id);
  // ...so the Priya memory is offered as a neighbour when the second fact is related.
  const relateCall = llm.requests.find((r) => r.role === "relate");
  expect(relateCall?.body.messages[1].content).toContain("Priya Raman is the user's manager");
});
test.todo("unapproved inferences rank below trusted facts");

target("paraphrase duplicates don't fill the results (MMR / dedupe)", async () => {
  await add("e1_para", "E1-PARA: notes about Alex's hobbies.");
  const res = await client.search("e1_para", { query: "what does Alex like to do outdoors?", searchMode: "memories", limit: 3, threshold: 0 });
  const hiking = res.results.filter((r) => r.memory?.toLowerCase().includes("hiking"));
  expect(hiking).toHaveLength(1);
});

// ---------- Re-dream ----------

test.todo("re-dream into a shadow namespace produces a diff; swap keeps pinned memories and past review decisions");
