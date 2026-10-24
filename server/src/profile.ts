import { sql } from "./db";
import { compileFilter, type Filter } from "./filter";
import { LIVE } from "./memories";

// Built-in bucket: preferences are classified by kind, so no LLM needed. Custom buckets are assigned during dreaming.
export const BUILTIN_BUCKETS: Record<string, string> = {
  preferences: "How the subject likes things done: style, tools, formats, habits, likes and dislikes.",
};
const STATIC_LIMIT = 40;
const DYNAMIC_LIMIT = 20;
const RECENT_DAYS = 30;

export async function buckets(ns: string): Promise<Record<string, string>> {
  const rows = await sql`select name, description from profile_buckets where ns = ${ns} order by name`;
  return { ...BUILTIN_BUCKETS, ...Object.fromEntries(rows.map((r: any) => [r.name, r.description])) };
}

/**
 * Profile straight from live memories, no LLM on the read path. Sensitive memories are left out unless the
 * namespace allows injecting them (PATCH /ns/{ns}/x/settings {injectSensitive}).
 *  static  = durable facts and preferences (strongest first)
 *  dynamic = episodes and facts that changed recently (current state)
 * ponytail: no "aggregated_" summaries; add an LLM rollup per bucket if lists get long.
 */
export async function profile(ns: string, filter?: Filter) {
  const params: unknown[] = [ns];
  const where = filter ? `and ${compileFilter(filter, "m.metadata", params)}` : "";
  const rows = (await sql.unsafe(
    `select m.id, m.content, m.kind, m.bucket, m.version, m.strength, m.updated_at from memories m
     where m.ns = $1 and ${LIVE()} and not m.is_inference ${where}
       and (m.sensitivity is distinct from 'sensitive' or (select inject_sensitive from namespaces where id = $1))
     order by m.strength desc, m.updated_at desc`,
    params,
  )) as any[];

  const recent = (r: any) => Date.now() - r.updated_at.getTime() < RECENT_DAYS * 864e5;
  const item = (r: any) => ({ id: r.id, memory: r.content });
  const isDynamic = (r: any) => r.kind === "episode" || (r.version > 1 && recent(r));

  const out: Record<string, { id: string; memory: string }[]> = {};
  for (const name of Object.keys(await buckets(ns))) out[name] = [];
  for (const r of rows) {
    const b = r.kind === "preference" ? "preferences" : r.bucket;
    if (b && out[b]) out[b].push(item(r));
  }
  return {
    profile: {
      static: rows.filter((r) => !isDynamic(r)).slice(0, STATIC_LIMIT).map(item),
      dynamic: rows.filter(isDynamic).sort((a, b) => b.updated_at - a.updated_at).slice(0, DYNAMIC_LIMIT).map(item),
      buckets: out,
    },
  };
}
