// E1 mechanics gate: the server test suite with the fake LLM.
// Run 1 (normal): must have 0 failures. Run 2 (SHOW_TARGETS=1): targets run as plain tests, so failures = targets
// still open. Records pass/fail/todo and open/fixed targets per test file.
import { readdirSync } from "node:fs";
import { $ } from "bun";
import { ROOT, writeRun, type Metrics } from "./lib";

const testDir = `${ROOT}/server/test`;
const files = readdirSync(testDir).filter((f) => f.endsWith(".test.ts")).sort();

async function runFile(file: string, showTargets: boolean) {
  const env = { ...process.env, ...(showTargets && { SHOW_TARGETS: "1" }) };
  const out = await $`bun test ${`test/${file}`}`.cwd(`${ROOT}/server`).env(env).quiet().nothrow();
  const text = out.stdout.toString() + out.stderr.toString();
  const n = (word: string) => Number(text.match(new RegExp(`^\\s*(\\d+) ${word}$`, "m"))?.[1] ?? 0);
  return { pass: n("pass"), fail: n("fail"), todo: n("todo"), exit: out.exitCode, text };
}

const started = Date.now();
const startedAt = new Date().toISOString();
const groups: Record<string, Metrics> = {};
const failures: string[] = [];
for (const f of files) {
  const normal = await runFile(f, false);
  const targets = (await Bun.file(`${testDir}/${f}`).text()).match(/^target\(/gm)?.length ?? 0;
  const shown = targets ? await runFile(f, true) : { fail: 0 };
  groups[f.replace(".test.ts", "")] = {
    pass: normal.pass - targets, // expected-failing targets report as "pass" in the normal run
    fail: normal.fail,
    todo: normal.todo,
    targets_open: shown.fail,
    targets_fixed: targets - shown.fail,
  };
  if (normal.exit !== 0) failures.push(`${f}:\n${normal.text.split("\n").filter((l) => /^\(fail\)|error:/.test(l)).slice(0, 10).join("\n")}`);
  console.log(f, groups[f.replace(".test.ts", "")]);
}

const sum = (k: string) => Object.values(groups).reduce((s, g) => s + g[k], 0);
await writeRun({
  layer: "e1",
  name: "suite",
  startedAt,
  durationMs: Date.now() - started,
  config: { files: files.length, llm: "fake" },
  metrics: { pass: sum("pass"), fail: sum("fail"), todo: sum("todo"), targets_open: sum("targets_open"), targets_fixed: sum("targets_fixed") },
  groups,
  notes: failures.length ? ["GATE FAILED: unexpected failures", ...failures] : ["gate passed: 0 unexpected failures"],
});
if (failures.length) process.exit(1);
