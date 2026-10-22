import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationLinkDatum, type SimulationNodeDatum } from "d3-force";
import { sm, useQuery, type GraphEdge, type GraphNode } from "../api";
import { Button } from "@/components/ui/button";
import { LayerStack } from "@/components/ui/layer-stack";
import { Skeleton } from "@/components/ui/shimmer-loader";
import { Empty, useApp } from "../shared";
import { stackItems } from "./Memories";

type N = GraphNode & SimulationNodeDatum;
type L = SimulationLinkDatum<N> & { relation: GraphEdge["relation"] };

const EDGE: Record<GraphEdge["relation"], { color: string; label: string }> = {
  updates: { color: "var(--warn)", label: "updates" },
  extends: { color: "var(--accent)", label: "extends" },
  derives: { color: "var(--violet)", label: "derives" },
  source: { color: "var(--line)", label: "from document" },
};
const radius = (n: N) => (n.type === "document" ? 9 : 4.5);

export function Graph() {
  const { space, version } = useApp();
  const q = useQuery(() => sm.graph(space), [space, version]);
  const nav = useNavigate();
  const svg = useRef<SVGSVGElement>(null);
  const [, setTick] = useState(0);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [hover, setHover] = useState<N | null>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);

  // Fresh copies: d3 mutates nodes (x/y) and links (source/target become objects)
  const { nodes, links } = useMemo(() => {
    const nodes: N[] = (q.data?.nodes ?? []).map((n) => ({ ...n }));
    const ids = new Set(nodes.map((n) => n.id));
    const links: L[] = (q.data?.edges ?? []).filter((e) => ids.has(e.source) && ids.has(e.target)).map((e) => ({ ...e }));
    return { nodes, links };
  }, [q.data]);

  const fit = () => {
    const el = svg.current;
    if (!el || !nodes.length) return;
    const xs = nodes.map((n) => n.x ?? 0), ys = nodes.map((n) => n.y ?? 0);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const { width, height } = el.getBoundingClientRect();
    const k = Math.min(2, 0.85 * Math.min(width / Math.max(1, x1 - x0 + 40), height / Math.max(1, y1 - y0 + 40)));
    setView({ k, x: width / 2 - ((x0 + x1) / 2) * k, y: height / 2 - ((y0 + y1) / 2) * k });
  };

  useEffect(() => {
    if (!nodes.length) return;
    const sim = forceSimulation(nodes)
      .force("link", forceLink<N, L>(links).id((n) => n.id).distance((l) => (l.relation === "source" ? 46 : 30)).strength(0.6))
      .force("charge", forceManyBody<N>().strength((n) => (n.type === "document" ? -160 : -40)))
      .force("collide", forceCollide<N>((n) => radius(n) + 3))
      .force("x", forceX(0).strength(0.04))
      .force("y", forceY(0).strength(0.04));

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      // No motion: settle off-screen, draw once
      sim.stop();
      sim.tick(Math.ceil(Math.log(sim.alphaMin()) / Math.log(1 - sim.alphaDecay())));
      setTick((t) => t + 1);
      fit();
    } else {
      let fitted = false;
      sim.on("tick", () => {
        setTick((t) => t + 1);
        if (!fitted && sim.alpha() < 0.3) {
          fitted = true;
          fit();
        }
      });
    }
    return () => void sim.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, links]);

  // Wheel zoom around the pointer; React's onWheel is passive, so attach natively
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      setView((v) => {
        const k = Math.min(6, Math.max(0.2, v.k * Math.exp(-e.deltaY * 0.0015)));
        return { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [q.data]);

  const counts = {
    docs: nodes.filter((n) => n.type === "document").length,
    mems: nodes.length - nodes.filter((n) => n.type === "document").length,
  };
  const neighbours = useMemo(() => {
    if (!hover) return null;
    const s = new Set([hover.id]);
    for (const l of links) {
      const a = (l.source as N).id, b = (l.target as N).id;
      if (a === hover.id) s.add(b);
      if (b === hover.id) s.add(a);
    }
    return s;
  }, [hover, links]);

  // document node ids come back as "doc:<id>" so they can't collide with memory ids
  const open = (n: N) =>
    nav(n.type === "document" ? `/documents/${encodeURIComponent(n.id.replace(/^doc:/, ""))}` : `/memories/${encodeURIComponent(n.id)}`);

  return (
    <div className="graph-page">
      <header className="graph-head">
        <div>
          <h1>Graph</h1>
          <p>{q.data ? `${counts.mems} memories · ${counts.docs} documents · ${links.length} links` : "Mapping your memory…"}</p>
        </div>
        <div className="actions">
          <Button variant="secondary" size="sm" onClick={fit} disabled={!nodes.length}>
            Fit
          </Button>
          <Button variant="ghost" size="sm" onClick={() => q.reload()}>
            Refresh
          </Button>
        </div>
      </header>

      <div className="graph-frame tray">
        <div className="card">
          {q.error ? (
            <div className="error-box" style={{ margin: 16 }}>{q.error.message}</div>
          ) : q.loading && !q.data ? (
            <div style={{ display: "grid", placeItems: "center", height: "100%" }}>
              <Skeleton width={180} height={180} circle />
            </div>
          ) : !nodes.length ? (
            <Empty art={<LayerStack items={stackItems} defaultIndex={3} />} title="Nothing to map yet">
              Add a few notes and their memories, and the links between them, will appear here.
            </Empty>
          ) : (
            <svg
              ref={svg}
              className="graph-svg"
              role="img"
              aria-label={`Memory graph with ${nodes.length} nodes`}
              onPointerDown={(e) => {
                drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
              }}
              onPointerMove={(e) => {
                const d = drag.current;
                if (!d) return;
                if (!d.moved && Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 3) {
                  d.moved = true;
                  // capture only once it's a drag, so plain clicks still land on nodes
                  e.currentTarget.setPointerCapture(e.pointerId);
                }
                setView((v) => ({ ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }));
              }}
              onPointerUp={() => setTimeout(() => (drag.current = null))}
            >
              <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
                {links.map((l, i) => {
                  const s = l.source as N, t = l.target as N;
                  const dim = neighbours && !(neighbours.has(s.id) && neighbours.has(t.id));
                  return (
                    <line
                      key={i}
                      x1={s.x} y1={s.y} x2={t.x} y2={t.y}
                      stroke={EDGE[l.relation]?.color ?? "var(--line)"}
                      strokeWidth={(l.relation === "source" ? 1 : 1.6) / Math.sqrt(view.k)}
                      opacity={dim ? 0.15 : 1}
                    />
                  );
                })}
                {nodes.map((n) => {
                  const dim = (neighbours && !neighbours.has(n.id)) || n.isLatest === false;
                  return (
                    <circle
                      key={n.id}
                      className="graph-node"
                      data-type={n.type}
                      data-inference={n.isInference || undefined}
                      cx={n.x}
                      cy={n.y}
                      r={radius(n)}
                      opacity={dim ? 0.3 : 1}
                      tabIndex={0}
                      aria-label={`${n.type}: ${n.label}`}
                      onPointerEnter={() => setHover(n)}
                      onPointerLeave={() => setHover(null)}
                      onFocus={() => setHover(n)}
                      onBlur={() => setHover(null)}
                      onClick={() => !drag.current?.moved && open(n)}
                      onKeyDown={(e) => e.key === "Enter" && open(n)}
                    />
                  );
                })}
              </g>
            </svg>
          )}
          {hover && (
            <div
              className="graph-tip"
              style={{ left: (hover.x ?? 0) * view.k + view.x, top: (hover.y ?? 0) * view.k + view.y - radius(hover) * view.k - 10 }}
            >
              <span className="pill" data-tone={hover.type === "document" ? undefined : hover.isInference ? "violet" : "ok"}>
                {hover.type === "document" ? "Document" : hover.isInference ? "Inference" : "Memory"}
                {hover.version && hover.version > 1 ? ` · v${hover.version}` : ""}
              </span>
              <span>{hover.label}</span>
            </div>
          )}
          {nodes.length > 0 && (
            <div className="graph-legend" aria-hidden="true">
              <span><i className="dot doc" /> Document</span>
              <span><i className="dot mem" /> Memory</span>
              <span><i className="dot inf" /> Inference</span>
              {(["updates", "extends", "derives"] as const).map((r) => (
                <span key={r}><i className="bar" style={{ background: EDGE[r].color }} /> {r}</span>
              ))}
              <span className="hint">scroll to zoom · drag to pan</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
