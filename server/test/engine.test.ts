// Seam 2: memory formation through the public API, with a scripted LLM so mechanics are deterministic.
import { beforeAll, afterAll, expect, test } from "bun:test";
import { freshDb, startFakeLlm } from "./fake-llm";
import { target } from "./targets";
import { KNOWN_V5_MISMATCHES, validatingFetch } from "./v5-schema";

const has = (s: string, ...words: string[]) => words.every((w) => s.toLowerCase().includes(w.toLowerCase()));

const llm = startFakeLlm({
  extract: ({ content }) => {
    if (has(content, "Google")) return [{ content: "Alex works at Google as a software engineer", kind: "fact", expiresAt: null }];
    if (has(content, "Stripe")) return [{ content: "Alex works at Stripe as a product manager", kind: "fact", expiresAt: null }];
    if (has(content, "payment APIs")) return [{ content: "Alex frequently discusses payment APIs and fraud detection at work", kind: "fact", expiresAt: null }];
    if (has(content, "morning")) return [{ content: "Alex prefers morning meetings", kind: "preference", expiresAt: null }];
    if (has(content, "exam")) return [{ content: "Alex has a statistics exam", kind: "episode", expiresAt: "2026-03-02T00:00:00Z" }];
    if (has(content, "marathon")) return [{ content: "Alex is training for the Seattle marathon", kind: "episode", expiresAt: null, bucket: "health" }];
    if (has(content, "Pune")) return [{ content: "Alex moved from Pune to Berlin", kind: "fact", expiresAt: "2026-03-01T09:00:00Z" }]; // bogus expiry == doc date
    if (has(content, "dentist")) return [{ content: "Alex visited the dentist", kind: "episode", expiresAt: null }];
    return [];
  },
  relate: (c) => {
    const find = (...w: string[]) => c.neighbors.find((n) => has(n.content, ...w))?.j ?? null;
    if (has(c.content, "Stripe")) return { relation: "updates", target: find("Google") };
    if (has(c.content, "payment APIs")) return { relation: "extends", target: find("Stripe") };
    if (has(c.content, "morning")) return { relation: "duplicate", target: find("morning") };
    return { relation: "new", target: null };
  },
  chat: (messages) => `Echo: ${messages[0].content.includes("Stripe") ? "you work at Stripe" : "no memory"}`,
  forget: ({ request, candidates }) => candidates.filter((c) => has(request, "Google") && has(c.content, "Google") || has(request, "marathon") && has(c.content, "marathon")).map((c) => c.j),
  derive: (ms) => {
    const stripe = ms.find((m) => has(m.content, "Stripe"));
    const pay = ms.find((m) => has(m.content, "payment APIs"));
    return stripe && pay ? [{ content: "Alex likely works on Stripe's core payments product", from: [stripe.j, pay.j] }] : [];
  },
});

await freshDb("supermem_test_engine");
const { migrate } = await import("../src/db");
const { createApp } = await import("../src/app");
const { drain } = await import("../src/worker");
const { Supermemory } = await import("supermemory");

const NS = "user_alex_engine";
let server: ReturnType<typeof Bun.serve>;
let client: InstanceType<typeof Supermemory>;

beforeAll(async () => {
  await migrate();
  server = Bun.serve({ port: 0, fetch: createApp("k").fetch });
  client = new Supermemory({ apiKey: "k", baseUrl: `http://localhost:${server.port}`, maxRetries: 0, fetch: validatingFetch(KNOWN_V5_MISMATCHES) });
});
afterAll(() => (server.stop(true), llm.stop(true)));

const add = async (content: string, extra: Record<string, unknown> = {}) => {
  await client.add(NS, { content, ...extra });
  await drain();
};

test("new job updates the old one; old fact drops out of search but stays in history", async () => {
  await add("Alex works at Google as a software engineer.", { id: "d1" });
  await add("Big news: Alex just started at Stripe as a PM!", { id: "d2" });

  const res = await client.search(NS, { query: "where does Alex work?", searchMode: "memories", threshold: 0 });
  const texts = res.results.map((r) => r.memory);
  expect(texts[0]).toContain("Stripe");
  expect(texts.some((t) => t?.includes("Google"))).toBe(false);
  expect(res.results[0].isLatest).toBe(true);

  const stripe = await client.memories.get(NS, res.results[0].id, {});
  expect(stripe.version).toBe(2);
  expect(stripe.included?.related?.parents).toMatchObject([{ relation: "updates", memory: expect.stringContaining("Google") }]);
  expect(stripe.included?.document?.id).toBe("d2");
}, 120_000);

test("extends links detail; derive adds a flagged inference", async () => {
  await add("He keeps talking about payment APIs and fraud detection.", { id: "d3" });

  const res = await client.search(NS, { query: "Stripe payments", searchMode: "memories", threshold: 0, include: { related: true } });
  const inference = res.results.find((r) => r.isInference);
  expect(inference?.memory).toContain("core payments product");
  expect(inference?.included?.related?.parents?.map((p) => p.relation)).toEqual(["derives", "derives"]);

  const stripe = res.results.find((r) => r.memory?.includes("product manager"))!;
  const children = stripe.included?.related?.children?.map((c) => c.relation).sort();
  expect(children).toEqual(["derives", "extends"]);
});

test("a repeated preference is a duplicate, not a second memory", async () => {
  await add("Alex said he prefers morning meetings.");
  await add("Reminder: Alex likes meetings in the morning.");
  const list = await client.list(NS, "memories", {});
  expect(list.memories?.filter((m) => m.memory.includes("morning"))).toHaveLength(1);
});

test("time-bound facts expire: hidden by default, visible with forgotten", async () => {
  await add("Alex has a statistics exam tomorrow.", { date: "2026-03-01T09:00:00Z" });
  const live = await client.search(NS, { query: "exam", searchMode: "memories", threshold: 0 });
  expect(live.results.some((r) => r.memory?.includes("exam"))).toBe(false);

  const all = await client.search(NS, { query: "exam", searchMode: "memories", threshold: 0, include: { forgotten: true } });
  expect(all.results.some((r) => r.memory?.includes("exam"))).toBe(true);
});

test("forget by id is soft and reversible via include.forgotten", async () => {
  const list = await client.list(NS, "memories", {});
  const pref = list.memories!.find((m) => m.memory.includes("morning"))!;
  const out = await client.memories.forget(NS, { ids: [pref.id, "missing"] });
  expect(out.count).toBe(1);
  expect(out.errors).toEqual([{ id: "missing", error: "not found" }]);

  const after = await client.list(NS, "memories", {});
  expect(after.memories!.some((m) => m.id === pref.id)).toBe(false);
  const withForgotten = await client.list(NS, "memories", { include: { forgotten: true } });
  expect(withForgotten.memories!.find((m) => m.id === pref.id)?.isForgotten).toBe(true);
});

test("hybrid mode mixes memories and chunks; documents report memory counts", async () => {
  const res = await client.search(NS, { query: "Stripe", threshold: 0 });
  expect(res.results.some((r) => r.memory)).toBe(true);
  expect(res.results.some((r) => r.chunk)).toBe(true);

  const doc = await client.documents.get(NS, "d2", { include: ["memories"] });
  expect(doc.system.dreamingStatus).toBe("done");
  expect(doc.memories?.[0].memory).toContain("Stripe");
});

test("profile: durable facts are static, preferences bucketed, episodes dynamic", async () => {
  await client.add(NS, { content: "Alex prefers morning meetings." }); // re-learn the preference forgotten above
  await drain();
  const [{ profile }] = [await client.profile(NS, {})];
  const statics = profile.static.map((m) => m.memory);
  expect(statics.some((m) => m.includes("product manager"))).toBe(false); // changed recently -> dynamic
  expect(profile.dynamic.map((m) => m.memory).some((m) => m.includes("product manager"))).toBe(true);
  expect(statics.some((m) => m.includes("payment APIs"))).toBe(true);
  expect(profile.buckets.preferences.map((m) => m.memory)).toContain("Alex prefers morning meetings");
  expect(statics.concat(profile.dynamic.map((m) => m.memory)).some((m) => m.includes("likely"))).toBe(false); // inferences excluded until approved
});

test("custom buckets classify new memories", async () => {
  const put = await client.profiles.setBuckets(NS, { buckets: { health: "Fitness, medical and wellbeing" } });
  expect(Object.keys(put.buckets).sort()).toEqual(["health", "preferences"]);
  await client.add(NS, { content: "Alex is training for the marathon in spring." });
  await drain();
  const { profile } = await client.profile(NS, {});
  expect(profile.buckets.health.map((m) => m.memory)).toEqual(["Alex is training for the Seattle marathon"]);
  expect(profile.dynamic.map((m) => m.memory)).toContain("Alex is training for the Seattle marathon");
});

test("review: approve keeps an inference as fact, decline forgets it", async () => {
  const base = `http://localhost:${server.port}/ns/${NS}/memories`;
  const h = { authorization: "Bearer k", "content-type": "application/json" };
  const list = await client.list(NS, "memories", {});
  const inf = list.memories!.find((m) => m.isInference)!;
  const ok = await fetch(`${base}/${inf.id}/review`, { method: "POST", headers: h, body: JSON.stringify({ action: "approve" }) });
  expect((await ok.json()).isInference).toBe(false);
  const again = await fetch(`${base}/${inf.id}/review`, { method: "POST", headers: h, body: JSON.stringify({ action: "decline" }) });
  expect(again.status).toBe(404); // no longer an inference
});

test("semantic forget: dry run reports, real run forgets only what the LLM picked", async () => {
  const dry = await client.memories.forgetMatching(NS, { query: "forget the marathon stuff", dryRun: true });
  expect(dry.matches.map((m) => m.memory)).toEqual(["Alex is training for the Seattle marathon"]);
  expect((await client.profile(NS, {})).profile.buckets.health).toHaveLength(1); // untouched

  const real = await client.memories.forgetMatching(NS, { query: "forget the marathon stuff", dryRun: false });
  expect(real.count).toBe(1);
  expect((await client.profile(NS, {})).profile.buckets.health).toHaveLength(0);
});

test("sweep: unreinforced episodes decay and are forgotten; expired facts are flagged", async () => {
  const { sql } = await import("../src/db");
  const { sweep } = await import("../src/lifecycle");
  await client.add(NS, { content: "Alex went to the dentist." });
  await drain();
  // lifecycle.yaml: significance 0.5, half-life 30 days, forget below 0.05 -> gone after ~100 days unreinforced.
  await sql`update memories set updated_at = now() - interval '60 days' where content like '%dentist%'`;
  await sweep();
  expect((await client.list(NS, "memories", { include: { forgotten: true } })).memories!.find((m) => m.memory.includes("dentist"))?.isForgotten).toBe(false);
  await sql`update memories set updated_at = now() - interval '120 days' where content like '%dentist%'`;
  await sweep();
  const all = await client.list(NS, "memories", { include: { forgotten: true } });
  expect(all.memories!.find((m) => m.memory.includes("dentist"))?.isForgotten).toBe(true);
  const [exam] = await sql`select forget_reason from memories where content like '%exam%'`;
  expect(exam.forget_reason).toBe("expired");
});

const api = (path: string, init: RequestInit = {}) =>
  fetch(`http://localhost:${server.port}${path}`, { ...init, headers: { authorization: "Bearer k", "content-type": "application/json", ...init.headers } });

test("restore brings a forgotten memory back; inference filter lists only inferences", async () => {
  const all = await client.list(NS, "memories", { include: { forgotten: true } });
  const gone = all.memories!.find((m) => m.isForgotten && m.memory.includes("marathon"))!;
  const res = await api(`/ns/${NS}/memories/${gone.id}/restore`, { method: "POST" });
  expect((await res.json()).isForgotten).toBe(false);
  expect((await client.list(NS, "memories", {})).memories!.some((m) => m.id === gone.id)).toBe(true);
  expect((await api(`/ns/${NS}/memories/nope/restore`, { method: "POST" })).status).toBe(404);

  await add("He keeps talking about payment APIs and fraud detection, again."); // may re-derive; filter must hold either way
  const inf = await (await api(`/ns/${NS}/list/memories?inference=true`, { method: "POST", body: "{}" })).json();
  expect(inf.memories.every((m: any) => m.isInference)).toBe(true);
});

test("graph returns memory + document nodes and typed edges", async () => {
  const g = await (await api(`/ns/${NS}/graph`)).json();
  const rels = new Set(g.edges.map((e: any) => e.relation));
  for (const r of ["updates", "extends", "source"]) expect(rels.has(r)).toBe(true);
  const ids = new Set(g.nodes.map((n: any) => n.id));
  expect(g.edges.every((e: any) => ids.has(e.source) && ids.has(e.target))).toBe(true);
  expect(g.nodes.find((n: any) => n.type === "memory" && n.label?.includes("Google"))?.isLatest).toBe(false); // old version kept for the chain
});

test("chat streams context + reply over SSE and saves the conversation as memory", async () => {
  const res = await api("/chat", { method: "POST", body: JSON.stringify({ namespace: NS, messages: [{ role: "user", content: "Where do I work? Stripe?" }] }) });
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const events = (await res.text()).trim().split("\n\n").map((block) => ({
    event: block.match(/^event: (.*)$/m)?.[1], data: JSON.parse(block.match(/^data: (.*)$/m)![1]),
  }));
  expect(events[0].event).toBe("context");
  expect(events[0].data.memories.some((m: any) => m.memory.includes("Stripe"))).toBe(true);
  expect(events.filter((e) => e.event === "delta").map((e) => e.data.text).join("")).toBe("Echo: you work at Stripe");
  const done = events.at(-1)!;
  expect(done.event).toBe("done");

  await drain();
  const doc = await client.documents.get(NS, `chat-${done.data.conversationId}`);
  expect(doc.metadata).toEqual({ source: "chat" });
  expect(doc.content).toContain("Assistant: Echo: you work at Stripe");
});

test("an expiry at or before the document date is ignored (lasting fact stays live)", async () => {
  await add("Alex moved from Pune to Berlin last year.", { date: "2026-03-01T09:00:00Z" });
  const { sweep } = await import("../src/lifecycle");
  await sweep();
  const list = await client.list(NS, "memories", {});
  expect(list.memories!.some((m) => m.memory.includes("Pune"))).toBe(true);
});

// Known v5 deviation (GAP_REPORT §3 #2), scheduled for P4: make it a plain `test` once it passes (see ./targets.ts).
target("v5 mismatch (P4): memories.get with include=documents returns the source document", async () => {
  const list = await client.list(NS, "memories", {});
  const fromDoc = list.memories!.find((m) => m.memory.includes("Stripe"))!;
  const m = await client.memories.get(NS, fromDoc.id, { include: ["documents"] });
  expect(m.included?.document?.id).toBe("d2");
});
