import { z } from "zod";

const field = z.string().min(1).regex(/^[a-zA-Z0-9_.-]+$/);
const leaf = z.union([
  z.object({ field, operator: z.enum(["eq", "neq"]), value: z.string(), caseSensitive: z.boolean().default(true) }).strict(),
  z.object({ field, operator: z.enum(["eq", "neq"]), value: z.union([z.number(), z.boolean()]) }).strict(),
  z.object({ field, operator: z.enum(["gt", "gte", "lt", "lte"]), value: z.number() }).strict(),
  z.object({ field, operator: z.enum(["contains", "notContains"]), value: z.string(), caseSensitive: z.boolean().default(true) }).strict(),
  z.object({ field, operator: z.enum(["arrayContains", "arrayNotContains"]), value: z.string() }).strict(),
]);
export type Filter = z.infer<typeof leaf> | { operator: "and" | "or"; operands: Filter[] };
export const filterSchema: z.ZodType<Filter> = z.lazy(() =>
  z.union([leaf, z.object({ operator: z.enum(["and", "or"]), operands: z.array(filterSchema).min(1).max(200) }).strict()]),
);

const CMP = { gt: ">", gte: ">=", lt: "<", lte: "<=" } as const;

/** Compile to a SQL predicate over `${col}` (a jsonb column). Pushes values into `params` ($n placeholders). */
export function compileFilter(f: Filter, col: string, params: unknown[], depth = 0): string {
  if (depth > 5) throw new Error("filter nested deeper than 5 levels");
  const p = (v: unknown) => `$${params.push(v)}`;
  if ("operands" in f) {
    const parts = f.operands.map((o) => compileFilter(o, col, params, depth + 1));
    return `(${parts.join(f.operator === "and" ? " and " : " or ")})`;
  }
  const key = p(f.field);
  const text = `(${col}->>${key})`;
  switch (f.operator) {
    case "eq":
    case "neq": {
      const op = f.operator === "eq" ? "=" : "is distinct from";
      if (typeof f.value !== "string") return `(${col}->${key}) ${op} ${p(JSON.stringify(f.value))}::jsonb`;
      const cs = "caseSensitive" in f ? f.caseSensitive : true;
      return cs ? `${text} ${op} ${p(f.value)}` : `lower(${text}) ${op} lower(${p(f.value)})`;
    }
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      return `(jsonb_typeof(${col}->${key}) = 'number' and (${col}->>${key})::numeric ${CMP[f.operator]} ${p(f.value)})`;
    case "contains":
    case "notContains": {
      const hit = f.caseSensitive ? `strpos(${text}, ${p(f.value)}) > 0` : `strpos(lower(${text}), lower(${p(f.value)})) > 0`;
      return f.operator === "contains" ? `coalesce(${hit}, false)` : `not coalesce(${hit}, false)`;
    }
    case "arrayContains":
      return `coalesce((${col}->${key}) ? ${p(f.value)}, false)`;
    case "arrayNotContains":
      return `not coalesce((${col}->${key}) ? ${p(f.value)}, false)`;
  }
}
