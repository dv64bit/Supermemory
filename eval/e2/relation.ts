// E2 relation: for each case of data/relation.v1.json, store the existing memories in their own namespace, then run
// the engine's relation step (dream.ts relateCandidates: neighbour search, near-duplicate shortcut, relate LLM call)
// on the candidate. Scores the decision against the v2 label; the headline is the false-UPDATE rate.
import { mean, ROOT, type Metrics } from "../lib";

type Op = "ADD" | "DUPLICATE" | "UPDATE" | "EXTEND" | "CONFLICT" | "HISTORICAL";
type Case = {
  id: string; category: string; existing: { key: string; content: string; date?: string }[];
  candidate: string; candidateDate?: string; expected: { op: Op; target: string | null };
};
const ENGINE_TO_OP: Record<string, Op> = { new: "ADD", duplicate: "DUPLICATE", updates: "UPDATE", extends: "EXTEND" };
const DUPLICATE_SIM = 0.92; // mirrors dream.ts, only to label which path decided

export async function runRelation() {
  const data: { version: number; cases: Case[] } = await Bun.file(`${ROOT}/eval/data/relation.v1.json`).json();
  const { sql, toVector } = await import("../../server/src/db"); // eval:e2 created and migrated the database
  const { embed } = await import("../../server/src/embed");
  const { relateCandidates } = await import("../../server/src/dream");

  type Row = { id: string; category: string; gold: Op; goldTarget: string | null; pred: Op; predTarget: string | null;
    path: string; error?: string; correct: number; falseUpdate: number };
  const per: Row[] = [];
  for (const c of data.cases) {
    const ns = `eval_rel_${c.id}`;
    await sql`insert into namespaces (id) values (${ns}) on conflict do nothing`;
    const vecs = await embed([...c.existing.map((e) => e.content), c.candidate]);
    const keyOfPk = new Map<number, string>();
    for (const [i, e] of c.existing.entries()) {
      const [m] = await sql`insert into memories (ns, content, kind, embedding) values (${ns}, ${e.content}, 'fact', ${toVector(vecs[i])}::vector) returning pk`;
      keyOfPk.set(m.pk, e.key);
    }
    let op: Op = "ADD", target: string | null = null, path = "no-neighbour", error: string | undefined;
    try {
      const { neighbors, candNeighbors, decisions } = await relateCandidates(ns, [{ content: c.candidate }], [vecs.at(-1)!]);
      const d = decisions.get(0);
      const top = candNeighbors[0].length ? neighbors[candNeighbors[0][0]] : undefined;
      path = !top ? "no-neighbour" : top.sim >= DUPLICATE_SIM ? "shortcut" : "llm";
      if (d) {
        op = ENGINE_TO_OP[d.relation] ?? "ADD";
        target = d.target !== null ? keyOfPk.get(neighbors[d.target].pk) ?? null : null;
      }
    } catch (e) {
      error = String((e as Error).message);
    }
    const g = c.expected;
    per.push({
      id: c.id, category: c.category, gold: g.op, goldTarget: g.target, pred: op, predTarget: target, path, error,
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
      dataset: `relation.v${data.version}`, cases: data.cases.length, prompt: "relate.v1",
      note: "engine has no CONFLICT/HISTORICAL ops and ignores dates; those cases can only be 'safe' (not UPDATE) or a false UPDATE",
    },
    metrics: {
      ...agg(per),
      accuracy_engine_classes: mean(per.filter((r) => !["CONFLICT", "HISTORICAL"].includes(r.gold)).map((r) => r.correct)),
      missed_update_rate: share(updates, (r) => r.pred !== "UPDATE"),
      update_swallowed_as_duplicate: share(updates, (r) => r.pred === "DUPLICATE"),
      missed_link_rate: share(linked, (r) => r.path === "no-neighbour"),
      decided_by_shortcut: per.filter((r) => r.path === "shortcut").length,
      relate_errors: per.filter((r) => r.error).length,
    },
    groups: { ...byGold, ...byCategory },
    details: per,
  };
}
