// Seam 3: a real MCP client against /mcp, backed by the live API and a scripted LLM.
import { beforeAll, afterAll, expect, test } from "bun:test";
import { freshDb, startFakeLlm } from "./fake-llm";

const llm = startFakeLlm({
  extract: ({ content }) => content.includes("tea") ? [{ content: "The user prefers green tea over coffee", kind: "preference", expiresAt: null }] : [],
});
await freshDb("supermem_test_mcp");
const { migrate } = await import("../src/db");
const { createApp } = await import("../src/app");
const { drain } = await import("../src/worker");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");

let server: ReturnType<typeof Bun.serve>;
let client: InstanceType<typeof Client>;
const textOf = (r: any) => r.content.map((c: any) => c.text).join("\n") as string;
const call = async (name: string, args: Record<string, unknown> = {}) => textOf(await client.callTool({ name, arguments: args }));

beforeAll(async () => {
  await migrate();
  server = Bun.serve({ port: 0, fetch: createApp("k").fetch });
  client = new Client({ name: "test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${server.port}/mcp`), {
    requestInit: { headers: { authorization: "Bearer k" } },
  }));
});
afterAll(async () => (await client.close(), server.stop(true), llm.stop(true)));

test("lists upstream-compatible tools", async () => {
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name).sort()).toEqual([
    "add_memory", "forget_memory", "get_document", "get_profile", "list_documents",
    "list_memories", "list_spaces", "search_memory", "select_space", "who_am_i",
  ]);
});

test("select space, add, search, profile, forget round-trip", async () => {
  expect(await call("select_space", { namespace: "personal" })).toContain('"personal"');
  expect(await call("who_am_i")).toContain("personal");

  const saved = await call("add_memory", { content: "I always drink green tea, never coffee." });
  expect(saved).toContain("space: personal");
  await drain();

  const found = await call("search_memory", { query: "what does the user drink?" });
  expect(found).toContain("green tea");
  const id = found.match(/^- (\S+) \[/m)![1];

  expect(await call("get_profile")).toContain("## preferences\n- The user prefers green tea over coffee");
  expect(await call("list_spaces")).toContain("personal (active): 1 documents, 1 memories");
  expect(await call("list_memories")).toContain(id);

  const docs = await call("list_documents");
  const docId = docs.match(/^- (\S+) \[/m)![1];
  expect(await call("get_document", { documentId: docId })).toContain("green tea");

  expect(await call("forget_memory", { content: "tea" })).toContain("Nothing was forgotten yet");
  expect(await call("forget_memory", { ids: [id] })).toBe("Forgot 1 memory.");
  expect(await call("search_memory", { query: "what does the user drink?" })).toContain("No matching memories");
});

test("resources and the context prompt", async () => {
  const { resources } = await client.listResources();
  expect(resources.map((r) => r.uri).sort()).toEqual(["supermemory://profile", "supermemory://spaces"]);
  const spaces = await client.readResource({ uri: "supermemory://spaces" });
  expect(JSON.parse((spaces.contents[0] as any).text).namespaces[0].id).toBe("personal");
  const prompt = await client.getPrompt({ name: "context" });
  expect((prompt.messages[0].content as any).text).toContain('space "personal"');
});

test("rejects requests without the API key", async () => {
  const res = await fetch(`http://localhost:${server.port}/mcp`, { method: "POST", body: "{}" });
  expect(res.status).toBe(401);
});
