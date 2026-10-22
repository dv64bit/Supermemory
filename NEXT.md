# Resume notes (paused 2026-10-22)

Branch: `browser-extension` (main = initial commit a01b4b3).

## Done on this branch
- `server/src/legacy.ts`: v3/v4 shims (`GET /v3/projects`, `POST /v3/documents`, `/v3/documents/batch`, `/v4/search`) for the upstream browser extension. Tested in `test/contract.test.ts`. All 28 tests pass.

## Next: fork the browser extension
- Upstream MIT source is at commit `4d8a4ebfddadc3430f7f59a752cd374670833f50`, path `apps/browser-extension` (WXT + React).
  Fetch it with: `gh api repos/supermemoryai/supermemory/tarball/<sha> > repo.tgz && tar -xzf repo.tgz '*/apps/browser-extension/*'`
- Copy it to `extension/` and keep the MIT notice. Then:
  1. `utils/constants.ts`: make the API base come from storage (`serverUrl`, default `http://127.0.0.1:6767`). `utils/api.ts` already sends `Authorization: Bearer <bearerToken>`.
  2. Popup (`entrypoints/popup/App.tsx` ~L280, ~L1349) and `welcome/Welcome.tsx`: replace the cloud login with a form for server URL + API key, validated via `GET /v3/projects`.
  3. `entrypoints/content/shared.ts` ~L128: remove the token capture from app.supermemory.ai.
  4. Stub `utils/posthog.ts` (no analytics). In `wxt.config.ts`, drop the supermemory/posthog hosts and add `http://127.0.0.1/*` and `http://localhost/*`.
  5. Optional: restyle the popup with affectUI tokens (`web/src/index.css`).

## After that
- Connectors (Notion / Drive / Gmail...) need OAuth apps registered by the user.
- Images (vision model) and audio (whisper).

## Running
- API: `cd server && SUPERMEM_API_KEY=dev bun --watch src/index.ts` (127.0.0.1:6767)
- Web: `cd web && bun run dev` (localhost:5173). On first open, enter the API key in Settings.
- MCP: `claude mcp add --scope user --transport http supermem http://127.0.0.1:6767/mcp --header "Authorization: Bearer dev"`
