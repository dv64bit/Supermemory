# supermem browser extension

Chrome extension for your self-hosted supermem server. Third-party license notice: see `LICENSE`.

- Connect with a server URL and API key in the popup.
- No analytics.
- Host permissions: `127.0.0.1` / `localhost` only.

## Build and load

```sh
bun install && bun run build      # output: .output/chrome-mv3
```

1. In Chrome, open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick `extension/.output/chrome-mv3`.
3. Click the extension icon and connect. The server URL defaults to `http://127.0.0.1:6767`; the API key is your `SUPERMEM_API_KEY` (default `dev`).

Features: save the current page, auto-recall memories while typing in ChatGPT, Claude, Gemini, Grok and T3 chat, and import X/Twitter bookmarks.
They use the server's v3/v4 compatibility routes (`server/src/legacy.ts`).

To use a server on a host other than localhost, add it to `host_permissions` in `wxt.config.ts` and rebuild.
