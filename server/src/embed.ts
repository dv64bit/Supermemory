import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";

// Local bge-base-en-v1.5 (768d). Dimension is baked into the schema; changing models means re-embedding.
const MODEL = process.env.EMBED_MODEL ?? "Xenova/bge-base-en-v1.5";
const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

let extractor: Promise<FeatureExtractionPipeline> | undefined;
const load = () => (extractor ??= pipeline("feature-extraction", MODEL, { dtype: "q8" }));

export async function embed(texts: string[], kind: "passage" | "query" = "passage"): Promise<number[][]> {
  if (!texts.length) return [];
  const model = await load();
  const input = kind === "query" ? texts.map((t) => QUERY_PREFIX + t) : texts;
  const out = await model(input, { pooling: "cls", normalize: true });
  return out.tolist() as number[][];
}
