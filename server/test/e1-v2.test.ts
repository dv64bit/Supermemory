// E1 v2 target list (PRD.v2 "Testing Decisions" + bugs confirmed in the P0 audit, docs/v2/GAP_REPORT.md §4).
// Everything goes through the public API with the fake LLM.
//   target(...)    : runnable today, currently FAILS on purpose (see ./targets.ts). When a phase fixes it, bun reports
//                    "marked as failing but it passed": switch it to `test`. SHOW_TARGETS=1 shows why each one fails.
//   test.todo(...) : needs a feature that doesn't exist yet (speaker, confidence, pinned, as_of, ...); written in its phase.
import { beforeAll, afterAll, expect, test } from "bun:test";
import { freshDb, startFakeLlm } from "./fake-llm";

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
const { MemClient } = await import("./client");

let server: ReturnType<typeof Bun.serve>;
let client: InstanceType<typeof MemClient>;
beforeAll(async () => {
  await migrate();
  server = Bun.serve({ port: 0, fetch: createApp("k").fetch });
  client = new MemClient({ apiKey: "k", baseUrl: `http://localhost:${server.port}`, maxRetries: 0 });
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
}, 60_000); // the first test loads the embedding model

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
test("as_of: search as of a past date returns the memory valid then (valid_from <= t < valid_to)", async () => {
  extractBy.set("E1-ASOF-A", () => [fact("Quinn works at Contoso Retail", { subject: "Quinn", slot: "employer" })]);
  extractBy.set("E1-ASOF-B", () => [fact("Quinn works at Northwind Labs", { subject: "Quinn", slot: "employer" })]);
  await add("e1_asof", "E1-ASOF-A Quinn works at Contoso Retail.", { date: "2024-01-10T00:00:00Z" });
  await add("e1_asof", "E1-ASOF-B Quinn joined Northwind Labs.", { date: "2026-01-10T00:00:00Z" });
  const at = async (asOf?: string) => {
    const res = await api("/ns/e1_asof/x/search", { query: "Where does Quinn work?", searchMode: "memories", threshold: 0, ...(asOf && { asOf }) });
    return ((await res.json()) as { results: { memory: string }[] }).results.map((r) => r.memory);
  };
  expect(await at("2025-06-01T00:00:00Z")).toEqual(["Quinn works at Contoso Retail"]);
  expect(await at("2026-06-01T00:00:00Z")).toEqual(["Quinn works at Northwind Labs"]);
  expect(await at()).toEqual(["Quinn works at Northwind Labs"]); // no asOf: the current state
  expect(await at("2023-01-01T00:00:00Z")).toEqual([]); // before anything was known to be true
});

test("temporal query ('where did I work before X') includes superseded history", async () => {
  extractBy.set("E1-HIST-A", () => [fact("The user works at Contoso Retail as a data scientist", { subject: "the user", slot: "employer" })]);
  extractBy.set("E1-HIST-B", () => [fact("The user works at Northwind Labs", { subject: "the user", slot: "employer" })]);
  await add("e1_hist", "User: E1-HIST-A I'm a data scientist at Contoso Retail.", { date: "2024-01-10T00:00:00Z" });
  await add("e1_hist", "User: E1-HIST-B I joined Northwind Labs.", { date: "2026-01-10T00:00:00Z" });
  const ask = async (query: string) => (await client.search("e1_hist", { query, searchMode: "memories", threshold: 0 })).results.map((r) => r.memory);
  expect(await ask("Where do I work?")).toEqual(["The user works at Northwind Labs"]);
  expect(await ask("Where did I work before Northwind?")).toContain("The user works at Contoso Retail as a data scientist");
});

// ---------- Silent overwrites / invariants ----------

test("a model that calls a changed single-valued attribute ADD still supersedes it (same subject, same slot)", async () => {
  extractBy.set("E1-SLOT-A", () => [fact("The user works at Contoso Retail", { subject: "the user", slot: "employer" })]);
  extractBy.set("E1-SLOT-B", () => [fact("The user works at Northwind Labs", { subject: "the user", slot: "employer" })]);
  extractBy.set("E1-SLOT-C", () => [fact("The user plays chess", { subject: "the user", slot: null, kind: "preference" })]);
  relateBy.set("Northwind Labs", () => ({ op: "ADD", target: null, confidence: 0.6 }));
  relateBy.set("plays chess", () => ({ op: "ADD", target: null, confidence: 0.9 }));
  await add("e1_slot", "User: E1-SLOT-A I work at Contoso Retail.", { date: "2026-01-01T00:00:00Z" });
  await add("e1_slot", "User: E1-SLOT-B I just joined Northwind Labs.", { date: "2026-06-01T00:00:00Z" });
  await add("e1_slot", "User: E1-SLOT-C I play chess.", { date: "2026-07-01T00:00:00Z" });
  expect((await memRow("e1_slot", "The user works at Contoso Retail")).is_latest).toBe(false);
  expect((await live("e1_slot")).sort()).toEqual(["The user plays chess", "The user works at Northwind Labs"]);
});

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

test("a fact the assistant repeats back is kept when the quote copies the assistant's wording", async () => {
  extractBy.set("E1-ECHO", () => [fact("The user is flying to Kochi on AI-302 on 2026-10-30", { quote: "flying to Kochi on AI-302" })]);
  await add("e1_echo", "User: E1-ECHO btw I'm flying to Kochi next Friday, flight AI-302.\n\nAssistant: Nice! So you're flying to Kochi on AI-302. Want a packing list?");
  expect(await live("e1_echo")).toEqual(["The user is flying to Kochi on AI-302 on 2026-10-30"]);
});

test("a loosely copied quote goes to the LLM check instead of being rejected outright", async () => {
  extractBy.set("E1-LOOSE", () => [fact("The user now works at Northwind Labs", { slot: "employer", quote: "I am now employed at Northwind Labs" })]);
  await add("e1_loose", "User: E1-LOOSE Big news, I'm now employed at Northwind Labs!");
  expect(await live("e1_loose")).toEqual(["The user now works at Northwind Labs"]);
});

test("a relative date left in a memory is resolved against the document date, not dropped", async () => {
  extractBy.set("E1-REL", () => [fact("The user moved to Pune last week", { quote: "I moved to Pune last week" })]);
  await add("e1_rel", "User: E1-REL I moved to Pune last week.", { date: "2026-10-24T00:00:00Z" });
  expect(await live("e1_rel")).toEqual(["The user moved to Pune in the week of 2026-10-12"]);
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
test("unapproved inferences rank below trusted facts", async () => {
  const { embed } = await import("../src/embed");
  const { toVector } = await import("../src/db");
  await sql`insert into namespaces (id) values ('e1_infer') on conflict do nothing`;
  const put = async (content: string, inference: boolean) => {
    const [v] = await embed([content]);
    await sql`insert into memories (ns, content, kind, is_inference, status, embedding)
      values ('e1_infer', ${content}, 'fact', ${inference}, ${inference ? "pending_review" : "active"}, ${toVector(v)}::vector)`;
  };
  // The inference is the closer match to the query; unapproved, it must still rank below the stated fact.
  await put("Alex probably enjoys green tea", true);
  await put("Alex drinks green tea every evening", false);
  const order = async () => (await client.search("e1_infer", { query: "Does Alex enjoy green tea?", searchMode: "memories", threshold: 0 })).results.map((r) => r.memory);
  expect(await order()).toEqual(["Alex drinks green tea every evening", "Alex probably enjoys green tea"]);
  // Memories with no source document: include.documents must not build an empty `in ()` list.
  const withDocs = await client.search("e1_infer", { query: "green tea", searchMode: "hybrid", include: { documents: true } });
  expect(withDocs.results.length).toBe(2);
  await sql`update memories set status = 'active' where ns = 'e1_infer' and is_inference`; // approved in review
  expect((await order())[0]).toBe("Alex probably enjoys green tea");
});

test("x/context: profile, then relevant memories and document chunks, under the budget; sensitive only if allowed", async () => {
  extractBy.set("E1-CTX-FACTS", () => [
    fact("The user lives in Pune", { subject: "the user", slot: "home_city" }),
    fact("The user prefers short answers", { kind: "preference" }),
    fact("The user has type 2 diabetes", { sensitivity: "sensitive" }),
    fact("The user's daughter Anika plays the violin", { subject: "Anika" }),
  ]);
  extractBy.set("E1-CTX-DOC", () => []);
  await add("e1_ctx", "User: E1-CTX-FACTS I live in Pune, I like short answers, I have type 2 diabetes, and Anika plays the violin.", { date: "2026-11-01T00:00:00Z" });
  await add("e1_ctx", "E1-CTX-DOC Violin lessons: Ms. Kulkarni, Saturdays at 10, bring the A-string replacement.", { id: "violin-notes" });
  const ctx = async (body: Record<string, unknown>) => (await (await api("/ns/e1_ctx/x/context", body)).json()) as any;

  const full = await ctx({ query: "When are the violin lessons?", budgetTokens: 1000, threshold: 0 });
  expect(full.tokens).toBeLessThanOrEqual(1000);
  expect(full.context.indexOf("## About the user")).toBe(0);
  expect(full.context).toContain("- The user lives in Pune");
  expect(full.context).toContain("Ms. Kulkarni"); // the chunk, cited
  expect(full.context).toContain("(violin-notes)");
  expect(full.context).not.toContain("diabetes");

  const tiny = await ctx({ query: "When are the violin lessons?", budgetTokens: 60, threshold: 0 });
  expect(tiny.tokens).toBeLessThanOrEqual(60);
  expect(tiny.context.length).toBeGreaterThan(0);

  expect((await api("/ns/e1_ctx/x/settings", { injectSensitive: true }, "PATCH")).status).toBe(200);
  expect((await ctx({ query: "What health conditions do I have?", budgetTokens: 1000, threshold: 0 })).context).toContain("diabetes");
});

test("paraphrase duplicates don't fill the results (MMR / dedupe)", async () => {
  await add("e1_para", "E1-PARA: notes about Alex's hobbies.");
  const res = await client.search("e1_para", { query: "what does Alex like to do outdoors?", searchMode: "memories", limit: 3, threshold: 0 });
  const hiking = res.results.filter((r) => r.memory?.toLowerCase().includes("hiking"));
  expect(hiking).toHaveLength(1);
});

// ---------- Review inbox / provenance (P5) ----------

// A low-confidence update queues a review item: both memories stay live until a person decides.
async function conflictIn(ns: string) {
  extractBy.set("E1-RV-A", () => [fact("Lena works at Contoso", { quote: "Lena works at Contoso" })]);
  extractBy.set("E1-RV-B", () => [fact("Lena works at Fabrikam", { quote: "Lena works at Fabrikam" })]);
  relateBy.set("Lena works at Fabrikam", (c) => ({ op: "UPDATE", target: c.neighbors[0].j, confidence: 0.5 }));
  await add(ns, "User: E1-RV-A Lena works at Contoso.", { date: "2026-01-01T00:00:00Z" });
  await add(ns, "User: E1-RV-B Lena works at Fabrikam.", { date: "2026-06-01T00:00:00Z" });
  const { items } = (await (await fetch(`http://localhost:${server.port}/ns/${ns}/x/review`, { headers: { authorization: "Bearer k" } })).json()) as any;
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ kind: "low_confidence", memory: { memory: "Lena works at Fabrikam", quote: "Lena works at Fabrikam" }, related: { memory: "Lena works at Contoso" } });
  expect((await live(ns)).sort()).toEqual(["Lena works at Contoso", "Lena works at Fabrikam"]);
  return items[0].id as string;
}
const resolve = (ns: string, id: string, body: Record<string, unknown>) => api(`/ns/${ns}/x/review/${id}`, body);

test("review: keep_new makes the newer memory the next version; keep_old drops it; keep_both keeps both", async () => {
  const a = await conflictIn("e1_rv_new");
  expect((await resolve("e1_rv_new", a, { action: "keep_new" })).status).toBe(200);
  expect(await live("e1_rv_new")).toEqual(["Lena works at Fabrikam"]);
  expect(await memRow("e1_rv_new", "Lena works at Fabrikam")).toMatchObject({ version: 2, status: "active", is_latest: true });

  const b = await conflictIn("e1_rv_old");
  expect((await resolve("e1_rv_old", b, { action: "keep_old" })).status).toBe(200);
  expect(await live("e1_rv_old")).toEqual(["Lena works at Contoso"]);

  const c = await conflictIn("e1_rv_both");
  expect((await resolve("e1_rv_both", c, { action: "keep_both" })).status).toBe(200);
  expect((await live("e1_rv_both")).sort()).toEqual(["Lena works at Contoso", "Lena works at Fabrikam"]);
  const done = (await (await fetch(`http://localhost:${server.port}/ns/e1_rv_both/x/review?status=approved`, { headers: { authorization: "Bearer k" } })).json()) as any;
  expect(done.items[0]).toMatchObject({ id: c, resolution: "keep_both" });

  expect((await resolve("e1_rv_both", c, { action: "keep_new" })).status).toBe(409); // already resolved
  expect((await resolve("e1_rv_both", c, { action: "approve" })).status).toBe(400); // inference-only action
});

test("review: merge replaces both sides with one pinned memory written by the user", async () => {
  const id = await conflictIn("e1_rv_merge");
  const res = await resolve("e1_rv_merge", id, { action: "merge", content: "Lena moved from Contoso to Fabrikam in June 2026" });
  expect(res.status).toBe(200);
  expect(await live("e1_rv_merge")).toEqual(["Lena moved from Contoso to Fabrikam in June 2026"]);
  expect(await memRow("e1_rv_merge", "Lena moved from Contoso to Fabrikam in June 2026")).toMatchObject({ pinned: true, speaker: "user", version: 2 });
  const merged = ((await res.json()) as any).memory.id;
  const why = (await (await fetch(`http://localhost:${server.port}/ns/e1_rv_merge/x/memories/${merged}/explain`, { headers: { authorization: "Bearer k" } })).json()) as any;
  expect(why.summary).toContain("Written or edited by you.");
  expect(why.versions.map((v: any) => v.memory)).toContain("Lena works at Contoso");
});

test("review: an inference is approved into a trusted fact", async () => {
  await sql`insert into namespaces (id) values ('e1_rv_inf') on conflict do nothing`;
  const { embed } = await import("../src/embed");
  const { toVector } = await import("../src/db");
  const [v] = await embed(["Alex probably runs marathons"]);
  const [m] = await sql`insert into memories (ns, content, kind, is_inference, status, embedding)
    values ('e1_rv_inf', 'Alex probably runs marathons', 'fact', true, 'pending_review', ${toVector(v)}::vector) returning pk`;
  const [item] = await sql`insert into review_items (ns, kind, memory_pk) values ('e1_rv_inf', 'inference', ${m.pk}) returning id`;
  expect((await resolve("e1_rv_inf", item.id, { action: "keep_new" })).status).toBe(400); // conflict-only action
  expect((await resolve("e1_rv_inf", item.id, { action: "approve" })).status).toBe(200);
  expect(await memRow("e1_rv_inf", "Alex probably runs marathons")).toMatchObject({ status: "active", is_inference: false });
});

test("explain: a dreamed memory says who said it, the quote, the source, the run and its history", async () => {
  extractBy.set("E1-WHY", () => [fact("The user drinks oolong tea", { kind: "preference", quote: "I drink oolong tea" })]);
  await add("e1_why", "User: E1-WHY I drink oolong tea every afternoon.", { id: "why-doc", date: "2026-02-01T00:00:00Z" });
  const { id } = await memRow("e1_why", "The user drinks oolong tea");
  const why = (await (await fetch(`http://localhost:${server.port}/ns/e1_why/x/memories/${id}/explain`, { headers: { authorization: "Bearer k" } })).json()) as any;
  expect(why.summary).toContain('Learned because you said: "I drink oolong tea".');
  expect(why.summary).toContain("Source: document why-doc.");
  expect(why.summary).toContain("True since 2026-02-01");
  expect(why.memory).toMatchObject({ speaker: "user", document: { id: "why-doc" } });
  expect(why.learnedBy.dreamRun).toBeTruthy();
  expect(why.history.map((e: any) => e.action)).toContain("create");
  expect((await fetch(`http://localhost:${server.port}/ns/e1_why/x/memories/nope/explain`, { headers: { authorization: "Bearer k" } })).status).toBe(404);
});

// ---------- Re-dream ----------

const getJson = async (path: string) => (await (await fetch(`http://localhost:${server.port}${path}`, { headers: { authorization: "Bearer k" } })).json()) as any;
async function redreamed(ns: string) {
  expect((await api(`/ns/${ns}/x/redream`, {})).status).toBe(202);
  for (let i = 0; i < 300; i++) {
    const r = await getJson(`/ns/${ns}/x/redream`);
    if (r.status !== "running") return r;
    await Bun.sleep(100);
  }
  throw new Error("re-dream did not finish");
}

test("re-dream into a shadow namespace produces a diff; swap keeps pinned memories and past review decisions", async () => {
  const NS = "e1_rd";
  // The default fake relate calls everything an UPDATE of its nearest neighbour; in the shadow the pinned Acme memory
  // is there from the start, so the unrelated facts are scripted as ADD.
  relateBy.set("Lena works at Contoso", () => ({ op: "ADD", target: null }));
  relateBy.set("likes", () => ({ op: "ADD", target: null }));
  relateBy.set("Alex manages", () => ({ op: "ADD", target: null }));
  relateBy.set("Alex works at Acme", (c) => {
    const j = c.neighbors.find((n) => n.content.includes("Acme"))?.j;
    return j === undefined ? { op: "ADD", target: null } : { op: "DUPLICATE", target: j };
  });
  // Before: a disagreement the user settled (kept the existing job), a fact, and a memory the user edited (pinned).
  const item = await conflictIn(NS);
  expect((await resolve(NS, item, { action: "keep_old" })).status).toBe(200);
  extractBy.set("E1-RD-TEA", () => [fact("The user likes tea", { kind: "preference" })]);
  extractBy.set("E1-RD-JOB", () => [fact("Alex works at Acme")]);
  await add(NS, "User: E1-RD-TEA I like tea.");
  await add(NS, "User: E1-RD-JOB Alex is my manager at Acme.");
  const { id: acme } = await memRow(NS, "Alex works at Acme");
  expect((await api(`/ns/${NS}/x/memories/${acme}`, { content: "Alex works at Acme Corp" }, "PATCH")).status).toBe(200);
  const before = (await live(NS)).sort();
  expect(before).toEqual(["Alex works at Acme Corp", "Lena works at Contoso", "The user likes tea"]);

  // A better extractor (a prompt change would also change the cache key; here the cache is bypassed instead).
  extractBy.set("E1-RD-TEA", () => [fact("The user likes green tea", { kind: "preference" })]);
  extractBy.set("E1-RD-JOB", () => [fact("Alex works at Acme"), fact("Alex manages the user")]);
  process.env.LLM_CACHE = "off";
  const r = await redreamed(NS).finally(() => delete process.env.LLM_CACHE);
  expect(r).toMatchObject({ status: "ready", total: 4, done: 4, failed: 0, shadow: "e1_rd:shadow" });
  expect(r.report.changed.map((c: any) => [c.before.memory, c.after.memory])).toEqual([["The user likes tea", "The user likes green tea"]]);
  expect(r.report.added.map((m: any) => m.memory)).toEqual(["Alex manages the user"]);
  expect(r.report.removed).toEqual([]);
  expect(r.report.openReviews).toBe(0); // the Fabrikam disagreement came back and was settled the same way
  expect((await live(NS)).sort()).toEqual(before); // nothing changes until the swap

  const swapped = await (await api(`/ns/${NS}/x/redream/swap`, {})).json() as any;
  expect(swapped.status).toBe("swapped");
  expect((await live(NS)).sort()).toEqual(["Alex manages the user", "Alex works at Acme Corp", "Lena works at Contoso", "The user likes green tea"]);
  expect(await memRow(NS, "Alex works at Acme Corp")).toMatchObject({ pinned: true });
  expect((await getJson(`/ns/${NS}/x/review`)).items).toEqual([]);
  expect((await live(swapped.archive)).sort()).toEqual(before); // the old memories are archived, not deleted
  const green = await memRow(NS, "The user likes green tea");
  const [doc] = await sql`select id, ns from documents where pk = ${green.source_document_pk}`;
  expect(doc.ns).toBe(NS); // points at the space's own document, not the dropped shadow copy
  expect((await sql`select 1 from namespaces where id = 'e1_rd:shadow'`).length).toBe(0);
}, 60_000);

test("re-dream: a swap is refused when documents changed meanwhile; discard drops the shadow", async () => {
  const NS = "e1_rd2";
  expect(await getJson(`/ns/${NS}/x/redream`)).toBeNull(); // none yet
  extractBy.set("E1-RD2", () => [fact("Pat likes jazz", { kind: "preference" })]);
  relateBy.set("Pat likes", () => ({ op: "ADD", target: null }));
  await add(NS, "User: E1-RD2 Pat likes jazz.");
  expect((await redreamed(NS)).status).toBe("ready");
  await add(NS, "User: E1-RD2 Pat also likes blues.", { id: "late" });
  const spaces = (await getJson("/ns?limit=100")).namespaces.map((n: any) => n.id);
  expect(spaces).toContain(NS);
  expect(spaces).not.toContain(`${NS}:shadow`); // the working copy is not listed as a space
  const refused = await api(`/ns/${NS}/x/redream/swap`, {});
  expect(refused.status).toBe(409);
  expect(((await refused.json()) as any).error).toContain("since the re-dream started");
  // Deleting a document after the run is refused the same way (its memories would otherwise come back).
  expect((await redreamed(NS)).status).toBe("ready");
  expect((await api(`/ns/${NS}/document`, { ids: ["late"] }, "DELETE")).status).toBe(200);
  expect((await api(`/ns/${NS}/x/redream/swap`, {})).status).toBe(409);
  expect((await api(`/ns/${NS}/x/redream`, {}, "DELETE")).status).toBe(200);
  expect((await getJson(`/ns/${NS}/x/redream`)).status).toBe("discarded");
  expect((await sql`select 1 from namespaces where id = 'e1_rd2:shadow'`).length).toBe(0);
}, 60_000);
