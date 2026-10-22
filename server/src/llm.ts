// LLM router: every model call goes through here. One OpenAI-compatible endpoint (Ollama by default; tests point
// LLM_BASE_URL at a fake). Per call: a role (picks the model), a versioned prompt file, a JSON schema that is both sent
// as structured output and turned into a Zod validator, one repair retry, the response cache, and an `llm_calls` row.
import { readdirSync, readFileSync } from "node:fs";
import { z } from "zod";
import { sql } from "./db";

export type Role = "extract" | "relate" | "derive" | "forget" | "chat" | "judge"; // judge: evals only
type Schema = Record<string, unknown>;

const base = () => process.env.LLM_BASE_URL ?? "http://localhost:11434/v1";
/** LLM_MODEL_<ROLE> overrides LLM_MODEL for one role (chat also honours the older LLM_CHAT_MODEL). */
export const modelFor = (role: Role) =>
  process.env[`LLM_MODEL_${role.toUpperCase()}`] ?? (role === "chat" ? process.env.LLM_CHAT_MODEL : undefined) ?? process.env.LLM_MODEL ?? "qwen3:8b";
const timeoutMs = () => Number(process.env.LLM_TIMEOUT_MS ?? 300_000);
const cacheOn = () => process.env.LLM_CACHE !== "off";
const sha256 = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");

// Prompt files live in src/prompts/<name>.v<N>.md; the version recorded is the file name plus a content hash,
// so editing a prompt without bumping N still changes the cache key and PIPELINE_VERSION.
const PROMPT_DIR = `${import.meta.dir}/prompts`;
const prompts = new Map<string, { text: string; version: string }>();
export function prompt(name: string) {
  let p = prompts.get(name);
  if (!p) {
    const text = readFileSync(`${PROMPT_DIR}/${name}.md`, "utf8").replace(/\n$/, "");
    p = { text, version: `${name}@${sha256(text).slice(0, 8)}` };
    prompts.set(name, p);
  }
  return p;
}

/** Identifies the prompts + models that produce memories. Changes whenever either does. */
export function pipelineVersion() {
  const names = readdirSync(PROMPT_DIR).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).sort();
  const roles: Role[] = ["extract", "relate", "derive", "forget"];
  return sha256(JSON.stringify([names.map((n) => prompt(n).version), roles.map(modelFor)])).slice(0, 12);
}

const validators = new WeakMap<Schema, z.ZodType>();
const validator = (schema: Schema) => {
  let v = validators.get(schema);
  if (!v) validators.set(schema, (v = z.fromJSONSchema(schema as any)));
  return v;
};

type Msg = { role: "system" | "user" | "assistant"; content: string };
type Usage = { in: number; out: number };

async function post(role: Role, body: Record<string, unknown>, signal?: AbortSignal) {
  return fetch(`${base()}/chat/completions`, {
    method: "POST",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs())]) : AbortSignal.timeout(timeoutMs()),
    headers: {
      "content-type": "application/json",
      "x-llm-role": role, // ignored by real servers; lets the fake LLM route without parsing prompts
      ...(process.env.LLM_API_KEY && { authorization: `Bearer ${process.env.LLM_API_KEY}` }),
    },
    body: JSON.stringify(body),
  });
}

async function log(row: {
  role: Role; model: string; promptVersion: string | null; inputHash: string; usage: Usage | null; latencyMs: number;
  cached: boolean; ok: boolean; attempts: number; error?: string; raw?: string;
}) {
  try {
    await sql`insert into llm_calls (role, model, prompt_version, input_hash, tokens_in, tokens_out, latency_ms, cached, ok, attempts, error, raw_output)
      values (${row.role}, ${row.model}, ${row.promptVersion}, ${row.inputHash}, ${row.usage?.in ?? null}, ${row.usage?.out ?? null},
              ${Math.round(row.latencyMs)}, ${row.cached}, ${row.ok}, ${row.attempts}, ${row.error ?? null}, ${row.raw ?? null})`;
  } catch (e) {
    console.error("llm_calls log", e); // logging must never fail the call
  }
}

export class LlmError extends Error {}

/**
 * Structured call: `input` is JSON-encoded as the user message, `promptName` is the system prompt file.
 * Invalid JSON or a schema mismatch gets one repair turn; after that the call fails and the raw output is logged.
 */
export async function call<T>(role: Role, promptName: string, input: unknown, schema: Schema): Promise<T> {
  const p = prompt(promptName);
  const model = modelFor(role);
  const user = JSON.stringify(input);
  const inputHash = sha256(user);
  const key = sha256(JSON.stringify([role, model, p.version, schema, user]));
  const started = performance.now();

  if (cacheOn()) {
    const [hit] = await sql`select response from llm_cache where key = ${key}`;
    if (hit) {
      await log({ role, model, promptVersion: p.version, inputHash, usage: null, latencyMs: performance.now() - started, cached: true, ok: true, attempts: 0 });
      return hit.response as T;
    }
  }

  const messages: Msg[] = [{ role: "system", content: p.text }, { role: "user", content: user }];
  const usage: Usage = { in: 0, out: 0 };
  let raw = "";
  let error = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await post(role, {
      model,
      temperature: 0,
      reasoning_effort: "none", // skip hidden thinking on reasoning models; ignored by others
      messages,
      response_format: { type: "json_schema", json_schema: { name: "out", schema, strict: true } },
    }).catch((e: Error) => e);
    if (res instanceof Error || !res.ok) {
      error = res instanceof Error ? res.message : `llm ${res.status}: ${(await res.text()).slice(0, 300)}`;
      await log({ role, model, promptVersion: p.version, inputHash, usage, latencyMs: performance.now() - started, cached: false, ok: false, attempts: attempt, error });
      throw new LlmError(error);
    }
    const body = (await res.json()) as { choices: { message: { content: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    usage.in += body.usage?.prompt_tokens ?? 0;
    usage.out += body.usage?.completion_tokens ?? 0;
    raw = (body.choices?.[0]?.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    let parsed: unknown;
    try {
      parsed = validator(schema).parse(JSON.parse(raw));
    } catch (e) {
      error = e instanceof z.ZodError ? z.prettifyError(e) : String((e as Error).message);
      messages.push({ role: "assistant", content: raw }, {
        role: "user",
        content: `That reply was not valid JSON for the required schema (${error.slice(0, 500)}). Reply again with only the corrected JSON.`,
      });
      continue;
    }
    if (cacheOn()) await sql`insert into llm_cache (key, role, response) values (${key}, ${role}, ${parsed as object}) on conflict do nothing`;
    await log({ role, model, promptVersion: p.version, inputHash, usage, latencyMs: performance.now() - started, cached: false, ok: true, attempts: attempt });
    return parsed as T;
  }
  await log({ role, model, promptVersion: p.version, inputHash, usage, latencyMs: performance.now() - started, cached: false, ok: false, attempts: 2, error, raw });
  throw new LlmError(`${role}: invalid output after repair retry: ${error.slice(0, 300)}`);
}

export type ChatMessage = Msg;

/** Streamed chat completion; yields text deltas. Not cached (conversations don't repeat); logged once it ends. */
export async function* stream(role: "chat", messages: ChatMessage[], signal?: AbortSignal): AsyncGenerator<string> {
  const model = modelFor(role);
  const started = performance.now();
  const inputHash = sha256(JSON.stringify(messages));
  let ok = false;
  let error: string | undefined;
  try {
    const res = await post(role, { model, stream: true, reasoning_effort: "none", messages }, signal);
    if (!res.ok || !res.body) throw new LlmError(`llm ${res.status}: ${(await res.text()).slice(0, 300)}`);
    let buf = "";
    let inThink = false;
    for await (const bytes of res.body.pipeThrough(new TextDecoderStream())) {
      buf += bytes;
      const lines = buf.split("\n");
      buf = lines.pop()!;
      for (const line of lines) {
        if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
        let text: string = JSON.parse(line.slice(6)).choices?.[0]?.delta?.content ?? "";
        // Drop inline <think> blocks some local models emit even with reasoning off.
        if (text.includes("<think>")) inThink = true;
        if (inThink) {
          if (!text.includes("</think>")) continue;
          text = text.split("</think>").pop()!;
          inThink = false;
        }
        if (text) yield text;
      }
    }
    ok = true;
  } catch (e) {
    error = String((e as Error).message ?? e);
    throw e;
  } finally {
    await log({ role, model, promptVersion: null, inputHash, usage: null, latencyMs: performance.now() - started, cached: false, ok, attempts: 1, error });
  }
}
