// bun run seed:demo: a small "demo" space for trying the web app without a model: two chats, the memories dreaming
// would have learned from them (with quotes and dates), one disagreement waiting for review (old job vs new job) and
// one inferred memory. Only the "demo" namespace is touched; running it again starts that space over.
import { migrate, sql, toVector } from "./db";
import { embed, EMBED_MODEL } from "./embed";
import { logEvents } from "./events";

const NS = "demo";
const CHAT_1 = `User: Hi, I'm an AI engineer. I work at Contoso Retail on their recommendation models.

Assistant: Nice to meet you! What would you like help with?

User: Keep answers short please. Also, my daughter Anika turned 6 last month.`;
const CHAT_2 = `User: Big news, I just joined Northwind Labs as a staff ML engineer.

Assistant: Congratulations! Want me to remember that?`;

type Mem = { content: string; kind: string; quote: string; doc: string; from: string; slot?: string; subject?: string; confidence: number };
const MEMS: Mem[] = [
  { content: "The user is an AI engineer", kind: "fact", quote: "I'm an AI engineer", doc: "chat-demo-1", from: "2026-09-01", confidence: 0.95 },
  { content: "The user works at Contoso Retail on recommendation models", kind: "fact", quote: "I work at Contoso Retail on their recommendation models", doc: "chat-demo-1", from: "2026-09-01", slot: "employer", subject: "the user", confidence: 0.9 },
  { content: "The user prefers short answers", kind: "preference", quote: "Keep answers short please", doc: "chat-demo-1", from: "2026-09-01", confidence: 0.9 },
  { content: "The user's daughter Anika turned 6 in August 2026", kind: "fact", quote: "my daughter Anika turned 6 last month", doc: "chat-demo-1", from: "2026-08-01", subject: "Anika", confidence: 0.85 },
  { content: "The user joined Northwind Labs as a staff ML engineer", kind: "fact", quote: "I just joined Northwind Labs as a staff ML engineer", doc: "chat-demo-2", from: "2026-11-20", slot: "employer", subject: "the user", confidence: 0.9 },
];
const INFERENCE = "The user probably works on machine learning models at Northwind Labs";

await migrate();
await sql`delete from namespaces where id = ${NS}`; // cascades to everything in the demo space
await sql`insert into namespaces (id) values (${NS})`;
const docPk: Record<string, number> = {};
for (const [id, content, date] of [["chat-demo-1", CHAT_1, "2026-09-01"], ["chat-demo-2", CHAT_2, "2026-11-20"]]) {
  const [d] = await sql`insert into documents (ns, id, raw, content, status, dreaming_status, doc_date, dreamed_chars, metadata)
    values (${NS}, ${id}, ${content}, ${content}, 'done', 'done', ${date}, ${content.length}, ${{ source: "chat" }}) returning pk`;
  docPk[id] = d.pk;
}

const vecs = await embed([...MEMS.map((m) => m.content), INFERENCE]);
const pks: number[] = [];
for (const [i, m] of MEMS.entries()) {
  const doc = m.doc === "chat-demo-1" ? CHAT_1 : CHAT_2;
  const start = doc.indexOf(m.quote);
  const [row] = await sql`
    insert into memories (ns, content, kind, source_document_pk, embedding, valid_from, speaker, subject, slot, confidence, sensitivity,
                          source_span, status, embedding_model, metadata)
    values (${NS}, ${m.content}, ${m.kind}, ${docPk[m.doc]}, ${toVector(vecs[i])}::vector, ${m.from}, 'user', ${m.subject ?? null},
            ${m.slot ?? null}, ${m.confidence}, ${m.subject === "Anika" ? "personal" : "none"},
            ${{ document_id: m.doc, start, end: start + m.quote.length, quote: m.quote }}, 'active', ${EMBED_MODEL}, ${{ source: "chat" }})
    returning pk`;
  await sql`update memories set root_id = id where pk = ${row.pk}`;
  pks.push(row.pk);
}
await logEvents(pks.map((pk) => ({ memoryPk: pk, action: "create" as const, actor: "dreamer" as const })));

// The new job contradicts the old one, but the model wasn't sure enough to replace it: both stay until reviewed.
const [contoso, northwind] = [pks[1], pks[4]];
await sql`insert into review_items (ns, kind, memory_pk, related_memory_pk, payload)
  values (${NS}, 'low_confidence', ${northwind}, ${contoso}, ${{ op: "CONFLICT", reason: "low-confidence update (0.62 < 0.75)", confidence: 0.62 }})`;

// An inference drawn from two memories, pending until someone approves it.
const [inf] = await sql`
  insert into memories (ns, content, kind, is_inference, status, source_document_pk, embedding, valid_from, confidence, embedding_model)
  values (${NS}, ${INFERENCE}, 'fact', true, 'pending_review', ${docPk["chat-demo-2"]}, ${toVector(vecs[MEMS.length])}::vector, '2026-11-20', 0.6, ${EMBED_MODEL})
  returning pk`;
await sql`update memories set root_id = id where pk = ${inf.pk}`;
for (const pk of [pks[0], northwind]) await sql`insert into memory_edges (src, dst, rel) values (${inf.pk}, ${pk}, 'derives')`;
await sql`insert into review_items (ns, kind, memory_pk, payload) values (${NS}, 'inference', ${inf.pk}, ${{ from: [pks[0], northwind] }})`;
await logEvents([{ memoryPk: inf.pk, action: "derive", actor: "dreamer" }]);

console.log(`seeded "${NS}": 2 chats, ${MEMS.length + 1} memories, 2 review items (1 disagreement, 1 inference)`);
await sql.close();
