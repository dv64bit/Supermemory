# Supermemory web

The web UI for the self-hosted memory engine in `../server`. It is built with Vite, React 19, TypeScript and Bun, and styled with plain CSS variables. There is no Tailwind and no UI kit.

## Run

```sh
# terminal 1: the API on 127.0.0.1:6767
cd ../server && SUPERMEM_API_KEY=dev bun src/index.ts

# terminal 2: the UI on http://localhost:5173
cd web && bun install && bun run dev
```

On first launch the app asks for the API key (`dev` above). The key is stored in localStorage. The Vite dev server proxies `/api/*` to `http://127.0.0.1:6767/*` and strips the `/api` prefix. To use a different server, change the base URL in **Settings**. A remote server must allow CORS.

`bun run build` type-checks the project and writes `dist/`. `bun test` runs the SSE parser check.

The only runtime dependencies beyond React are `react-router` and `d3-force`.

## Screens

| Screen | What it does |
| --- | --- |
| Chat (default) | Streams `/chat` over SSE, parsed with fetch + ReadableStream. A "Memories used" rail plus a collapsible chip per reply, copy via `message-actions`, `thinking-loader` until the first delta. History lives in localStorage with a list of recent chats per space; `conversationId` is sent back on later turns |
| Graph | d3-force layout of memories and documents (`/graph`), drawn as SVG. Documents are large muted rings, inferences purple, superseded memories dimmed, edges colored by relation. Hover highlights neighbours, click opens the detail view, wheel zooms, drag pans. With reduced motion the layout is computed off-screen and drawn once |
| Shell | Sidebar with nav, a spaces switcher (type a new name; the space is created on its first add) and a light/dark/system theme |
| Add (⌘K / Ctrl+K) | Captures a note or URL, or uploads files by drag & drop or a picker (`/document/file`: PDF, DOCX, MD, TXT, CSV, JSON, HTML, code, up to 50 MB; rejected files stay listed with the server's error). Comma-separated tags go to `metadata.tags` |
| Documents | Type icon, title or first line, a live status pill (polls every 2s until `done` and dreaming finishes), memory count, delete. The detail view shows extracted memories and chunks |
| Memories | Grouped by recency, with Inference/Static/vN badges, a filter (kind, source, forgotten) and forget with undo (calls `/restore`), and Restore on forgotten memories. The detail view shows the version history (follows `updates` parents) and related memories |
| Review | Inferred memories (`list/memories?inference=true`) as a decision inbox: Keep runs `approve`, Forget runs `decline` (falls back to a soft forget) |
| Search | Hybrid, memories or chunks mode, with a similarity bar and the source document |
| Profile | Static and dynamic facts plus custom buckets. If `/profile` 404s it shows a stub |
| Settings | API key and base URL, with a connection test |

## affectUI (free, MIT items only)

Installed with `npx shadcn@latest add https://www.affectui.com/r/<slug>.json` into `src/components/ui`:

- `button`: every action
- `segmented-control`: theme toggle and search mode
- `filter-menu`: memory filters, inside a native `popover`
- `thinking-loader`: search in flight, and chat before the first delta
- `shimmer-loader`: skeleton rows (`Skeleton`)
- `number-ticker`: per-document memory counts
- `decision-inbox`: the Review screen
- `message-actions`: copy under chat replies
- `grid-background`: the first-run screen
- `side-folder`, `layer-stack`, `empty-calendar`: empty-state illustrations

Also installed but unused: `notification-stack`. It keeps its own copy of the notices, which doesn't suit transient toasts.

Built by hand in the same language: the app shell, the tray-plus-card frame, rows, pills, the composer dialog, the toasts, the timeline and the search results. The tokens in `src/index.css` are copied from the installed components' CSS variables, including the gray tray, white card, `#e5e5e5` lines, 22/16/12px radii, Inter and `cubic-bezier(0.22, 1, 0.36, 1)`. Dark mode sets `class="dark"` on `<html>`, which the affectUI components follow too. Everything respects `prefers-reduced-motion`.
