import { useState } from "react";
import { Link } from "react-router";
import { sm, timeAgo, useQuery, type ReviewAction, type ReviewItem, type ReviewMemory } from "../api";
import { Button } from "@/components/ui/button";
import { DecisionInbox } from "@/components/ui/decision-inbox";
import { EmptyCalendar } from "@/components/ui/empty-calendar";
import { Empty, useApp } from "../shared";
import { SkeletonRows } from "./Documents";

// Review inbox (GET /x/review): inferences get a quick keep/forget; conflicts show both memories side by side with
// keep new / keep old / keep both / merge.
export function Review() {
  const { space, version, toast, bump } = useApp();
  const q = useQuery(() => sm.reviewItems(space), [space, version]);
  const items = q.data ?? [];
  const inferences = items.filter((i) => i.kind === "inference");
  const conflicts = items.filter((i) => i.kind !== "inference");

  const resolve = async (item: ReviewItem, body: ReviewAction, done: string) => {
    try {
      await sm.resolve(space, item.id, body);
      toast({ text: done });
      bump();
    } catch (e) {
      toast({ text: `Couldn't save: ${(e as Error).message}`, tone: "danger" });
    }
  };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Review</h1>
          <p>What the engine wouldn't decide on its own: facts that disagree, and conclusions it drew rather than read.</p>
        </div>
      </header>
      {q.error && <div className="error-box">{q.error.message}</div>}
      {q.loading && !q.data ? (
        <div className="tray"><div className="card"><SkeletonRows n={3} /></div></div>
      ) : items.length === 0 ? (
        <div className="tray">
          <div className="card">
            <Empty art={<EmptyCalendar />} title="Nothing to review">
              When two memories disagree, or the engine connects the dots between them, it waits here for your call.
            </Empty>
          </div>
        </div>
      ) : (
        <>
          {conflicts.length > 0 && (
            <>
              <h2 className="section-title">Disagreements · {conflicts.length}</h2>
              {conflicts.map((item) => <ConflictCard key={item.id} item={item} onResolve={resolve} />)}
            </>
          )}
          {inferences.length > 0 && (
            <>
              <h2 className="section-title">Inferred · {inferences.length}</h2>
              <DecisionInbox
                key={inferences.map((i) => i.id).join()}
                className="review-inbox"
                decisions={inferences.map((i, n) => ({
                  id: i.id,
                  title: i.memory.memory,
                  detail: i.from.length
                    ? `From: ${i.from.map((f) => f.memory).join(" · ")}`
                    : `Inferred · ${new Date(i.createdAt).toLocaleDateString()}`,
                  primary: "Keep",
                  secondary: "Forget",
                  collapsed: n > 2,
                }))}
                onDecide={(d, answer) => {
                  const item = inferences.find((i) => i.id === d.id)!;
                  void resolve(item, { action: answer === "primary" ? "approve" : "reject" }, answer === "primary" ? "Kept" : "Forgotten");
                }}
              />
            </>
          )}
        </>
      )}
    </div>
  );
}

const WHY: Record<string, string> = {
  low_confidence: "The engine thinks this replaces the existing memory, but isn't sure enough to change it on its own.",
  conflict: "These disagree, and the engine won't let the new one overwrite the existing one by itself.",
};

function ConflictCard({ item, onResolve }: { item: ReviewItem; onResolve: (item: ReviewItem, body: ReviewAction, done: string) => Promise<void> }) {
  const [merging, setMerging] = useState(false);
  const [text, setText] = useState(item.memory.memory);
  const [busy, setBusy] = useState(false);
  const act = async (body: ReviewAction, done: string) => {
    setBusy(true);
    await onResolve(item, body, done);
    setBusy(false);
  };

  return (
    <div className="tray conflict">
      <div className="tray-head">
        {WHY[item.kind] ?? "Needs your call."}
        <span className="right">{timeAgo(item.createdAt)}</span>
      </div>
      <div className="conflict-sides">
        <Side label="Existing" m={item.related} />
        <Side label="New" m={item.memory} />
      </div>
      {merging ? (
        <div className="card conflict-merge">
          <textarea className="textarea" value={text} onChange={(e) => setText(e.target.value)} aria-label="Merged memory" />
          <div className="conflict-actions">
            <Button variant="ghost" size="sm" onClick={() => setMerging(false)}>Cancel</Button>
            <Button size="sm" disabled={busy || !text.trim()} onClick={() => act({ action: "merge", content: text.trim() }, "Merged into one memory")}>
              Save merged memory
            </Button>
          </div>
        </div>
      ) : (
        <div className="conflict-actions">
          <Button size="sm" disabled={busy} onClick={() => act({ action: "keep_new" }, "The new memory replaces the old one")}>Use new</Button>
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => act({ action: "keep_old" }, "Kept the existing memory")}>Keep existing</Button>
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => act({ action: "keep_both" }, "Both memories stay")}>Keep both</Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => setMerging(true)}>Merge…</Button>
        </div>
      )}
    </div>
  );
}

const SPEAKER: Record<string, string> = { user: "You said", third_party: "Someone else said", assistant: "The assistant said", document: "A document says" };

function Side({ label, m }: { label: string; m: ReviewMemory | null }) {
  if (!m) return <div className="card conflict-side"><div className="sub">{label}: no longer exists</div></div>;
  return (
    <div className="card conflict-side">
      <div className="sub">{label}</div>
      <Link className="memory-text" to={`/memories/${encodeURIComponent(m.id)}`}>{m.memory}</Link>
      {m.quote && <blockquote className="quote">{SPEAKER[m.speaker ?? ""] ?? "Source"}: “{m.quote}”</blockquote>}
      <div className="sub">
        {m.validFrom && <span>since {m.validFrom.slice(0, 10)}</span>}
        {m.confidence != null && <span>confidence {m.confidence.toFixed(2)}</span>}
        {m.pinned && <span className="pill" data-tone="accent">pinned</span>}
        {m.document && <Link to={`/documents/${encodeURIComponent(m.document.id)}`}>{m.document.title || "source"}</Link>}
      </div>
    </div>
  );
}
