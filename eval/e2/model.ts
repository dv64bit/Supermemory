// Which model the LLM evals run against.
//   EVAL_FAKE_LLM=1 : the test suite's fake LLM with trivial answers. Smoke-tests the plumbing; numbers are meaningless
//                     and nothing is written to eval/runs.
//   otherwise       : the real endpoint at LLM_BASE_URL (default: local Ollama). If it doesn't answer, the eval is skipped.
// Imports nothing from server/src at load time: the database URL must be set before server/src/db is first imported.
export type ModelMode = { mode: "fake" | "real"; describe: () => Promise<Record<string, string>> } | null;

export async function pickModel(): Promise<ModelMode> {
  if (process.env.EVAL_FAKE_LLM) {
    const { startFakeLlm } = await import("../../server/test/fake-llm");
    startFakeLlm({
      // Echo the first user sentence as a "fact"; relate says new; the judge matches nothing and supports everything.
      extract: ({ content }) => {
        const first = content.split("\n").find((l) => l.startsWith("User:"))?.slice(5).trim() ?? content.slice(0, 80);
        return first ? [{ content: first, kind: "fact", expiresAt: null }] : [];
      },
      judge: (_input, task) => (task === "judge-match" ? { matches: [], forbidden_hits: [] } : { verdict: "supported", quote: "" }),
    });
    return { mode: "fake", describe: async () => ({ llm: "fake (smoke test)" }) };
  }
  const base = process.env.LLM_BASE_URL ?? "http://localhost:11434/v1";
  const ok = await fetch(`${base}/models`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false);
  if (!ok) return null;
  return {
    mode: "real",
    describe: async () => {
      const { modelFor } = await import("../../server/src/llm");
      return { llm_base_url: base, extract_model: modelFor("extract"), relate_model: modelFor("relate"), judge_model: modelFor("judge") };
    },
  };
}
