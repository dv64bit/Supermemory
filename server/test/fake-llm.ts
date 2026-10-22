// Fake OpenAI-compatible /chat/completions. Routes on the "TASK: <name>" line of the system prompt
// and hands the parsed user JSON to a scripted handler. Deterministic engine tests, no model needed.
type Handlers = {
  extract?: (input: { content: string; documentDate: string; buckets?: Record<string, string> }) => { content: string; kind: string; expiresAt: string | null; bucket?: string | null }[];
  relate?: (c: { i: number; content: string; neighbors: { j: number; content: string }[] }) => { relation: string; target: number | null };
  derive?: (memories: { j: number; content: string }[]) => { content: string; from: number[] }[];
  forget?: (input: { request: string; candidates: { j: number; content: string }[] }) => number[];
  chat?: (messages: { role: string; content: string }[]) => string;
};

export function startFakeLlm(h: Handlers = {}) {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { stream?: boolean; messages: { role: string; content: string }[] };
      if (body.stream) {
        // Stream the scripted reply word by word, OpenAI SSE style.
        const words = (h.chat?.(body.messages) ?? "ok").split(/(?<= )/);
        const sse = words.map((w) => `data: ${JSON.stringify({ choices: [{ delta: { content: w } }] })}\n\n`).join("") + "data: [DONE]\n\n";
        return new Response(sse, { headers: { "content-type": "text/event-stream" } });
      }
      const task = body.messages[0].content.match(/^TASK: (\w+)/)?.[1];
      const input = JSON.parse(body.messages[1].content);
      let out: unknown;
      if (task === "extract") out = { memories: h.extract?.(input) ?? [] };
      else if (task === "relate") out = { decisions: input.candidates.map((c: any) => ({ i: c.i, ...(h.relate?.(c) ?? { relation: "new", target: null }) })) };
      else if (task === "derive") out = { inferences: h.derive?.(input.memories) ?? [] };
      else if (task === "forget") out = { forget: h.forget?.(input) ?? [] };
      else return new Response(`unknown task ${task}`, { status: 400 });
      return Response.json({ choices: [{ message: { role: "assistant", content: JSON.stringify(out) } }] });
    },
  });
  process.env.LLM_BASE_URL = `http://localhost:${server.port}`;
  return server;
}

/** Fresh, isolated database per test file (files may run in parallel). Call before importing src/db. */
export async function freshDb(name: string) {
  const admin = new Bun.SQL("postgres://localhost/postgres");
  await admin.unsafe(`drop database if exists ${name} with (force)`);
  await admin.unsafe(`create database ${name}`);
  await admin.close();
  process.env.DATABASE_URL = `postgres://localhost/${name}`;
}
