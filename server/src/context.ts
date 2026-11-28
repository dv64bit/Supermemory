// Context assembly (PLAN.v2 §4.7): one ready-to-inject block under a token budget, for chat, MCP and hooks.
// Order: durable profile, recent profile, memories relevant to the query (with dates and ids), then document chunks
// (with citations), each list packed greedily. With a query the profile gets at most PROFILE_SHARE of the budget, so
// relevant memories always have room. Sensitive memories are left out unless the namespace allows injecting them.
import { profile } from "./profile";
import { search } from "./search";

const PROFILE_SHARE = 0.4;
const SEARCH_LIMIT = 20;
const CHUNK_CHARS = 600;
/** Rough token count (~4 characters per token for English); the budget is a ceiling, not an exact fit. */
export const tokens = (s: string) => Math.ceil(s.length / 4);

export type ContextInput = { query?: string; budgetTokens: number; asOf?: Date; threshold?: number };
type Item = { id: string; line: string };

export async function assembleContext(ns: string, input: ContextInput) {
  const [{ profile: p }, found] = await Promise.all([
    profile(ns, undefined, []),
    input.query
      ? search(ns, {
          query: input.query, searchMode: "hybrid", limit: SEARCH_LIMIT, threshold: input.threshold ?? 0.3, asOf: input.asOf,
          include: { documents: true, related: false, forgotten: false }, injectable: true, dates: true,
        })
      : null,
  ]);
  const inProfile = new Set([...p.static, ...p.dynamic].map((m) => m.id));
  const hits = (found?.results ?? []) as Record<string, any>[]; // v5 result shapes: memory hits and chunk hits
  const memories: Item[] = hits.filter((h) => h.memory !== undefined && !inProfile.has(h.id)).map((h) => ({
    id: h.id,
    line: `- ${h.memory} (${[h.validFrom ? `since ${h.validFrom.slice(0, 10)}` : null, h.isInference ? "inferred, unconfirmed" : null].filter(Boolean).join("; ") || "undated"}) [${h.id}]`,
  }));
  const chunks: Item[] = hits.filter((h) => h.chunk !== undefined).map((h) => {
    const doc = h.included?.document;
    const text = h.chunk.length > CHUNK_CHARS ? `${h.chunk.slice(0, CHUNK_CHARS)}…` : h.chunk;
    return { id: h.id, line: `- "${text.replace(/\s+/g, " ").trim()}" (${doc?.title ?? doc?.id ?? "document"})` };
  });

  let left = input.budgetTokens;
  const used: Record<string, string[]> = { static: [], dynamic: [], memories: [], chunks: [] };
  const parts: string[] = [];
  // Greedy: an item goes in if it (plus its section heading, the first time) still fits; otherwise it is skipped.
  const pack = (key: string, heading: string, items: Item[], cap = Infinity) => {
    const lines: string[] = [];
    let spent = 0;
    for (const it of items) {
      const cost = tokens(it.line) + 1 + (lines.length ? 0 : tokens(heading) + 2);
      if (cost > left || spent + cost > cap) continue;
      lines.push(it.line);
      used[key].push(it.id);
      left -= cost;
      spent += cost;
    }
    if (lines.length) parts.push(`${heading}\n${lines.join("\n")}`);
    return spent;
  };
  const profileCap = input.query ? Math.floor(input.budgetTokens * PROFILE_SHARE) : Infinity;
  const spentStatic = pack("static", "## About the user", p.static.map((m) => ({ id: m.id, line: `- ${m.memory}` })), profileCap);
  pack("dynamic", "## Recent", p.dynamic.map((m) => ({ id: m.id, line: `- ${m.memory}` })), profileCap - spentStatic);
  pack("memories", "## Relevant memories", memories);
  pack("chunks", "## From documents", chunks);

  const context = parts.join("\n\n");
  return {
    context,
    tokens: tokens(context),
    budgetTokens: input.budgetTokens,
    used,
    profile: { static: p.static.filter((m) => used.static.includes(m.id)), dynamic: p.dynamic.filter((m) => used.dynamic.includes(m.id)) },
    // Memories that matched the query and made it into the block, in its memory list or in the profile.
    memories: hits.filter((h) => h.memory !== undefined && [...used.memories, ...used.static, ...used.dynamic].includes(h.id))
      .map((h) => ({ id: h.id, memory: h.memory as string, similarity: h.similarity as number })),
  };
}
