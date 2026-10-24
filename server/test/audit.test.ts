// Audit trail and secret storage: dream_runs, memory_events and llm_calls.dream_run_id are written for every dream
// and every change; secrets never reach stored documents, chunks or memories (raw kept only with STORE_RAW_SECRETS).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { freshDb, startFakeLlm } from "./fake-llm";

const AWS = ["AKIA", "Z7QK2M4N6P8R0T3V"].join(""); // assembled at runtime (GitHub push protection)

const llm = startFakeLlm({
  extract: ({ content }) => {
    if (content.includes("AUDIT-1")) return [{ content: "Ana lives in Lisbon", kind: "fact", expiresAt: null }, { content: "Ana likes surfing", kind: "preference", expiresAt: null }];
    // Duplicate first: the engine's near-duplicate shortcut reads a neighbour's similarity to the first candidate that found it.
    if (content.includes("AUDIT-2")) return [{ content: "Ana likes surfing", kind: "preference", expiresAt: null }, { content: "Ana lives in Porto", kind: "fact", expiresAt: null }];
    if (content.includes("AUDIT-KEY")) return [{ content: `Ana's AWS key is ${content.match(/key (\S+)/)?.[1]}`, kind: "fact", expiresAt: null }];
    return [];
  },
  relate: (c) => (c.content.includes("Porto") ? { relation: "updates", target: c.neighbors[0]?.j ?? null } : { relation: "new", target: null }),
  derive: (ms) => (ms.length >= 2 ? [{ content: "Ana lives near the sea", from: [0, 1] }] : []),
});

await freshDb("supermem_test_audit");
const { migrate, sql } = await import("../src/db");
const { createApp } = await import("../src/app");
const { drain } = await import("../src/worker");

let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
  await migrate();
  server = Bun.serve({ port: 0, fetch: createApp("k").fetch });
});
afterAll(() => (server.stop(true), llm.stop(true)));

const api = (method: string, path: string, body?: unknown) => fetch(`http://localhost:${server.port}${path}`, {
  method, headers: { authorization: "Bearer k", "content-type": "application/json" }, ...(body !== undefined && { body: JSON.stringify(body) }),
}).then((r) => r.json() as Promise<any>);
const add = async (ns: string, content: string, extra: Record<string, unknown> = {}) => {
  const r = await api("POST", `/ns/${ns}/document`, { content, ...extra });
  await drain();
  return r;
};
const events = async (ns: string) =>
  (await sql`select e.action, e.actor, e.dream_run_id, m.content from memory_events e join memories m on m.pk = e.memory_pk
    where m.ns = ${ns} order by e.id`) as { action: string; actor: string; dream_run_id: string | null; content: string }[];

test("each dream is a dream_run; its LLM calls and memory events point at it", async () => {
  await add("au", "AUDIT-1: Ana lives in Lisbon and loves surfing.", { date: "2026-01-10T00:00:00Z" });
  await add("au", "AUDIT-2: Ana moved to Porto. Still surfing.", { date: "2026-06-01T00:00:00Z" });

  const runs = await sql`select * from dream_runs where ns = 'au' order by started_at`;
  expect(runs).toHaveLength(2);
  for (const r of runs) {
    expect(r.status).toBe("done");
    expect(r.finished_at).not.toBeNull();
    expect(r.pipeline_version).toMatch(/^[0-9a-f]{12}$/);
  }
  expect(runs[0].stats).toMatchObject({ candidates: 2, added: 2, inferences: 1 });
  expect(runs[1].stats).toMatchObject({ candidates: 2, updated: 1, duplicates: 1 });

  const calls = await sql`select role, dream_run_id from llm_calls where dream_run_id = ${runs[1].id}`;
  expect(calls.map((c: any) => c.role)).toEqual(expect.arrayContaining(["extract", "relate"]));

  const ev = await events("au");
  expect(ev.map((e) => `${e.action}:${e.content}`)).toEqual([
    "create:Ana lives in Lisbon", "create:Ana likes surfing", "derive:Ana lives near the sea",
    "strengthen:Ana likes surfing", "update:Ana lives in Porto", "supersede:Ana lives in Lisbon",
    ...ev.slice(6).map((e) => `${e.action}:${e.content}`), // the second dream may add an inference
  ]);
  expect(ev.every((e) => e.actor === "dreamer" && runs.some((r: any) => r.id === e.dream_run_id))).toBe(true);

  const [lisbon] = await sql`select valid_from, valid_to, speaker, confidence, pipeline_version, dream_run_id, embedding_model
    from memories where content = 'Ana lives in Lisbon'`;
  expect(lisbon.valid_from.toISOString()).toBe("2026-01-10T00:00:00.000Z");
  expect(lisbon.valid_to.toISOString()).toBe("2026-06-01T00:00:00.000Z");
  expect(lisbon).toMatchObject({ speaker: "document", pipeline_version: runs[0].pipeline_version, dream_run_id: runs[0].id, embedding_model: "Xenova/bge-base-en-v1.5" });
  const [inf] = await sql`select status from memories where content = 'Ana lives near the sea'`;
  expect(inf.status).toBe("pending_review");
}, 60_000); // first test in the file loads the embedding model

test("forget, restore and review are logged", async () => {
  const [m] = await sql`select id from memories where content = 'Ana likes surfing'`;
  await api("DELETE", "/ns/au/memories", { ids: [m.id] });
  await api("POST", `/ns/au/memories/${m.id}/restore`);
  const [inf] = await sql`select id from memories where content = 'Ana lives near the sea'`;
  await api("POST", `/ns/au/memories/${inf.id}/review`, { action: "approve" });

  const ev = (await events("au")).filter((e) => e.actor !== "dreamer");
  expect(ev.map((e) => `${e.action}:${e.actor}:${e.content}`)).toEqual([
    "forget:api:Ana likes surfing", "restore:api:Ana likes surfing", "approve:user:Ana lives near the sea",
  ]);
  const [after] = await sql`select status from memories where id = ${inf.id}`;
  expect(after.status).toBe("active");
});

test("secrets are not stored: document raw and content, chunks and memories are redacted; findings are counted", async () => {
  const { id } = await add("au_key", `AUDIT-KEY: my aws key ${AWS} for the lab`);
  const [doc] = await sql`select pk, raw, content, redactions from documents where ns = 'au_key' and id = ${id}`;
  expect(doc.raw).not.toContain(AWS);
  expect(doc.content).not.toContain(AWS);
  expect(doc.redactions).toEqual({ aws_access_key: 1 });
  const chunks = await sql`select content from chunks where document_pk = ${doc.pk}`;
  expect(chunks.length).toBeGreaterThan(0);
  expect(chunks.every((c: any) => !c.content.includes(AWS))).toBe(true);
  const mems = await sql`select content from memories where ns = 'au_key'`;
  expect(mems.map((m: any) => m.content)).toEqual(["Ana's AWS key is [REDACTED:aws_access_key]"]);
  expect(llm.requests.some((r) => JSON.stringify(r.body).includes(AWS))).toBe(false);
});

test("STORE_RAW_SECRETS=true keeps the raw document, but nothing derived from it", async () => {
  process.env.STORE_RAW_SECRETS = "true";
  try {
    const { id } = await add("au_raw", `AUDIT-KEY: my aws key ${AWS} for the lab`);
    const [doc] = await sql`select pk, raw, content from documents where ns = 'au_raw' and id = ${id}`;
    expect(doc.raw).toContain(AWS);
    expect(doc.content).not.toContain(AWS);
    const leaked = await sql`select 1 from chunks where document_pk = ${doc.pk} and content like ${"%" + AWS + "%"}
      union all select 1 from memories where ns = 'au_raw' and content like ${"%" + AWS + "%"}`;
    expect(leaked).toHaveLength(0);
  } finally {
    delete process.env.STORE_RAW_SECRETS;
  }
});

test("chat messages are redacted before the chat model sees them", async () => {
  const res = await fetch(`http://localhost:${server.port}/chat`, {
    method: "POST", headers: { authorization: "Bearer k", "content-type": "application/json" },
    body: JSON.stringify({ namespace: "au_chat", messages: [{ role: "user", content: `remember ${AWS} please` }] }),
  });
  await res.text();
  await drain();
  expect(llm.requests.some((r) => JSON.stringify(r.body).includes(AWS))).toBe(false);
  const [doc] = await sql`select raw from documents where ns = 'au_chat'`;
  expect(doc.raw).not.toContain(AWS);
});
