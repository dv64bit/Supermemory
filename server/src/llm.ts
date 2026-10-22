// One OpenAI-compatible client for every LLM call (Ollama by default). Tests point LLM_BASE_URL at a fake.
const base = () => process.env.LLM_BASE_URL ?? "http://localhost:11434/v1";
const model = () => process.env.LLM_MODEL ?? "qwen3:8b";

export async function llmJson<T>(system: string, user: string, schema: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${base()}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(process.env.LLM_API_KEY && { authorization: `Bearer ${process.env.LLM_API_KEY}` }),
    },
    body: JSON.stringify({
      model: model(),
      temperature: 0,
      reasoning_effort: "none", // skip hidden thinking on reasoning models; ignored by others
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      response_format: { type: "json_schema", json_schema: { name: "out", schema, strict: true } },
    }),
  });
  if (!res.ok) throw new Error(`llm ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { choices: { message: { content: string } }[] };
  const text = body.choices[0].message.content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  return JSON.parse(text) as T;
}

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

/** Streamed chat completion; yields text deltas. Uses LLM_CHAT_MODEL when set (chat can afford a bigger model). */
export async function* llmStream(messages: ChatMessage[], signal?: AbortSignal): AsyncGenerator<string> {
  const res = await fetch(`${base()}/chat/completions`, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      ...(process.env.LLM_API_KEY && { authorization: `Bearer ${process.env.LLM_API_KEY}` }),
    },
    body: JSON.stringify({ model: process.env.LLM_CHAT_MODEL ?? model(), stream: true, reasoning_effort: "none", messages }),
  });
  if (!res.ok || !res.body) throw new Error(`llm ${res.status}: ${(await res.text()).slice(0, 300)}`);
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
}
