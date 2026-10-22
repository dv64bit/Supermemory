// Targets: tests for behaviour we have committed to but not built yet (bugs to fix, spec mismatches, E1 v2 scenarios).
// `target` is bun's `test.failing`: it passes while the behaviour is still wrong and turns red once it is fixed;
// at that point replace `target(` with `test(`. SHOW_TARGETS=1 runs them as normal tests to show why each one fails
// (that run's fail count = targets still open; `bun run eval:e1` records it).
import { test } from "bun:test";

export const target = process.env.SHOW_TARGETS ? test : test.failing;
