// Chat with memory: profile + relevant memories go into the system prompt, the reply streams back as SSE,
// and the conversation is saved as a document so it becomes memory too (what upstream's withSupermemory does).
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { llmStream, type ChatMessage } from "./llm";

const body = z.object({
  namespace: z.string().max(100).regex(/^[a-zA-Z0-9_:-]+$/),
  conversationId: z.string().min(1).max(200).regex(/^[a-zA-Z0-9_-]+$/).optional(),
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(50_000) })).min(1).max(200),
}).strict().refine((b) => b.messages.at(-1)!.role === "user", { message: "last message must be from the user" });

const MEMORY_LIMIT = 8;

function systemPrompt(profile: { static: { memory: string }[]; dynamic: { memory: string }[] }, memories: { memory: string }[]) {
  const list = (xs: { memory: string }[]) => xs.map((m) => `- ${m.memory}`).join("\n") || "- (nothing yet)";
  return `You are the user's personal assistant with long-term memory.
Use what you know about the user when it helps; don't recite it unprompted. If memory and the conversation disagree, trust the conversation.
Answer concisely.

## About the user (durable)
${list(profile.static.slice(0, 25))}

## Recent context
${list(profile.dynamic.slice(0, 10))}

## Memories relevant to this message
${list(memories)}`;
}

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
    const { namespace: ns, conversationId, messages } = body.parse(await c.req.json());
    const cid = conversationId ?? crypto.randomUUID();
    const last = messages.at(-1)!.content;

    const [{ profile }, found] = await Promise.all([
      call("POST", `/ns/${ns}/profile`, {}).then((r) => (r.profile ? r : { profile: { static: [], dynamic: [], buckets: {} } })),
      call("POST", `/ns/${ns}/search`, { query: last.slice(0, 2000), searchMode: "memories", limit: MEMORY_LIMIT }),
    ]);
    const memories = (found.results ?? []).map((r: any) => ({ id: r.id, memory: r.memory, similarity: r.similarity }));

    return streamSSE(c, async (stream) => {
      await stream.writeSSE({ event: "context", data: JSON.stringify({ conversationId: cid, memories, profile: { static: profile.static, dynamic: profile.dynamic } }) });
      let reply = "";
      try {
        const prompt: ChatMessage[] = [{ role: "system", content: systemPrompt(profile, memories) }, ...messages];
        for await (const text of llmStream(prompt, c.req.raw.signal)) {
          reply += text;
          await stream.writeSSE({ event: "delta", data: JSON.stringify({ text }) });
        }
      } catch (e) {
        await stream.writeSSE({ event: "error", data: JSON.stringify({ error: String((e as Error).message ?? e) }) });
        return;
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
