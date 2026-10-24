// E2 relation: for each case of data/relation.v1.json, store the existing memories (with their event dates) in their own
// namespace, then run the engine's relate steps (relator.ts: D4 neighbours, D5 relate call, D6 policy) on the candidate.
// Scores the final op against the v2 label; the headline is the false-UPDATE rate.
// The data has no speakers, so the candidate is a neutral "document" statement; hearsay must be read from its wording.
import { mean, ROOT, type Metrics } from "../lib";

type Op = "ADD" | "DUPLICATE" | "UPDATE" | "EXTEND" | "CONFLICT" | "HISTORICAL" | "SKIP";
type Case = {
  id: string; category: string; existing: { key: string; content: string; date?: string }[];
  candidate: string; candidateDate?: string; expected: { op: Op; target: string | null };
};

export async function runRelation() {
  const data: { version: number; cases: Case[] } = await Bun.file(`${ROOT}/eval/data/relation.v1.json`).json();
  const { sql, toVector } = await import("../../server/src/db"); // eval:e2 created and migrated the database
  const { embed } = await import("../../server/src/embed");
  const { relate } = await import("../../server/src/relator");

  type Row = { id: string; category: string; gold: Op; goldTarget: string | null; pred: Op; predTarget: string | null;
    path: string; reason?: string; error?: string; correct: number; falseUpdate: number };
  const per: Row[] = [];
  for (const c of data.cases) {
    const ns = `eval_rel_${c.id}`;
    await sql`insert into namespaces (id) values (${ns}) on conflict do nothing`;
    const vecs = await embed([...c.existing.map((e) => e.content), c.candidate]);
    const keyOfPk = new Map<number, string>();
    for (const [i, e] of c.existing.entries()) {
      const [m] = await sql`insert into memories (ns, content, kind, embedding, valid_from)
        values (${ns}, ${e.content}, 'fact', ${toVector(vecs[i])}::vector, ${e.date ? new Date(e.date) : null}) returning pk`;
      keyOfPk.set(m.pk, e.key);
    }
    let op: Op = "ADD", target: string | null = null, path = "none", reason: string | undefined, error: string | undefined;
    try {
      const cand = {
        content: c.candidate, kind: "fact" as const, speaker: "document" as const, subject: null, slot: null, entities: [],
        validFrom: c.candidateDate ?? null, expiresAt: null, sensitivity: "none" as const, confidence: 1, quote: c.candidate,
      };
      const docDate = c.candidateDate ? new Date(c.candidateDate) : new Date();
      const { neighbors, plans } = await relate(ns, [cand], [vecs.at(-1)!], [{ subject: null, mentions: [] }], docDate);
      const p = plans[0];
      op = p.op;
      path = p.path;
      reason = p.reason;
      target = p.target !== null ? keyOfPk.get(neighbors[p.target].pk) ?? null : null;
    } catch (e) {
      error = String((e as Error).message);
    }
    const g = c.expected;
    per.push({
      id: c.id, category: c.category, gold: g.op, goldTarget: g.target, pred: op, predTarget: target, path, reason, error,
      correct: op === g.op && (g.op === "ADD" || target === g.target) ? 1 : 0,
      falseUpdate: op === "UPDATE" && g.op !== "UPDATE" ? 1 : 0,
    });
  }

  const share = (rows: Row[], f: (r: Row) => boolean) => (rows.length ? rows.filter(f).length / rows.length : 0);
  const agg = (rows: Row[]): Metrics => ({
    n: rows.length,
    accuracy: mean(rows.map((r) => r.correct)),
    false_update_rate: share(rows.filter((r) => r.gold !== "UPDATE"), (r) => r.pred === "UPDATE"),
  });
  const updates = per.filter((r) => r.gold === "UPDATE");
  const linked = per.filter((r) => r.goldTarget !== null);
  const byGold: Record<string, Metrics> = {};
  for (const op of ["ADD", "DUPLICATE", "UPDATE", "EXTEND", "CONFLICT", "HISTORICAL"] as Op[]) {
    const rows = per.filter((r) => r.gold === op);
    if (rows.length) byGold[`gold:${op}`] = { n: rows.length, recall: share(rows, (r) => r.correct === 1), predicted_update: share(rows, (r) => r.pred === "UPDATE") };
  }
  const byCategory: Record<string, Metrics> = {};
  for (const cat of [...new Set(per.map((r) => r.category))].sort()) byCategory[cat] = agg(per.filter((r) => r.category === cat));
  return {
    config: {
      dataset: `relation.v${data.version}`, cases: data.cases.length, prompt: "relate.v2", policy: "relator.ts D6",
    },
    metrics: {
      ...agg(per),
      missed_update_rate: share(updates, (r) => r.pred !== "UPDATE"),
      update_swallowed_as_duplicate: share(updates, (r) => r.pred === "DUPLICATE"),
      missed_link_rate: share(linked, (r) => r.path === "none"),
      decided_without_llm: per.filter((r) => r.path === "exact").length,
      relate_errors: per.filter((r) => r.error).length,
    },
    groups: { ...byGold, ...byCategory },
    details: per,
  };
}
