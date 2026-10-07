#!/usr/bin/env bash
# Installs the packed package into a clean project that is not "type": "module"
# and uses it the way a plain-JavaScript app would: from .mjs (runtime and
# `docuconf-t3 export`) and from .cjs via require(); the browser build and
# @docuconf/t3/next resolve. Run after `npm run build`
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
npx docuconf-t3 export env.mjs --out contract.cue >/dev/null
grep -q 'name: "smoke"' contract.cue && echo "ok: docuconf-t3 export env.mjs"
npx docuconf-t3 export env.mjs --check contract.cue 2>/dev/null && echo "ok: docuconf-t3 export --check"

cat > env.cjs <<'JS'
const { z } = require("zod");
const { createEnv } = require("@docuconf/t3");
exports.env = createEnv({
  name: "smoke-cjs",
  server: { PORT: z.coerce.number().int().min(1).max(65535).default(8080).describe("HTTP listen port") },
  runtimeEnv: process.env,
});
JS
npx docuconf-t3 export env.cjs --out contract-cjs.cue >/dev/null
grep -q 'name: "smoke-cjs"' contract-cjs.cue && echo "ok: docuconf-t3 export env.cjs"

# jiti is an optional peer: export of plain JavaScript and erasable TypeScript needs no extra package.
[ ! -e node_modules/jiti ] && echo "ok: jiti is not installed with the SDK"

# The browser build: what bundlers resolve for client components.
node --conditions=browser --input-type=module -e '
import { createEnv, duration } from "@docuconf/t3";
import { z } from "zod";
const env = createEnv({ server: { T: duration({ default: "1s" }).describe("A timeout") },
  client: { PUBLIC_X: z.string() }, clientPrefix: "PUBLIC_", runtimeEnv: { PUBLIC_X: "x" }, isServer: false });
try { env.files.x; throw new Error("env.files did not throw in the browser build"); } catch (e) { if (!/server-only/.test(e.message)) throw e; }
if (env.PUBLIC_X !== "x") throw new Error("client variable");
console.log("ok: browser build");'

node --input-type=module -e '
import { registerEnv } from "@docuconf/t3/next";
if (typeof registerEnv(async () => {}) !== "function") throw new Error("registerEnv");
console.log("ok: @docuconf/t3/next");'

