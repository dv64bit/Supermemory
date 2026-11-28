import { useEffect, useState } from "react";
import { save, settings, sm, timeAgo, useQuery, type Redream } from "../api";
import { Button } from "@/components/ui/button";
import { useApp } from "../shared";

export function Settings() {
  const { toast, bump } = useApp();
  const [key, setKey] = useState(settings.key);
  const [base, setBase] = useState(settings.base);
  const [testing, setTesting] = useState(false);

  const apply = async () => {
    save("sm.apiKey", key.trim());
    save("sm.baseUrl", base.trim() || "/api");
    setTesting(true);
    try {
      const spaces = await sm.spaces();
      toast({ text: `Connected · ${spaces.length} space${spaces.length === 1 ? "" : "s"}` });
      bump();
    } catch (e) {
      toast({ text: `Saved, but the server said: ${(e as Error).message}`, tone: "danger" });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Settings</h1>
          <p>Where this UI finds your memory server. Stored in this browser only.</p>
        </div>
      </header>
      <form
        className="tray"
        onSubmit={(e) => {
          e.preventDefault();
          apply();
        }}
      >
        <div className="tray-head">Connection</div>
        <div className="card settings-card">
          <div className="field">
            <label htmlFor="key">API key</label>
            <input id="key" className="input" type="password" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" />
            <span className="hint">Sent as Authorization: Bearer on every request. Matches SUPERMEM_API_KEY on the server.</span>
          </div>
          <div className="field">
            <label htmlFor="base">Base URL</label>
            <input id="base" className="input" value={base} onChange={(e) => setBase(e.target.value)} placeholder="/api" />
            <span className="hint">/api goes through the Vite dev proxy to 127.0.0.1:6767. Use a full URL for a remote server (it must allow CORS).</span>
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Button type="submit" loading={testing}>Save and test</Button>
          </div>
        </div>
      </form>
      <RedreamCard />
    </div>
  );
}

/**
 * Re-dream: replay every document of the current space through the current pipeline into a shadow copy, show what
 * would change, then swap it in (old memories go to an archive space) or discard it.
 */
function RedreamCard() {
  const { space, toast, bump } = useApp();
  const q = useQuery(() => sm.redream(space), [space]);
  const r = q.data;
  const [busy, setBusy] = useState(false);
  // Poll while it runs; a replay on a local model can take a while.
  useEffect(() => {
    if (r?.status !== "running") return;
    const t = window.setInterval(() => q.reload(true), 2000);
    return () => window.clearInterval(t);
  }, [r?.status]);

  const act = async (f: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await f();
      toast({ text: done });
      bump();
      q.reload(true);
    } catch (e) {
      toast({ text: (e as Error).message, tone: "danger" });
    } finally {
      setBusy(false);
    }
  };
  const start = () => act(() => sm.startRedream(space), "Re-dream started");

  return (
    <div className="tray" style={{ marginTop: 16 }}>
      <div className="tray-head">Re-dream “{space}”</div>
      <div className="card settings-card">
        <p className="hint" style={{ margin: 0 }}>
          Re-reads every document in this space with the current prompts and model, into a separate copy. You see what would
          change before anything does. Memories you edited and decisions you made in Review are kept.
        </p>
        {q.error && <div className="error-box">{q.error.message}</div>}
        {!r || r.status === "swapped" || r.status === "discarded" ? (
          <>
            {r?.status === "swapped" && <p className="hint">Last re-dream swapped in {timeAgo(r.finishedAt ?? r.startedAt)}. Old memories are in the space “{r.archive}”.</p>}
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <Button onClick={start} loading={busy}>Start re-dream</Button>
            </div>
          </>
        ) : r.status === "running" ? (
          <div className="field">
            <label>Re-reading documents: {r.done} of {r.total}</label>
            <progress max={r.total || 1} value={r.done} style={{ width: "100%" }} />
          </div>
        ) : r.status === "ready" && r.report ? (
          <RedreamReport r={r} busy={busy}
            onSwap={() => act(() => sm.swapRedream(space), "Swapped in. The old memories are archived.")}
            onDiscard={() => act(() => sm.discardRedream(space), "Discarded")} />
        ) : (
          <>
            <div className="error-box">Re-dream {r.status}{r.error ? `: ${r.error}` : ""}</div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              {r.status === "failed" && <Button variant="ghost" onClick={() => act(() => sm.discardRedream(space), "Discarded")} disabled={busy}>Discard</Button>}
              <Button onClick={start} loading={busy}>Start again</Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function RedreamReport({ r, busy, onSwap, onDiscard }: { r: Redream; busy: boolean; onSwap: () => void; onDiscard: () => void }) {
  const rep = r.report!;
  const none = !rep.added.length && !rep.removed.length && !rep.changed.length;
  return (
    <>
      <p style={{ margin: 0 }}>
        {none ? "Nothing would change." : `${rep.changed.length} changed · ${rep.added.length} new · ${rep.removed.length} gone`}
        <span className="hint"> · {rep.before} memories now, {rep.after} after · {r.failed ? `${r.failed} document(s) failed · ` : ""}{rep.openReviews} to review after</span>
      </p>
      {rep.changed.length > 0 && (
        <div className="redream-list">
          <div className="hint">Changed</div>
          {rep.changed.map((c) => (
            <div key={c.after.id} className="memory-text"><s style={{ color: "var(--muted)" }}>{c.before.memory}</s> → {c.after.memory}</div>
          ))}
        </div>
      )}
      {rep.added.length > 0 && (
        <div className="redream-list">
          <div className="hint">New</div>
          {rep.added.map((m) => <div key={m.id} className="memory-text">+ {m.memory}</div>)}
        </div>
      )}
      {rep.removed.length > 0 && (
        <div className="redream-list">
          <div className="hint">Gone</div>
          {rep.removed.map((m) => <div key={m.id} className="memory-text" style={{ color: "var(--muted)" }}>− {m.memory}</div>)}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <Button variant="ghost" onClick={onDiscard} disabled={busy}>Discard</Button>
        <Button onClick={onSwap} loading={busy} disabled={none}>Swap in</Button>
      </div>
    </>
  );
}
