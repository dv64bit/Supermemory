import { useEffect, useRef, useState } from "react";
import { BrowserRouter, NavLink, Navigate, Route, Routes } from "react-router";
import { isUrl, load, save, settings, sm, useQuery } from "./api";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { GridBackground } from "@/components/ui/grid-background";
import { App as Ctx, Icon, useApp, useTheme, useToasts, type Theme } from "./shared";
import { Documents, DocumentDetail } from "./pages/Documents";
import { Memories, MemoryDetailPage } from "./pages/Memories";
import { Review } from "./pages/Review";
import { Search } from "./pages/Search";
import { Profile } from "./pages/Profile";
import { Settings } from "./pages/Settings";
import { Chat } from "./pages/Chat";
import { Graph } from "./pages/Graph";

export default function Root() {
  const [key, setKey] = useState(settings.key);
  const [theme, setTheme] = useTheme((load("sm.theme", "system") as Theme) || "system");
  useEffect(() => save("sm.theme", theme), [theme]);
  if (!key) return <Welcome onDone={setKey} />;
  return (
    <BrowserRouter>
      <Shell theme={theme} setTheme={setTheme} />
    </BrowserRouter>
  );
}

function Shell({ theme, setTheme }: { theme: Theme; setTheme: (t: Theme) => void }) {
  const [space, setSpaceState] = useState(load("sm.space", "default") || "default");
  const [version, setVersion] = useState(0);
  const [drafts, setDrafts] = useState<string[]>([]); // typed spaces that exist only after their first add
  const composer = useRef<HTMLDialogElement>(null);
  const { toast, view: toasts } = useToasts();
  const spaces = useQuery(() => sm.spaces(), [version]);

  const setSpace = (s: string) => {
    setSpaceState(s);
    save("sm.space", s);
  };
  const ctx = {
    space,
    setSpace,
    version,
    bump: () => setVersion((v) => v + 1),
    openComposer: () => composer.current?.showModal(),
    toast,
  };

  // ⌘K / Ctrl+K opens the composer from anywhere
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        composer.current?.showModal();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const known = spaces.data ?? [];
  const list = [
    ...known,
    ...[space, ...drafts]
      .filter((s, i, a) => a.indexOf(s) === i && !known.some((k) => k.id === s))
      .map((id) => ({ id, documentCount: 0, memoryCount: 0 })),
  ];
  const current = list.find((s) => s.id === space);

  return (
    <Ctx value={ctx}>
      <div className="shell">
        <aside className="side">
          <div className="brand">
            <span className="brand-mark">
              <Icon.memory />
            </span>
            supermemory
          </div>

          <Button icon={<Icon.plus />} onClick={ctx.openComposer} iconRight={<kbd>⌘K</kbd>}>
            Add memory
          </Button>

          <nav className="nav" aria-label="Main">
            <NavLink to="/chat">
              <Icon.chat /> Chat
            </NavLink>
            <NavLink to="/memories">
              <Icon.memory /> Memories <span className="count">{current?.memoryCount || ""}</span>
            </NavLink>
            <NavLink to="/documents">
              <Icon.doc /> Documents <span className="count">{current?.documentCount || ""}</span>
            </NavLink>
            <NavLink to="/graph">
              <Icon.graph /> Graph
            </NavLink>
            <NavLink to="/review">
              <Icon.inbox /> Review
            </NavLink>
            <NavLink to="/search">
              <Icon.search /> Search
            </NavLink>
            <NavLink to="/profile">
              <Icon.user /> Profile
            </NavLink>
            <NavLink to="/settings">
              <Icon.gear /> Settings
            </NavLink>
          </nav>

          <div>
            <div className="side-label">Spaces</div>
            <div className="spaces">
              {list.map((s) => (
                <button key={s.id} className="space-btn" aria-current={s.id === space} onClick={() => setSpace(s.id)}>
                  <span className="dot" />
                  {s.id}
                  <span className="n">{s.documentCount || ""}</span>
                </button>
              ))}
              <form
                className="space-new"
                onSubmit={(e) => {
                  e.preventDefault();
                  const input = e.currentTarget.elements.namedItem("space") as HTMLInputElement;
                  const name = input.value.trim().replace(/[^a-zA-Z0-9_:-]+/g, "-");
                  if (!name) return;
                  setDrafts((d) => [...d, name]);
                  setSpace(name);
                  input.value = "";
                  toast({ text: `Space “${name}” is created with its first memory` });
                }}
              >
                <input name="space" placeholder="New space…" aria-label="New space name" maxLength={100} />
              </form>
            </div>
          </div>

          <div className="side-foot">
            <SegmentedControl<Theme>
              aria-label="Theme"
              size="sm"
              fullWidth
              value={theme}
              onChange={setTheme}
              options={[
                { value: "light", icon: <Icon.sun />, ariaLabel: "Light" },
                { value: "dark", icon: <Icon.moon />, ariaLabel: "Dark" },
                { value: "system", icon: <Icon.monitor />, ariaLabel: "System" },
              ]}
            />
          </div>
        </aside>

        <main className="main">
          <Routes>
            <Route path="/" element={<Navigate to="/chat" replace />} />
            <Route path="/chat" element={<Chat />} />
            <Route path="/graph" element={<Graph />} />
            <Route path="/memories" element={<Memories />} />
            <Route path="/memories/:id" element={<MemoryDetailPage />} />
            <Route path="/documents" element={<Documents />} />
            <Route path="/documents/:id" element={<DocumentDetail />} />
            <Route path="/review" element={<Review />} />
            <Route path="/search" element={<Search />} />
            <Route path="/profile" element={<Profile />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/chat" replace />} />
          </Routes>
        </main>
      </div>
      <Composer ref={composer} />
      {toasts}
    </Ctx>
  );
}

function Composer({ ref }: { ref: React.RefObject<HTMLDialogElement | null> }) {
  return (
    <dialog
      ref={ref}
      className="composer"
      aria-label="Add memory"
      onClick={(e) => e.target === e.currentTarget && e.currentTarget.close()}
    >
      <ComposerBody close={() => ref.current?.close()} />
    </dialog>
  );
}

const ACCEPT = ".pdf,.docx,.md,.markdown,.txt,.csv,.json,.html,.htm,.js,.jsx,.ts,.tsx,.py,.go,.rs,.java,.c,.cpp,.h,.rb,.php,.sh,.sql,.css,.yaml,.yml,.toml";
const MAX_BYTES = 50 * 1024 * 1024;
const fmtSize = (b: number) => (b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);

function ComposerBody({ close }: { close: () => void }) {
  const ctx = useApp();
  const [text, setText] = useState("");
  const [tags, setTags] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const url = !files.length && isUrl(text);

  const addFiles = (list: FileList | null) => {
    const picked = [...(list ?? [])];
    const tooBig = picked.filter((f) => f.size > MAX_BYTES);
    if (tooBig.length) ctx.toast({ text: `${tooBig.map((f) => f.name).join(", ")} is over 50 MB`, tone: "danger" });
    setFiles((fs) => [...fs, ...picked.filter((f) => f.size <= MAX_BYTES)]);
  };

  const reset = () => {
    setText("");
    setTags("");
    setFiles([]);
  };

  const submit = async () => {
    if ((!text.trim() && !files.length) || busy) return;
    setBusy(true);
    const tagList = tags.split(",").map((t) => t.trim()).filter(Boolean);
    const metadata = { source: "web", ...(tagList.length && { tags: tagList }) };
    try {
      if (files.length) {
        // one at a time so a rejected type doesn't sink the rest
        const failed: File[] = [];
        for (const f of files) {
          try {
            await sm.upload(ctx.space, f, metadata);
          } catch (e) {
            failed.push(f);
            ctx.toast({ text: `${f.name}: ${(e as Error).message}`, tone: "danger" }, 7000);
          }
        }
        const ok = files.length - failed.length;
        if (ok) ctx.toast({ text: `${ok} file${ok === 1 ? "" : "s"} uploaded, extracting now` });
        ctx.bump();
        if (failed.length) return setFiles(failed);
      } else {
        await sm.add(ctx.space, { content: text.trim(), metadata });
        ctx.toast({ text: url ? "Link queued, fetching it now" : "Note added, memories are forming" });
        ctx.bump();
      }
      reset();
      close();
    } catch (e) {
      ctx.toast({ text: `Couldn't add: ${(e as Error).message}`, tone: "danger" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tray">
      <div className="tray-head">
        {files.length ? <Icon.upload /> : url ? <Icon.link /> : <Icon.sparkle />}
        {files.length ? `Upload ${files.length} file${files.length === 1 ? "" : "s"}` : url ? "Save a link" : "Capture a note"}
        <span className="right">
          into <b style={{ color: "var(--ink)" }}>{ctx.space}</b>
        </span>
      </div>
      <div
        className="card drop"
        data-drag={drag || undefined}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={(e) => e.currentTarget.contains(e.relatedTarget as Node) || setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          addFiles(e.dataTransfer.files);
        }}
      >
        {files.length ? (
          <ul className="files">
            {files.map((f, i) => (
              <li key={f.name + i}>
                <Icon.doc />
                <span className="name">{f.name}</span>
                <span className="size">{fmtSize(f.size)}</span>
                <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles((fs) => fs.filter((_, j) => j !== i))}>
                  <Icon.x />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <textarea
            className="textarea"
            autoFocus
            placeholder="Write something to remember, paste a URL, or drop files here…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
            }}
          />
        )}
        <div className="drop-hint" aria-hidden="true">
          <Icon.upload /> Drop to upload
        </div>
        <div className="composer-foot">
          <input ref={picker} type="file" multiple accept={ACCEPT} hidden onChange={(e) => (addFiles(e.target.files), (e.target.value = ""))} />
          <Button variant="ghost" size="sm" icon={<Icon.upload />} aria-label="Attach files" title="PDF, DOCX, Markdown, text, CSV, JSON, HTML, code, up to 50 MB" onClick={() => picker.current?.click()} />
          <input className="tags" placeholder="Tags, comma separated" value={tags} onChange={(e) => setTags(e.target.value)} aria-label="Tags" />
          <Button variant="ghost" size="sm" onClick={close}>
            Cancel
          </Button>
          <Button size="sm" loading={busy} disabled={!text.trim() && !files.length} onClick={submit}>
            {files.length ? "Upload" : url ? "Save link" : "Add"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Welcome({ onDone }: { onDone: (k: string) => void }) {
  const [key, setKey] = useState("");
  return (
    <GridBackground className="welcome">
      <div className="welcome">
        <form
          className="tray"
          onSubmit={(e) => {
            e.preventDefault();
            if (!key.trim()) return;
            save("sm.apiKey", key.trim());
            onDone(key.trim());
          }}
        >
          <div className="card">
            <span className="brand-mark" style={{ width: 36, height: 36, borderRadius: 11 }}>
              <Icon.memory />
            </span>
            <div>
              <h1>Welcome to your memory</h1>
              <p>Paste the API key your server runs with (SUPERMEM_API_KEY). It stays in this browser.</p>
            </div>
            <div className="field">
              <label htmlFor="key">API key</label>
              <input id="key" className="input" type="password" autoFocus value={key} onChange={(e) => setKey(e.target.value)} placeholder="sm_…" />
            </div>
            <Button type="submit" disabled={!key.trim()}>
              Continue
            </Button>
          </div>
        </form>
      </div>
    </GridBackground>
  );
}
