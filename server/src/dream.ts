// "Dreaming": turn an indexed document into atomic memories linked to what the namespace already knew.
// Three LLM passes per document: extract -> relate (to nearest existing memories) -> derive (inferences).
import { sql, toVector } from "./db";
import { embed } from "./embed";
import { call } from "./llm";

const NEIGHBORS = 5;
const NEIGHBOR_MIN_SIM = 0.55;
const MAX_CANDIDATES = 30;
const DUPLICATE_SIM = 0.92; // ponytail: embedding near-identity as "already known"; tune on real data

type Kind = "fact" | "preference" | "episode";
type Candidate = { content: string; kind: Kind; expiresAt: string | null; bucket?: string | null };
type Neighbor = { pk: number; id: string; content: string; version: number; root_id: string | null; sim: number };

const str = { type: "string" };
const extractSchema = {
  type: "object", additionalProperties: false, required: ["memories"],
  properties: {
    memories: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["content", "kind", "expiresAt"],
        properties: { content: str, kind: { type: "string", enum: ["fact", "preference", "episode"] }, expiresAt: { type: ["string", "null"] } },
      },
    },
  },
};
const relateSchema = {
  type: "object", additionalProperties: false, required: ["decisions"],
  properties: {
    decisions: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["i", "relation", "target"],
        properties: { i: { type: "integer" }, relation: { type: "string", enum: ["new", "duplicate", "updates", "extends"] }, target: { type: ["integer", "null"] } },
      },
    },
  },
};
const deriveSchema = {
  type: "object", additionalProperties: false, required: ["inferences"],
  properties: {
    inferences: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["content", "from"], properties: { content: str, from: { type: "array", items: { type: "integer" } } } },
    },
  },
};

const withBucket = (names: string[]) => {
  const item = extractSchema.properties.memories.items;
  return { ...extractSchema, properties: { memories: { type: "array", items: {
    ...item, required: [...item.required, "bucket"],
    properties: { ...item.properties, bucket: { type: ["string", "null"], enum: [...names, null] } },
  } } } };
};

const validDate = (s: string | null) => (s && !Number.isNaN(Date.parse(s)) ? new Date(s) : null);
// An expiry at or before the moment the content was written is a model mistake, not a deadline: ignore it.
const expiry = (s: string | null, docDate: Date) => {
  const d = validDate(s);
  return d && d > docDate ? d : null;
};

/** Extraction as the engine runs it (D1 today): one call over the whole unit, capped at MAX_CANDIDATES. */
export async function extractCandidates(ns: string, unit: { content: string; documentDate: Date; supportingContext: string | null }) {
  // Custom profile buckets ride along with extraction; "preferences" is assigned by kind.
  const custom = await sql`select name, description from profile_buckets where ns = ${ns} order by name`;
  const { memories } = await call<{ memories: Candidate[] }>(
    "extract",
    custom.length ? "extract-buckets.v1" : "extract.v1",
    {
      supportingContext: unit.supportingContext, documentDate: unit.documentDate.toISOString(), content: unit.content,
      ...(custom.length && { buckets: Object.fromEntries(custom.map((b: any) => [b.name, b.description])) }),
    },
    custom.length ? withBucket(custom.map((b: any) => b.name)) : extractSchema,
  );
  const bucketNames = new Set<string>(custom.map((b: any) => b.name));
  return { cands: memories.filter((m) => m.content?.trim()).slice(0, MAX_CANDIDATES), bucketNames };
}

/**
 * Relation decisions as the engine makes them today: per candidate, the nearest live memories (vector top-k above a
 * similarity floor), a near-duplicate shortcut, then one batched LLM call. `target` indexes into `neighbors`.
 */
export async function relateCandidates(ns: string, cands: { content: string }[], vecs: number[][]) {
  // Nearest live memories per candidate, numbered globally so the LLM can point at them.
  const neighbors: Neighbor[] = [];
  const neighborIdx = new Map<number, number>();
  const candNeighbors: number[][] = [];
  for (const v of vecs) {
    const rows = (await sql`
      select pk, id, content, version, root_id, 1 - (embedding <=> ${toVector(v)}::vector) as sim from memories
      where ns = ${ns} and is_latest and not is_forgotten
        and 1 - (embedding <=> ${toVector(v)}::vector) >= ${NEIGHBOR_MIN_SIM}
      order by embedding <=> ${toVector(v)}::vector limit ${NEIGHBORS}`) as Neighbor[];
    candNeighbors.push(rows.map((r) => {
      if (!neighborIdx.has(r.pk)) neighborIdx.set(r.pk, neighbors.push(r) - 1);
      return neighborIdx.get(r.pk)!;
    }));
  }

  const decisions = new Map<number, { relation: string; target: number | null }>();
  // Near-identical to something already known: a duplicate, no LLM needed (small models miss these).
  const nearDup = (i: number) => (candNeighbors[i].length && neighbors[candNeighbors[i][0]].sim >= DUPLICATE_SIM ? candNeighbors[i][0] : null);
  const toRelate = cands.map((c, i) => ({ i, content: c.content, neighbors: candNeighbors[i].map((j) => ({ j, content: neighbors[j].content })) }))
    .filter((c) => c.neighbors.length && nearDup(c.i) === null);
  for (const i of cands.keys()) if (nearDup(i) !== null) decisions.set(i, { relation: "duplicate", target: nearDup(i) });
  if (toRelate.length) {
    const out = await call<{ decisions: { i: number; relation: string; target: number | null }[] }>(
      "relate", "relate.v1", { candidates: toRelate }, relateSchema,
    );
    for (const d of out.decisions) {
      // Only trust targets that were actually offered for that candidate.
      if (d.relation === "new" || (d.target !== null && candNeighbors[d.i]?.includes(d.target))) decisions.set(d.i, d);
    }
  }

  return { neighbors, candNeighbors, decisions };
}

export async function dream(docPk: number) {
  const [doc] = await sql`
    select d.pk, d.ns, d.content, d.metadata, coalesce(d.supporting_context, n.supporting_context) as ctx,
           coalesce(d.doc_date, d.created_at) as doc_date
    from documents d join namespaces n on n.id = d.ns where d.pk = ${docPk}`;
  if (!doc?.content?.trim()) return;

  const { cands, bucketNames } = await extractCandidates(doc.ns, { content: doc.content, documentDate: doc.doc_date, supportingContext: doc.ctx });
  if (!cands.length) return;
  const vecs = await embed(cands.map((c) => c.content));
  const { neighbors, candNeighbors, decisions } = await relateCandidates(doc.ns, cands, vecs);

  const inserted: { pk: number; content: string; related: number[] }[] = [];
  await sql.begin(async (tx) => {
    const insert = async (c: Candidate, v: number[], extra: { version?: number; root_id?: string | null; is_inference?: boolean } = {}) => {
      const bucket = c.bucket && bucketNames.has(c.bucket) ? c.bucket : null;
      const [m] = await tx`
        insert into memories (ns, content, kind, bucket, forget_after, version, root_id, is_inference, metadata, source_document_pk, embedding)
        values (${doc.ns}, ${c.content}, ${c.kind}, ${bucket}, ${expiry(c.expiresAt ?? null, doc.doc_date)}, ${extra.version ?? 1}, ${extra.root_id ?? null},
                ${extra.is_inference ?? false}, ${doc.metadata}, ${doc.pk}, ${toVector(v)}::vector)
        returning pk, id`;
      if (!extra.root_id) await tx`update memories set root_id = id where pk = ${m.pk}`;
      return m as { pk: number; id: string };
    };

    for (const [i, c] of cands.entries()) {
      const d = decisions.get(i) ?? { relation: "new", target: null };
      const target = d.target !== null ? neighbors[d.target] : undefined;
      if (d.relation === "duplicate" && target) {
        await tx`update memories set strength = strength + 1, updated_at = now() where pk = ${target.pk}`;
        continue;
      }
      if (d.relation === "updates" && target) {
        const m = await insert(c, vecs[i], { version: target.version + 1, root_id: target.root_id ?? target.id });
        await tx`update memories set is_latest = false, updated_at = now() where pk = ${target.pk}`;
        await tx`insert into memory_edges (src, dst, rel) values (${m.pk}, ${target.pk}, 'updates')`;
        inserted.push({ pk: m.pk, content: c.content, related: [] });
        continue;
      }
      const m = await insert(c, vecs[i]);
      if (d.relation === "extends" && target) await tx`insert into memory_edges (src, dst, rel) values (${m.pk}, ${target.pk}, 'extends')`;
      inserted.push({ pk: m.pk, content: c.content, related: candNeighbors[i].map((j) => neighbors[j].pk) });
    }
  });

  await derive(doc, inserted);
}

// Inferences over the touched cluster: new memories plus the live neighbors they landed next to.
async function derive(doc: { ns: string; pk: number; metadata: unknown }, inserted: { pk: number; content: string; related: number[] }[]) {
  if (!inserted.length) return;
  const pks = [...new Set([...inserted.map((m) => m.pk), ...inserted.flatMap((m) => m.related)])];
  const pool = (await sql`
    select pk, content from memories where pk in ${sql(pks)} and is_latest and not is_forgotten order by pk limit 15`) as { pk: number; content: string }[];
  if (pool.length < 2) return;
  const { inferences } = await call<{ inferences: { content: string; from: number[] }[] }>(
    "derive", "derive.v1", { memories: pool.map((m, j) => ({ j, content: m.content })) }, deriveSchema,
  );
  const valid = inferences.filter((x) => x.content?.trim() && x.from.filter((j) => pool[j]).length >= 2).slice(0, 3);
  if (!valid.length) return;
  const vecs = await embed(valid.map((x) => x.content));
  await sql.begin(async (tx) => {
    for (const [k, x] of valid.entries()) {
      // The same cluster gets re-derived as neighbors recur; skip anything the namespace already knows.
      const [{ known }] = await tx`select exists (select 1 from memories where ns = ${doc.ns} and is_latest and not is_forgotten
        and 1 - (embedding <=> ${toVector(vecs[k])}::vector) >= ${DUPLICATE_SIM}) as known`;
      if (known) continue;
      const [m] = await tx`
        insert into memories (ns, content, kind, is_inference, metadata, source_document_pk, embedding)
        values (${doc.ns}, ${x.content}, 'fact', true, ${doc.metadata}, ${doc.pk}, ${toVector(vecs[k])}::vector)
        returning pk`;
      await tx`update memories set root_id = id where pk = ${m.pk}`;
      for (const j of new Set(x.from)) {
        if (pool[j]) await tx`insert into memory_edges (src, dst, rel) values (${m.pk}, ${pool[j].pk}, 'derives') on conflict do nothing`;
      }
    }
  });
}
