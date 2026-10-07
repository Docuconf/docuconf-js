# @docuconf/nestjs

The NestJS SDK for [docuconf](https://github.com/docuconf): typed configuration contracts between an application and the Kubernetes platform that runs it.

It builds on [`@nestjs/config`](https://docs.nestjs.com/techniques/configuration) rather than replacing it. You keep the `EnvironmentVariables` class from the NestJS docs, validated with class-validator, and `ConfigModule.forRoot({ validate })`. docuconf adds:

1. **Small decorators** for what class-validator has no word for: `@Describe`, `@Secret`, `@UrlSchemes`, `@Duration`, `@List`, `@Json`, and file inputs (`@ConfigFile`, `@TlsFile`, `@CaBundleFile`, `@KeystoreFile`, `@TextFile`, `@BinaryFile`).
2. **A `validate` function** for `ConfigModule.forRoot`. It reports every problem with variables *and* mounted files at once, each with a stable error code, and never prints secret values. `ConfigService` still gives typed values.
3. **Contract export.** `npx docuconf-nestjs export` turns the same class into a `contract.cue`, so the platform can reject bad configuration before it deploys.

> Status: v0.1, implementing [spec v1alpha1](https://github.com/docuconf/docuconf-go/blob/main/spec/SPEC.md). Expect breaking changes until v1.

## 1. Install

The packages are not on npm yet. Build them from a checkout and install the packed tarballs (Node 22.12 or later):

```sh
git clone https://github.com/docuconf/docuconf-js.git
(cd docuconf-js && npm ci && npm run build && npm pack -w packages/core -w packages/nestjs --pack-destination /tmp)
cd your-nest-app
npm install /tmp/docuconf-core-0.1.0.tgz /tmp/docuconf-nestjs-0.1.0.tgz @nestjs/config class-validator class-transformer
```

Install both tarballs in one command: `@docuconf/nestjs` depends on `@docuconf/core`, which npm cannot fetch yet. From the first release on, this is `npm install @docuconf/nestjs @nestjs/config class-validator class-transformer`.

Works with NestJS 11 (`@nestjs/config` 4, CommonJS) and NestJS 12 (`@nestjs/config` 12, ES modules): the package ships both builds, so `require()` and Jest load it too. Your `tsconfig.json` needs `experimentalDecorators` and `emitDecoratorMetadata`, as every Nest project has.

## 2. Declare

The class from the NestJS configuration docs, with one `@Describe` per variable and docuconf's decorators where class-validator has no word:

```ts
// src/config/env.validation.ts
import { ArrayMinSize, IsEnum, IsInt, IsString, Max, Min } from "class-validator";
import { Describe, Duration, List, Secret, UrlSchemes, docuconfValidate } from "@docuconf/nestjs";

export enum LogLevel {
  Debug = "debug",
  Info = "info",
  Warn = "warn",
  Error = "error",
}

export class EnvironmentVariables {
  @IsInt() @Min(1) @Max(65535) @Describe("Port the HTTP server listens on")
  PORT: number = 8080;

  @IsEnum(LogLevel) @Describe("Minimum log level emitted")
  LOG_LEVEL: LogLevel = LogLevel.Info;

  @Secret() @UrlSchemes("postgres") @Describe("Postgres connection string for the orders database")
  DATABASE_URL!: string;

  @List() @IsString({ each: true }) @ArrayMinSize(1) @Describe("CORS origins allowed to call the API")
  ALLOWED_ORIGINS: string[] = ["http://localhost:3000"];

  @Duration({ min: "1s", max: "5m", default: "30s" }) @Describe("Timeout for a single request")
  REQUEST_TIMEOUT!: number;

  @IsInt() @Min(1) @Max(64) @Describe("Number of background order workers")
  WORKER_COUNT: number = 4;
}

// exitOnError: on a problem, print every one and exit 1.
export const validate = docuconfValidate(EnvironmentVariables, { name: "orders", exitOnError: true });
```

Leave `NODE_ENV` out: it is a framework concern, and test runners set it to `test`, which a `development | production` enum rejects. docuconf warns when it is declared.

## 3. Run

```ts
// src/app.module.ts
import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { OrdersService } from "./orders.service";
import { validate } from "./config/env.validation";

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, validate })],
  providers: [OrdersService],
})
export class AppModule {}
```

```ts
// src/orders.service.ts
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { EnvironmentVariables } from "./config/env.validation";

@Injectable()
export class OrdersService {
  constructor(private readonly config: ConfigService<EnvironmentVariables, true>) {}

  describe(): string {
    const workers = this.config.get("WORKER_COUNT", { infer: true }); // number
    const timeout = this.config.get("REQUEST_TIMEOUT", { infer: true }); // milliseconds
    return `orders: ${workers} workers, timeout ${timeout} ms`;
  }
}
```

`ConfigService<EnvironmentVariables, true>` infers each type: `WORKER_COUNT` is a `number`, `REQUEST_TIMEOUT` is milliseconds, `ALLOWED_ORIGINS` is a `string[]`. `console.log` and `JSON.stringify` of the validated config show secrets as `[redacted]`.

```console
$ DATABASE_URL=postgres://orders:secret@localhost:5432/orders npm run start
orders: 4 workers, timeout 30000 ms
```

## 4. See an error

With `exitOnError: true`, the app prints every problem with its code and exits with status 1, before Nest starts:

```console
$ PORT=0 npm run start
docuconf: 2 configuration problems:
  - PORT [out_of_range]: must not be less than 1 (got "0")
  - DATABASE_URL [missing_required]: required, but not set
```

In Kubernetes the same lines go to `/dev/termination-log`, so `kubectl describe pod` shows them. A secret's problem names the rule, never the value: `DATABASE_URL [invalid_scheme]: scheme must be one of postgres (value hidden: secret)`. A variable that looks like a typo of a declared one gets a warning: `docuconf: WORKERS_COUNT is set but not declared; did you mean WORKER_COUNT?`.

Without `exitOnError`, `validate` throws a `DocuconfValidationError`, and Nest logs it as the same list under `[ExceptionHandler]`. Under a test runner it always throws.

## 5. Test

`validate.check(map)` validates any map as `validate` does, without throwing, reading `process.env`, writing the termination log or watching files:

```ts
// src/config/env.validation.spec.ts
import { describe, expect, it } from "vitest";
import { validate } from "./env.validation";

const deployed = { DATABASE_URL: "postgres://orders:secret@db:5432/orders" };

describe("orders configuration", () => {
  it("accepts what a deployment sets", () => {
    const { values, violations } = validate.check({ ...deployed, REQUEST_TIMEOUT: "1m30s" });
    expect(violations).toEqual([]);
    expect(values.REQUEST_TIMEOUT).toBe(90_000);
  });

  it("rejects port 0 and a missing database", () => {
    const { violations } = validate.check({ PORT: "0" });
    expect(violations.map((v) => `${v.input} ${v.code}`)).toEqual(["PORT out_of_range", "DATABASE_URL missing_required"]);
  });
});
```

`validate(map)` itself is a pure function of its input too: `expect(() => validate({ PORT: "0" })).toThrow(/PORT \[out_of_range\]/)`. For file inputs, pass a directory of test files as `validate.check(map, { fileRoot: "test/fixtures" })`.

An end-to-end test that boots `AppModule` needs the configuration a deployment would give it. Set it in the test runner's config:

```ts
// vitest.config.e2e.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.e2e-spec.ts"],
    // What ConfigModule.forRoot({ validate }) needs to boot the app under test.
    env: { DATABASE_URL: "postgres://orders:test@localhost:5432/orders_test" },
  },
});
```

With Jest, put the same variables in a `setupFiles` module that assigns `process.env`.

## 6. Export the contract

```sh
npx docuconf-nestjs export src/config/env.validation.ts --out contract.cue
# or from the build output
npx docuconf-nestjs export dist/config/env.validation.js --out contract.cue
```

The module is loaded in **export mode**: no environment is read, and a `validate` function called by `ConfigModule.forRoot()` passes its input through, so even a module that declares the class inline loads without configuration. TypeScript sources are compiled with your project's own `typescript`, with `experimentalDecorators` and `emitDecoratorMetadata`, as `nest build` does; extensionless imports and `tsconfig.json` `paths` aliases resolve. Commit `contract.cue`, and check it in CI:

```sh
npx docuconf-nestjs export src/config/env.validation.ts --check contract.cue   # exits 1 with a diff when it is out of date
```

| Option | |
|---|---|
| `--out`, `-o` | File to write. Default: stdout. |
| `--check` | Compare with this file instead of writing; exit 1 with a diff when it differs. |
| `--name`, `-n` | Service name (a DNS label). Default: `docuconfValidate`'s `name`. |
| `--app-version` | `metadata.appVersion`, such as the git SHA. |
| `--package` | CUE package name. Default: the service name with `-` replaced by `_`. |
| `--tsconfig` | The `tsconfig.json` whose `paths` aliases apply. Default: the nearest one above the module. |
| `--export` | The exported validate function to use, when the module makes several. |

`npx docuconf-nestjs docs src/config/env.validation.ts --out CONFIG.md` writes the same declaration as Markdown tables. From code:

```ts
// src/contract.ts
import { toContract } from "@docuconf/nestjs";
import { EnvironmentVariables, validate } from "./config/env.validation";

toContract(validate, { appVersion: process.env.GIT_SHA }); // the CUE text
toContract(EnvironmentVariables, { name: "orders" }); // from the class
```

## 7. Deploy

The contract is what the platform sees. CI exports `contract.cue` and publishes it with the image (SPEC §8). The platform writes typed values (`PORT: 9090`, `REQUEST_TIMEOUT: "45s"`), secret references (`DATABASE_URL: secretKeyRef: {...}`) and file sources; `docuconf vet` (from [docuconf-go](https://github.com/docuconf/docuconf-go)) checks them against the contract before anything is deployed, and `docuconf render`, or the [docuconf Helm chart](https://github.com/docuconf/docuconf-go/tree/main/helm/docuconf), turns them into env entries and volumes. At boot, `validate` checks what the platform could not see (secret contents, certificates, file contents); a failure exits 1 and lands in the termination log.

A runnable app is in [`examples/orders-nestjs`](https://github.com/docuconf/docuconf-js/tree/main/examples/orders-nestjs), with file inputs in [`examples/nestjs`](https://github.com/docuconf/docuconf-js/tree/main/examples/nestjs).

---

## Reference

### Declaring variables

Every property with class-validator decorators or `@Describe` is a variable named after the property (`DATABASE_URL`). Its contract type comes from its decorators:

| Contract type | Declare with | Property type |
|---|---|---|
| `string` | `@IsString()`, with `@MinLength`, `@MaxLength`, `@Length`, `@Matches`, `@IsNotEmpty` | `string` |
| `int` | `@IsInt()`, with `@Min`, `@Max`, `@IsPositive`, `@IsNegative` | `number`, within ±`Number.MAX_SAFE_INTEGER` |
| `float` | `@IsNumber()`, with `@Min`, `@Max` | `number` |
| `bool` | `@IsBoolean()` | `boolean` |
| `duration` | `@Duration({ min, max, default })`, Go syntax (`30s`, `1m30s`) | `number` (milliseconds) |
| `url` | `@UrlSchemes("https", ...)`, or `@IsUrl({ protocols, require_tld: false })`; `@MaxLength` | `string` |
| `enum` | `@IsEnum(StringEnum)` or `@IsIn([...])` | the enum |
| `list` | `@List({ separator })` and items `@IsString({ each: true })` or `@IsInt({ each: true })`; int items bounded with `@Min`, `@Max`, `@IsPositive`, `@IsNegative` and `{ each: true }`, string items with `@MinLength`, `@MaxLength`, `@Length` and `{ each: true }`; `@ArrayMinSize`, `@ArrayMaxSize` | `string[]` or `number[]` |
| `json` | `@Json(SomeClass, { maxLength })`, validated with that class's decorators | `SomeClass` |

- **Descriptions**: `@Describe("...")`, at least 5 characters, on every variable.
- **Required** means no `@IsOptional()` and no default. **Defaults** are property initializers (`PORT: number = 3000`), exported and checked against the variable's own constraints; for durations, `@Duration({ default: "30s" })`, an initializer in the same syntax, or one in milliseconds.
- **Secrets**: `@Secret()`. A secret cannot have a default or examples, and its value never appears in errors or when the config is printed.
- **Docs metadata**: `@Examples("eu-west-1")`, `@Group("logging")`, `@Deprecated({ message, replacedBy })`. Setting a deprecated variable logs a warning.
- **Values are parsed by docuconf, not class-transformer.** Env strings become the contract type (strict base-10 integers; `true`/`false` in any case, so `"false"` is never `true`; Go durations; lists split on the separator) before class-validator checks the instance. `@Type` and `@Transform` on variables are not applied; on `@Json` and config-file classes, `@Type` is how nested classes are found.
- **Empty strings** count as unset for every type except `string`. Values are never trimmed, except around list separators (`a, b` is `["a", "b"]`).
- **Lists** need an item type: `@List()` without `@IsString({ each: true })` or `@IsInt({ each: true })` is an error, since `emitDecoratorMetadata` cannot see it. Every bad item is reported. Int items are exported with `itemMin`/`itemMax` from `@Min(0, { each: true })` and friends, capped at ±`Number.MAX_SAFE_INTEGER` as for `int` variables; an item outside them is `out_of_range`.
- **Length limits** for fixed-width fields: `@MaxLength(n)` on a `url` is exported as `maxLength`, `@Json(SomeClass, { maxLength })` bounds a `json` value as received (whitespace included, before parsing), and `@MinLength(n, { each: true })`/`@MaxLength(n, { each: true })` (or `@Length(min, max, { each: true })`) on a string list become `itemMinLength`/`itemMaxLength`, checked on each item after splitting. They count characters (Unicode code points): `日本` is 2, an emoji is 1. A value outside them is `out_of_range`; a secret's error gives its length, never its value. Item lengths on an int list, or a minimum above the maximum, are declaration errors.
- **Patterns** (`@Matches`) are RE2 and match anywhere in the value; anchor with `^...$`. Lookaround, backreferences and flags other than `g`/`u` are rejected.
- **Constraints the contract cannot express** (`@IsEmail()`, custom validators) are still checked at boot, with a warning that the platform cannot see them. `@IsUrl()` warns too: by default it rejects hosts without a top-level domain (`localhost`, `db`), which the contract cannot say; use `@UrlSchemes(...)` or `@IsUrl({ require_tld: false })`.
- **Constraints that do not fit the type** (`@MinLength` on an `@IsInt`, `@Min` on a `@Duration`) are errors, not dropped.
- **Undecorated properties are invisible** to docuconf: they are not exported or validated. One with a default is an error, since the app could read it through `ConfigService` while the contract leaves it out.
- **`@IsPositive` on a float** is exported as the smallest double above 0, so the platform rejects exactly what the app does.
- **Feature flags**: names starting `FF_`, `FEATURE_`, `FEATURE_FLAG_` or `ENABLE_` produce a warning (SPEC §10). So does `NODE_ENV`.
- Without class-validator type decorators, a `string`, `number` or `boolean` property type (from `emitDecoratorMetadata`) gives `string`, `float` or `bool`.

Problems with the declaration itself (bad names, short descriptions, non-RE2 patterns, a default that breaks its own constraints, file mount clashes) throw `DocuconfDeclarationError` when `docuconfValidate` is called, in both boot and export mode. With `exitOnError`, they print and exit 1 too.

The object `validate` returns is an instance of your class, like the one in the NestJS docs: typed values, plus the variables the class does not declare. Nest copies its string, number and boolean values to `process.env`; durations (milliseconds are not a Go duration) and file inputs are kept out of that copy.

### `docuconfValidate` options

| Option | |
|---|---|
| `name` | Service name for the contract, a DNS label. |
| `appVersion` | `metadata.appVersion` for the contract. |
| `exitOnError` | On invalid configuration, print the problems and exit 1 instead of throwing. Under a test runner it throws. |
| `fileRoot` | Prefix for absolute file paths. Default: `DOCUCONF_FILE_ROOT`, also read from a `.env` file. |
| `terminationLog` | Where to write violations. Default: `DOCUCONF_TERMINATION_LOG`, else `/dev/termination-log` when it exists. `false` disables. |
| `onWarning` | Receives hints (feature flags, deprecated variables, constraints the contract cannot express, likely typos). Default: `console.warn`. |
| `watch` | Watch `reload: "watch"` file inputs. Default `true`. |

### File inputs

```ts
// src/files.ts
import { IsIn, IsInt, Min } from "class-validator";
import { ConfigFile, TlsFile, type TlsMaterial } from "@docuconf/nestjs";

export class Settings {
  @IsIn(["EUR", "USD"]) currency!: string;
  @IsInt() @Min(1) maxItemsPerOrder!: number;
}

export class FileInputs {
  @ConfigFile({ format: "json", path: "/etc/orders/config/settings.json", required: true, reload: "watch",
    description: "Business settings: currency and order limits", schema: Settings })
  settings!: Settings;

  @TlsFile({ path: "/etc/orders/tls", description: "Certificate the API serves HTTPS with",
    dnsNames: ["orders.internal"], minRemaining: "168h" })
  tls?: TlsMaterial;
}
```

| Decorator | Contract type | Property |
|---|---|---|
| `@ConfigFile({ format: "json" \| "yaml", schema })` | `config`; `schema` is a class-validator class (or a Zod schema), and its JSON Schema goes into the contract | the validated instance |
| `@TlsFile({ dnsNames, keyAlgorithms, minRemaining, requireCA })` | `tls` (a `kubernetes.io/tls` directory) | `TlsMaterial`: `{ cert, key, ca }`, `certificate`, `getSecureContext()`, `attach(server)`, `onChange()` |
| `@CaBundleFile({ minCertificates })` | `caBundle` | `CaBundle`: `{ ca }` PEM, plus `certificates` |
| `@KeystoreFile({ format: "pkcs12", passwordVar })` | `keystore` | `Keystore`: `{ pfx, passphrase }` |
| `@TextFile({ pattern, minLength, maxLength })` | `text` | `string` |
| `@BinaryFile()` | `binary` | `Buffer` |

Every file decorator takes `path`, `description`, `required`, `pathEnv`, `reload: "restart" | "watch"`, `maxSize`, `group`, `deprecated`, and `name`: the input name in the contract, by default the property name in kebab case (`servingTls` is `serving-tls`). Optional inputs that are absent are `undefined`.

Checks at boot (SPEC §11.2 item 7): the file exists, is readable and within `maxSize`; config files parse (a BOM is accepted) and validate against their class, with the failing path in the message (a missing field says `required`); TLS key pairs parse and match, are valid now with at least `minRemaining` left, cover every `dnsNames` entry, use an allowed key algorithm and, with `requireCA`, chain to `ca.crt` (using `node:crypto`); CA bundles hold at least `minCertificates` certificates; PKCS#12 keystores open with the password in `passwordVar` (JKS: magic number only); text files match their constraints.

`reload: "watch"` inputs are re-read when their mount directory changes (Kubernetes swaps a `..data` symlink). A reload that fails its checks is logged and the previous value kept. File properties are getters, so `ConfigService.get("settings")` returns the current value (unless you turned on `ConfigModule`'s `cache`). To react to a change:

```ts
// src/reload.ts
import type { Server } from "node:https";
import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { docuconfValidate } from "@docuconf/nestjs";
import { FileInputs, type Settings } from "./files";

export const validate = docuconfValidate(FileInputs, { name: "orders" });

export function watch(config: ConfigService<FileInputs, true>, httpsServer: Server, logger: Logger): void {
  validate.onFileChange("settings", (settings) => logger.log(`now selling in ${(settings as Settings).currency}`));
  config.get("tls", { infer: true })?.attach(httpsServer); // serve renewed certificates without a restart
}
```

### Error codes

`missing_required`, `invalid_type`, `out_of_range`, `pattern_mismatch`, `not_in_enum`, `invalid_scheme`, `too_few_items`, `too_many_items`, `file_missing`, `file_unreadable`, `file_too_large`, `file_malformed`, `schema_mismatch`, `certificate_invalid`, `certificate_expiring`, `certificate_name_mismatch`, `key_mismatch`, `keystore_unreadable`.

`DocuconfValidationError.violations` and `validate.check(...).violations` hold `{ input, kind, code, message }` for each.

### Kubernetes and local development

| Variable | Effect |
|---|---|
| `DOCUCONF_FILE_ROOT` | Prefix for absolute file paths (including paths from `pathEnv`), so `/etc/orders/tls` is read from `$DOCUCONF_FILE_ROOT/etc/orders/tls`. For local development and tests. Also read from a `.env` file, and the `fileRoot` option. A missing file's message suggests it when it is not set. |
| `DOCUCONF_TERMINATION_LOG` | Where to write violations. By default they go to `/dev/termination-log` when it exists, so `kubectl describe pod` shows why the pod failed. The `terminationLog` option overrides it; `false` disables it. |

### Injected secrets

Platforms that supply values when the container starts, such as Bank-Vaults' `vault-env`, `op run` or an operator (SPEC §4.5.1), need nothing special: `ConfigModule` hands `validate` the process environment as it is at start, after injection, and injected values are validated like any other. docuconf never resolves references itself.

If the injector did not run, a secret variable still holds the raw reference. A secret whose value starts with `vault:`, `op://` or `ref+` fails with `invalid_type`, naming the reference scheme but never the value:

```
DATABASE_URL [invalid_type]: holds an unresolved vault: reference; the injector that should resolve it did not run
```

### Config-file overlays

Not supported, by design. Node does not layer configuration files (base, profile, overlay, environment) the way .NET or Spring do, so there is nothing for a platform-mounted overlay (SPEC §4.7) to slot into, and this SDK has no overlay API. Contracts it exports never declare `overlays`. `ConfigModule`'s `.env` files are a development convenience, and real environment variables override them.

### Zod or Joi instead of class-validator

- **Zod**: use [`@docuconf/t3`](https://github.com/docuconf/docuconf-js/tree/main/packages/t3) to declare the environment, and its `createEnv` as the validate function: `validate: (config) => createEnv({ name: "orders-api", server, runtimeEnv: config })`. Config-file schemas in `@ConfigFile` may also be Zod schemas.
- **Joi** (`validationSchema`) has no JSON Schema export docuconf can build a contract from. Move the declaration to a class-validator class or Zod.

## Development

This package lives in the [docuconf-js](https://github.com/docuconf/docuconf-js) npm workspace, next to `@docuconf/core` (the shared contract writer, file checks and violations) and `@docuconf/t3`. From the repository root:

```sh
npm ci
npm run typecheck
npm test        # vets exported contracts with cue when it is installed
npm run build
npm run smoke   # installs the packed packages into clean NestJS 11 (CommonJS) and 12 (ESM) projects
```

Every TypeScript block in this README is a file under [`readme/`](readme): the typecheck compiles them, the `.spec.ts` runs with the tests, the app in it is started with valid and invalid configuration, and a test fails when a block here differs from its file.

Releases are published to npm from CI; see [RELEASING.md](https://github.com/docuconf/docuconf-js/blob/main/RELEASING.md).

## Licence

[MIT](https://github.com/docuconf/docuconf-js/blob/main/LICENSE).
