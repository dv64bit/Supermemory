import { useState } from "react";
import { Link } from "react-router";
import { sm, type SearchResult } from "../api";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { ThinkingLoader } from "@/components/ui/thinking-loader";
import { Empty, Icon, useApp } from "../shared";

type Mode = "hybrid" | "memories" | "chunks";

export function Search() {
  const { space } = useApp();
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<Mode>("hybrid");
  const [state, setState] = useState<{ loading?: boolean; results?: SearchResult[]; time?: number; error?: string; q?: string }>({});

  const run = async (m = mode) => {
    const q = query.trim();
    if (!q) return;
    setState((s) => ({ ...s, loading: true, error: undefined }));
    try {
      const r = await sm.search(space, q, m);
      setState({ results: r.results, time: r.searchTime, q });
    } catch (e) {
      setState({ error: (e as Error).message });
    }
  };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Search</h1>
          <p>Ask in your own words. Hybrid blends distilled memories with the raw passages they came from.</p>
        </div>
      </header>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          run();
        }}
        style={{ display: "grid", gap: 12 }}
      >
        <div className="search-box">
          <Icon.search />
          <input className="input" autoFocus placeholder={`Search ${space}…`} value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search query" />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, minHeight: 34 }}>
          <SegmentedControl<Mode>
            aria-label="Search mode"
            value={mode}
            onChange={(m) => {
              setMode(m);
              if (state.results) run(m);
            }}
            options={[
              { value: "hybrid", label: "Hybrid" },
              { value: "memories", label: "Memories" },
              { value: "chunks", label: "Chunks" },
            ]}
          />
          {state.loading && <ThinkingLoader size="sm" phases={["Embedding query", "Searching memories", "Ranking results"]} interval={700} />}
          {!state.loading && state.results && (
            <span style={{ color: "var(--muted)", fontSize: 13, marginLeft: "auto" }}>
              {state.results.length} results · {state.time} ms
            </span>
          )}
        </div>
      </form>

      {state.error && <div className="error-box" style={{ marginTop: 16 }}>{state.error}</div>}

      {state.results && (
        <div className="tray" style={{ marginTop: 20, opacity: state.loading ? 0.5 : 1, transition: "opacity 200ms ease" }}>
          <div className="tray-head">Results for “{state.q}”</div>
          <div className="card">
            {state.results.length === 0 ? (
              <Empty title="Nothing close enough">Try different words, or switch to Chunks to search the raw text.</Empty>
            ) : (
              state.results.map((r) => <ResultRow key={(r.memory ? "m" : "c") + r.id} r={r} />)
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ResultRow({ r }: { r: SearchResult }) {
  const isMemory = r.memory != null;
  const doc = r.included?.document;
  const pct = Math.round(r.similarity * 100);
  return (
    <div className="row link" style={{ alignItems: "flex-start" }}>
      <span className="type-icon">{isMemory ? <Icon.memory /> : <Icon.doc />}</span>
      <div className="grow">
        {isMemory ? (
          <Link className="memory-text stretch" to={`/memories/${encodeURIComponent(r.id)}`}>{r.memory}</Link>
        ) : (
          <div className="memory-text" style={{ color: "var(--text)", fontSize: 13, display: "-webkit-box", WebkitLineClamp: 4, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
            {r.chunk}
          </div>
        )}
        <div className="sub">
          <span className="pill" data-tone={isMemory ? "ok" : undefined}>{isMemory ? "Memory" : "Chunk"}</span>
          {r.isInference && <span className="pill" data-tone="violet">Inference</span>}
          {doc && (
            <Link to={`/documents/${encodeURIComponent(doc.id)}`} style={{ position: "relative", zIndex: 1, textDecoration: "underline", textDecorationColor: "var(--line)" }}>
              {doc.title || "Source document"}
            </Link>
          )}
        </div>
      </div>
      <span className="sim" title="Similarity">
        <span className="sim-bar"><i style={{ width: `${Math.max(4, pct)}%` }} /></span>
        <span style={{ fontSize: 12, color: "var(--muted)", width: 30, textAlign: "right" }}>{pct}%</span>
      </span>
    </div>
  );
}
