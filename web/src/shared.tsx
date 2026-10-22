import { createContext, use, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { sm, type Doc, type Memory, type Status } from "./api";

// ---------- app context: current space + refresh signal + composer + toasts ----------

export type Toast = { id: number; text: string; tone?: "danger"; action?: { label: string; onClick: () => void } };

export type AppCtx = {
  space: string;
  setSpace: (s: string) => void;
  /** bumps after anything changes server data, so screens re-fetch */
  version: number;
  bump: () => void;
  openComposer: () => void;
  toast: (t: Omit<Toast, "id">, ms?: number) => void;
};
export const App = createContext<AppCtx>(null!);
export const useApp = () => use(App);

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const toast = useCallback((t: Omit<Toast, "id">, ms = 5000) => {
    const id = nextId.current++;
    setToasts((ts) => [...ts.slice(-2), { ...t, id }]);
    window.setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), ms);
  }, []);
  const dismiss = (id: number) => setToasts((ts) => ts.filter((x) => x.id !== id));
  const view = (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div className="toast" key={t.id} data-tone={t.tone}>
          <span>{t.text}</span>
          {t.action && (
            <button
              onClick={() => {
                t.action!.onClick();
                dismiss(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
  return { toast, view };
}

/** Forget now; Undo calls the restore endpoint. */
export function useForget(space: string, onChange?: () => void) {
  const { toast } = useApp();
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const show = (id: string) =>
    setHidden((h) => {
      const n = new Set(h);
      n.delete(id);
      return n;
    });
  const forget = (m: Memory) => {
    setHidden((h) => new Set(h).add(m.id));
    sm.forget(space, [m.id]).then(
      () =>
        toast({
          text: "Memory forgotten",
          action: {
            label: "Undo",
            onClick: () =>
              sm.restore(space, m.id).then(
                () => (show(m.id), onChange?.()),
                (e) => toast({ text: `Restore failed: ${e.message}`, tone: "danger" }),
              ),
          },
        }),
      (e) => {
        show(m.id);
        toast({ text: `Forget failed: ${e.message}`, tone: "danger" });
      },
    );
  };
  const restore = (m: Memory) =>
    sm.restore(space, m.id).then(
      () => (toast({ text: "Memory restored" }), onChange?.()),
      (e) => toast({ text: `Restore failed: ${e.message}`, tone: "danger" }),
    );
  return { hidden, forget, restore };
}

// ---------- theme ----------

export type Theme = "light" | "dark" | "system";
export function useTheme(initial: Theme) {
  const [theme, setTheme] = useState<Theme>(initial);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () =>
      document.documentElement.classList.toggle("dark", theme === "dark" || (theme === "system" && mq.matches));
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [theme]);
  return [theme, setTheme] as const;
}

// ---------- small pieces ----------

const STATUS: Record<Status, { label: string; tone?: string }> = {
  queued: { label: "Queued" },
  extracting: { label: "Extracting", tone: "accent" },
  chunking: { label: "Chunking", tone: "accent" },
  embedding: { label: "Embedding", tone: "accent" },
  indexing: { label: "Indexing", tone: "accent" },
  done: { label: "Ready", tone: "ok" },
  failed: { label: "Failed", tone: "danger" },
};

export function StatusPill({ doc }: { doc: Doc }) {
  const s = doc.system.status;
  if (s === "done" && doc.system.dreamingStatus && doc.system.dreamingStatus !== "done")
    return (
      <span className="pill" data-tone="violet">
        <i className="live" />
        Dreaming
      </span>
    );
  const { label, tone } = STATUS[s] ?? { label: s };
  return (
    <span className="pill" data-tone={tone}>
      {s !== "done" && s !== "failed" && <i className="live" />}
      {label}
    </span>
  );
}

export function MemoryBadges({ m }: { m: Pick<Memory, "isInference" | "isStatic" | "version" | "isForgotten" | "isLatest"> }) {
  return (
    <>
      {m.isInference && (
        <span className="pill" data-tone="violet">
          Inference
        </span>
      )}
      {m.isStatic && (
        <span className="pill" data-tone="accent">
          Static
        </span>
      )}
      {m.version != null && m.version > 1 && <span className="pill">v{m.version}</span>}
      {m.isLatest === false && <span className="pill">Superseded</span>}
      {m.isForgotten && (
        <span className="pill" data-tone="danger">
          Forgotten
        </span>
      )}
    </>
  );
}

export function Empty({ art, title, children, actions }: { art?: ReactNode; title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="empty">
      {art && <div className="art">{art}</div>}
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}

export const docTitle = (d: Pick<Doc, "title" | "url" | "content" | "summary">) =>
  d.title || d.url || (d.summary ?? d.content)?.split("\n")[0]?.slice(0, 120) || "Untitled note";

// ---------- icons (inline, 24-grid, stroke) ----------

const I = ({ c, ...p }: { c: ReactNode } & React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" {...p}>
    {c}
  </svg>
);
export const Icon = {
  memory: () => <I c={<><circle cx="12" cy="12" r="3" /><circle cx="5" cy="6" r="2" /><circle cx="19" cy="6" r="2" /><circle cx="12" cy="20" r="2" /><path d="M6.6 7.2 9.6 10M17.4 7.2 14.4 10M12 15v3" /></>} />,
  doc: () => <I c={<><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M9 13h6M9 17h4" /></>} />,
  link: () => <I c={<><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></>} />,
  search: () => <I c={<><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>} />,
  user: () => <I c={<><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>} />,
  gear: () => <I c={<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>} />,
  inbox: () => <I c={<><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.5 5h13l3.5 7v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z" /></>} />,
  plus: () => <I c={<path d="M12 5v14M5 12h14" />} />,
  trash: () => <I c={<><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" /></>} />,
  back: () => <I c={<path d="m15 18-6-6 6-6" />} />,
  filter: () => <I c={<path d="M3 5h18l-7 9v5l-4 2v-7z" />} />,
  sun: () => <I c={<><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>} />,
  moon: () => <I c={<path d="M21 13A9 9 0 1 1 11 3a7 7 0 0 0 10 10z" />} />,
  monitor: () => <I c={<><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>} />,
  pdf: () => <I c={<><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><path d="M8.5 16v-3h1.2a1 1 0 0 1 0 2H8.5M13 13v3h.8a1.5 1.5 0 0 0 0-3zM17 13h-1.5v3M15.5 14.5H17" strokeWidth={1.4} /></>} />,
  docx: () => <I c={<><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><path d="m8.5 12 1.2 5 1.3-4 1.3 4 1.2-5" strokeWidth={1.5} /></>} />,
  markdown: () => <I c={<><rect x="2.5" y="5" width="19" height="14" rx="2.5" /><path d="M6 15V9l2.5 3L11 9v6M15.5 9v6M13.5 13l2 2 2-2" /></>} />,
  code: () => <I c={<path d="m8 7-5 5 5 5M16 7l5 5-5 5M13.5 4l-3 16" />} />,
  table: () => <I c={<><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M3 10h18M3 15h18M9 4v16" /></>} />,
  chat: () => <I c={<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.6A8 8 0 1 1 21 12z" />} />,
  graph: () => <I c={<><circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="8" r="2.5" /><circle cx="9" cy="18" r="2.5" /><path d="m8.3 7 7.4.9M7 8.4l1.4 7.2M16.4 10 10.8 16.2" /></>} />,
  upload: () => <I c={<path d="M12 16V4M7 9l5-5 5 5M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />} />,
  send: () => <I c={<path d="M12 19V5M6 11l6-6 6 6" />} />,
  x: () => <I c={<path d="M6 6l12 12M18 6 6 18" />} />,
  sparkle: () => <I c={<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 17l.8 2.2L22 20l-2.2.8L19 23l-.8-2.2L16 20l2.2-.8z" />} />,
};

const TYPE_ICON: Record<string, () => React.JSX.Element> = {
  webpage: Icon.link,
  pdf: Icon.pdf,
  docx: Icon.docx,
  markdown: Icon.markdown,
  code: Icon.code,
  csv: Icon.table,
  chat: Icon.chat,
};
export function TypeIcon({ type, url, chat }: { type?: string; url?: string | null; chat?: boolean }) {
  const I = TYPE_ICON[chat ? "chat" : (type ?? "")] ?? (url ? Icon.link : Icon.doc);
  return (
    <span className="type-icon" data-type={chat ? "chat" : type}>
      <I />
    </span>
  );
}
