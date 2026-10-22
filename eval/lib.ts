// Shared eval plumbing: throwaway databases, run records (eval/runs/<stamp>-<layer>-<name>.json + .md), stats.
// Eval code imports server modules by relative path; bare imports resolve from server/node_modules that way.
import { $ } from "bun";

export const ROOT = import.meta.dir.replace(/\/eval$/, "");

/** Fresh database for one eval; sets DATABASE_URL, so call it before importing anything from server/src. */
export async function freshEvalDb(name: string) {
  const adminUrl = process.env.EVAL_DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? "postgres://localhost/postgres";
  const admin = new Bun.SQL(adminUrl);
  await admin.unsafe(`drop database if exists ${name} with (force)`);
  await admin.unsafe(`create database ${name}`);
  await admin.close();
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  process.env.DATABASE_URL = url.toString();
}

export type Metrics = Record<string, number>;
export type Run = {
  id: string;
  layer: "e1" | "e2" | "e3" | "latency";
  name: string; // e.g. "retrieval", "suite", "10k"
  startedAt: string;
  durationMs: number;
  git: { sha: string; dirty: boolean };
  config: Record<string, unknown>;
  metrics: Metrics; // flat, numeric: what compare diffs
  groups?: Record<string, Metrics>; // e.g. per category
  notes?: string[];
  details?: unknown; // per-item results, for digging in
};

async function git() {
  const sha = (await $`git -C ${ROOT} rev-parse --short HEAD`.quiet().nothrow().text()).trim() || "unknown";
  const dirty = (await $`git -C ${ROOT} status --porcelain`.quiet().nothrow().text()).trim().length > 0;
  return { sha, dirty };
}

/** Writes the run (JSON + markdown summary). `private: true` runs go under eval/private/runs (git-ignored). */
export async function writeRun(r: Omit<Run, "id" | "git">, opts: { private?: boolean } = {}) {
  const stamp = r.startedAt.replace(/[:.]/g, "-").replace(/-\d+Z$/, "Z");
  const id = `${stamp}-${r.layer}-${r.name}`;
  const run: Run = { id, git: await git(), ...r };
  const dir = `${ROOT}/eval/${opts.private ? "private/runs" : "runs"}`;
  await Bun.write(`${dir}/${id}.json`, JSON.stringify(run, null, 2) + "\n");
  await Bun.write(`${dir}/${id}.md`, summary(run));
  console.log(summary(run));
  console.log(`wrote ${dir}/${id}.json`);
  return run;
}

const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(3));

export function summary(r: Run) {
  const lines = [
    `# ${r.layer} / ${r.name}`,
    "",
    `- run: \`${r.id}\``,
    `- git: \`${r.git.sha}\`${r.git.dirty ? " (uncommitted changes)" : ""}`,
    `- duration: ${(r.durationMs / 1000).toFixed(1)}s`,
    ...Object.entries(r.config).map(([k, v]) => `- ${k}: \`${typeof v === "string" ? v : JSON.stringify(v)}\``),
    "",
    "| metric | value |",
    "|---|---|",
    ...Object.entries(r.metrics).map(([k, v]) => `| ${k} | ${fmt(v)} |`),
  ];
  if (r.groups && Object.keys(r.groups).length) {
    const cols = [...new Set(Object.values(r.groups).flatMap((g) => Object.keys(g)))];
    lines.push("", `| group | ${cols.join(" | ")} |`, `|---|${cols.map(() => "---").join("|")}|`);
    for (const [g, m] of Object.entries(r.groups)) lines.push(`| ${g} | ${cols.map((c) => (c in m ? fmt(m[c]) : "")).join(" | ")} |`);
  }
  if (r.notes?.length) lines.push("", "Notes:", ...r.notes.map((n) => `- ${n}`));
  return lines.join("\n") + "\n";
}

export function percentile(xs: number[], p: number) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}

export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

/** Deterministic PRNG (mulberry32) so generated corpora are identical across runs. */
export function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
