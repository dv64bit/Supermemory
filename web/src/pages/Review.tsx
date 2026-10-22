import { sm, useQuery } from "../api";
import { DecisionInbox } from "@/components/ui/decision-inbox";
import { EmptyCalendar } from "@/components/ui/empty-calendar";
import { Empty, useApp } from "../shared";
import { SkeletonRows } from "./Documents";

export function Review() {
  const { space, version, toast } = useApp();
  const q = useQuery(() => sm.memories(space, false, true).then((ms) => ms.filter((m) => !m.isForgotten)), [space, version]);
  const items = q.data ?? [];

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Review</h1>
          <p>Memories the engine inferred rather than read. Keep the ones that are true, forget the rest.</p>
        </div>
      </header>
      {q.error && <div className="error-box">{q.error.message}</div>}
      {q.loading && !q.data ? (
        <div className="tray"><div className="card"><SkeletonRows n={3} /></div></div>
      ) : items.length === 0 ? (
        <div className="tray">
          <div className="card">
            <Empty art={<EmptyCalendar />} title="Nothing to review">
              When the engine connects the dots between your memories, its guesses wait here for a yes or no.
            </Empty>
          </div>
        </div>
      ) : (
        <DecisionInbox
          key={items.map((m) => m.id).join()}
          className="review-inbox"
          decisions={items.map((m, i) => ({
            id: m.id,
            title: m.memory,
            detail: `Inferred${m.version && m.version > 1 ? ` · v${m.version}` : ""} · ${new Date(m.system.createdAt).toLocaleDateString()}`,
            primary: "Keep",
            secondary: "Forget",
            collapsed: i > 2,
          }))}
          onDecide={(d, answer) => {
            sm.review(space, d.id, answer === "primary" ? "approve" : "decline").catch((e) => {
              // Older servers have no review route: decline falls back to a plain forget, keep is a no-op
              if (answer === "secondary") return sm.forget(space, [d.id]);
              if (e.status !== 404) throw e;
            }).catch((e) => toast({ text: `Couldn't save: ${e.message}`, tone: "danger" }));
          }}
        />
      )}
    </div>
  );
}
