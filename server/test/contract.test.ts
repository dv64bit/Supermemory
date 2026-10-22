// Seam 1: the official `supermemory` v5 SDK against our server. If the SDK is happy, plugins/tools are too.
import { beforeAll, afterAll, expect, test } from "bun:test";

import { freshDb, startFakeLlm } from "./fake-llm";
const llm = startFakeLlm(); // no memories extracted: this file covers documents/chunks only
await freshDb("supermem_test_contract");
const { migrate } = await import("../src/db");
const { createApp } = await import("../src/app");
const { drain } = await import("../src/worker");
const { Supermemory, UnauthorizedError, NotFoundError } = await import("supermemory");

const KEY = "sm_test_key";
let server: ReturnType<typeof Bun.serve>;
let client: InstanceType<typeof Supermemory>;
const NS = "user_alex";

beforeAll(async () => {
  await migrate();
  server = Bun.serve({ port: 0, fetch: createApp(KEY).fetch });
  client = new Supermemory({ apiKey: KEY, baseUrl: `http://localhost:${server.port}`, maxRetries: 0 });
});
afterAll(() => (server.stop(true), llm.stop(true)));

test("add -> ingest -> search round-trips through the SDK", async () => {
  const added = await client.add(NS, {
    content: "# Travel\nAlex moved to Seattle for a PM role at Stripe. He lives in Capitol Hill.\n\n# Food\nAlex loves Ethiopian food.",
    id: "note-1",
    metadata: { source: "note", tags: ["personal"], priority: 3 },
  });
  expect(added).toEqual({ id: "note-1", status: "queued" });
  await client.add(NS, { content: "Quarterly OKRs: ship the payments dashboard and cut fraud losses.", id: "note-2", metadata: { source: "work", priority: 1 } });
  await drain();

  const res = await client.search(NS, { query: "where does Alex live?", searchMode: "chunks", include: { documents: true } });
  expect(res.results.length).toBeGreaterThan(0);
  expect(res.results[0].chunk).toContain("Seattle");
  expect(res.results[0].included?.document?.id).toBe("note-1");
  expect(typeof res.searchTime).toBe("number");
}, 120_000);

test("metadata filters scope results", async () => {
  const work = await client.search(NS, { query: "Alex", filter: { field: "source", operator: "eq", value: "work" }, threshold: 0 });
  expect(work.results.every((r) => r.metadata?.source === "work")).toBe(true);

  const tagged = await client.search(NS, {
    query: "food", threshold: 0,
    filter: { operator: "and", operands: [{ field: "tags", operator: "arrayContains", value: "personal" }, { field: "priority", operator: "gte", value: 2 }] },
  });
  expect(tagged.results.length).toBeGreaterThan(0);
  expect(tagged.results.every((r) => r.metadata?.source === "note")).toBe(true);
});

test("get document with chunks; markdown splits on headings", async () => {
  const doc = await client.documents.get(NS, "note-1", { include: ["chunks"] });
  expect(doc.system.status).toBe("done");
  expect(doc.chunks?.map((c) => c.content.split("\n")[0])).toEqual(["# Travel", "# Food"]);
});

test("re-adding the same id updates in place; unchanged content keeps chunks", async () => {
  const before = await client.documents.get(NS, "note-2", { include: ["chunks"] });
  await client.add(NS, { content: "Quarterly OKRs: ship the payments dashboard and cut fraud losses.", id: "note-2", metadata: { source: "work", priority: 1 } });
  await drain();
  const after = await client.documents.get(NS, "note-2", { include: ["chunks"] });
  expect(after.chunks?.map((c) => c.id)).toEqual(before.chunks?.map((c) => c.id)); // not re-indexed

  await client.documents.update(NS, "note-2", { content: "Quarterly OKRs: hire two engineers." });
  await drain();
  const changed = await client.documents.get(NS, "note-2", { include: ["chunks"] });
  expect(changed.chunks?.[0].content).toContain("hire two engineers");
});

test("batch add, list, delete", async () => {
  const batch = await client.documents.batchAdd(NS, { documents: [{ content: "one", id: "b1" }, { content: "two", id: "b2" }] });
  expect(batch.count).toBe(2);
  await drain();
  const list = await client.list(NS, "documents", {});
  expect(list.documents?.map((d) => d.id).sort()).toEqual(["b1", "b2", "note-1", "note-2"]);

  const del = await client.documents.delete(NS, { ids: ["b1", "nope"] });
  expect(del.count).toBe(1);
  expect(del.errors).toEqual([{ id: "nope", error: "not found" }]);
  expect(await client.documents.get(NS, "b1").then(() => null, (e) => e)).toBeInstanceOf(NotFoundError);
});

test("namespaces list counts documents", async () => {
  const res = await fetch(`http://localhost:${server.port}/ns`, { headers: { authorization: `Bearer ${KEY}` } });
  const body = await res.json();
  expect(body.namespaces[0]).toMatchObject({ id: NS, documentCount: 3 });
});

test("bad key is rejected, bad body is 400", async () => {
  const bad = new Supermemory({ apiKey: "wrong", baseUrl: `http://localhost:${server.port}`, maxRetries: 0 });
  expect(await bad.search(NS, { query: "x" }).then(() => null, (e) => e)).toBeInstanceOf(UnauthorizedError);
  const res = await fetch(`http://localhost:${server.port}/ns/${NS}/search`, {
    method: "POST", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" }, body: JSON.stringify({ query: "" }),
  });
  expect(res.status).toBe(400);
});

// Minimal valid one-page PDF with a text object, built by hand (offsets computed).
function tinyPdf(text: string) {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${`BT /F1 12 Tf 20 100 Td (${text}) Tj ET`.length} >>\nstream\nBT /F1 12 Tf 20 100 Td (${text}) Tj ET\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets = objs.map((o, i) => { const at = out.length; out += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return out;
}

test("file upload: pdf and markdown ingest with their type; unsupported types are rejected", async () => {
  const upload = (file: File, metadata?: object) => {
    const form = new FormData();
    form.set("file", file);
    if (metadata) form.set("metadata", JSON.stringify(metadata));
    return fetch(`http://localhost:${server.port}/ns/${NS}/document/file`, { method: "POST", headers: { authorization: `Bearer ${KEY}` }, body: form });
  };
  const pdf = await upload(new File([tinyPdf("Invoice total is 420 euros")], "invoice.pdf", { type: "application/pdf" }), { source: "upload" });
  expect(pdf.status).toBe(200);
  const { id } = await pdf.json();
  const md = await (await upload(new File(["# Recipe\nAdd two eggs."], "recipe.md"))).json();
  await drain();

  const doc = await client.documents.get(NS, id);
  expect(doc).toMatchObject({ type: "pdf", title: "invoice.pdf", metadata: { source: "upload" } });
  expect(doc.system.status).toBe("done");
  expect(doc.content).toContain("Invoice total is 420 euros");
  expect((await client.documents.get(NS, md.id)).type).toBe("markdown");

  const bad = await upload(new File([new Uint8Array([137, 80, 78, 71])], "photo.png", { type: "image/png" }));
  expect(bad.status).toBe(400);
  expect((await bad.json()).error).toContain("unsupported");
});
