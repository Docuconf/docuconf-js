#!/usr/bin/env bash
# Installs the packed package (and @docuconf/core) into clean projects and
# uses it the way NestJS apps do:
#  - cjs/: a NestJS 11 app compiled to CommonJS by tsc, as `nest build` does,
#    loading @docuconf/nestjs through require() (also what Jest does);
#  - esm/: a NestJS 12 consumer as an .mjs ES module;
#  - `docuconf-nestjs export` on the TypeScript source and on the compiled JS.
# Run after `npm run build` of this package and @docuconf/core.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

tarball="$(cd "$root" && npm pack --silent --pack-destination "$work")"
core="$(cd "$root/../core" && npm pack --silent --pack-destination "$work")"

# ---- CommonJS: NestJS 11, compiled by tsc ---------------------------------
mkdir -p "$work/cjs/src" "$work/cjs/dev/etc/smoke/settings"
cd "$work/cjs"
echo '{ "name": "smoke-cjs", "private": true }' > package.json
npm install --silent --no-fund --no-audit "../$core" "../$tarball" \
  @nestjs/common@11 @nestjs/core@11 @nestjs/config@4 @nestjs/testing@11 \
  class-validator class-transformer reflect-metadata rxjs typescript@5 @types/node@22
cat > tsconfig.json <<'JSON'
{ "compilerOptions": { "module": "commonjs", "target": "ES2021", "outDir": "dist", "rootDir": "src",
  "experimentalDecorators": true, "emitDecoratorMetadata": true, "strict": true,
  "strictPropertyInitialization": false, "skipLibCheck": true, "esModuleInterop": true } }
JSON
cat > src/env.validation.ts <<'TS'
import { IsIn, IsInt, Max, Min } from "class-validator";
import { ConfigFile, Describe, Duration, Secret, UrlSchemes, docuconfValidate } from "@docuconf/nestjs";

export class Settings {
  @IsIn(["EUR", "USD"]) currency: string;
}

export class EnvironmentVariables {
  @IsInt() @Min(1) @Max(65535) @Describe("HTTP listen port")
  PORT: number = 3000;

  @Secret() @UrlSchemes("postgres") @Describe("Primary Postgres connection string")
  DATABASE_URL: string;

  @Duration({ default: "30s" }) @Describe("Upstream request timeout")
  REQUEST_TIMEOUT: number;

  @ConfigFile({ format: "json", path: "/etc/smoke/settings/settings.json", required: true,
    description: "Currency settings", schema: Settings })
  settings: Settings;
}

export const validate = docuconfValidate(EnvironmentVariables, { name: "smoke" });
TS
cat > src/main.ts <<'TS'
import "reflect-metadata";
import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { EnvironmentVariables, validate } from "./env.validation";

@Module({ imports: [ConfigModule.forRoot({ ignoreEnvFile: true, validate })] })
class AppModule {}

async function main() {
  const app = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const config = app.get<ConfigService<EnvironmentVariables, true>>(ConfigService);
  const port = config.get("PORT", { infer: true });
  const timeout = config.get("REQUEST_TIMEOUT", { infer: true });
  const currency = config.get("settings", { infer: true }).currency;
  if (port !== 8080 || timeout !== 30000 || currency !== "EUR") throw new Error(`unexpected: ${port} ${timeout} ${currency}`);
  console.log("ok: CommonJS NestJS 11 app via require()");
}
main().catch((e) => { console.error(String(e.message ?? e)); process.exit(1); });
TS
npx tsc -p .
node -e 'const p=require.resolve("@docuconf/nestjs"); if(!p.includes("/dist/cjs/")) throw new Error(p); console.log("ok: require() resolves the CommonJS build")'
PORT=8080 DATABASE_URL=postgres://u:p@db/x DOCUCONF_FILE_ROOT="$PWD/dev" bash -c 'echo "{\"currency\":\"EUR\"}" > dev/etc/smoke/settings/settings.json; node dist/main.js'
if PORT=abc DATABASE_URL=vault:secret/db DOCUCONF_FILE_ROOT="$PWD/dev" node dist/main.js 2>err.txt; then
  echo "expected a validation error" >&2; exit 1
fi
grep -q "PORT \[invalid_type\]" err.txt && grep -q "DATABASE_URL \[invalid_type\]: holds an unresolved vault: reference" err.txt \
  && ! grep -q "secret/db" err.txt && echo "ok: CommonJS boot validation"
npx docuconf-nestjs export src/env.validation.ts --out from-ts.cue 2>/dev/null
npx docuconf-nestjs export dist/env.validation.js --out from-js.cue 2>/dev/null
grep -q 'name: "smoke"' from-ts.cue && cmp -s from-ts.cue from-js.cue && echo "ok: docuconf-nestjs export (TypeScript source and compiled CommonJS)"
npx docuconf-nestjs export src/env.validation.ts --check from-js.cue 2>/dev/null && echo "ok: docuconf-nestjs export --check"
[ ! -e node_modules/jiti ] && echo "ok: jiti is not installed with the SDK"

# ---- ESM: NestJS 12, .mjs ---------------------------------------------------
mkdir -p "$work/esm"
cd "$work/esm"
echo '{ "name": "smoke-esm", "private": true }' > package.json
npm install --silent --no-fund --no-audit "../$core" "../$tarball" \
  @nestjs/common@12 @nestjs/core@12 @nestjs/config@12 @nestjs/testing@12 \
  class-validator class-transformer reflect-metadata rxjs
cat > main.mjs <<'JS'
import "reflect-metadata";
import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { IsInt, IsString, Max, Min } from "class-validator";
import { Describe, List, docuconfValidate, toContract } from "@docuconf/nestjs";

// Plain JavaScript has no decorator syntax: apply them by hand.
class Env {
  PORT = 3000;
}
for (const d of [IsInt(), Min(1), Max(65535), Describe("HTTP listen port")]) d(Env.prototype, "PORT");
List()(Env.prototype, "ORIGINS");
IsString({ each: true })(Env.prototype, "ORIGINS");
Describe("CORS origins")(Env.prototype, "ORIGINS");

const validate = docuconfValidate(Env, { name: "smoke-esm" });
class AppModule {}
Module({ imports: [ConfigModule.forRoot({ ignoreEnvFile: true, validate })] })(AppModule);
const app = await Test.createTestingModule({ imports: [AppModule] }).compile();
const config = app.get(ConfigService);
if (config.get("PORT") !== 8080 || config.get("ORIGINS").join("|") !== "a|b") throw new Error("unexpected values");
if (!toContract(validate).includes('name: "smoke-esm"')) throw new Error("no contract");
console.log("ok: ESM NestJS 12 consumer (.mjs)");
JS
PORT=8080 ORIGINS=a,b node main.mjs
