// E2 retrieval: query -> expected memory keys, measured through the real POST /ns/{ns}/search route.
// Memories are loaded straight into a throwaway database (no LLM: this measures retrieval only), together with
// generated hard negatives: the same kinds of facts about other people, from a fixed seed.
import { mean, percentile, rng, ROOT, type Metrics } from "../lib";

type Dataset = { version: number; memories: { key: string; content: string }[]; queries: { q: string; expect: string[]; category: string }[] };

export const DISTRACTOR_SEED = 20261022;

/** Facts about other people, phrased like the dataset's, so "who said what about whom" has to be resolved. */
export function distractors(n: number, seed = DISTRACTOR_SEED): string[] {
  const next = sentences(seed);
  const out = new Set<string>();
  while (out.size < n) out.add(next());
  return [...out];
}

/** Endless generator of such sentences (repeats allowed); used directly for large latency corpora. */
export function sentences(seed: number): () => string {
  const r = rng(seed);
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const names = ["Karan", "Sofia", "Arjun", "Leila", "Marco", "Yuki", "Fatima", "Rohan", "Elena", "Kwame", "Nisha", "Omar", "Hana", "Vikram",
    "Chloe", "Diego", "Sara", "Tariq", "Ines", "Jun", "Neha", "Lucas", "Zara", "Imran", "Grace", "Farhan", "Lina", "Aditya", "Maya", "Kenji"];
  const companies = ["Fabrikam", "Initech", "Globex", "Umbrella Analytics", "Hooli", "Stark Logistics", "Wayne Fintech", "Tyrell Health", "Acme Robotics", "Cyberdyne"];
  const roles = ["product manager", "data engineer", "designer", "backend engineer", "research scientist", "engineering manager", "QA lead", "SRE"];
  const cities = ["Bengaluru", "Hyderabad", "Chennai", "Mumbai", "Delhi", "Kolkata", "Jaipur", "Goa", "Singapore", "Berlin", "Lisbon", "Toronto"];
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const t = [
    () => `${pick(names)} works at ${pick(companies)} as a ${pick(roles)}`,
    () => `${pick(names)} leads the ${pick(["payments", "growth", "infra", "mobile", "search quality"])} team at ${pick(companies)}`,
    () => `${pick(names)} joined ${pick(companies)} in ${pick(months)} ${2019 + Math.floor(r() * 7)}`,
    () => `${pick(names)} lives in ${pick(cities)}`,
    () => `${pick(names)} grew up in ${pick(cities)}`,
    () => `${pick(names)}'s manager is ${pick(names)}`,
    () => `${pick(names)} drinks ${pick(["green tea", "filter coffee", "espresso", "oolong tea"])} every morning`,
    () => `${pick(names)} is allergic to ${pick(["shellfish", "dust", "pollen", "sulfa drugs", "cats"])}`,
    () => `${pick(names)}'s birthday is on ${1 + Math.floor(r() * 28)} ${pick(months)}`,
    () => `${pick(names)} has a ${pick(["labrador", "pug", "persian cat", "indie dog", "golden retriever"])} named ${pick(["Mochi", "Bruno", "Coco", "Simba", "Pepper"])}`,
    () => `${pick(names)} drives a ${pick(["white", "red", "blue", "black"])} ${pick(["Hyundai Creta", "Maruti Swift", "Honda City", "MG ZS EV"])}`,
    () => `${pick(names)} is flying to ${pick(cities)} on ${pick(["IndiGo", "Vistara", "Emirates"])} flight ${pick(["6E", "UK", "EK"])}-${100 + Math.floor(r() * 900)}`,
    () => `${pick(names)} prefers meetings ${pick(["after lunch", "in the late afternoon", "on Tuesdays"])}`,
    () => `${pick(names)} codes in ${pick(["VS Code", "IntelliJ", "Emacs", "Zed"])}`,
    () => `${pick(names)} runs ${3 + Math.floor(r() * 8)} km every ${pick(["Monday", "Wednesday", "Sunday"])}`,
    () => `${pick(names)} is reading ${pick(["Dune", "Sapiens", "Atomic Habits", "The Three-Body Problem", "Klara and the Sun"])}`,
    () => `${pick(names)}'s blood group is ${pick(["A positive", "O negative", "AB positive", "O positive"])}`,
    () => `${pick(names)} pays ${20 + Math.floor(r() * 50)},000 rupees a month in rent`,
    () => `${pick(names)} is preparing for the ${pick(["GRE", "CFA level 1", "AWS architect", "IELTS"])} exam`,
    () => `Ticket ${pick(["OPS", "WEB", "DATA", "AUTH"])}-${1000 + Math.floor(r() * 9000)} tracks a ${pick(["login", "billing", "export", "sync"])} bug`,
    () => `${pick(names)} speaks ${pick(["Tamil", "Bengali", "Spanish", "Arabic", "Portuguese"])} and English`,
    () => `${pick(names)} is training for the ${pick(cities)} marathon`,
    () => `${pick(names)} plays ${pick(["badminton", "tennis", "football", "chess"])} on weekends`,
    () => `${pick(names)}'s favourite dish is ${pick(["biryani", "ramen", "paella", "dosa", "pad thai"])}`,
  ];
  return () => pick(t)();
}

export async function runRetrieval(opts: { distractorCount?: number } = {}) {
  const data: Dataset = await Bun.file(`${ROOT}/eval/data/retrieval.v1.json`).json();
  const distractorCount = opts.distractorCount ?? 1500;
  const { sql, toVector } = await import("../../server/src/db"); // eval:e2 created and migrated the database
  const { embed } = await import("../../server/src/embed");
  const { createApp } = await import("../../server/src/app");

  const NS = "eval_retrieval";
  await sql`insert into namespaces (id) values (${NS})`;
  const corpus = [...data.memories.map((m) => ({ key: m.key, content: m.content })), ...distractors(distractorCount).map((content, i) => ({ key: `d${i}`, content }))];
  const keyOf = new Map<string, string>();
  for (let i = 0; i < corpus.length; i += 64) {
    const batch = corpus.slice(i, i + 64);
    const vecs = await embed(batch.map((c) => c.content));
    await sql.begin(async (tx) => {
      for (const [j, c] of batch.entries()) {
        const [row] = await tx`insert into memories (ns, content, kind, embedding) values (${NS}, ${c.content}, 'fact', ${toVector(vecs[j])}::vector) returning id`;
        await tx`update memories set root_id = id where id = ${row.id}`;
        keyOf.set(row.id, c.key);
      }
    });
  }

  const app = createApp("eval");
  const search = async (query: string, threshold?: number) => {
    const t0 = performance.now();
    const res = await app.request(`/ns/${NS}/search`, {
      method: "POST",
      headers: { authorization: "Bearer eval", "content-type": "application/json" },
      body: JSON.stringify({ query, searchMode: "memories", limit: 10, ...(threshold !== undefined && { threshold }) }),
    });
    const body = (await res.json()) as { results: { id: string }[] };
    return { keys: body.results.map((r) => keyOf.get(r.id) ?? "?"), ms: performance.now() - t0 };
  };
  await search("warm up the embedder"); // first query loads the model

  type PerQuery = { q: string; category: string; expect: string[]; got: string[]; ms: number; mrr: number; empty: number;
    "recall@1": number; "recall@5": number; "recall@10": number; "recall@10_t0": number };
  const per: PerQuery[] = [];
  for (const q of data.queries) {
    const def = await search(q.q);
    const t0 = await search(q.q, 0);
    const recallAt = (keys: string[], k: number) => q.expect.filter((e) => keys.slice(0, k).includes(e)).length / q.expect.length;
    const firstRank = def.keys.findIndex((k) => q.expect.includes(k));
    per.push({
      q: q.q, category: q.category, expect: q.expect, got: def.keys.slice(0, 5), ms: def.ms,
      "recall@1": recallAt(def.keys, 1), "recall@5": recallAt(def.keys, 5), "recall@10": recallAt(def.keys, 10),
      mrr: firstRank >= 0 ? 1 / (firstRank + 1) : 0,
      "recall@10_t0": recallAt(t0.keys, 10),
      empty: def.keys.length === 0 ? 1 : 0,
    });
  }

  const agg = (rows: typeof per): Metrics => ({
    n: rows.length,
    "recall@1": mean(rows.map((r) => r["recall@1"])),
    "recall@5": mean(rows.map((r) => r["recall@5"])),
    "recall@10": mean(rows.map((r) => r["recall@10"])),
    mrr: mean(rows.map((r) => r.mrr)),
    "recall@10_threshold0": mean(rows.map((r) => r["recall@10_t0"])),
  });
  const groups: Record<string, Metrics> = {};
  for (const c of [...new Set(per.map((r) => r.category))].sort()) groups[c] = agg(per.filter((r) => r.category === c));
  const ms = per.map((r) => r.ms);
  return {
    config: { dataset: `retrieval.v${data.version}`, memories: data.memories.length, distractors: distractorCount, distractorSeed: DISTRACTOR_SEED,
      queries: data.queries.length, searchMode: "memories", limit: 10, threshold: "API default (0.3)" },
    metrics: { ...agg(per), queries_with_no_results: per.reduce((s, r) => s + r.empty, 0), search_p50_ms: percentile(ms, 50), search_p95_ms: percentile(ms, 95) },
    groups,
    details: per,
    misses: per.filter((r) => r["recall@10"] < 1).map((r) => `${r.q} -> expected ${r.expect.join(",")}, top5 ${r.got.join(",")}`),
  };
}
