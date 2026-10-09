#!/usr/bin/env bash
# Starts the built example (npm run build) with valid env and checks
# GET /healthz and that GET /config hides the secret; then starts it with
# PORT=0 and no DATABASE_URL and checks it exits non-zero, naming
# missing_required and out_of_range, and prints only the docuconf list.
# Then the webhook key set: mid-rotation, POST /webhooks/payments accepts a
# body signed with the old or the new key and rejects any other or none;
# an empty key (a trailing comma) fails at boot without printing a key.
# Needs node and curl.
set -euo pipefail
cd "$(dirname "$0")"
start=(node dist/server.js)

# A clean environment for the app's own variables.
clean=(env -u PORT -u LOG_LEVEL -u DATABASE_URL -u ALLOWED_ORIGINS -u REQUEST_TIMEOUT -u WORKER_COUNT -u WEBHOOK_KEYS
  DOCUCONF_TERMINATION_LOG=/dev/null NO_COLOR=1)
secret="s3cret-$RANDOM$RANDOM"
# Two webhook keys: the old one and, mid-rotation, the new one.
old_key="old-webhook-key-0123456789abcdef0123"
new_key="new-webhook-key-0123456789abcdef0123"
port="$(node -e 'const s = require("node:net").createServer().listen(0, () => { console.log(s.address().port); s.close(); })')"
out="$(mktemp)"
pid=""
trap '[ -n "$pid" ] && kill "$pid" 2>/dev/null; rm -f "$out"' EXIT
fail() { echo "smoke: FAIL: $*" >&2; cat "$out" >&2; exit 1; }

"${clean[@]}" PORT="$port" DATABASE_URL="postgres://orders:$secret@localhost:5432/orders" WEBHOOK_KEYS="$old_key,$new_key" "${start[@]}" >"$out" 2>&1 &
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
case "$config" in *webhook-key*) fail "GET /config contains a webhook key" ;; esac
case "$config" in *'"WEBHOOK_KEYS":"***"'*) ;; *) fail "GET /config does not redact WEBHOOK_KEYS: $config" ;; esac
echo "smoke: ok: /healthz is ok, /config is $config"

# Mid-rotation, a webhook signed with either key is accepted, one signed
# with any other key or not at all is not.
body='{"order":"42","status":"paid"}'
post() { curl -s -o /dev/null -w '%{http_code}' -X POST "$@" -d "$body" "http://127.0.0.1:$port/webhooks/payments"; }
code="$(post)"
[ "$code" = 401 ] || fail "an unsigned webhook got $code, want 401"
for key in "$old_key" "$new_key" "other-webhook-key-0123456789abcdef"; do
  sig="$(node -e 'process.stdout.write(require("node:crypto").createHmac("sha256", process.argv[1]).update(process.argv[2]).digest("hex"))' "$key" "$body")"
  want=204; [ "${key#other}" != "$key" ] && want=401
  code="$(post -H "X-Signature: $sig")"
  [ "$code" = "$want" ] || fail "webhook signed with the ${key%%-*} key: got $code, want $want"
done
kill "$pid"
wait "$pid" 2>/dev/null || true
pid=""
if grep -q webhook-key "$out"; then fail "the log contains a webhook key"; fi
echo "smoke: ok: webhooks signed with the old or the new key are accepted; unsigned or any other key, 401"

if "${clean[@]}" PORT=0 timeout 30 "${start[@]}" >"$out" 2>&1; then fail "started with PORT=0 and no DATABASE_URL"; fi
grep -q missing_required "$out" || fail "no missing_required in the startup output"
grep -q out_of_range "$out" || fail "no out_of_range in the startup output"
# exitOnError: the docuconf list alone, with no stack trace.
[ "$(head -n 1 "$out")" = "docuconf: 2 configuration problems:" ] || fail "the output does not start with the docuconf header"
[ "$(wc -l <"$out")" -eq 3 ] || fail "the output is not exactly the header and one line per problem"
echo "smoke: ok: PORT=0 without DATABASE_URL exits 1 with exactly the missing_required and out_of_range lines"

# An empty second key (a trailing comma): the key set fails it at boot,
# without printing either key.
if "${clean[@]}" DATABASE_URL="postgres://orders:$secret@localhost:5432/orders" WEBHOOK_KEYS="$old_key," timeout 30 "${start[@]}" >"$out" 2>&1; then
  fail "started with an empty webhook key"
fi
[ "$(head -n 1 "$out")" = "docuconf: 1 configuration problem:" ] || fail "the output does not start with the docuconf header"
[ "$(wc -l <"$out")" -eq 2 ] || fail "the output is not exactly the header and one problem"
grep -qx '  - WEBHOOK_KEYS \[out_of_range\]: key 2 is empty' "$out" || fail "no 'WEBHOOK_KEYS [out_of_range]: key 2 is empty' line"
if grep -q webhook-key "$out"; then fail "the output contains a webhook key"; fi
echo "smoke: ok: an empty webhook key exits 1 with out_of_range, printing no key"
