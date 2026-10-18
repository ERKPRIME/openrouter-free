#!/bin/sh
# End-to-end failover check against a real opencode 2 (not run in CI; needs opencode 2, node 22.18+,
# timeout or gtimeout, and network access to OpenCode Zen's free models).
#   ./scripts/e2e-failover.sh
# Ranks a fake provider that always answers 429 "per-day limit" first, then checks that
#   1. the turn fails over to a real free model and is retried there within the same run,
#   2. the failed model is on cooldown,
#   3. the next turn stays on the switched model (sticky) even after the cooldown is cleared,
#   4. with no eligible model the run fails fast with a connection error instead of waiting.
set -eu

repo=$(cd "$(dirname "$0")/.." && pwd)
fake_port="${FAKE_PORT:-18999}"
limit=120
work=$(mktemp -d "${TMPDIR:-/tmp}/free-router-e2e.XXXXXX")
pids=""
cleanup() {
  for p in $pids; do kill "$p" 2>/dev/null || true; done
  rm -rf "$work"
}
trap cleanup EXIT INT TERM

if command -v timeout >/dev/null 2>&1; then tmo=timeout
elif command -v gtimeout >/dev/null 2>&1; then tmo=gtimeout
else
  echo "missing prerequisite: timeout or gtimeout (macOS: brew install coreutils)" >&2
  exit 1
fi

mkdir -p "$work/plugin"
cp "$repo/src/plugin/index.ts" "$work/plugin/"
cp "$repo/src/lib.mts" "$repo/src/rank.mts" "$work/"
# The fake provider must count as free; everything else keeps the defaults.
printf '{"freeTier":{"fakefree":["*"]}}\n' >"$work/config.json"
cp "$repo/templates/pins.example.json" "$work/pins.json"

cat >"$work/free.jsonc" <<EOF
{
  "plugins": ["./plugin"],
  "model": "free/auto",
  "providers": {
    "free": { "name": "Free", "package": "@ai-sdk/openai-compatible", "settings": { "baseURL": "http://127.0.0.1:9/v1", "apiKey": "x" },
      "models": { "auto": { "name": "auto", "capabilities": { "tools": true }, "limit": { "context": 200000, "output": 32000 } } } },
    "fakefree": { "name": "Fake", "package": "@ai-sdk/openai-compatible", "settings": { "baseURL": "http://127.0.0.1:$fake_port/v1", "apiKey": "x" },
      "models": { "broken": { "name": "Broken Free", "capabilities": { "tools": true }, "limit": { "context": 200000, "output": 32000 } } } }
  }
}
EOF

# opencode talks to its own private server (--standalone), which reads this config and directory.
oc() { (cd "$work" && OPENCODE_CONFIG="$work/free.jsonc" FREE_ROUTER_DIR="$work" FREE_ROUTER_RANKING=1 "$tmo" "$limit" opencode "$@"); }

# Ranking: the fake model first, then every live Zen model; the plugin drops the ones that are not free.
# shellcheck disable=SC2016 # ${...} is a JS template literal
oc api --standalone model.list | node -e '
  const out = require("fs").readFileSync(0, "utf8")
  const data = JSON.parse(out.slice(out.indexOf("{"))).data
  const ids = data.filter((m) => m.providerID === "opencode").map((m) => `opencode/${m.id}`)
  const models = [{ id: "fakefree/broken", score: 9, reason: "e2e", sources: {} }, ...ids.map((id, i) => ({ id, score: 1 - i / 100, reason: "e2e", sources: {} }))]
  require("fs").writeFileSync(process.argv[1], JSON.stringify({ generatedAt: new Date().toISOString(), models }))
' "$work/ranking.json"

node -e '
  require("http").createServer((req, res) => {
    req.resume()
    res.writeHead(429, { "content-type": "application/json", "retry-after": "3600" })
    res.end(JSON.stringify({ error: { message: "Rate limit exceeded: free-models-per-day", code: 429 } }))
  }).listen(Number(process.argv[1]), "127.0.0.1")
' "$fake_port" &
pids="$pids $!"
sleep 1

fail() {
  echo "FAIL: $1"
  cat "$work/router.log" 2>/dev/null || true
  exit 1
}
# The model a session is stuck to, from the router's state file.
pick_of() { node -e 'const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log(s.sessions[process.argv[2]]?.model ?? "")' "$work/state.json" "$1"; }

# Whether a --format json output holds an assistant text event with $2: the echoed prompt does not count.
said() {
  node -e '
    for (const line of require("fs").readFileSync(process.argv[1], "utf8").split("\n")) {
      try {
        const e = JSON.parse(line)
        if (e.type === "text" && String(e.part?.text ?? "").includes(process.argv[2])) process.exit(0)
      } catch {}
    }
    process.exit(1)
  ' "$1" "$2"
}

oc run --standalone --format json "Reply with exactly: e2e-one" >"$work/one.json" || fail "turn 1 did not finish within ${limit}s"
sid=$(node -e '
  for (const line of require("fs").readFileSync(process.argv[1], "utf8").split("\n")) {
    try {
      const id = JSON.parse(line).sessionID
      if (id) { console.log(id); break }
    } catch {}
  }
' "$work/one.json")
[ -n "$sid" ] || fail "no session id in the turn 1 output"
said "$work/one.json" e2e-one || fail "no reply after failover"
first=$(pick_of "$sid")
case "$first" in "" | fakefree/*) fail "turn 1 was not answered by a real model (session on '$first')" ;; esac
grep -q '"fakefree/broken"' "$work/state.json" || fail "fake model not on cooldown"
echo "ok  failover: fakefree/broken -> $first (retried in the same run)"

# Clear cooldowns: the fake model is #1 again, but the session must stay on its model.
node -e '
  const f = process.argv[1], s = JSON.parse(require("fs").readFileSync(f, "utf8"))
  s.cooldowns = {}
  require("fs").writeFileSync(f, JSON.stringify(s))
' "$work/state.json"
oc run --standalone --format json --session "$sid" "Reply with exactly: e2e-two" >"$work/two.json" || fail "turn 2 did not finish within ${limit}s"
said "$work/two.json" e2e-two || fail "no reply to second turn"
second=$(pick_of "$sid")
[ "$second" = "$first" ] || fail "second turn moved from $first to $second"
echo "ok  sticky: second turn stayed on $second"

# No eligible model: free/auto stays in place and the run must fail at once, not wait out a retry.
printf '{"freeTier":{"fakefree":["*"]},"minContext":99999999}\n' >"$work/config.json"
rm -f "$work/state.json"
status=0
oc run --standalone "Reply with exactly: e2e-three" >"$work/three.txt" 2>&1 || status=$?
[ "$status" -ne 0 ] || fail "run succeeded with no eligible model"
[ "$status" -ne 124 ] || fail "run did not fail fast with no eligible model"
grep -Eqi '127\.0\.0\.1:9|ConnectionRefused|ECONNREFUSED' "$work/three.txt" || { cat "$work/three.txt"; fail "no connection error to the dead free/auto address"; }
echo "ok  fail fast: exit $status with no eligible model"
echo "PASS"
