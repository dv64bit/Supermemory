# Resume notes (paused 2026-10-22)

Branch: `main`.

## Done
- `server/src/legacy.ts`: v3/v4 shims used by the extension (tested in `test/contract.test.ts`).
- `extension/`: fork of the upstream extension with a connect form (server URL + API key), no analytics, localhost-only host permissions. See `extension/README.md` to build and load it.
- `start.sh`: one command to run everything.

## Not verified yet
- The extension in a real browser: loading it, the popup connect form, save-page, and auto-recall in ChatGPT/Claude. It builds and typechecks, and the server routes it calls answer on the live server.

## After that
- Connectors (Notion / Drive / Gmail...) need OAuth apps registered by the user.
- Images (vision model) and audio (whisper).

## Running
- API: `cd server && SUPERMEM_API_KEY=dev bun --watch src/index.ts` (127.0.0.1:6767)
- Web: `cd web && bun run dev` (localhost:5173). On first open, enter the API key in Settings.
- MCP: `claude mcp add --scope user --transport http supermem http://127.0.0.1:6767/mcp --header "Authorization: Bearer dev"`
