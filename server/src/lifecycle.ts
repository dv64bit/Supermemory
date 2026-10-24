// Lifecycle: the per-kind strength/decay/expiry model, from lifecycle.yaml. The hourly sweep applies it.
import { readFileSync } from "node:fs";
import { z } from "zod";
import { sql } from "./db";

const schema = z.object({
  fact: z.object({ decay: z.literal(false) }),
  preference: z.object({ strength_cap: z.number().positive() }),
  episode: z.object({
    half_life_days: z.number().positive(),
    base_significance: z.number().min(0).max(1),
    per_reinforcement: z.number().min(0),
    forget_below: z.number().min(0),
    keep_if_significance: z.number().min(0).max(1),
  }),
  relate: z.object({ update_min_confidence: z.number().min(0).max(1) }),
});
export type Lifecycle = z.infer<typeof schema>;

let cached: Lifecycle | undefined;
export function lifecycle(): Lifecycle {
  if (!cached) {
    const file = process.env.LIFECYCLE_FILE ?? `${import.meta.dir}/../lifecycle.yaml`;
    cached = schema.parse(Bun.YAML.parse(readFileSync(file, "utf8")));
  }
  return cached;
}
export const updateMinConfidence = () => Number(process.env.RELATE_UPDATE_MIN ?? lifecycle().relate.update_min_confidence);

/** Expiry: memories past forget_after are forgotten. Episodes whose decayed score drops too low are soft-forgotten. */
export async function sweep() {
  const e = lifecycle().episode;
  await sql`with f as (update memories set is_forgotten = true, forget_reason = 'expired', updated_at = now()
        where not is_forgotten and forget_after is not null and forget_after <= now() returning pk)
    insert into memory_events (memory_pk, action, actor, reason) select pk, 'expire', 'sweeper', 'expired' from f`;
  await sql`with s as (
        select pk, least(1, ${e.base_significance}::float8 + ${e.per_reinforcement}::float8 * (strength - 1)) as sig,
               extract(epoch from now() - updated_at) / 86400 as age
        from memories where kind = 'episode' and not is_forgotten and not pinned),
      f as (update memories m set is_forgotten = true, forget_reason = 'decayed', updated_at = now() from s
        where m.pk = s.pk and s.sig < ${e.keep_if_significance}
          and s.sig * power(0.5, s.age / ${e.half_life_days}::float8) < ${e.forget_below} returning m.pk)
    insert into memory_events (memory_pk, action, actor, reason) select pk, 'decay', 'sweeper', 'decayed' from f`;
}
