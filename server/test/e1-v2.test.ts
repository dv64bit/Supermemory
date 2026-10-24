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

const llm = startFakeLlm({
  extract: ({ content }) => {
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
  // The relate model always claims the newcomer supersedes its closest neighbour: the policy in code must decide.
  relate: (c) => (c.neighbors.length ? { relation: "updates", target: c.neighbors[0].j } : { relation: "new", target: null }),
  chat: () => "Noted.",
});

await freshDb("supermem_test_e1v2");
const { migrate } = await import("../src/db");
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
const api = (path: string, body: unknown) => fetch(`http://localhost:${server.port}${path}`, {
  method: "POST", headers: { authorization: "Bearer k", "content-type": "application/json" }, body: JSON.stringify(body),
});

// ---------- Time ----------

target("late-arriving old fact becomes historical, not latest", async () => {
  await add("e1_late", "E1-LATE-NEW: Alex just started at Stripe as a PM.", { date: "2026-05-01T00:00:00Z" });
  await add("e1_late", "E1-LATE-OLD: Alex works at Google as an engineer.", { date: "2024-01-15T00:00:00Z" });
  const now = await live("e1_late");
  expect(now.some((m) => m.includes("Stripe"))).toBe(true);
  expect(now.some((m) => m.includes("Google"))).toBe(false);
});

test.todo("relative date ('tomorrow') is resolved to an absolute valid_from against the document date");
test.todo("as_of: search as of a past date returns the memory valid then (valid_from <= t < valid_to)");
test.todo("temporal query ('where did I work before X') includes superseded history");

// ---------- Silent overwrites / invariants ----------

target("a numeric change is an update, not a duplicate (2 children -> 3 children)", async () => {
  await add("e1_kids", "E1-KIDS-2: Kim has two kids.");
  await add("e1_kids", "E1-KIDS-3: Kim had another baby, three kids now.");
  const now = await live("e1_kids");
  expect(now).toContain("Kim has 3 children");
  expect(now).not.toContain("Kim has 2 children");
});

target("one memory is superseded by at most one live successor (no version fork)", async () => {
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

target("deleting a document keeps its memories as history, out of default search", async () => {
  await add("e1_delete", "E1-DELETE: Lee lives in Paris.", { id: "lee" });
  expect(await live("e1_delete")).toContain("Lee lives in Paris");
  await client.documents.delete("e1_delete", { ids: ["lee"] });
  const res = await client.search("e1_delete", { query: "where does Lee live?", searchMode: "memories", threshold: 0 });
  expect(res.results.map((r) => r.memory)).not.toContain("Lee lives in Paris");
});

test.todo("editing a document ends (valid_to) the memories its old version produced that the new version no longer supports");
test.todo("low-confidence UPDATE creates a conflict review item; both memories stay active");
test.todo("CONFLICT op never supersedes; it creates a conflict review item");
test.todo("pinned (user-written or edited) memory is never superseded automatically; the conflicting candidate goes to review");
test.todo("property: for any (ns, subject, slot), latest memories never have overlapping [valid_from, valid_to)");

// ---------- Speakers ----------

test.todo("assistant suggestion is not stored as a user fact; it is stored once the user confirms it");
test.todo("third-party claim is stored attributed ('Ravi said ...'), not as fact");
test.todo("a third-party or assistant statement cannot supersede a speaker=user memory");

target("a chat conversation is extracted once, not re-extracted in full on every turn", async () => {
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

test.todo("hallucinated candidate (quote not found in, or not supported by, the source) is rejected and logged");

test("secrets are redacted before any LLM sees the text", async () => {
  await add("e1_secret", `My OpenAI key is ${SECRET} and I like green tea.`);
  const sent = llm.requests.filter((r) => JSON.stringify(r.body.messages).includes(SECRET));
  expect(sent).toHaveLength(0);
});

test.todo("sensitive memories are excluded from profile injection unless the namespace policy allows it");

// ---------- Links / retrieval ----------

test.todo("entity alias links facts with low vector similarity ('my manager' = Priya)");
test.todo("unapproved inferences rank below trusted facts");

target("paraphrase duplicates don't fill the results (MMR / dedupe)", async () => {
  await add("e1_para", "E1-PARA: notes about Alex's hobbies.");
  const res = await client.search("e1_para", { query: "what does Alex like to do outdoors?", searchMode: "memories", limit: 3, threshold: 0 });
  const hiking = res.results.filter((r) => r.memory?.toLowerCase().includes("hiking"));
  expect(hiking).toHaveLength(1);
});

// ---------- Re-dream ----------

test.todo("re-dream into a shadow namespace produces a diff; swap keeps pinned memories and past review decisions");
