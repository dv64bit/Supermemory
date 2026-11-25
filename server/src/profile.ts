import { sql } from "./db";
import { compileFilter, type Filter } from "./filter";
import { LIVE } from "./memories";

// Built-in bucket: preferences are classified by kind, so no LLM needed. Custom buckets are assigned during dreaming.
export const BUILTIN_BUCKETS: Record<string, string> = {
  preferences: "How the subject likes things done: style, tools, formats, habits, likes and dislikes.",
};
const STATIC_LIMIT = 40;
const DYNAMIC_LIMIT = 20;
const BUCKET_LIMIT = 40;
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
 * Each list is capped (static 40, dynamic 20, each bucket 40).
 * ponytail: no "aggregated_" summaries; add an LLM rollup per bucket if lists get long (DEFERRED #3).
 */
/** `only` (v5 `buckets`) limits which buckets come back; static and dynamic are always returned. */
export async function profile(ns: string, filter?: Filter, only?: string[]) {
  const params: unknown[] = [ns];
  const where = filter ? `and ${compileFilter(filter, "m.metadata", params)}` : "";
  // Ranked and capped in SQL: only the rows the profile shows leave the database.
  const rows = (await sql.unsafe(
    `with live as (
       select m.id, m.content, m.kind, m.strength, m.updated_at,
              m.kind = 'episode' or (m.version > 1 and m.updated_at > now() - interval '${RECENT_DAYS} days') as dyn,
              case when m.kind = 'preference' then 'preferences' else m.bucket end as b
       from memories m
       where m.ns = $1 and ${LIVE()} and not m.is_inference ${where}
         and (m.sensitivity is distinct from 'sensitive' or (select inject_sensitive from namespaces where id = $1))),
     st as (select 'static' as part, id, content, null::text as b, row_number() over (order by strength desc, updated_at desc) as rn
            from live where not dyn order by rn limit ${STATIC_LIMIT}),
     dy as (select 'dynamic', id, content, null, row_number() over (order by updated_at desc) from live where dyn order by 5 limit ${DYNAMIC_LIMIT}),
     bu as (select * from (select 'bucket', id, content, b, row_number() over (partition by b order by strength desc, updated_at desc) as rn
                           from live where b is not null) x where rn <= ${BUCKET_LIMIT})
     select * from st union all select * from dy union all select * from bu order by part, b, rn`,
    params,
  )) as { part: string; id: string; content: string; b: string | null }[];

  const item = (r: { id: string; content: string }) => ({ id: r.id, memory: r.content });
  const out: Record<string, { id: string; memory: string }[]> = {};
  for (const name of Object.keys(await buckets(ns))) if (!only || only.includes(name)) out[name] = [];
  for (const r of rows) if (r.part === "bucket" && out[r.b!]) out[r.b!].push(item(r));
  return {
    profile: {
      static: rows.filter((r) => r.part === "static").map(item),
      dynamic: rows.filter((r) => r.part === "dynamic").map(item),
      buckets: out,
    },
  };
}
