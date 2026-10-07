# @docuconf/nestjs

The NestJS SDK for [docuconf](https://github.com/docuconf): typed configuration contracts between an application and the Kubernetes platform that runs it.

It builds on [`@nestjs/config`](https://docs.nestjs.com/techniques/configuration) rather than replacing it. You keep the `EnvironmentVariables` class from the NestJS docs, validated with class-validator, and `ConfigModule.forRoot({ validate })`. docuconf adds:

1. **Small decorators** for what class-validator has no word for: `@Describe`, `@Secret`, `@UrlSchemes`, `@Duration`, `@List`, `@Json`, and file inputs (`@ConfigFile`, `@TlsFile`, `@CaBundleFile`, `@KeystoreFile`, `@TextFile`, `@BinaryFile`).
2. **A `validate` function** for `ConfigModule.forRoot`. It reports every problem with variables *and* mounted files at once, each with a stable error code, and never prints secret values. `ConfigService` still gives typed values.
3. **Contract export.** `npx docuconf-nestjs export` turns the same class into a `contract.cue`, so the platform can reject bad configuration before it deploys.

> Status: v0.1, implementing [spec v1alpha1](https://github.com/docuconf/docuconf-go/blob/main/spec/SPEC.md). Expect breaking changes until v1.

## Install

```sh
npm install @docuconf/nestjs @nestjs/config class-validator class-transformer
```

Requires Node 22.12 or later. Works with NestJS 11 (`@nestjs/config` 4, CommonJS) and NestJS 12 (`@nestjs/config` 12, ES modules): the package ships both an ES module and a CommonJS build, so `require()` and Jest load it too. Your `tsconfig.json` needs `experimentalDecorators` and `emitDecoratorMetadata`, as every Nest project has.

## Example

```ts
// src/config/env.validation.ts
import { IsEnum, IsIn, IsInt, IsOptional, IsString, Max, Min } from "class-validator";
import { ConfigFile, Describe, Duration, List, Secret, TlsFile, type TlsMaterial, UrlSchemes, docuconfValidate } from "@docuconf/nestjs";

export enum Environment { Development = "development", Production = "production" }

export class Settings {
  @IsIn(["EUR", "USD"]) currency: string;
  @IsInt() @Min(1) maxItemsPerOrder: number;
}

export class EnvironmentVariables {
  @IsEnum(Environment) @Describe("Environment the app runs in")
  NODE_ENV: Environment = Environment.Production;

  @IsInt() @Min(1) @Max(65535) @Describe("Port the API listens on")
  PORT: number = 3000;

  @Secret() @UrlSchemes("postgres") @Describe("Primary Postgres connection string")
  DATABASE_URL: string;

  @Duration({ default: "30s", max: "5m" }) @Describe("Timeout for upstream requests")
  REQUEST_TIMEOUT: number;

  @IsOptional() @List() @IsString({ each: true }) @Describe("CORS origins allowed to call the API")
  ALLOWED_ORIGINS?: string[];

  @ConfigFile({ format: "json", path: "/etc/orders/config/settings.json", required: true, reload: "watch",
    description: "Business settings: currency and order limits", schema: Settings })
  settings: Settings;

  @TlsFile({ path: "/etc/orders/tls", description: "Certificate the API serves HTTPS with",
    dnsNames: ["orders.internal"], minRemaining: "168h" })
  tls?: TlsMaterial;
}

export const validate = docuconfValidate(EnvironmentVariables, { name: "orders-api" });
```

```ts
// src/app.module.ts
import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { validate } from "./config/env.validation";

@Module({ imports: [ConfigModule.forRoot({ isGlobal: true, validate })] })
export class AppModule {}
```

```ts
// anywhere
constructor(private readonly config: ConfigService<EnvironmentVariables, true>) {}

this.config.get("PORT", { infer: true });            // number
this.config.get("REQUEST_TIMEOUT", { infer: true }); // milliseconds
this.config.get("settings", { infer: true });        // a validated Settings instance
```

A runnable app is in [`examples/nestjs`](https://github.com/docuconf/docuconf-js/tree/main/examples/nestjs).

If anything is wrong, the app does not start. Nest logs a `DocuconfValidationError` listing every problem:

```
docuconf: 3 configuration problems:
  - PORT [out_of_range]: must not be greater than 65535 (got "70000")
  - DATABASE_URL [missing_required]: required, but not set
  - settings [file_missing]: /etc/orders/config/settings.json not found
```

## Export the contract

```sh
npx docuconf-nestjs export src/config/env.validation.ts --out contract.cue
# or from the build output
npx docuconf-nestjs export dist/config/env.validation.js --out contract.cue
```

| Option | |
|---|---|
| `--out`, `-o` | File to write. Default: stdout. |
| `--name`, `-n` | Service name (a DNS label). Default: `docuconfValidate`'s `name`. |
| `--app-version` | `metadata.appVersion`, such as the git SHA. |
| `--package` | CUE package name. Default: the service name with `-` replaced by `_`. |
| `--export` | The exported validate function to use, when the module makes several. |

The module is loaded in **export mode**: no environment is read, and a `validate` function called by `ConfigModule.forRoot()` passes its input through, so even a module that declares the class inline loads without configuration. Keeping the class in its own file, as above, is still the fastest.

TypeScript sources are compiled with your project's own `typescript` package, with `experimentalDecorators` and `emitDecoratorMetadata`, as `nest build` does. Relative imports may omit extensions.

From code:

```ts
import { toContract } from "@docuconf/nestjs";

toContract(validate, { appVersion: process.env.GIT_SHA });           // the CUE text
toContract(EnvironmentVariables, { name: "orders-api" });            // from the class
```

The output uses `generator.language: "typescript"` and `sdk: "@docuconf/nestjs"`, with variables and files sorted by name.

## Declaring variables

Every property with class-validator decorators or `@Describe` is a variable named after the property (`DATABASE_URL`). Its contract type comes from its decorators:

| Contract type | Declare with | Property type |
|---|---|---|
| `string` | `@IsString()`, with `@MinLength`, `@MaxLength`, `@Length`, `@Matches`, `@IsNotEmpty` | `string` |
| `int` | `@IsInt()`, with `@Min`, `@Max`, `@IsPositive`, `@IsNegative` | `number`, within ±`Number.MAX_SAFE_INTEGER` |
| `float` | `@IsNumber()`, with `@Min`, `@Max` | `number` |
| `bool` | `@IsBoolean()` | `boolean` |
| `duration` | `@Duration({ min, max, default })`, Go syntax (`30s`, `1m30s`) | `number` (milliseconds) |
| `url` | `@UrlSchemes("https", ...)`, or `@IsUrl({ protocols })`; `@MaxLength` | `string` |
| `enum` | `@IsEnum(StringEnum)` or `@IsIn([...])` | the enum |
| `list` | `@List({ separator })`; items `@IsString({ each: true })` or `@IsInt({ each: true })`, int items bounded with `@Min`, `@Max`, `@IsPositive`, `@IsNegative` and `{ each: true }`, string items with `@MinLength`, `@MaxLength`, `@Length` and `{ each: true }`; `@ArrayMinSize`, `@ArrayMaxSize` | `string[]` or `number[]` |
| `json` | `@Json(SomeClass, { maxLength })`, validated with that class's decorators | `SomeClass` |

- **Descriptions**: `@Describe("...")`, at least 5 characters, on every variable.
- **Required** means no `@IsOptional()` and no default. **Defaults** are property initializers (`PORT: number = 3000`), exported and checked against the variable's own constraints; for durations, `@Duration({ default: "30s" })` (or an initializer in milliseconds).
- **Secrets**: `@Secret()`. A secret cannot have a default or examples, and its value never appears in errors.
- **Docs metadata**: `@Examples("eu-west-1")`, `@Group("logging")`, `@Deprecated({ message, replacedBy })`. Setting a deprecated variable logs a warning.
- **Values are parsed by docuconf, not class-transformer.** Env strings become the contract type (strict base-10 integers; `true`/`false` in any case, so `"false"` is never `true`; Go durations; lists split on the separator) before class-validator checks the instance. `@Type` and `@Transform` on variables are not applied; on `@Json` and config-file classes, `@Type` is how nested classes are found.
- **Empty strings** count as unset for every type except `string`. Values are never trimmed.
- **Int list items** are exported with `itemMin`/`itemMax` from `@Min(0, { each: true })` and friends, capped at ±`Number.MAX_SAFE_INTEGER` as for `int` variables; an item outside them is `out_of_range`.
- **Length limits** for fixed-width fields: `@MaxLength(n)` on a `url` is exported as `maxLength`, `@Json(SomeClass, { maxLength })` bounds a `json` value as received (whitespace included, before parsing), and `@MinLength(n, { each: true })`/`@MaxLength(n, { each: true })` (or `@Length(min, max, { each: true })`) on a string list become `itemMinLength`/`itemMaxLength`, checked on each item after splitting. They count characters (Unicode code points): `日本` is 2, an emoji is 1. A value outside them is `out_of_range`; a secret's error gives its length, never its value. Item lengths on an int list, or a minimum above the maximum, are declaration errors.
- **Patterns** (`@Matches`) are RE2 and match anywhere in the value; anchor with `^...$`. Lookaround, backreferences and flags other than `g`/`u` are rejected.
- **Constraints the contract cannot express** (`@IsEmail()`, custom validators) are still checked at boot, with a warning that the platform cannot see them.
- **Feature flags**: names starting `FF_`, `FEATURE_`, `FEATURE_FLAG_` or `ENABLE_` produce a warning (SPEC §10).
- Without class-validator type decorators, a `string`, `number` or `boolean` property type (from `emitDecoratorMetadata`) gives `string`, `float` or `bool`.

Problems with the declaration itself (bad names, short descriptions, non-RE2 patterns, a default that breaks its own constraints, file mount clashes) throw `DocuconfDeclarationError` when `docuconfValidate` is called, in both boot and export mode.

The object `validate` returns is an instance of your class, like the one in the NestJS docs: typed values, plus the variables the class does not declare. Nest copies its string, number and boolean values to `process.env`; durations (milliseconds are not a Go duration) and file inputs are kept out of that copy.

## File inputs

| Decorator | Contract type | Property |
|---|---|---|
| `@ConfigFile({ format: "json" \| "yaml", schema })` | `config`; `schema` is a class-validator class (or a Zod schema), and its JSON Schema goes into the contract | the validated instance |
| `@TlsFile({ dnsNames, keyAlgorithms, minRemaining, requireCA })` | `tls` (a `kubernetes.io/tls` directory) | `TlsMaterial`: `{ cert, key, ca }`, `certificate`, `getSecureContext()`, `attach(server)`, `onChange()` |
| `@CaBundleFile({ minCertificates })` | `caBundle` | `CaBundle`: `{ ca }` PEM, plus `certificates` |
| `@KeystoreFile({ format: "pkcs12", passwordVar })` | `keystore` | `Keystore`: `{ pfx, passphrase }` |
| `@TextFile({ pattern, minLength, maxLength })` | `text` | `string` |
| `@BinaryFile()` | `binary` | `Buffer` |

Every file decorator takes `path`, `description`, `required`, `pathEnv`, `reload: "restart" | "watch"`, `maxSize`, `group`, `deprecated`, and `name`: the input name in the contract, by default the property name in kebab case (`servingTls` is `serving-tls`). Optional inputs that are absent are `undefined`.

Checks at boot (SPEC §11.2 item 7): the file exists, is readable and within `maxSize`; config files parse (a BOM is accepted) and validate against their class, with the failing path in the message; TLS key pairs parse and match, are valid now with at least `minRemaining` left, cover every `dnsNames` entry, use an allowed key algorithm and, with `requireCA`, chain to `ca.crt` (using `node:crypto`); CA bundles hold at least `minCertificates` certificates; PKCS#12 keystores open with the password in `passwordVar` (JKS: magic number only); text files match their constraints.

`reload: "watch"` inputs are re-read when their mount directory changes (Kubernetes swaps a `..data` symlink). A reload that fails its checks is logged and the previous value kept. File properties are getters, so `ConfigService.get("settings")` returns the current value (unless you turned on `ConfigModule`'s `cache`). To react to a change:

```ts
validate.onFileChange("settings", (settings) => logger.log(`now selling in ${settings.currency}`));
config.get("tls", { infer: true })?.attach(httpsServer); // serve renewed certificates without a restart
```

## Injected secrets

Platforms that supply values when the container starts, such as Bank-Vaults' `vault-env`, `op run` or an operator (SPEC §4.5.1), need nothing special: `ConfigModule` hands `validate` the process environment as it is at start, after injection, and injected values are validated like any other. docuconf never resolves references itself.

If the injector did not run, a secret variable still holds the raw reference. A secret whose value starts with `vault:`, `op://` or `ref+` fails with `invalid_type`, naming the reference scheme but never the value:

```
DATABASE_URL [invalid_type]: holds an unresolved vault: reference; the injector that should resolve it did not run
```

## Config-file overlays

Not supported, by design. Node does not layer configuration files (base, profile, overlay, environment) the way .NET or Spring do, so there is nothing for a platform-mounted overlay (SPEC §4.7) to slot into, and this SDK has no overlay API. Contracts it exports never declare `overlays`. `ConfigModule`'s `.env` files are a development convenience, and real environment variables override them.

## Zod or Joi instead of class-validator

- **Zod**: use [`@docuconf/t3`](https://www.npmjs.com/package/@docuconf/t3) to declare the environment, and its `createEnv` as the validate function: `validate: (config) => createEnv({ name: "orders-api", server, runtimeEnv: config })`. Config-file schemas in `@ConfigFile` may also be Zod schemas.
- **Joi** (`validationSchema`) has no JSON Schema export docuconf can build a contract from. Move the declaration to a class-validator class or Zod.

## Error codes

`missing_required`, `invalid_type`, `out_of_range`, `pattern_mismatch`, `not_in_enum`, `invalid_scheme`, `too_few_items`, `too_many_items`, `file_missing`, `file_unreadable`, `file_too_large`, `file_malformed`, `schema_mismatch`, `certificate_invalid`, `certificate_expiring`, `certificate_name_mismatch`, `key_mismatch`, `keystore_unreadable`.

`DocuconfValidationError.violations` holds `{ input, kind, code, message }` for each.

## Kubernetes and local development

| Variable | Effect |
|---|---|
| `DOCUCONF_FILE_ROOT` | Prefix for absolute file paths (including paths from `pathEnv`), so `/etc/orders/tls` is read from `$DOCUCONF_FILE_ROOT/etc/orders/tls`. For local development and tests. Also read from a `.env` file, and the `fileRoot` option. |
| `DOCUCONF_TERMINATION_LOG` | Where to write violations. By default they go to `/dev/termination-log` when it exists, so `kubectl describe pod` shows why the pod failed. The `terminationLog` option overrides it; `false` disables it. |

Other `docuconfValidate` options: `onWarning` (default `console.warn`) and `watch: false` to never watch files.

## Development

This package lives in the [docuconf-js](https://github.com/docuconf/docuconf-js) npm workspace, next to `@docuconf/core` (the shared contract writer, file checks and violations) and `@docuconf/t3`. From the repository root:

```sh
npm ci
npm run typecheck
npm test        # vets exported contracts with cue when it is installed
npm run build
npm run smoke   # installs the packed packages into clean NestJS 11 (CommonJS) and 12 (ESM) projects
```

Releases are published to npm from CI; see [RELEASING.md](https://github.com/docuconf/docuconf-js/blob/main/RELEASING.md).

## Licence

[MIT](https://github.com/docuconf/docuconf-js/blob/main/LICENSE).
