import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { chat, load, save, timeAgo, type ChatContext, type ChatMsg } from "../api";
import { Button } from "@/components/ui/button";
import { MessageActions } from "@/components/ui/message-actions";
import { ThinkingLoader } from "@/components/ui/thinking-loader";
import { Icon, useApp } from "../shared";

type Turn = ChatMsg & { context?: ChatContext; pending?: boolean; error?: string };
type Conversation = { id: string; space: string; conversationId?: string; title: string; turns: Turn[]; updatedAt: string };

const KEY = "sm.chats";
function loadChats(): Conversation[] {
  try {
    return JSON.parse(load(KEY, "[]"));
  } catch {
    return [];
  }
}
// ponytail: whole history in one localStorage key, capped at 50 chats; move to the server's chat documents if it outgrows ~5MB
const saveChats = (cs: Conversation[]) => save(KEY, JSON.stringify(cs.slice(0, 50)));

export function Chat() {
  const { space, bump } = useApp();
  const [chats, setChats] = useState<Conversation[]>(loadChats);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const abort = useRef<AbortController | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const mine = chats.filter((c) => c.space === space);
  const active = mine.find((c) => c.id === activeId);
  const streaming = !!active?.turns.at(-1)?.pending;
  const lastContext = active?.turns.findLast((t) => t.context)?.context;

  useEffect(() => saveChats(chats), [chats]);
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [active?.turns]);
  useEffect(() => setActiveId(null), [space]);

  const update = (id: string, fn: (c: Conversation) => Conversation) =>
    setChats((cs) => cs.map((c) => (c.id === id ? fn(c) : c)));
  const patchLast = (id: string, fn: (t: Turn) => Turn) =>
    update(id, (c) => ({ ...c, turns: [...c.turns.slice(0, -1), fn(c.turns.at(-1)!)], updatedAt: new Date().toISOString() }));

  const send = async () => {
    const text = input.trim();
    if (!text || streaming) return;
    setInput("");
    let conv = active;
    if (!conv) {
      conv = { id: crypto.randomUUID(), space, title: text.slice(0, 60), turns: [], updatedAt: new Date().toISOString() };
      const fresh = conv;
      setChats((cs) => [fresh, ...cs]);
      setActiveId(conv.id);
    }
    const id = conv.id;
    const history: ChatMsg[] = [...conv.turns.filter((t) => !t.error).map(({ role, content }) => ({ role, content })), { role: "user", content: text }];
    update(id, (c) => ({ ...c, turns: [...c.turns, { role: "user", content: text }, { role: "assistant", content: "", pending: true }] }));

    const ctrl = new AbortController();
    abort.current = ctrl;
    try {
      for await (const ev of chat({ namespace: space, conversationId: conv.conversationId, messages: history }, ctrl.signal)) {
        if (ev.event === "context") {
          update(id, (c) => ({ ...c, conversationId: ev.data.conversationId }));
          patchLast(id, (t) => ({ ...t, context: ev.data }));
        } else if (ev.event === "delta") {
          patchLast(id, (t) => ({ ...t, content: t.content + ev.data.text }));
        } else if (ev.event === "done") {
          update(id, (c) => ({ ...c, conversationId: ev.data.conversationId ?? c.conversationId }));
        } else if (ev.event === "error") {
          patchLast(id, (t) => ({ ...t, error: ev.data.error }));
        }
      }
      bump(); // the conversation was saved as a document, so counts move
    } catch (e) {
      if ((e as Error).name !== "AbortError") patchLast(id, (t) => ({ ...t, error: (e as Error).message }));
    } finally {
      patchLast(id, (t) => ({ ...t, pending: false }));
      abort.current = null;
    }
  };

  return (
    <div className="chat">
      <aside className="chat-list" aria-label="Conversations">
        <Button variant="secondary" size="sm" icon={<Icon.plus />} onClick={() => setActiveId(null)} style={{ width: "100%" }}>
          New chat
        </Button>
        <div className="side-label" style={{ marginTop: 14 }}>Recent</div>
        {mine.length === 0 && <p className="chat-list-empty">Your chats in {space} show up here.</p>}
        {mine.map((c) => (
          <div key={c.id} className="chat-item" aria-current={c.id === activeId}>
            <button onClick={() => setActiveId(c.id)}>
              <span className="t">{c.title}</span>
              <span className="d">{timeAgo(c.updatedAt)}</span>
            </button>
            <button
              className="del"
              aria-label="Delete chat"
              onClick={() => {
                setChats((cs) => cs.filter((x) => x.id !== c.id));
                if (activeId === c.id) setActiveId(null);
              }}
            >
              <Icon.x />
            </button>
          </div>
        ))}
      </aside>

      <section className="chat-main">
        <div className="chat-scroll" ref={scroller}>
          {!active ? (
            <div className="chat-hello">
              <span className="brand-mark" style={{ width: 40, height: 40, borderRadius: 12 }}>
                <Icon.memory />
              </span>
              <h1>What's on your mind?</h1>
              <p>Answers draw on what you've saved in {space}. Every conversation is remembered too.</p>
              <div className="chat-suggest">
                {["What do you know about me?", "What changed recently?", "Summarize my notes on…"].map((s) => (
                  <button key={s} onClick={() => setInput(s)}>{s}</button>
                ))}
              </div>
            </div>
          ) : (
            <div className="chat-thread">
              {active.turns.map((t, i) =>
                t.role === "user" ? (
                  <div className="msg user" key={i}>{t.content}</div>
                ) : (
                  <div className="msg assistant" key={i} data-ui-message>
                    {t.context && t.context.memories.length > 0 && <UsedChips context={t.context} />}
                    {t.pending && !t.content && !t.error ? (
                      <ThinkingLoader size="sm" variant="plain" phases={["Recalling memories", "Reading your profile", "Thinking"]} interval={1400} />
                    ) : (
                      <div className="msg-text">{t.content}</div>
                    )}
                    {t.error && <div className="error-box" style={{ marginTop: 8 }}>{t.error}</div>}
                    {!t.pending && t.content && <MessageActions text={t.content} actions={["copy"]} />}
                  </div>
                ),
              )}
            </div>
          )}
        </div>

        <form
          className="chat-input tray"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <div className="card">
            <textarea
              rows={1}
              placeholder={`Ask your memory in ${space}…`}
              value={input}
              autoFocus
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            {streaming ? (
              <Button type="button" size="sm" variant="secondary" onClick={() => abort.current?.abort()}>
                Stop
              </Button>
            ) : (
              <Button type="submit" size="sm" icon={<Icon.send />} aria-label="Send" disabled={!input.trim()} />
            )}
          </div>
        </form>
      </section>

      <aside className="chat-rail" aria-label="Memories used">
        <div className="tray">
          <div className="tray-head">
            <Icon.memory /> Memories used
            <span className="right">{lastContext?.memories.length ?? 0}</span>
          </div>
          <div className="card">
            {!lastContext?.memories.length ? (
              <p className="rail-empty">The memories behind each answer appear here.</p>
            ) : (
              lastContext.memories.map((m) => (
                <Link key={m.id} className="rail-mem" to={`/memories/${encodeURIComponent(m.id)}`}>
                  <span>{m.memory}</span>
                  <span className="sim">
                    <span className="sim-bar"><i style={{ width: `${Math.round(m.similarity * 100)}%` }} /></span>
                  </span>
                </Link>
              ))
            )}
          </div>
        </div>
      </aside>
    </div>
  );
}

/** Collapsible "used N memories" chip above a reply; the rail shows the latest turn, this keeps older turns inspectable. */
function UsedChips({ context }: { context: ChatContext }) {
  return (
    <details className="used">
      <summary>
        <Icon.memory /> Used {context.memories.length} memor{context.memories.length === 1 ? "y" : "ies"}
      </summary>
      <ul>
        {context.memories.map((m) => (
          <li key={m.id}>
            <Link to={`/memories/${encodeURIComponent(m.id)}`}>{m.memory}</Link>
            <span className="pct">{Math.round(m.similarity * 100)}%</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
