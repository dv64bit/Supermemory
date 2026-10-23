# supermem browser extension

Fork of supermemory's MIT-licensed extension (upstream `apps/browser-extension` at commit `4d8a4ebf`; see `LICENSE`).
It talks to your self-hosted supermem server instead of supermemory.ai.

Changes from upstream:
- Connect with a server URL and API key in the popup, replacing the hosted sign-in.
- Analytics (PostHog) removed.
- Host permissions point at `127.0.0.1` / `localhost`.

## Build and load

```sh
bun install && bun run build      # output: .output/chrome-mv3
```

1. In Chrome, open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick `extension/.output/chrome-mv3`.
3. Click the extension icon and connect. The server URL defaults to `http://127.0.0.1:6767`; the API key is your `SUPERMEM_API_KEY` (default `dev`).

Features (from upstream): save the current page, auto-recall memories while typing in ChatGPT, Claude, Gemini, Grok and T3 chat, and import X/Twitter bookmarks.
They use the server's v3/v4 compatibility routes (`server/src/legacy.ts`).

To use a server on a host other than localhost, add it to `host_permissions` in `wxt.config.ts` and rebuild.
