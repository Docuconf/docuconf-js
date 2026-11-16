#!/usr/bin/env bash
# Runs the built example (npm run build) as a real process, with a fresh,
# empty DOCUCONF_FILE_ROOT, for cases 1, 2 and 6 of the matrix in README.md:
# web and worker start, print their one line and exit 0; a worker with
# LOG_FORMAT=json and no LOG_SCHEMA_URL exits 1 with exactly the docuconf
# header and the LOG_SCHEMA_URL line, and never prints DATABASE_URL.
# Needs node.
set -euo pipefail
cd "$(dirname "$0")"
start=(node dist/main.js)

root="$(mktemp -d)"
out="$(mktemp)"
trap 'rm -rf "$root" "$out"' EXIT
# A clean environment for the app's own variables.
clean=(env -u DOCUCONF_ROLE -u DATABASE_URL -u PORT -u ALLOWED_ORIGINS -u QUEUES -u WEBHOOKS_ENABLED -u LOG_FORMAT
  -u LOG_SCHEMA_URL -u OTEL_EXPORTER_OTLP_PROTOCOL DOCUCONF_FILE_ROOT="$root" DOCUCONF_TERMINATION_LOG=/dev/null NO_COLOR=1
  DATABASE_URL="postgres://shop:s3cret-$RANDOM$RANDOM@db:5432/shop")
fail() { echo "smoke: FAIL: $*" >&2; cat "$out" >&2; exit 1; }

# run WANT_STATUS WANT_OUTPUT ENV...: the app's exit status and its whole output.
run() {
  local want_status="$1" want="$2"
  shift 2
  local status=0
  "${clean[@]}" "$@" "${start[@]}" >"$out" 2>&1 || status=$?
  [ "$status" -eq "$want_status" ] || fail "$*: exit status $status, want $want_status"
  [ "$(cat "$out")" = "$want" ] || fail "$*: unexpected output"
  case "$(cat "$out")" in *s3cret*) fail "$*: the output contains the DATABASE_URL secret" ;; esac
  echo "smoke: ok: $* -> exit $status: $(head -n 1 "$out")"
}

run 0 "shop web: port 8080, origins https://shop.example" DOCUCONF_ROLE=web ALLOWED_ORIGINS=https://shop.example
run 0 "shop worker: queues default,mail, webhooks off" DOCUCONF_ROLE=worker QUEUES=default,mail
run 1 'docuconf: 1 configuration problem:
  - LOG_SCHEMA_URL [missing_required]: is required when LOG_FORMAT is "json"' \
  DOCUCONF_ROLE=worker QUEUES=default LOG_FORMAT=json
