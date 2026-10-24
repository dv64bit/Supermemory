// D4 Neighbours, D5 Relate (one batched LLM call per unit) and D6 Policy (the invariants, in code).
// The LLM only proposes an op per candidate; `policy` decides what actually happens.
import { sql, toVector } from "./db";
import type { Candidate, Speaker } from "./extractor";
import type { Resolved } from "./entities";
import { updateMinConfidence } from "./lifecycle";
import { call } from "./llm";
import { LIVE } from "./memories";

export type Neighbor = {
  pk: number; id: string; content: string; kind: string; speaker: Speaker | null; subject: string | null; slot: string | null;
  valid_from: Date | null; pinned: boolean; version: number; root_id: string | null; sim: number;
};
export type ProposedOp = "ADD" | "DUPLICATE" | "UPDATE" | "EXTEND" | "CONFLICT" | "SKIP";
export type FinalOp = ProposedOp | "HISTORICAL";
/** `target` is a neighbour index; `targetCand` points at an earlier candidate of the same unit (its new memory). */
export type Plan = { op: FinalOp; target: number | null; targetCand?: number; confidence: number; reason?: string; path: "exact" | "llm" | "none" | "unit" };

const VEC_K = 5;
const VEC_MIN_SIM = 0.55;
const KW_K = 5;
const PER_CANDIDATE = 8;
const MAX_NEIGHBORS = 30;

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
// Words every fact shares carry no signal for the keyword channel.
const KW_STOP = new Set(["the", "user", "users", "and", "for", "with", "has", "have", "was", "are", "is"]);
const orQuery = (s: string) => [...new Set(norm(s).split(" ").filter((w) => w.length > 2 && !KW_STOP.has(w)))].join(" | ");

/**
 * D4: per candidate, the union of vector top-k, keyword top-k and memories about the same subject entity
 * (same slot when the candidate has one), all live and not rejected. Numbered globally for the relate call.
 */
export async function neighbours(ns: string, cands: Candidate[], vecs: number[][], resolved: Resolved[]) {
  const neighbors: Neighbor[] = [];
  const index = new Map<number, number>();
  const candNeighbors: number[][] = [];
  for (const [i, c] of cands.entries()) {
    const v = toVector(vecs[i]);
    const kw = orQuery(c.content);
    const subject = resolved[i]?.subject ?? null;
    const rows = (await sql.unsafe(
      `with live as (select pk from memories m where m.ns = $1 and ${LIVE()}),
       vec as (select m.pk from memories m join live using (pk) where 1 - (m.embedding <=> $2::vector) >= $3
               order by m.embedding <=> $2::vector limit ${VEC_K}),
       kw as (select m.pk from memories m join live using (pk) where $4 <> '' and m.fts @@ to_tsquery('english', $4)
              order by ts_rank_cd(m.fts, to_tsquery('english', $4)) desc limit ${KW_K}),
       ent as (select m.pk from memories m join live using (pk) join memory_entities me on me.memory_pk = m.pk
               where me.entity_id = $5 and me.role = 'subject' and ($6::text is null or m.slot = $6)
               order by m.embedding <=> $2::vector limit case when $6::text is null then 3 else 5 end)
       select m.pk, m.id, m.content, m.kind, m.speaker, m.subject, m.slot, m.valid_from, m.pinned, m.version, m.root_id,
              1 - (m.embedding <=> $2::vector) as sim
       from memories m where m.pk in (select pk from vec union select pk from kw union select pk from ent)
       order by sim desc limit ${PER_CANDIDATE}`,
      [ns, v, VEC_MIN_SIM, kw, subject, subject ? c.slot : null],
    )) as Neighbor[];
    const mine: number[] = [];
    for (const r of rows) {
      if (!index.has(r.pk)) {
        if (neighbors.length >= MAX_NEIGHBORS) continue;
        index.set(r.pk, neighbors.push(r) - 1);
      }
      mine.push(index.get(r.pk)!);
    }
    candNeighbors.push(mine);
  }
  return { neighbors, candNeighbors };
}

const relateSchema = {
  type: "object", additionalProperties: false, required: ["decisions"],
  properties: {
    decisions: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["i", "op", "target", "confidence"],
        properties: {
          i: { type: "integer" },
          op: { type: "string", enum: ["ADD", "DUPLICATE", "UPDATE", "EXTEND", "CONFLICT", "SKIP"] },
          target: { type: ["integer", "null"] },
          confidence: { type: "number" },
        },
      },
    },
  },
};

type Proposal = { op: ProposedOp; target: number | null; confidence: number; path: Plan["path"] };

/** D5: exact (normalised) repeats are duplicates without a model; everything with neighbours goes to one relate call. */
async function propose(cands: Candidate[], neighbors: Neighbor[], candNeighbors: number[][]): Promise<Proposal[]> {
  const out: Proposal[] = cands.map((_, i) => ({ op: "ADD", target: null, confidence: 1, path: candNeighbors[i].length ? "llm" : "none" }));
  const ask: number[] = [];
  for (const [i, c] of cands.entries()) {
    const same = candNeighbors[i].find((j) => norm(neighbors[j].content) === norm(c.content));
    if (same !== undefined) out[i] = { op: "DUPLICATE", target: same, confidence: 1, path: "exact" };
    else if (candNeighbors[i].length) ask.push(i);
  }
  if (!ask.length) return out;
  const { decisions } = await call<{ decisions: { i: number; op: ProposedOp; target: number | null; confidence: number }[] }>(
    "relate", "relate.v2",
    {
      candidates: ask.map((i) => ({
        i, content: cands[i].content, speaker: cands[i].speaker, subject: cands[i].subject,
        neighbors: candNeighbors[i].map((j) => ({ j, content: neighbors[j].content, speaker: neighbors[j].speaker })),
      })),
    },
    relateSchema,
  );
  for (const d of decisions) {
    if (!ask.includes(d.i)) continue;
    // Only targets that were offered for that candidate count.
    const target = d.target !== null && candNeighbors[d.i].includes(d.target) ? d.target : null;
    out[d.i] = { op: d.op, target, confidence: Math.min(1, Math.max(0, Number(d.confidence) || 0)), path: "llm" };
  }
  return out;
}

const OTHERS: (Speaker | null)[] = ["third_party", "assistant"];
const time = (d: Date | string | null | undefined) => (d ? new Date(d).getTime() : null);

/**
 * D6: the invariants, whatever the model said.
 *  - a link needs a target that was offered;
 *  - an UPDATE/CONFLICT that is older in event time than its target becomes HISTORICAL (never supersedes);
 *  - an UPDATE supersedes only if confident, the target isn't pinned, and a third party/assistant isn't overriding the user;
 *    otherwise it is a CONFLICT for review, and both memories stay;
 *  - a memory gets at most one successor: a second update of the same target extends the first one;
 *  - a candidate repeated within the unit is stored once.
 */
export function policy(cands: Candidate[], proposals: Proposal[], neighbors: Neighbor[], documentDate: Date): Plan[] {
  const minConf = updateMinConfidence();
  const successor = new Map<number, number>(); // neighbour index -> candidate index that superseded it
  const seen = new Map<string, number>();
  return cands.map((c, i) => {
    const p = proposals[i];
    const plan = (op: FinalOp, reason?: string, extra: Partial<Plan> = {}): Plan => ({ op, target: p.target, confidence: p.confidence, path: p.path, reason, ...extra });
    const first = seen.get(norm(c.content));
    if (first !== undefined) return plan("SKIP", "repeated in the unit", { target: null, path: "unit" });
    seen.set(norm(c.content), i);
    if (p.op === "SKIP") return plan("SKIP", "relate: not worth storing");
    if (p.op === "ADD") return plan("ADD");
    const t = p.target !== null ? neighbors[p.target] : undefined;
    if (!t) return plan("ADD", `relate said ${p.op} without a valid target`, { target: null });
    if (p.op === "DUPLICATE" || p.op === "EXTEND") return plan(p.op);

    const hearsay = OTHERS.includes(c.speaker) && t.speaker === "user";
    const candTime = time(c.validFrom) ?? documentDate.getTime();
    const targetTime = time(t.valid_from);
    if (!hearsay && targetTime !== null && candTime < targetTime) return plan("HISTORICAL", "older than the memory it contradicts");
    if (p.op === "CONFLICT") return plan("CONFLICT", "relate: conflict");
    if (t.pinned) return plan("CONFLICT", "target is pinned");
    if (hearsay) return plan("CONFLICT", "a third party or the assistant cannot supersede the user");
    if (p.confidence < minConf) return plan("CONFLICT", `low-confidence update (${p.confidence.toFixed(2)} < ${minConf})`);
    const prev = successor.get(p.target!);
    if (prev !== undefined) return plan("EXTEND", "target already superseded in this unit", { target: null, targetCand: prev });
    successor.set(p.target!, i);
    return plan("UPDATE");
  });
}

/** D4 + D5 + D6 for one unit's grounded candidates. */
export async function relate(ns: string, cands: Candidate[], vecs: number[][], resolved: Resolved[], documentDate: Date) {
  const { neighbors, candNeighbors } = await neighbours(ns, cands, vecs, resolved);
  const proposals = await propose(cands, neighbors, candNeighbors);
  return { neighbors, candNeighbors, plans: policy(cands, proposals, neighbors, documentDate) };
}
