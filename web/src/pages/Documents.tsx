import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { sm, timeAgo, useQuery, type Doc } from "../api";
import { Button } from "@/components/ui/button";
import { NumberTicker } from "@/components/ui/number-ticker";
import { Skeleton } from "@/components/ui/shimmer-loader";
import { SideFolder } from "@/components/ui/side-folder";
import { Empty, Icon, MemoryBadges, StatusPill, TypeIcon, docTitle, useApp } from "../shared";

const settled = (d: Doc) => (d.system.status === "done" || d.system.status === "failed") && (d.system.dreamingStatus ?? "done") === "done";

export function Documents() {
  const { space, version, bump, openComposer, toast } = useApp();
  const q = useQuery(() => sm.documents(space), [space, version]);
  const [leaving, setLeaving] = useState<Set<string>>(new Set());
  const docs = q.data?.documents ?? [];
  const pending = docs.some((d) => !settled(d));

  // Live polling while anything is still processing
  useEffect(() => {
    if (!pending) return;
    const t = window.setInterval(() => q.reload(true), 2000);
    return () => window.clearInterval(t);
  }, [pending, q.reload]);

  const remove = async (d: Doc) => {
    if (!window.confirm(`Delete “${docTitle(d)}” and its memories? This can't be undone.`)) return;
    setLeaving((s) => new Set(s).add(d.id));
    try {
      await sm.deleteDocuments(space, [d.id]);
      toast({ text: "Document deleted" });
      window.setTimeout(bump, 300);
    } catch (e) {
      setLeaving((s) => {
        const n = new Set(s);
        n.delete(d.id);
        return n;
      });
      toast({ text: `Delete failed: ${(e as Error).message}`, tone: "danger" });
    }
  };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Documents</h1>
          <p>Everything you've added to {space}. Each one is chunked, embedded and distilled into memories.</p>
        </div>
        <div className="actions">
          <Button variant="secondary" icon={<Icon.plus />} onClick={openComposer}>
            Add
          </Button>
        </div>
      </header>

      {q.error && <div className="error-box">{q.error.message}</div>}

      <div className="tray">
        <div className="tray-head">
          <Icon.doc />
          {q.data ? `${q.data.pagination.totalItems} document${q.data.pagination.totalItems === 1 ? "" : "s"}` : "Loading"}
          {pending && <span className="right pill" data-tone="accent"><i className="live" />Processing</span>}
        </div>
        <div className="card">
          {q.loading && !q.data ? (
            <SkeletonRows />
          ) : docs.length === 0 ? (
            <Empty
              art={<SideFolder />}
              title="No documents yet"
              actions={<Button icon={<Icon.plus />} onClick={openComposer}>Add your first note</Button>}
            >
              Drop in a note, a thought or a link. It turns into small, searchable memories.
            </Empty>
          ) : (
            docs.map((d) => (
              <div key={d.id} className={`row link${leaving.has(d.id) ? " leaving" : ""}`}>
                <TypeIcon type={d.type} url={d.url} chat={d.metadata?.source === "chat"} />
                <div className="grow">
                  <Link className="title stretch" to={`/documents/${encodeURIComponent(d.id)}`}>{docTitle(d)}</Link>
                  <div className="sub">
                    <span>{d.type}</span>·<span>{timeAgo(d.system.createdAt)}</span>
                    {Array.isArray(d.metadata?.tags) && (d.metadata.tags as string[]).map((t) => <span key={t} className="pill">#{t}</span>)}
                  </div>
                </div>
                <StatusPill doc={d} />
                <span className="pill" title="Memories" style={{ minWidth: 52, justifyContent: "center" }}>
                  <Icon.memory />
                  <NumberTicker value={d.system.memoryCount ?? 0} />
                </span>
                <span className="hover-only">
                  <Button variant="ghost" size="sm" icon={<Icon.trash />} aria-label="Delete document" onClick={() => remove(d)} />
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

export function SkeletonRows({ n = 4 }: { n?: number }) {
  return Array.from({ length: n }, (_, i) => (
    <div className="row" key={i}>
      <Skeleton width={34} height={34} radius={10} />
      <div className="grow" style={{ display: "grid", gap: 6 }}>
        <Skeleton width={`${60 - i * 8}%`} height={12} radius={6} />
        <Skeleton width="30%" height={10} radius={5} />
      </div>
    </div>
  ));
}

export function DocumentDetail() {
  const { id = "" } = useParams();
  const { space, bump, toast } = useApp();
  const nav = useNavigate();
  const q = useQuery(() => sm.document(space, id), [space, id]);
  const d = q.data;
  const pending = d && !settled(d);

  useEffect(() => {
    if (!pending) return;
    const t = window.setInterval(() => q.reload(true), 2000);
    return () => window.clearInterval(t);
  }, [pending, q.reload]);

  return (
    <div className="page">
      <Link to="/documents" className="crumb">
        <Icon.back /> Documents
      </Link>
      {q.error && <div className="error-box">{q.error.message}</div>}
      {!d ? (
        <div className="tray"><div className="card"><SkeletonRows n={3} /></div></div>
      ) : (
        <>
          <header className="page-head">
            <div style={{ minWidth: 0 }}>
              <h1 style={{ overflowWrap: "anywhere" }}>{docTitle(d)}</h1>
              <p>
                {d.type} · added {timeAgo(d.system.createdAt)}
                {d.url && (
                  <>
                    {" · "}
                    <a href={d.url} target="_blank" rel="noreferrer" style={{ textDecoration: "underline" }}>open source</a>
                  </>
                )}
              </p>
            </div>
            <div className="actions">
              <StatusPill doc={d} />
              <Button
                variant="destructive"
                size="sm"
                icon={<Icon.trash />}
                onClick={async () => {
                  if (!window.confirm("Delete this document and its memories?")) return;
                  await sm.deleteDocuments(space, [d.id]);
                  toast({ text: "Document deleted" });
                  bump();
                  nav("/documents");
                }}
              >
                Delete
              </Button>
            </div>
          </header>

          <div className="tray">
            <div className="tray-head">
              <Icon.memory /> Memories extracted
              <span className="right">{d.memories?.length ?? 0}</span>
            </div>
            <div className="card">
              {!d.memories?.length ? (
                <Empty title={pending ? "Memories are forming…" : "No memories from this document"}>
                  {pending ? "This updates on its own." : "The extractor found nothing worth keeping, or the LLM isn't running."}
                </Empty>
              ) : (
                d.memories.map((m) => (
                  <Link key={m.id} to={`/memories/${encodeURIComponent(m.id)}`} className={`row${m.isForgotten ? " forgotten" : ""}`}>
                    <div className="grow">
                      <div className="memory-text">{m.memory}</div>
                      <div className="sub"><MemoryBadges m={m} /></div>
                    </div>
                  </Link>
                ))
              )}
            </div>
          </div>

          <div className="tray">
            <div className="tray-head">
              <Icon.doc /> Chunks <span className="right">{d.chunks?.length ?? 0}</span>
            </div>
            <div className="card">
              {!d.chunks?.length ? (
                <Empty title={pending ? "Chunking…" : "No chunks"} />
              ) : (
                d.chunks.map((c) => (
                  <div className="chunk" key={c.id}>
                    <span className="idx">#{c.position}</span>
                    {c.content}
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
