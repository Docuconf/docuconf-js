#!/usr/bin/env bash
# The Next.js example as a user installs it: packs @docuconf/core and
# @docuconf/t3 (run `npm run build` at the repository root first), installs
# them with Next.js into a copy of this directory, then checks that
#  - the committed contract.cue is what `docuconf-t3 export` writes, through
#    the "@/*" tsconfig alias;
#  - `next build` succeeds with no server configuration (only the
#    NEXT_PUBLIC_ variable Next.js inlines), including the "use client"
#    component that imports env.ts;
#  - `next start` with valid env serves values read at start, not at build;
#  - `next start` with a missing secret and a bad value exits 1, printing
#    only the docuconf problems, instead of serving 500s.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
work="$(mktemp -d "${DOCUCONF_SMOKE_TMP:-${TMPDIR:-/tmp}}/next-t3-smoke.XXXXXX")"
pid=""
cleanup() {
  [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  [ "${KEEP_SMOKE:-}" = 1 ] || rm -rf "$work"
}
trap cleanup EXIT
fail() { echo "smoke: FAIL: $*" >&2; [ -f "$work/out.txt" ] && cat "$work/out.txt" >&2; exit 1; }

core="$(cd "$root/packages/core" && npm pack --silent --pack-destination "$work")"
t3="$(cd "$root/packages/t3" && npm pack --silent --pack-destination "$work")"
mkdir "$work/app"
(cd "$here" && tar --exclude=node_modules --exclude=.next -cf - .) | (cd "$work/app" && tar -xf -)
cd "$work/app"
npm install --silent --no-fund --no-audit "../$core" "../$t3"
echo "smoke: ok: installed @docuconf/core and @docuconf/t3 with next $(node -p 'require("next/package.json").version')"

npx docuconf-t3 export src/env.ts --check contract.cue || fail "contract.cue is out of date"
echo "smoke: ok: contract.cue is up to date (export follows the @/* alias)"

# Only what Next.js inlines into the browser bundle; no server configuration.
clean=(env -i "PATH=$PATH" "HOME=${HOME:-/tmp}" NEXT_TELEMETRY_DISABLED=1 NO_COLOR=1 DOCUCONF_TERMINATION_LOG=/dev/null
  NEXT_PUBLIC_API_BASE=https://api.example.com)
next=(node node_modules/next/dist/bin/next)
"${clean[@]}" "${next[@]}" build >"$work/out.txt" 2>&1 || fail "next build failed without server configuration"
echo "smoke: ok: next build needs no server configuration"

port="$(node -e 'const s = require("node:net").createServer().listen(0, () => { console.log(s.address().port); s.close(); })')"
secret="s3cret-$RANDOM$RANDOM"
"${clean[@]}" DATABASE_URL="postgres://orders:$secret@db:5432/orders" WORKER_COUNT=9 \
  "${next[@]}" start -p "$port" >"$work/out.txt" 2>&1 &
pid=$!
page=""
for _ in $(seq 1 200); do
  page="$(curl -fsS "http://127.0.0.1:$port/" 2>/dev/null)" && break
  kill -0 "$pid" 2>/dev/null || fail "next start exited with valid configuration"
  sleep 0.1
done
case "$page" in *'&quot;WORKER_COUNT&quot;:9'*|*'"WORKER_COUNT":9'*) ;; *) fail "the page does not show WORKER_COUNT=9 from the runtime environment: $page" ;; esac
case "$page" in *'https://api.example.com'*) ;; *) fail "the client component did not render NEXT_PUBLIC_API_BASE" ;; esac
case "$page" in *"$secret"*) fail "the page contains the secret" ;; esac
kill "$pid"; wait "$pid" 2>/dev/null || true; pid=""
echo "smoke: ok: next start serves values read at start, and the client component"

status=0
port="$(node -e 'const s = require("node:net").createServer().listen(0, () => { console.log(s.address().port); s.close(); })')"
"${clean[@]}" WORKER_COUNT=999 timeout 60 "${next[@]}" start -p "$port" >"$work/out.txt" 2>&1 || status=$?
[ "$status" -eq 1 ] || fail "next start with invalid configuration exited $status, want 1"
grep -q '^docuconf: 2 configuration problems:$' "$work/out.txt" || fail "no docuconf header"
grep -q '^  - DATABASE_URL \[missing_required\]: required, but not set$' "$work/out.txt" || fail "no DATABASE_URL line"
grep -q '^  - WORKER_COUNT \[out_of_range\]: ' "$work/out.txt" || fail "no WORKER_COUNT line"
if grep -q '^    at ' "$work/out.txt"; then fail "a stack trace was printed"; fi
echo "smoke: ok: next start with invalid configuration exits 1 with the docuconf problems"
