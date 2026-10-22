import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { sm, timeAgo, useQuery, type Memory, type MemoryDetail, type Related } from "../api";
import { Button } from "@/components/ui/button";
import { FilterMenu, type FilterGroup, type FilterValue } from "@/components/ui/filter-menu";
import { LayerStack } from "@/components/ui/layer-stack";
import { Empty, Icon, MemoryBadges, useApp, useForget } from "../shared";
import { SkeletonRows } from "./Documents";

const groups: FilterGroup[] = [
  { id: "kind", label: "Kind", options: [{ id: "static", label: "Static facts" }, { id: "dynamic", label: "Dynamic" }] },
  { id: "source", label: "Source", options: [{ id: "inference", label: "Inferred" }, { id: "extracted", label: "Extracted" }] },
  { id: "status", label: "Status", chipPrefix: "Show: ", options: [{ id: "forgotten", label: "Forgotten" }] },
];

function bucket(iso: string) {
  const days = (Date.now() - new Date(iso).getTime()) / 864e5;
  if (days < 1) return "Today";
  if (days < 7) return "This week";
  if (days < 31) return "This month";
  return "Earlier";
}

export const stackItems = [
  { title: "Documents", hint: "Notes and links you add", icon: "database" as const },
  { title: "Chunks", hint: "Split and embedded", icon: "bolt" as const },
  { title: "Memories", hint: "Atomic facts, versioned", icon: "spark" as const },
  { title: "Relations", hint: "updates · extends · derives", icon: "plug" as const },
  { title: "Profile", hint: "What stays true about you", icon: "pulse" as const },
];

export function Memories() {
  const { space, version, openComposer } = useApp();
  const [filters, setFilters] = useState<FilterValue>({});
  const showForgotten = !!filters.status?.includes("forgotten");
  const q = useQuery(() => sm.memories(space, showForgotten), [space, version, showForgotten]);
  const { hidden, forget, restore } = useForget(space, () => q.reload(true));

  const kind = filters.kind ?? [];
  const source = filters.source ?? [];
  const list = (q.data ?? []).filter(
    (m) =>
      !hidden.has(m.id) &&
      (showForgotten || !m.isForgotten) &&
      (!kind.length || kind.includes(m.isStatic ? "static" : "dynamic")) &&
      (!source.length || source.includes(m.isInference ? "inference" : "extracted")),
  );
  const grouped = Map.groupBy(list, (m) => bucket(m.system.updatedAt));
  const active = Object.values(filters).flat().length;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Memories</h1>
          <p>Atomic facts distilled from your documents. Newer facts update older ones.</p>
        </div>
        <div className="actions">
          <Button variant="secondary" icon={<Icon.filter />} popoverTarget="mem-filters" style={{ anchorName: "--filters" } as React.CSSProperties}>
            {active ? `Filters · ${active}` : "Filter"}
          </Button>
          <div id="mem-filters" popover="auto" className="pop" style={{ positionAnchor: "--filters" } as React.CSSProperties}>
            <FilterMenu groups={groups} value={filters} onChange={setFilters} defaultOpen={["kind", "source", "status"]} hints={false} />
          </div>
        </div>
      </header>

      {q.error && <div className="error-box">{q.error.message}</div>}

      {q.loading && !q.data ? (
        <div className="tray"><div className="card"><SkeletonRows /></div></div>
      ) : list.length === 0 ? (
        <div className="tray">
          <div className="card">
            <Empty
              art={<LayerStack items={stackItems} defaultIndex={2} />}
              title={active ? "Nothing matches these filters" : "No memories yet"}
              actions={!active && <Button icon={<Icon.plus />} onClick={openComposer}>Add a note</Button>}
            >
              {active ? "Try clearing a filter." : "Add a note or a link and the engine will distill it into memories in a few seconds."}
            </Empty>
          </div>
        </div>
      ) : (
        [...grouped].map(([label, ms]) => (
          <div className="tray" key={label}>
            <div className="tray-head">
              {label}
              <span className="right">{ms.length}</span>
            </div>
            <div className="card">
              {ms.map((m) => (
                <MemoryRow key={m.id} m={m} onForget={() => forget(m)} onRestore={() => restore(m)} />
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

export function MemoryRow({ m, onForget, onRestore }: { m: Memory; onForget?: () => void; onRestore?: () => void }) {
  return (
    <div className={`row link${m.isForgotten ? " forgotten" : ""}`}>
      <div className="grow">
        <Link className="memory-text stretch" to={`/memories/${encodeURIComponent(m.id)}`}>
          {m.memory}
        </Link>
        <div className="sub">
          <MemoryBadges m={m} />
          <span>{timeAgo(m.system.updatedAt)}</span>
        </div>
      </div>
      {m.isForgotten
        ? onRestore && (
            <span style={{ position: "relative", zIndex: 1 }}>
              <Button variant="secondary" size="sm" onClick={onRestore}>
                Restore
              </Button>
            </span>
          )
        : onForget && (
            <span className="hover-only">
              <Button variant="ghost" size="sm" onClick={onForget}>
                Forget
              </Button>
            </span>
          )}
    </div>
  );
}

const REL: Record<string, { label: string; tone: string }> = {
  updates: { label: "updates", tone: "warn" },
  extends: { label: "extends", tone: "accent" },
  derives: { label: "derives", tone: "violet" },
};

export function MemoryDetailPage() {
  const { id = "" } = useParams();
  const { space, toast, bump } = useApp();
  const q = useQuery(() => sm.memory(space, id), [space, id]);
  const [history, setHistory] = useState<MemoryDetail[]>([]);
  const m = q.data;

  // Version history: walk `updates` parents back to the first version
  useEffect(() => {
    if (!m) return;
    let stop = false;
    (async () => {
      const chain: MemoryDetail[] = [];
      let cur: MemoryDetail = m;
      for (let i = 0; i < 20; i++) {
        const prev = cur.included?.related?.parents.find((p) => p.relation === "updates");
        if (!prev) break;
        try {
          cur = await sm.memory(space, prev.id);
        } catch {
          break;
        }
        chain.push(cur);
      }
      if (!stop) setHistory(chain);
    })();
    return () => {
      stop = true;
    };
  }, [m, space]);

  const rel = m?.included?.related;
  const relations: (Related & { dir: "parent" | "child" })[] = [
    ...(rel?.parents ?? []).map((r) => ({ ...r, dir: "parent" as const })),
    ...(rel?.children ?? []).map((r) => ({ ...r, dir: "child" as const })),
  ];

  return (
    <div className="page">
      <Link to="/memories" className="crumb">
        <Icon.back /> Memories
      </Link>
      {q.error && <div className="error-box">{q.error.message}</div>}
      {!m ? (
        <div className="tray"><div className="card"><SkeletonRows n={2} /></div></div>
      ) : (
        <>
          <div className="tray">
            <div className="tray-head">
              <Icon.memory /> Memory
              <span className="right mono">{m.id}</span>
            </div>
            <div className={`card${m.isForgotten ? " forgotten" : ""}`}>
              <p className="hero-memory memory-text">{m.memory}</p>
              <div className="meta-grid">
                <MemoryBadges m={m} />
                <span className="pill">Updated {timeAgo(m.system.updatedAt)}</span>
                {m.included?.document && (
                  <Link className="pill" to={`/documents/${encodeURIComponent(m.included.document.id)}`}>
                    <Icon.doc /> {m.included.document.title || "Source document"}
                  </Link>
                )}
              </div>
            </div>
          </div>
          {m.isForgotten && (
            <div style={{ marginTop: 12, display: "flex", justifyContent: "flex-end" }}>
              <Button
                variant="secondary"
                size="sm"
                onClick={async () => {
                  try {
                    await sm.restore(space, m.id);
                    toast({ text: "Memory restored" });
                    bump();
                    q.reload(true);
                  } catch (e) {
                    toast({ text: `Restore failed: ${(e as Error).message}`, tone: "danger" });
                  }
                }}
              >
                Restore this memory
              </Button>
            </div>
          )}
          {!m.isForgotten && (
            <div style={{ marginTop: 12, display: "flex", justifyContent: "flex-end" }}>
              <Button
                variant="ghost"
                size="sm"
                onClick={async () => {
                  await sm.forget(space, [m.id]);
                  toast({ text: "Memory forgotten" });
                  bump();
                  q.reload(true);
                }}
              >
                Forget this memory
              </Button>
            </div>
          )}

          <h2 className="section-title">Version history</h2>
          <div className="tray">
            <div className="card timeline">
              {[m, ...history].map((v, i) => (
                <div className="tl-item" key={v.id} data-current={i === 0 || undefined}>
                  <span className="tl-dot">v{v.version ?? [m, ...history].length - i}</span>
                  <div>
                    {i === 0 ? (
                      <div className="memory-text">{v.memory}</div>
                    ) : (
                      <Link className="memory-text" to={`/memories/${encodeURIComponent(v.id)}`}>{v.memory}</Link>
                    )}
                    <div className="sub" style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>
                      {i === 0 ? "This version" : "Replaced"} · {timeAgo(v.system.updatedAt)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <h2 className="section-title">Related</h2>
          <div className="tray">
            <div className="card">
              {relations.length === 0 ? (
                <Empty title="No related memories">Relations appear when new facts update, extend or derive from this one.</Empty>
              ) : (
                relations.map((r) => (
                  <div className="row link" key={r.dir + r.id}>
                    <span className="pill" data-tone={REL[r.relation]?.tone} style={{ minWidth: 92, justifyContent: "center" }}>
                      {r.dir === "parent" ? `this ${REL[r.relation]?.label ?? r.relation}` : `${REL[r.relation]?.label ?? r.relation} this`}
                    </span>
                    <div className="grow">
                      <Link className="memory-text stretch" to={`/memories/${encodeURIComponent(r.id)}`}>
                        {r.memory}
                      </Link>
                    </div>
                    {r.version != null && r.version > 1 && <span className="pill">v{r.version}</span>}
                  </div>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
