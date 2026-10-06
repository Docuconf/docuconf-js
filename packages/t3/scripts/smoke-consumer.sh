#!/usr/bin/env bash
# Installs the packed package into a clean project that is not "type": "module"
# and uses it the way a plain-JavaScript app would: from .mjs (runtime and
# `docuconf export`) and from .cjs via require(). Run after `npm run build`
# (of this package and @docuconf/core, which is packed and installed with it).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

tarball="$(cd "$root" && npm pack --silent --pack-destination "$work")"
core="$(cd "$root/../core" && npm pack --silent --pack-destination "$work")"
cd "$work"
echo '{ "name": "smoke", "private": true }' > package.json
npm install --silent --no-fund --no-audit "./$core" "./$tarball" @t3-oss/env-core@0.13 zod@4

mkdir -p dev/etc/smoke
echo '{"currency":"EUR"}' > dev/etc/smoke/settings.json
cat > env.mjs <<'JS'
import { z } from "zod";
import { configFile, createEnv, duration, secret, url } from "@docuconf/t3";
export const env = createEnv({
  name: "smoke",
  server: {
    DATABASE_URL: secret(url({ schemes: ["postgres"] })).describe("Primary Postgres connection string"),
    PORT: z.coerce.number().int().min(1).max(65535).default(8080).describe("HTTP listen port"),
    REQUEST_TIMEOUT: duration({ default: "30s" }).describe("Upstream request timeout"),
  },
  files: {
    settings: configFile({ format: "json", path: "/etc/smoke/settings.json", required: true,
      description: "Currency settings", schema: z.object({ currency: z.enum(["EUR", "USD"]) }) }),
  },
  runtimeEnv: process.env,
});
JS
cat > main.mjs <<'JS'
import { env } from "./env.mjs";
if (env.PORT !== 8080 || env.REQUEST_TIMEOUT !== 30000 || env.files.settings.currency !== "EUR") {
  throw new Error("unexpected values: " + JSON.stringify(env));
}
console.log("ok: .mjs runtime");
JS
cat > main.cjs <<'JS'
const { createEnv } = require("@docuconf/t3");
if (typeof createEnv !== "function") throw new Error("require() did not load createEnv");
console.log("ok: .cjs require()");
JS

DATABASE_URL=postgres://u:p@db/x DOCUCONF_FILE_ROOT="$work/dev" node main.mjs
if PORT=abc DATABASE_URL=postgres://u:p@db/x DOCUCONF_FILE_ROOT="$work/dev" node main.mjs 2>err.txt; then
  echo "expected a validation error for PORT=abc" >&2; exit 1
fi
grep -q "PORT \[invalid_type\]" err.txt && echo "ok: .mjs boot validation"
node main.cjs
npx docuconf export env.mjs --out contract.cue >/dev/null
grep -q 'name: "smoke"' contract.cue && echo "ok: docuconf export env.mjs"

cat > env.cjs <<'JS'
const { z } = require("zod");
const { createEnv } = require("@docuconf/t3");
exports.env = createEnv({
  name: "smoke-cjs",
  server: { PORT: z.coerce.number().int().min(1).max(65535).default(8080).describe("HTTP listen port") },
  runtimeEnv: process.env,
});
JS
npx docuconf export env.cjs --out contract-cjs.cue >/dev/null
grep -q 'name: "smoke-cjs"' contract-cjs.cue && echo "ok: docuconf export env.cjs"
