// bun run eval:e2 [--only retrieval|extraction|relation|grounding]
// Component evals, all in one throwaway database (server/src/db binds its URL on first import, so it is created once).
//   retrieval                       : local embeddings only, always runs.
//   extraction, relation, grounding : need a model. Real numbers come from LLM_BASE_URL (local Ollama); with
//                                     EVAL_FAKE_LLM=1 they run against the fake LLM as a smoke test and record nothing.
import { freshEvalDb, summary, writeRun, type Run } from "../lib";
import { pickModel } from "./model";

const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : undefined;
const want = (name: string) => !only || only === name;
const needsModel = ["extraction", "relation", "grounding"].filter(want);
const model = needsModel.length ? await pickModel() : null;

await freshEvalDb("supermem_eval_e2");
const { migrate, sql } = await import("../../server/src/db");
await migrate();

type Result = { config: Record<string, unknown>; metrics: Record<string, number>; groups?: Run["groups"]; details?: unknown; notes?: string[] };
async function record(name: string, smoke: boolean, run: () => Promise<Result>) {
  const started = Date.now();
  const startedAt = new Date().toISOString();
  const r = await run();
  const rec = { layer: "e2" as const, name, startedAt, durationMs: Date.now() - started, ...r };
  if (smoke) {
    console.log(summary({ ...rec, id: `smoke-${name}`, git: { sha: "-", dirty: true }, notes: ["SMOKE TEST with the fake LLM: plumbing only, numbers are meaningless; not recorded"] }));
  } else await writeRun(rec);
}

if (want("retrieval")) {
  const { runRetrieval } = await import("./retrieval");
  await record("retrieval", false, async () => {
    const r = await runRetrieval();
    return { ...r, notes: r.misses.length ? [`${r.misses.length} queries missed at least one expected memory in the top 10:`, ...r.misses] : ["no misses in the top 10"] };
  });
}

if (needsModel.length && !model) {
  for (const name of needsModel) console.log(`e2/${name}: skipped (no model at ${process.env.LLM_BASE_URL ?? "http://localhost:11434/v1"}; start Ollama, or EVAL_FAKE_LLM=1 for a smoke test)`);
} else if (model) {
  const smoke = model.mode === "fake";
  const withModel = (run: () => Promise<Result>) => async () => {
    const r = await run();
    return { ...r, config: { ...r.config, ...(await model.describe()) } };
  };
  if (want("extraction")) await record("extraction", smoke, withModel(async () => (await import("./extraction")).runExtraction()));
  if (want("relation")) await record("relation", smoke, withModel(async () => (await import("./relation")).runRelation()));
  if (want("grounding")) await record("grounding", smoke, withModel(async () => (await import("./grounding")).runGrounding()));
}
await sql.close();
process.exit(0); // the fake LLM server (smoke mode) would otherwise keep the process alive
