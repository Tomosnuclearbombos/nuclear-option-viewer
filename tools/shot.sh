#!/usr/bin/env bash
# Screenshot the viewer in headless Firefox.
#   tools/shot.sh <replay path> <fraction 0..1> <out.jpg> [WxH] [extra query, e.g. "&cam=0,5000,8000,0,0,0"]
set -euo pipefail
cd "$(dirname "$0")/.."
REPLAY="$1"; FRAC="$2"; OUT="$3"; SIZE="${4:-1600x900}"; EXTRA="${5:-}"
WORK="$(mktemp -d)"
PORT=$((20000 + RANDOM % 20000))
python3 tools/devserver.py --port "$PORT" --results "$WORK/results.jsonl" > "$WORK/server.log" 2>&1 &
SRV=$!
mkdir -p "$WORK/profile"
# let headless Firefox use WebGL
cat > "$WORK/profile/user.js" <<'EOF'
user_pref("webgl.force-enabled", true);
user_pref("webgl.disabled", false);
user_pref("layers.acceleration.force-enabled", true);
EOF
cleanup() { kill "$FF" "$SRV" 2>/dev/null || true; wait 2>/dev/null || true; rm -rf "$WORK"; }
sleep 0.5
W="${SIZE%x*}"; H="${SIZE#*x}"
firefox --headless --no-remote --profile "$WORK/profile" --window-size "$W,$H" \
  "http://127.0.0.1:$PORT/index.html?replay=$REPLAY&shot=$FRAC$EXTRA" > "$WORK/firefox.log" 2>&1 &
FF=$!
trap cleanup EXIT
for _ in $(seq 300); do
  if [ -s "$WORK/results.jsonl" ]; then
    python3 - "$WORK/results.jsonl" "$OUT" <<'PY'
import base64, json, sys
d = json.loads(open(sys.argv[1]).readline())
if "png" in d:
    open(sys.argv[2], "wb").write(base64.b64decode(d["png"].split(",", 1)[1]))
    print(json.dumps(d.get("info")))
else:
    print(json.dumps(d))
PY
    exit 0
  fi
  sleep 1
done
echo "TIMEOUT" >&2; tail -20 "$WORK/firefox.log" >&2; exit 1
