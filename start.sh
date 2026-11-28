#!/usr/bin/env bash
# One command to run supermem: Postgres + Ollama (brew services), API on :6767, web UI on :5173.
# Ctrl-C stops the API and UI; Postgres and Ollama keep running as background services.
set -euo pipefail
cd "$(dirname "$0")"
PG=/opt/homebrew/opt/postgresql@17/bin
MODEL="${LLM_MODEL:-qwen3:8b}"

for port in 6767 5173; do
  if lsof -nP -iTCP:$port -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $port is already in use: supermem is probably already running. Stop it first (Ctrl-C in its terminal)."
    exit 1
  fi
done

for svc in postgresql@17 ollama; do
  brew services list | grep -qE "^$svc +started" || brew services start "$svc"
done
until "$PG/pg_isready" -q; do sleep 0.5; done
"$PG/psql" -lqt | cut -d'|' -f1 | grep -qw supermem || "$PG/createdb" supermem
until ollama list >/dev/null 2>&1; do sleep 0.5; done
ollama list | grep -q "^$MODEL" || ollama pull "$MODEL"

[ -d server/node_modules ] || (cd server && bun install)
[ -d web/node_modules ] || (cd web && bun install)

# The key comes from server/.env when set there; otherwise fall back to "dev".
grep -qs '^SUPERMEM_API_KEY=' server/.env || export SUPERMEM_API_KEY=dev

trap 'trap - EXIT INT TERM; kill 0' EXIT INT TERM
(cd server && bun --watch src/index.ts) &
(cd web && bun run dev) &

until curl -sf http://127.0.0.1:6767/v3/health >/dev/null; do sleep 0.5; done
echo
echo "supermem is up:  UI http://localhost:5173   API http://127.0.0.1:6767   key: ${SUPERMEM_API_KEY:-see server/.env}"
echo "Ctrl-C to stop."
wait
