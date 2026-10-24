// Migration runner: every migration applies, rolls back and re-applies cleanly; edited migrations are refused;
// v1 data is backfilled as PRD.v2 specifies.
import { afterAll, expect, test } from "bun:test";
import { freshDb } from "./fake-llm";

await freshDb("supermem_test_migrations");
const { migrate, migrationStatus, rollback, sql } = await import("../src/db");
afterAll(() => sql.close());

const tables = async () =>
  ((await sql`select table_name from information_schema.tables where table_schema = 'public' and table_name <> 'schema_migrations' order by 1`) as { table_name: string }[])
    .map((r) => r.table_name);
const columns = async (table: string) =>
  ((await sql`select column_name from information_schema.columns where table_name = ${table} order by 1`) as { column_name: string }[]).map((r) => r.column_name);

test("up, all the way down, and up again", async () => {
  const all = (await migrationStatus()).length;
  expect(await migrate()).toHaveLength(all);
  expect(await migrate()).toEqual([]); // idempotent
  expect((await migrationStatus()).every((m) => m.applied)).toBe(true);
  const full = await tables();
  expect(full).toEqual(expect.arrayContaining(["memories", "memory_events", "dream_runs", "entities", "memory_entities", "review_items"]));
  const memCols = await columns("memories");

  // Each step down undoes exactly that migration; at the bottom no tables are left.
  for (let i = all; i > 0; i--) {
    expect(await rollback()).toHaveLength(1);
    expect((await migrationStatus()).filter((m) => m.applied)).toHaveLength(i - 1);
  }
  expect(await tables()).toEqual([]);

  expect(await migrate()).toHaveLength(all);
  expect(await tables()).toEqual(full);
  expect(await columns("memories")).toEqual(memCols);
});

test("a migration edited after it was applied is refused", async () => {
  await migrate();
  await sql`update schema_migrations set checksum = 'edited' where version = 1`;
  await expect(migrate()).rejects.toThrow(/edited after it was applied/);
});

test("v1 data is backfilled: event time, speaker, confidence, status, superseded valid_to", async () => {
  await sql.unsafe("drop schema public cascade; create schema public");
  await migrate({ to: 1 });
  const v = `[${Array(768).fill(0.01).join(",")}]`;
  await sql`insert into namespaces (id) values ('n')`;
  const [d] = await sql`insert into documents (ns, id, raw, doc_date) values ('n', 'd1', 'x', '2024-03-01T00:00:00Z') returning pk`;
  const [old] = await sql`insert into memories (ns, content, is_latest, source_document_pk, embedding, created_at)
    values ('n', 'Kim has 2 children', false, ${d.pk}, ${v}::vector, '2024-03-02T00:00:00Z') returning pk`;
  const [neu] = await sql`insert into memories (ns, content, embedding, created_at) values ('n', 'Kim has 3 children', ${v}::vector, '2025-06-01T00:00:00Z') returning pk`;
  await sql`insert into memory_edges (src, dst, rel) values (${neu.pk}, ${old.pk}, 'updates')`;
  await sql`insert into memories (ns, content, is_inference, embedding) values ('n', 'Kim is a parent', true, ${v}::vector)`;
  await sql`insert into memories (ns, content, is_inference, is_forgotten, forget_reason, embedding) values ('n', 'Kim dislikes kids', true, true, 'declined in review', ${v}::vector)`;

  await migrate();
  const rows = await sql`select content, valid_from, valid_to, learned_at, speaker, confidence, status, embedding_model from memories order by pk`;
  const by = Object.fromEntries(rows.map((r: any) => [r.content, r]));
  expect(by["Kim has 2 children"].valid_from.toISOString()).toBe("2024-03-01T00:00:00.000Z"); // the document's date
  expect(by["Kim has 2 children"].valid_to.toISOString()).toBe("2025-06-01T00:00:00.000Z"); // where its successor starts
  expect(by["Kim has 3 children"].valid_from.toISOString()).toBe("2025-06-01T00:00:00.000Z"); // no document: created_at
  expect(by["Kim has 3 children"].valid_to).toBeNull();
  expect(by["Kim has 3 children"].learned_at.toISOString()).toBe("2025-06-01T00:00:00.000Z");
  for (const r of rows) {
    expect(r.speaker).toBe("document");
    expect(r.confidence).toBeCloseTo(0.7);
    expect(r.embedding_model).toBe("Xenova/bge-base-en-v1.5");
  }
  expect(by["Kim has 2 children"].status).toBe("active");
  expect(by["Kim is a parent"].status).toBe("pending_review");
  expect(by["Kim dislikes kids"].status).toBe("rejected");
});
