// D1 Extract: one structured call per unit -> candidates with speaker, subject, slot, entities, dates, sensitivity,
// confidence and the quote that states them. Assistant-attributed candidates never leave this module.
import { sql } from "./db";
import { call } from "./llm";

export type Kind = "fact" | "preference" | "episode";
export type Speaker = "user" | "assistant" | "third_party" | "document";
export type Sensitivity = "none" | "personal" | "sensitive";
export type Entity = { name: string; type: string; aliases: string[] };
export type Candidate = {
  content: string; kind: Kind; speaker: Speaker; subject: string | null; slot: string | null; entities: Entity[];
  validFrom: string | null; expiresAt: string | null; sensitivity: Sensitivity; confidence: number; quote: string;
  bucket?: string | null;
};
/** What D1 sees: the new part of a document (`content`) plus already-dreamed lines just before it (`context`). */
export type Unit = { content: string; context: string | null; documentDate: Date; supportingContext: string | null };

const MAX_CANDIDATES = 30;
const str = { type: "string" };
const nullableStr = { type: ["string", "null"] };
const item = {
  type: "object", additionalProperties: false,
  required: ["content", "kind", "speaker", "subject", "slot", "entities", "validFrom", "expiresAt", "sensitivity", "confidence", "quote"],
  properties: {
    content: str,
    kind: { type: "string", enum: ["fact", "preference", "episode"] },
    speaker: { type: "string", enum: ["user", "assistant", "third_party", "document"] },
    subject: nullableStr,
    slot: nullableStr,
    entities: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["name", "type", "aliases"],
        properties: { name: str, type: str, aliases: { type: "array", items: str } },
      },
    },
    validFrom: nullableStr,
    expiresAt: nullableStr,
    sensitivity: { type: "string", enum: ["none", "personal", "sensitive"] },
    confidence: { type: "number" },
    quote: str,
  },
};
export const schemaFor = (buckets: string[]) => ({
  type: "object", additionalProperties: false, required: ["memories"],
  properties: {
    memories: {
      type: "array",
      items: buckets.length
        ? { ...item, required: [...item.required, "bucket"], properties: { ...item.properties, bucket: { type: ["string", "null"], enum: [...buckets, null] } } }
        : item,
    },
  },
});

export async function extract(ns: string, unit: Unit) {
  // Custom profile buckets ride along with extraction; "preferences" is assigned by kind.
  const custom = (await sql`select name, description from profile_buckets where ns = ${ns} order by name`) as { name: string; description: string }[];
  const { memories } = await call<{ memories: Candidate[] }>(
    "extract",
    custom.length ? "extract-buckets.v2" : "extract.v2",
    {
      documentDate: unit.documentDate.toISOString(), supportingContext: unit.supportingContext, context: unit.context, content: unit.content,
      ...(custom.length && { buckets: Object.fromEntries(custom.map((b) => [b.name, b.description])) }),
    },
    schemaFor(custom.map((b) => b.name)),
  );
  const bucketNames = new Set(custom.map((b) => b.name));
  const cands = memories
    .filter((m) => m.content?.trim())
    .map((m) => ({
      ...m,
      content: m.content.trim(),
      subject: m.subject?.trim() || null,
      slot: m.slot?.trim().toLowerCase().replace(/\s+/g, "_") || null,
      confidence: Math.min(1, Math.max(0, Number(m.confidence) || 0)),
      bucket: m.bucket && bucketNames.has(m.bucket) ? m.bucket : null,
    }))
    .slice(0, MAX_CANDIDATES);
  return cands;
}
