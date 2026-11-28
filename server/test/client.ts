// Minimal HTTP client for the /ns API, used by the tests to exercise the server like an external caller would.
export class ApiError extends Error {
  constructor(public statusCode: number, public body: any) {
    super(`HTTP ${statusCode}: ${JSON.stringify(body)}`);
  }
}
export class NotFoundError extends ApiError {}
export class UnauthorizedError extends ApiError {}

// `fetch` lets a test wrap every request (v5-schema.ts validates each response against ref/v5.json).
type Opts = { apiKey: string; baseUrl: string; maxRetries?: number; fetch?: typeof fetch };
// Loose response type: tests assert on fields directly; list fields typed as arrays so callbacks aren't implicit-any.
type Res = { [k: string]: any; results: any[]; documents: any[]; memories: any[]; chunks: any[] };

export class MemClient {
  constructor(private opts: Opts) {}

  private async req(method: string, path: string, body?: unknown): Promise<Res> {
    const res = await (this.opts.fetch ?? fetch)(`${this.opts.baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.opts.apiKey}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    if (res.ok) return json;
    if (res.status === 404) throw new NotFoundError(404, json);
    if (res.status === 401) throw new UnauthorizedError(401, json);
    throw new ApiError(res.status, json);
  }

  add = (ns: string, body: Record<string, unknown>) => this.req("POST", `/ns/${ns}/document`, body);
  search = (ns: string, body: Record<string, unknown>) => this.req("POST", `/ns/${ns}/search`, body);
  // v5 takes paging and sorting as query parameters; the body only holds filter/include.
  list = (ns: string, type: "documents" | "chunks" | "memories", body: Record<string, unknown> = {}) => {
    const { page, limit, sort, order, ...rest } = body;
    const q = new URLSearchParams(Object.entries({ page, limit, sort, order }).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
    return this.req("POST", `/ns/${ns}/list/${type}${q.size ? `?${q}` : ""}`, rest);
  };
  profile = (ns: string, body: Record<string, unknown> = {}) => this.req("POST", `/ns/${ns}/profile`, body);

  documents = {
    get: (ns: string, id: string, o: { include?: string[] } = {}) =>
      this.req("GET", `/ns/${ns}/document/${encodeURIComponent(id)}${o.include?.length ? `?include=${o.include.join(",")}` : ""}`),
    update: (ns: string, id: string, body: Record<string, unknown>) => this.req("PATCH", `/ns/${ns}/document/${encodeURIComponent(id)}`, body),
    batchAdd: (ns: string, body: Record<string, unknown>) => this.req("POST", `/ns/${ns}/document/batch`, body),
    delete: (ns: string, body: { ids: string[] }) => this.req("DELETE", `/ns/${ns}/document`, body),
  };

  memories = {
    get: (ns: string, id: string, o: { include?: string[] } = {}) =>
      this.req("GET", `/ns/${ns}/memories/${encodeURIComponent(id)}${o.include?.length ? `?include=${o.include.join(",")}` : ""}`),
    forget: (ns: string, body: { ids: string[] }) => this.req("DELETE", `/ns/${ns}/memories`, body),
    forgetMatching: (ns: string, body: { query: string; dryRun: boolean }) => this.req("DELETE", `/ns/${ns}/memories/semantic`, body),
  };

  profiles = {
    setBuckets: (ns: string, body: { buckets: Record<string, string> }) => this.req("PUT", `/ns/${ns}/profile/buckets`, body),
  };
}
