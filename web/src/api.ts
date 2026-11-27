import { useCallback, useEffect, useState } from "react";

// ---------- settings (localStorage, never trusted to exist) ----------

export function load(key: string, fallback = ""): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
export function save(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private window / blocked storage: setting lives for this session only */
  }
}

export const settings = {
  get key() {
    return load("sm.apiKey");
  },
  get base() {
    return load("sm.baseUrl", "/api") || "/api";
  },
};

// ---------- types (Supermemory v5 shapes, only the fields the UI reads) ----------

export type Status = "queued" | "extracting" | "chunking" | "embedding" | "indexing" | "done" | "failed";

export type Space = { id: string; documentCount: number; memoryCount: number };

export type Doc = {
  id: string;
  title: string | null;
  summary?: string | null;
  type: string;
  url: string | null;
  content?: string;
  metadata: Record<string, unknown> | null;
  system: { status: Status; dreamingStatus?: string; memoryCount?: number; createdAt: string; updatedAt: string };
};

export type Memory = {
  id: string;
  memory: string;
  metadata: Record<string, unknown> | null;
  isStatic?: boolean;
  isInference: boolean;
  isLatest: boolean;
  isForgotten?: boolean;
  version?: number;
  system: { createdAt: string; updatedAt: string };
};

export type Relation = "updates" | "extends" | "derives";
export type Related = { id: string; relation: Relation; memory: string; version?: number };

export type MemoryDetail = Memory & {
  included?: {
    related?: { parents: Related[]; children: Related[] };
    document?: { id: string; title: string | null; type?: string };
  };
};

export type Chunk = { id: string; position: number; content: string };

/** One side of a review item, or the memory being explained (GET /x/review, /x/memories/{id}/explain). */
export type ReviewMemory = {
  id: string; memory: string; kind: string; speaker: string | null; confidence: number | null; quote: string | null;
  validFrom: string | null; validTo: string | null; isLatest: boolean; status: string; pinned: boolean;
  document: { id: string; title: string | null } | null;
};
export type ReviewItem = {
  id: string; kind: "inference" | "conflict" | "low_confidence"; status: string; createdAt: string;
  reason: string | null; confidence: number | null; resolution: string | null;
  memory: ReviewMemory; related: ReviewMemory | null; from: ReviewMemory[];
};
export type ReviewAction =
  | { action: "approve" | "reject" | "keep_new" | "keep_old" | "keep_both" }
  | { action: "merge"; content: string };
export type Explanation = {
  summary: string;
  memory: ReviewMemory & { version: number; isInference: boolean; learnedAt: string | null };
  learnedBy: { dreamRun: string; pipelineVersion: string; models: string[]; at: string } | null;
  derivedFrom: { id: string; memory: string }[];
  versions: { id: string; memory: string; version: number; isLatest: boolean; validFrom: string | null; validTo: string | null }[];
  history: { action: string; actor: string; reason: string | null; at: string }[];
};

export type SearchResult = {
  id: string;
  memory?: string;
  chunk?: string;
  similarity: number;
  isLatest?: boolean;
  isInference?: boolean;
  metadata: Record<string, unknown> | null;
  included?: { document?: { id: string; title: string | null; type?: string } };
};

export type GraphNode = {
  id: string;
  type: "memory" | "document";
  label: string;
  isLatest?: boolean;
  isInference?: boolean;
  isForgotten?: boolean;
  kind?: string;
  version?: number;
  createdAt?: string;
};
export type GraphEdge = { source: string; target: string; relation: Relation | "source" };
export type Graph = { nodes: GraphNode[]; edges: GraphEdge[] };

export type Fact = string | { id: string; memory: string };
export type Profile = { static: Fact[]; dynamic: Fact[]; buckets?: Record<string, Fact[]> };

// ---------- fetch ----------

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Authenticated fetch that throws ApiError on non-2xx. JSON bodies are stringified; FormData passes through. */
export async function req(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<Response> {
  const form = init.body instanceof FormData;
  const res = await fetch(settings.base.replace(/\/$/, "") + path, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers: { Authorization: `Bearer ${settings.key}`, ...(init.body && !form ? { "Content-Type": "application/json" } : {}) },
    body: form ? (init.body as FormData) : init.body ? JSON.stringify(init.body) : undefined,
    signal: init.signal,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const j = await res.json();
      msg = j.error ?? j.message ?? msg;
      if (j.details) msg += `: ${typeof j.details === "string" ? j.details : JSON.stringify(j.details)}`;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, msg || `HTTP ${res.status}`);
  }
  return res;
}

export const api = <T,>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> => req(path, init).then((r) => r.json());

const ns = (space: string) => `/ns/${encodeURIComponent(space)}`;

export const sm = {
  spaces: () => api<{ namespaces: Space[] }>("/ns?limit=100").then((r) => r.namespaces),
  add: (space: string, body: { content: string; metadata?: Record<string, unknown> }) =>
    api<{ id: string; status: Status }>(`${ns(space)}/document`, { body }),
  documents: (space: string, page = 1, limit = 50) =>
    api<{ documents: Doc[]; pagination: { totalItems: number } }>(`${ns(space)}/list/documents?page=${page}&limit=${limit}`, {
      body: { include: { content: false } },
    }),
  document: (space: string, id: string) =>
    api<Doc & { chunks?: Chunk[]; memories?: Memory[] }>(`${ns(space)}/document/${encodeURIComponent(id)}?include=chunks,memories`),
  deleteDocuments: (space: string, ids: string[]) => api(`${ns(space)}/document`, { method: "DELETE", body: { ids } }),
  memories: (space: string, forgotten: boolean, inference = false) =>
    // ponytail: one page of 500; paginate when a space outgrows it
    api<{ memories: Memory[] }>(`${ns(space)}/list/memories?limit=500&sort=updatedAt${inference ? "&inference=true" : ""}`, {
      body: { include: { forgotten } },
    }).then((r) => r.memories),
  restore: (space: string, id: string) => api<Memory>(`${ns(space)}/x/memories/${encodeURIComponent(id)}/restore`, { body: {} }),
  upload: (space: string, file: File, metadata?: Record<string, unknown>) => {
    const fd = new FormData();
    fd.append("file", file);
    if (metadata) fd.append("metadata", JSON.stringify(metadata));
    return api<{ id: string; status: Status }>(`${ns(space)}/document/file`, { body: fd });
  },
  graph: (space: string, limit = 300) => api<Graph>(`${ns(space)}/x/graph?limit=${limit}`),
  memory: (space: string, id: string) => api<MemoryDetail>(`${ns(space)}/memories/${encodeURIComponent(id)}`),
  forget: (space: string, ids: string[]) => api(`${ns(space)}/memories`, { method: "DELETE", body: { ids } }),
  search: (space: string, query: string, searchMode: "hybrid" | "memories" | "chunks") =>
    api<{ results: SearchResult[]; searchTime: number }>(`${ns(space)}/search`, {
      body: { query, searchMode, limit: 20, threshold: 0.3, include: { documents: true, related: false, forgotten: false } },
    }),
  review: (space: string, id: string, action: "approve" | "decline") =>
    api<Memory>(`${ns(space)}/x/memories/${encodeURIComponent(id)}/review`, { body: { action } }),
  reviewItems: (space: string) => api<{ items: ReviewItem[] }>(`${ns(space)}/x/review`).then((r) => r.items),
  resolve: (space: string, id: string, body: ReviewAction) =>
    api<{ status: string; memory: { id: string; memory: string } }>(`${ns(space)}/x/review/${encodeURIComponent(id)}`, { body }),
  explain: (space: string, id: string) => api<Explanation>(`${ns(space)}/x/memories/${encodeURIComponent(id)}/explain`),
  profile: (space: string) => api<{ profile: Profile }>(`${ns(space)}/profile`, { body: {} }).then((r) => r.profile),
};

// ---------- chat (SSE over POST) ----------

export type ChatMsg = { role: "user" | "assistant"; content: string };
export type ChatContext = {
  conversationId: string;
  memories: { id: string; memory: string; similarity: number }[];
  profile?: { static: Fact[]; dynamic: Fact[] };
};
export type ChatEvent =
  | { event: "context"; data: ChatContext }
  | { event: "delta"; data: { text: string } }
  | { event: "done"; data: { conversationId: string } }
  | { event: "error"; data: { error: string } };

/** POST /chat and yield parsed SSE events. EventSource can't POST, so this reads the body stream by hand. */
export async function* chat(
  body: { namespace: string; conversationId?: string; messages: ChatMsg[] },
  signal?: AbortSignal,
): AsyncGenerator<ChatEvent> {
  const res = await req("/chat", { body, signal });
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value.replace(/\r\n/g, "\n");
    let cut;
    while ((cut = buf.indexOf("\n\n")) >= 0) {
      const ev = parseSse(buf.slice(0, cut));
      buf = buf.slice(cut + 2);
      if (ev) yield ev;
    }
  }
  const tail = parseSse(buf);
  if (tail) yield tail;
}

export function parseSse(block: string): ChatEvent | null {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  if (!data.length) return null;
  try {
    return { event, data: JSON.parse(data.join("\n")) } as ChatEvent;
  } catch {
    return null;
  }
}

// ---------- tiny data hook ----------

export function useQuery<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data?: T; error?: Error; loading: boolean }>({ loading: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(fn, deps);
  const reload = useCallback(
    (quiet = false) => {
      if (!quiet) setState((s) => ({ ...s, loading: true }));
      return run().then(
        (data) => setState({ data, loading: false }),
        (error) => setState((s) => ({ ...s, error, loading: false })),
      );
    },
    [run],
  );
  useEffect(() => {
    setState({ loading: true });
    reload();
  }, [reload]);
  return { ...state, reload, setData: (data: T) => setState((s) => ({ ...s, data })) };
}

// ---------- formatting ----------

export const isUrl = (s: string) => /^https?:\/\/\S+$/i.test(s.trim());

export function timeAgo(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
