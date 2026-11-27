// Chat with memory: the assembled context (profile, relevant memories, document chunks; sensitive memories only if the
// namespace allows) goes into the system prompt, the reply streams back as SSE, and the conversation is saved as a
// document so it becomes memory too (what upstream's withSupermemory does).
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { stream as llmStream, type ChatMessage } from "./llm";
import { redact } from "./guard";
import { assembleContext } from "./context";

const body = z.object({
  namespace: z.string().max(100).regex(/^[a-zA-Z0-9_:-]+$/),
  conversationId: z.string().min(1).max(200).regex(/^[a-zA-Z0-9_-]+$/).optional(),
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(50_000) })).min(1).max(200),
}).strict().refine((b) => b.messages.at(-1)!.role === "user", { message: "last message must be from the user" });

const CONTEXT_BUDGET = 1500; // tokens
const PING_MS = 5000;

const systemPrompt = (context: string) => `You are the user's personal assistant with long-term memory.
Use what you know about the user when it helps; don't recite it unprompted. If memory and the conversation disagree, trust the conversation.
Answer concisely.

${context || "(Nothing is known about the user yet.)"}`;

export function mountChat(app: Hono, apiKey: string) {
  const call = async (method: string, path: string, payload?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      ...(payload !== undefined && { body: JSON.stringify(payload) }),
    });
    return res.json();
  };

  app.post("/chat", async (c) => {
    const parsed = body.parse(await c.req.json());
    const { namespace: ns, conversationId } = parsed;
    const messages = parsed.messages.map((m) => ({ ...m, content: redact(m.content).text }));
    const cid = conversationId ?? crypto.randomUUID();
    const last = messages.at(-1)!.content;

    const ctx = await assembleContext(ns, { query: last.slice(0, 2000), budgetTokens: CONTEXT_BUDGET });
    const { memories, profile } = ctx;

    return streamSSE(c, async (stream) => {
      await stream.writeSSE({ event: "context", data: JSON.stringify({ conversationId: cid, memories, profile: { static: profile.static, dynamic: profile.dynamic } }) });
      let reply = "";
      // A local model can take minutes to load and start answering; a quiet connection gets closed by the server
      // (Bun's idle timeout) or a proxy. A ping every few seconds keeps it open; clients ignore the event.
      const ping = setInterval(() => void stream.writeSSE({ event: "ping", data: "{}" }).catch(() => {}), PING_MS);
      try {
        const prompt: ChatMessage[] = [{ role: "system", content: systemPrompt(ctx.context) }, ...messages];
        for await (const text of llmStream("chat", prompt, c.req.raw.signal)) {
          reply += text;
          await stream.writeSSE({ event: "delta", data: JSON.stringify({ text }) });
        }
      } catch (e) {
        await stream.writeSSE({ event: "error", data: JSON.stringify({ error: String((e as Error).message ?? e) }) });
        return;
      } finally {
        clearInterval(ping);
      }
      await stream.writeSSE({ event: "done", data: JSON.stringify({ conversationId: cid }) });

      // Same id every turn: the document is re-ingested and dreaming dedupes facts it already learned.
      const transcript = [...messages, { role: "assistant", content: reply }]
        .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`).join("\n\n");
      await call("POST", `/ns/${ns}/document`, { id: `chat-${cid}`, content: transcript, metadata: { source: "chat" } })
        .catch((e) => console.error("chat save", e));
    });
  });
}
