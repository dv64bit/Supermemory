// Validates live responses against the published v5 OpenAPI spec (ref/v5.json). Plug `validatingFetch` into the
// official SDK (`new Supermemory({ fetch })`) so every call a test makes is checked, without modifying the SDK.
import { z } from "zod";

const spec = await Bun.file(`${import.meta.dir}/../../ref/v5.json`).json();

/** Inline $refs (recursive schemas, only the filter tree, collapse to {}); drop doc-only keys. */
function deref(x: any, stack: string[] = []): any {
  if (Array.isArray(x)) return x.map((y) => deref(y, stack));
  if (!x || typeof x !== "object") return x;
  if (x.$ref) {
    const name = x.$ref.split("/").pop();
    return stack.includes(name) ? {} : deref(spec.components.schemas[name], [...stack, name]);
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(x)) if (!["description", "example", "examples"].includes(k)) out[k] = deref(v, stack);
  return out;
}

// Literal segments beat {params}, so /list/documents/memory-counts wins over /list/{type}.
const routes = Object.entries(spec.paths as Record<string, Record<string, any>>)
  .flatMap(([path, ops]) => Object.entries(ops).map(([method, op]) => ({
    method: method.toUpperCase(),
    path,
    re: new RegExp(`^${path.replace(/\{[^}]+\}/g, "[^/]+")}$`),
    params: (path.match(/\{/g) ?? []).length,
    op,
  })))
  .sort((a, b) => a.params - b.params);

const validators = new Map<string, z.ZodType | null>();
function validatorFor(method: string, pathname: string, status: number) {
  const route = routes.find((r) => r.method === method && r.re.test(pathname));
  if (!route) return { route: null, validator: null };
  const key = `${route.method} ${route.path} ${status}`;
  if (!validators.has(key)) {
    const schema = (route.op.responses?.[String(status)] ?? route.op.responses?.default)?.content?.["application/json"]?.schema;
    validators.set(key, schema ? z.fromJSONSchema(deref(schema)) : null);
  }
  return { route, validator: validators.get(key)! };
}

/** A deviation from the spec we know about and have scheduled; matched by operation and issue path. */
export type KnownMismatch = { operation: string; issuePath: RegExp; message?: RegExp; why: string };

export class SpecViolation extends Error {}

export type SpecIssue = { operation: string; path: string; message: string };

/** Returns the spec issues in one response body (after removing known mismatches). Unknown routes return []. */
export function specIssues(method: string, pathname: string, status: number, body: unknown, known: KnownMismatch[] = []): SpecIssue[] {
  const { route, validator } = validatorFor(method, pathname, status);
  if (!route || !validator) return [];
  const operation = `${route.method} ${route.path}`;
  const res = validator.safeParse(body);
  if (res.success) return [];
  return res.error.issues
    .map((i) => ({ operation, path: i.path.join("."), message: i.message }))
    .filter((i) => !known.some((k) => k.operation === operation && k.issuePath.test(i.path) && (!k.message || k.message.test(i.message))));
}

/** A fetch that throws SpecViolation when a JSON response from a spec'd route doesn't match ref/v5.json. */
export function validatingFetch(known: KnownMismatch[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const res = await fetch(req);
    if (!(res.headers.get("content-type") ?? "").includes("application/json")) return res;
    const body = await res.clone().json();
    const issues = specIssues(req.method, new URL(req.url).pathname, res.status, body, known);
    if (issues.length) {
      throw new SpecViolation(`${issues[0].operation} -> ${res.status} violates ref/v5.json:\n` +
        issues.slice(0, 10).map((i) => `  ${i.path || "(root)"}: ${i.message}`).join("\n"));
    }
    return res;
  }) as typeof fetch;
}

/**
 * Deviations found in the P0 audit (docs/v2/GAP_REPORT.md §3), scheduled for P4. Each also has a `target` test
 * in contract.test.ts that flips red when fixed, at which point remove the entry here.
 */
export const KNOWN_V5_MISMATCHES: KnownMismatch[] = [
  { operation: "POST /ns/{namespace}/search", issuePath: /^results\.\d+\.(isLatest|isInference)$/, message: /received undefined/, why: "chunk results omit isLatest/isInference" },
  // Found in P1-B (missed by the P0 audit): the spec requires all three arrays on every list response.
  { operation: "POST /ns/{namespace}/list/{type}", issuePath: /^(documents|chunks|memories)$/, message: /received undefined/, why: "list returns only the requested array" },
];
