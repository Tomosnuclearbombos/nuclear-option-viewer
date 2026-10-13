#!/usr/bin/env bash
# Opens a test page in headless Firefox and prints the JSON report it POSTs back.
#   tools/headless.sh "tools/parse-test.html?file=data/x.zip.acmi" [timeout_seconds]
set -euo pipefail
cd "$(dirname "$0")/.."
PAGE="$1"; TIMEOUT="${2:-300}"
WORK="$(mktemp -d)"
PORT=$((20000 + RANDOM % 20000))
python3 tools/devserver.py --port "$PORT" --results "$WORK/results.jsonl" > "$WORK/server.log" 2>&1 &
SRV=$!
mkdir -p "$WORK/profile"
cleanup() { kill "$FF" "$SRV" 2>/dev/null || true; wait 2>/dev/null || true; rm -rf "$WORK"; }
sleep 0.5
firefox --headless --no-remote --profile "$WORK/profile" "http://127.0.0.1:$PORT/$PAGE" > "$WORK/firefox.log" 2>&1 &
FF=$!
trap cleanup EXIT
for _ in $(seq "$TIMEOUT"); do
  if [ -s "$WORK/results.jsonl" ]; then cat "$WORK/results.jsonl"; exit 0; fi
  sleep 1
done
echo "TIMEOUT after ${TIMEOUT}s" >&2
tail -20 "$WORK/firefox.log" >&2 || true
exit 1
