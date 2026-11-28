// LLM router: role routing, schema validation with one repair retry, the response cache and the llm_calls log.
import { beforeAll, beforeEach, expect, test } from "bun:test";
import { freshDb, startFakeLlm } from "./fake-llm";

let rawReplies: ((attempt: number) => string | undefined) | undefined;
const llm = startFakeLlm({
  forget: ({ candidates }) => candidates.map((c) => c.j),
  raw: (_role, attempt) => rawReplies?.(attempt),
});
await freshDb("supermem_test_llm");
const { migrate, sql } = await import("../src/db");
const { call, pipelineVersion, prompt, LlmError } = await import("../src/llm");

const schema = {
  type: "object", additionalProperties: false, required: ["forget"],
  properties: { forget: { type: "array", items: { type: "integer" } } },
};
const input = (n: number) => ({ request: "forget x", candidates: Array.from({ length: n }, (_, j) => ({ j, content: `c${j}` })) });

beforeAll(migrate);
beforeEach(() => {
  rawReplies = undefined;
  llm.requests.length = 0;
  delete process.env.LLM_CACHE;
});

test("sends the prompt file, the JSON input and the role; logs the call", async () => {
  process.env.LLM_MODEL_FORGET = "tiny-forget-model";
  const out = await call<{ forget: number[] }>("forget", "forget.v1", input(2), schema);
  delete process.env.LLM_MODEL_FORGET;
  expect(out).toEqual({ forget: [0, 1] });

  const [req] = llm.requests;
  expect(req.role).toBe("forget");
  expect(req.body.model).toBe("tiny-forget-model");
  expect(req.body.temperature).toBe(0);
  expect(req.body.messages[0].content).toBe(prompt("forget.v1").text);
  expect(JSON.parse(req.body.messages[1].content)).toEqual(input(2));

  const [row] = await sql`select * from llm_calls order by id desc limit 1`;
  expect(row).toMatchObject({ role: "forget", model: "tiny-forget-model", cached: false, ok: true, attempts: 1 });
  expect(row.prompt_version).toMatch(/^forget\.v1@[0-9a-f]{8}$/);
  expect(row.tokens_in).toBeGreaterThan(0);
});

test("identical calls hit the cache; LLM_CACHE=off bypasses it", async () => {
  await call("forget", "forget.v1", input(3), schema);
  await call("forget", "forget.v1", input(3), schema);
  expect(llm.requests).toHaveLength(1);
  const [row] = await sql`select cached, attempts from llm_calls order by id desc limit 1`;
  expect(row).toEqual({ cached: true, attempts: 0 });

  process.env.LLM_CACHE = "off";
  await call("forget", "forget.v1", input(3), schema);
  expect(llm.requests).toHaveLength(2);
});

test("invalid output gets one repair turn that includes the bad reply", async () => {
  rawReplies = (attempt) => (attempt === 1 ? `{"forget": ["zero"]}` : `{"forget": [0]}`);
  const out = await call<{ forget: number[] }>("forget", "forget.v1", input(4), schema);
  expect(out).toEqual({ forget: [0] });
  expect(llm.requests).toHaveLength(2);
  const retry = llm.requests[1].body.messages;
  expect(retry.at(-2)).toEqual({ role: "assistant", content: `{"forget": ["zero"]}` });
  expect(retry.at(-1)?.role).toBe("user");
  const [row] = await sql`select ok, attempts from llm_calls order by id desc limit 1`;
  expect(row).toEqual({ ok: true, attempts: 2 });
});

test("still invalid after the repair: the call fails, raw output is logged, nothing is cached", async () => {
  rawReplies = () => "not json at all";
  expect(await call("forget", "forget.v1", input(5), schema).then(() => null, (e) => e)).toBeInstanceOf(LlmError);
  const [row] = await sql`select ok, attempts, raw_output, error from llm_calls order by id desc limit 1`;
  expect(row).toMatchObject({ ok: false, attempts: 2, raw_output: "not json at all" });
  expect(row.error).toBeTruthy();

  rawReplies = undefined; // the model recovers: the earlier failure must not have been cached
  expect(await call("forget", "forget.v1", input(5), schema)).toEqual({ forget: [0, 1, 2, 3, 4] });
});

test("pipeline version changes with the model", () => {
  const before = pipelineVersion();
  process.env.LLM_MODEL_EXTRACT = "another-model";
  expect(pipelineVersion()).not.toBe(before);
  delete process.env.LLM_MODEL_EXTRACT;
  expect(pipelineVersion()).toBe(before);
});
