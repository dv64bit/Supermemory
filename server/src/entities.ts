// D3 Resolve entities: map each candidate's subject and named entities to rows in `entities`.
// Exact name or alias match first, then an embedding match within the same type; otherwise a new entity.
// Aliases the extractor reports ("my manager" for Priya) are recorded, so later facts that use them link up.
// ponytail: no LLM tie-break for ambiguous names yet; the first exact/alias hit wins.
import type { SQL } from "bun";
import { toVector } from "./db";
import { embed, EMBED_MODEL } from "./embed";
import type { Candidate } from "./extractor";

const NAME_SIM = 0.9;

/** Lowercased, possessive "my"/"the user's" unified, articles and punctuation dropped: "My manager" = "the user's manager". */
export const normName = (s: string) =>
  s.toLowerCase().replace(/[’']/g, "'").replace(/^(my|our)\b/, "the user's").replace(/^i$|^me$/, "the user")
    .replace(/^(the|a|an)\s+(?!user\b)/, "").replace(/[^\p{L}\p{N}' ]+/gu, " ").replace(/\s+/g, " ").trim();

type Row = { id: string; canonical_name: string; type: string; aliases: string[] };
export type Resolved = { subject: string | null; mentions: string[] }; // entity ids

export async function resolveEntities(tx: SQL, ns: string, cands: Candidate[]): Promise<Resolved[]> {
  const cache = new Map<string, string>(); // normalised name -> entity id, within this unit
  const find = async (name: string, type: string, aliases: string[]) => {
    const key = normName(name);
    if (!key) return null;
    const names = [key, ...aliases.map(normName).filter(Boolean)];
    for (const n of names) if (cache.has(n)) return remember(cache.get(n)!, names);
    const [hit] = (await tx`select id, canonical_name, type, aliases from entities
      where ns = ${ns} and (lower(canonical_name) = any(${tx.array(names, "text")}) or aliases && ${tx.array(names, "text")})
      order by (lower(canonical_name) = ${key}) desc limit 1`) as Row[];
    if (hit) return remember(hit.id, names, hit);
    const [vec] = await embed([name]);
    const [near] = (await tx`select id, canonical_name, type, aliases from entities
      where ns = ${ns} and type = ${type} and embedding is not null and 1 - (embedding <=> ${toVector(vec)}::vector) >= ${NAME_SIM}
      order by embedding <=> ${toVector(vec)}::vector limit 1`) as Row[];
    if (near) return remember(near.id, names, near);
    const [made] = await tx`insert into entities (ns, canonical_name, type, aliases, embedding, embedding_model)
      values (${ns}, ${name.trim()}, ${type}, ${tx.array(names.filter((n) => n !== key), "text")}, ${toVector(vec)}::vector, ${EMBED_MODEL})
      on conflict (ns, type, canonical_name) do update set canonical_name = excluded.canonical_name returning id`;
    return remember(made.id, names);
  };
  // Every name seen for an entity becomes a lookup key, in this unit and as a stored alias.
  const remember = async (id: string, names: string[], row?: Row) => {
    for (const n of names) cache.set(n, id);
    if (row) {
      const fresh = names.filter((n) => n !== normName(row.canonical_name) && !row.aliases.includes(n));
      if (fresh.length) await tx`update entities set aliases = aliases || ${tx.array(fresh, "text")} where id = ${id}`;
    }
    return id;
  };

  const out: Resolved[] = [];
  for (const c of cands) {
    // An entity listed with aliases tells us how this unit refers to it; resolve those first so the subject can use them.
    const mentions: string[] = [];
    for (const e of c.entities ?? []) {
      const id = await find(e.name, e.type?.toLowerCase() || "thing", e.aliases ?? []);
      if (id) mentions.push(id);
    }
    const subject = c.subject ? await find(c.subject, "person", []) : null;
    out.push({ subject, mentions: [...new Set(mentions)].filter((m) => m !== subject) });
  }
  return out;
}
