// Fake OpenAI-compatible /chat/completions. Routes on the router's `x-llm-role` header (never on prompt wording)
// and hands the parsed user JSON to a scripted handler. Deterministic engine tests, no model needed.
// Every request is recorded in `requests`, so tests can assert on exactly what the model was sent.
// Extract handlers return the fields they care about; the rest get schema-valid defaults (speaker user, the whole
// content as the quote, so grounding finds it). Relate handlers may answer with a v2 op or the older relation names.
type ExtractOut = {
  content: string; kind: string; expiresAt: string | null; bucket?: string | null; speaker?: string; subject?: string | null;
  slot?: string | null; entities?: { name: string; type: string; aliases: string[] }[]; validFrom?: string | null;
  sensitivity?: string; confidence?: number; quote?: string;
};
type RelateOut = { op: string; target: number | null; confidence?: number } | { relation: string; target: number | null; confidence?: number };
type Handlers = {
  extract?: (input: { content: string; context: string | null; documentDate: string; buckets?: Record<string, string> }) => ExtractOut[];
  relate?: (c: { i: number; content: string; speaker: string; subject: string | null; neighbors: { j: number; content: string; speaker: string | null }[] }) => RelateOut;
  /** Grounding verdict per claim; default supported. */
  ground?: (claim: { i: number; claim: string; quote: string }, source: string) => "supported" | "unsupported";
  derive?: (memories: { j: number; content: string }[]) => { content: string; from: number[] }[];
  forget?: (input: { request: string; candidates: { j: number; content: string }[] }) => number[];
  chat?: (messages: { role: string; content: string }[]) => string;
  /** Evals only: gets the parsed input and the prompt name (first line "TASK: <name>"); returns the JSON reply. */
  judge?: (input: any, task: string) => unknown;
  /** Raw reply text per role, bypassing the handlers above (e.g. to send invalid JSON). Called once per request. */
  raw?: (role: string, attempt: number) => string | undefined;
};

export type RecordedRequest = { role: string | null; body: { model: string; stream?: boolean; messages: { role: string; content: string }[]; [k: string]: unknown } };

export function startFakeLlm(h: Handlers = {}) {
  const requests: RecordedRequest[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as RecordedRequest["body"];
      const role = req.headers.get("x-llm-role");
      requests.push({ role, body });
      if (body.stream) {
        // Stream the scripted reply word by word, OpenAI SSE style.
        const words = (h.chat?.(body.messages) ?? "ok").split(/(?<= )/);
        const sse = words.map((w) => `data: ${JSON.stringify({ choices: [{ delta: { content: w } }] })}\n\n`).join("") + "data: [DONE]\n\n";
        return new Response(sse, { headers: { "content-type": "text/event-stream" } });
      }
      const reply = (content: string) => Response.json({
        choices: [{ message: { role: "assistant", content } }],
        usage: { prompt_tokens: body.messages.reduce((n, m) => n + m.content.length, 0), completion_tokens: content.length },
      });
      const attempt = body.messages.filter((m) => m.role === "assistant").length + 1;
      const raw = h.raw?.(role ?? "", attempt);
      if (raw !== undefined) return reply(raw);

      const input = JSON.parse(body.messages[1].content);
      let out: unknown;
      if (role === "extract") {
        // A schema-following model always emits every required key; mirror that for the optional bucket.
        out = { memories: (h.extract?.(input) ?? []).map((m) => ({
          speaker: "user", subject: null, slot: null, entities: [], validFrom: null, sensitivity: "none", confidence: 0.9, quote: input.content,
          ...(input.buckets && { bucket: null }), ...m,
        })) };
      } else if (role === "ground") {
        out = { verdicts: input.claims.map((c: any) => ({ i: c.i, verdict: h.ground?.(c, input.source) ?? "supported" })) };
      } else if (role === "relate") {
        const OLD: Record<string, string> = { new: "ADD", duplicate: "DUPLICATE", updates: "UPDATE", extends: "EXTEND" };
        out = { decisions: input.candidates.map((c: any) => {
          const d: any = h.relate?.(c) ?? { op: "ADD", target: null };
          return { i: c.i, op: d.op ?? OLD[d.relation], target: d.target, confidence: d.confidence ?? 0.9 };
        }) };
      }
      else if (role === "derive") out = { inferences: h.derive?.(input.memories) ?? [] };
      else if (role === "forget") out = { forget: h.forget?.(input) ?? [] };
      else if (role === "judge" && h.judge) out = h.judge(input, body.messages[0].content.match(/^TASK: (\S+)/)?.[1] ?? "");
      else return new Response(`unknown role ${role}`, { status: 400 });
      return reply(JSON.stringify(out));
    },
  });
  process.env.LLM_BASE_URL = `http://localhost:${server.port}`;
  return Object.assign(server, { requests });
}

/**
 * Fresh, isolated database per test file (files may run in parallel). Call before importing src/db.
 * TEST_DATABASE_URL points at any database on the server (default postgres://localhost/postgres); the role needs createdb.
 */
export async function freshDb(name: string) {
  const adminUrl = process.env.TEST_DATABASE_URL ?? "postgres://localhost/postgres";
  const admin = new Bun.SQL(adminUrl);
  await admin.unsafe(`drop database if exists ${name} with (force)`);
  await admin.unsafe(`create database ${name}`);
  await admin.close();
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  process.env.DATABASE_URL = url.toString();
}
