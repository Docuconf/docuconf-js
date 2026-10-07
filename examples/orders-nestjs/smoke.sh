#!/usr/bin/env bash
# Starts the built example (npm run build) with valid env and checks
# GET /healthz and that GET /config hides the secret; then starts it with
# PORT=0 and no DATABASE_URL and checks it exits non-zero, naming
# missing_required and out_of_range.
set -euo pipefail
cd "$(dirname "$0")"
start=(node dist/main.js)

# A clean environment for the app's own variables.
clean=(env -u PORT -u LOG_LEVEL -u DATABASE_URL -u ALLOWED_ORIGINS -u REQUEST_TIMEOUT -u WORKER_COUNT
  DOCUCONF_TERMINATION_LOG=/dev/null NO_COLOR=1)
secret="s3cret-$RANDOM$RANDOM"
port="$(node -e 'const s = require("node:net").createServer().listen(0, () => { console.log(s.address().port); s.close(); })')"
out="$(mktemp)"
pid=""
trap '[ -n "$pid" ] && kill "$pid" 2>/dev/null; rm -f "$out"' EXIT
fail() { echo "smoke: FAIL: $*" >&2; cat "$out" >&2; exit 1; }

"${clean[@]}" PORT="$port" DATABASE_URL="postgres://orders:$secret@localhost:5432/orders" "${start[@]}" >"$out" 2>&1 &
pid=$!
health=""
for _ in $(seq 1 100); do
  health="$(curl -fsS "http://127.0.0.1:$port/healthz" 2>/dev/null)" && break
  kill -0 "$pid" 2>/dev/null || fail "the app exited during startup"
  sleep 0.1
done
[ "$health" = "ok" ] || fail "GET /healthz returned '$health', want 'ok'"
config="$(curl -fsS "http://127.0.0.1:$port/config")"
case "$config" in *"$secret"*) fail "GET /config contains the secret" ;; esac
case "$config" in *'"DATABASE_URL":"***"'*) ;; *) fail "GET /config does not redact DATABASE_URL: $config" ;; esac
kill "$pid"
wait "$pid" 2>/dev/null || true
pid=""
echo "smoke: ok: /healthz is ok, /config is $config"

if "${clean[@]}" PORT=0 timeout 30 "${start[@]}" >"$out" 2>&1; then fail "started with PORT=0 and no DATABASE_URL"; fi
grep -q missing_required "$out" || fail "no missing_required in the startup output"
grep -q out_of_range "$out" || fail "no out_of_range in the startup output"
echo "smoke: ok: PORT=0 without DATABASE_URL exits non-zero with missing_required and out_of_range"
