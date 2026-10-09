# @docuconf/t3

The TypeScript SDK for [docuconf](https://github.com/docuconf): typed configuration contracts between an application and the Kubernetes platform that runs it.

It extends [T3 Env](https://env.t3.gg) rather than replacing it. You keep writing `createEnv({ server: {...} })` with Zod 4. docuconf adds three things:

1. **Declaration metadata** T3 has no field for: `secret`, Go durations, CSV lists, URL schemes, and file inputs (config files, TLS key pairs, CA bundles, keystores).
2. **Boot validation.** Every problem with variables *and* mounted files is reported at once, each with a stable error code. Secret values are never printed.
3. **Contract export.** `docuconf-t3 export` turns the same declaration into a `contract.cue`, so the platform can reject bad configuration before it deploys.

> Status: v0.1, implementing [spec v1alpha1](https://github.com/docuconf/docuconf-go/blob/main/spec/SPEC.md). Expect breaking changes until v1.

Using Next.js? Read the steps below, then [Next.js](#nextjs).

## 1. Install

The packages are not on npm yet. Build them from a checkout and install the packed tarballs (Node 22.12 or later):

```sh
git clone https://github.com/docuconf/docuconf-js.git
(cd docuconf-js && npm ci && npm run build && npm pack -w packages/core -w packages/t3 --pack-destination /tmp)
cd your-app
npm install /tmp/docuconf-core-0.1.0.tgz /tmp/docuconf-t3-0.1.0.tgz @t3-oss/env-core zod
```

Install both tarballs in one command: `@docuconf/t3` depends on `@docuconf/core`, which npm cannot fetch yet. From the first release on, this is `npm install @docuconf/t3 @t3-oss/env-core zod`.

## 2. Declare

```ts
// src/env.ts
import { z } from "zod";
import { createEnv, duration, list, secret, url } from "@docuconf/t3";

export const env = createEnv({
  name: "orders",
  server: {
    PORT: z.coerce.number().int().min(1).max(65535).default(8080).describe("Port the HTTP server listens on"),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info").describe("Minimum log level emitted"),
    DATABASE_URL: secret(url({ schemes: ["postgres"] })).describe("Postgres connection string for the orders database"),
    ALLOWED_ORIGINS: list(z.string(), { minItems: 1 }).default(["http://localhost:3000"]).describe("CORS origins allowed to call the API"),
    REQUEST_TIMEOUT: duration({ min: "1s", max: "5m", default: "30s" }).describe("Timeout for a single request"),
    WORKER_COUNT: z.coerce.number().int().min(1).max(64).default(4).describe("Number of background order workers"),
  },
  runtimeEnv: process.env,
  exitOnError: true, // on a problem: print every one and exit 1
  skipValidation: process.env.SKIP_ENV_VALIDATION === "1", // for tests, which use checkEnv
});
```

Every variable needs a description (`.describe()`) of at least 5 characters. `secret`, `url`, `list` and `duration` are docuconf's; the rest is Zod. [Declaring variables](#declaring-variables) has the full table.

## 3. Run

```ts
// src/server.ts
import { createServer } from "node:http";
import { env } from "./env.ts";

createServer((req, res) => res.end(`orders: ${env.WORKER_COUNT} workers, timeout ${env.REQUEST_TIMEOUT} ms\n`)).listen(env.PORT);
```

```console
$ DATABASE_URL=postgres://orders:secret@localhost:5432/orders node src/server.ts &
$ curl localhost:8080
orders: 4 workers, timeout 30000 ms
```

Values are typed: `env.PORT` is a `number`, `env.REQUEST_TIMEOUT` is milliseconds, `env.ALLOWED_ORIGINS` is a `string[]`. `console.log(env)` and `JSON.stringify(env)` show secrets as `[redacted]`.

## 4. See an error

With `exitOnError: true`, the app prints every problem with its code and exits with status 1, before it listens:

```console
$ PORT=0 node src/server.ts
docuconf: 2 configuration problems:
  - PORT [out_of_range]: Too small: expected number to be >=1 (got "0")
  - DATABASE_URL [missing_required]: required, but not set
```

In Kubernetes the same lines go to `/dev/termination-log`, so `kubectl describe pod` shows them. A secret's problem names the rule, never the value: `DATABASE_URL [invalid_scheme]: scheme must be one of postgres (value hidden: secret)`. A variable that looks like a typo of a declared one gets a warning: `docuconf: WORKERS_COUNT is set but not declared; did you mean WORKER_COUNT?`.

Without `exitOnError`, `createEnv` throws a `DocuconfValidationError` with the same message and a `violations` array; under a test runner it always throws.

## 5. Test

`checkEnv(env, map)` validates any map against the declaration, without reading `process.env`, throwing, or writing the termination log. Skip boot validation in tests, as T3 Env does:

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { env: { SKIP_ENV_VALIDATION: "1" } },
});
```

```ts
// src/env.test.ts
import { checkEnv } from "@docuconf/t3";
import { describe, expect, it } from "vitest";
import { env } from "./env.ts";

const deployed = { DATABASE_URL: "postgres://orders:secret@db:5432/orders" };

describe("orders configuration", () => {
  it("accepts what a deployment sets", () => {
    const { values, violations } = checkEnv(env, { ...deployed, REQUEST_TIMEOUT: "1m30s" });
    expect(violations).toEqual([]);
    expect(values.REQUEST_TIMEOUT).toBe(90_000);
  });

  it("rejects port 0 and a missing database", () => {
    const { violations } = checkEnv(env, { PORT: "0" });
    expect(violations.map((v) => `${v.input} ${v.code}`)).toEqual(["PORT out_of_range", "DATABASE_URL missing_required"]);
  });
});
```

For file inputs, pass a directory of test files as `checkEnv(env, map, { fileRoot: "test/fixtures" })`.

## 6. Export the contract

```sh
npx docuconf-t3 export src/env.ts --out contract.cue
```

The module is imported in **export mode**: `createEnv` records the declaration and skips validation and file loading, so no environment is needed. Keep `createEnv` in its own module, as above, so exporting it does not start your server. Commit `contract.cue`, and check it in CI:

```sh
npx docuconf-t3 export src/env.ts --check contract.cue   # exits 1 with a diff when it is out of date
```

| Option | |
|---|---|
| `--out`, `-o` | File to write. Default: stdout. |
| `--check` | Compare with this file instead of writing; exit 1 with a diff when it differs. |
| `--name`, `-n` | Service name (a DNS label). Default: `createEnv`'s `name`. |
| `--app-version` | `metadata.appVersion`, such as the git SHA. |
| `--package` | CUE package name. Default: the service name with `-` replaced by `_`. |
| `--tsconfig` | The `tsconfig.json` whose `paths` aliases apply. Default: the nearest one above the module. |

`npx docuconf-t3 docs src/env.ts --out CONFIG.md` writes the same declaration as Markdown tables. For full documentation, with each input's details, run `docuconf docs` on the exported contract (see [Descriptions and details](#descriptions-and-details)).

TypeScript modules load with Node's type stripping (Node 22.18+), with `tsconfig.json` `paths` aliases (`@/lib/schemas`) and extensionless imports resolved as TypeScript does. For syntax Node cannot strip (enums, namespaces) or older Node, install [jiti](https://github.com/unjs/jiti) as a dev dependency (`npm install --save-dev jiti`) and the CLI uses it. Plain `.mjs` and `.cjs` modules work too.

## 7. Deploy

The contract is what the platform sees:

```
 app repo (CI)                                     platform (GitOps)
 src/env.ts ──docuconf-t3 export──▶ contract.cue ──▶ #Validate(values, file sources, policy) ──▶ #Render
                                                                                                │
 createEnv() at boot ◀──── env vars, mounted Secrets and ConfigMaps ◀───────────────────────────┘
```

1. CI exports `contract.cue` and publishes it with the image (SPEC §8).
2. The platform writes typed values (`PORT: 9090`, `REQUEST_TIMEOUT: "45s"`), secret references (`DATABASE_URL: secretKeyRef: {...}`) and file sources. `docuconf vet` (from [docuconf-go](https://github.com/docuconf/docuconf-go)) checks them against the contract before anything is deployed, and `docuconf render`, or the [docuconf Helm chart](https://github.com/docuconf/docuconf-go/tree/main/helm/docuconf), turns them into env entries in the encoding this SDK parses (`duration` as Go syntax, `list` as `csv`) and volumes at the declared paths.
3. At boot `createEnv` checks what the platform could not see: secret contents, certificate expiry and key match, file contents. A failure exits 1 and lands in the termination log.

## Next.js

`@docuconf/t3` works with the App Router: validation at server start, nothing at build time, and one `env.ts` for server and client components. [`examples/next-t3`](https://github.com/docuconf/docuconf-js/tree/main/examples/next-t3) is a complete app, built and started in CI.

**Validate when the server starts.** Next.js calls `register()` in `instrumentation.ts` once per server. `registerEnv` imports your env module there and, if the configuration is wrong, prints the problems and exits 1, so the pod fails to start instead of serving 500s:

```ts
// src/instrumentation.ts
// Next.js calls register() once when the server starts: validate the
// environment then, and exit 1 with every problem if it is wrong.
import { registerEnv } from "@docuconf/t3/next";

export const register = registerEnv(() => import("./env"));
```

**`next build` needs no server configuration.** `createEnv` skips validation while `NEXT_PHASE` is `phase-production-build`; configuration is read when the server starts, never at build time. `NEXT_PUBLIC_` variables are the exception: Next.js inlines them into the browser bundle at build time, so they are build inputs, not part of the contract.

**Pages that read `env` must be dynamic**, or Next.js prerenders them at build time and freezes the values it saw then. Call `await connection()` (or `export const dynamic = "force-dynamic"`):

```tsx
import { connection } from "next/server";
import { env } from "@/env";
import { ApiBase } from "./api-base";

// Reads env at request time: without this, `next build` would prerender
// the page and freeze the values it saw then.
export default async function Page() {
  await connection();
  const { LOG_LEVEL, ALLOWED_ORIGINS, REQUEST_TIMEOUT, WORKER_COUNT } = env;
```

**Client components can import the same `env.ts`.** In the browser and the Edge runtime, bundlers resolve `@docuconf/t3` to a build with no Node built-ins, where `createEnv` is T3's own: client variables are validated by T3, server variables throw on access, and `env.files` is server-only. Next.js only inlines `process.env.NEXT_PUBLIC_*` written out in full, so list them in `runtimeEnv`:

```ts
  // Inlined into the browser bundle by `next build`: not runtime configuration.
  clientPrefix: "NEXT_PUBLIC_",
  client: {
    NEXT_PUBLIC_API_BASE: z.url().describe("Public base URL of the API"),
  },
  // Next.js only inlines process.env.NEXT_PUBLIC_* written out in full.
  runtimeEnv: { ...process.env, NEXT_PUBLIC_API_BASE: process.env.NEXT_PUBLIC_API_BASE },
```

`docuconf-t3 export src/env.ts` follows the `@/*` alias from `tsconfig.json`, and prints no warning for the `package.json` without `"type"` that Next.js apps have.

---

## Reference

### Declaring variables

Only the `server` section is runtime configuration. T3's `client` section (and `shared`) is inlined at build time, so it is never exported (SPEC §11.1); it is still validated as T3 would.

| Contract type | Declare with | Value |
|---|---|---|
| `string` | `z.string()`, with `.min()`, `.max()`, `.regex()` | `string` |
| `int` | `z.coerce.number().int()`, with `.min()`, `.max()` | `number`, within ±`Number.MAX_SAFE_INTEGER` |
| `int` (64-bit) | `int64({ min, max })` | `number` within ±`Number.MAX_SAFE_INTEGER`, exact `bigint` beyond |
| `float` | `z.coerce.number()` | `number` |
| `bool` | `z.stringbool()` | `boolean` |
| `duration` | `duration({ min, max, default })`, Go syntax (`30s`, `1m30s`) | milliseconds |
| `url` | `url({ schemes, maxLength })` | `string` |
| `enum` | `z.enum([...])` | union of the values |
| `list` | `list(item, { separator, minItems, maxItems, itemMinLength, itemMaxLength })`, items strings or ints | array |
| `keySet` | `keySet({ separator, minKeys, maxKeys, keyMinLength, keyMaxLength })`, always secret | `KeySet` |
| `json` | `json(schema, { maxLength })` | parsed object |

- **Validators.** Zod 4 is first class. Other validators that implement [Standard JSON Schema](https://standardschema.dev) (ArkType, or Valibot wrapped in `toStandardJsonSchema()` from `@valibot/to-json-schema`) work for plain strings, numbers and enums. `duration`, `list`, `url` and `json` build Zod schemas, so `zod` is a peer dependency.
- **Descriptions** come from `.describe()` or `.meta({ description })`, and need at least 5 characters. **Details**, longer docs, come from the property's TSDoc comment, `.meta({ details })` or `annotate(schema, { details })`: see [Descriptions and details](#descriptions-and-details).
- **Secrets**: `secret(schema)`. A secret cannot have a default or examples, and its value never appears in errors or when `env` is printed.
- **Required** means the schema rejects `undefined`. A `.default()`, `.prefault()` or `.optional()` makes a variable optional; defaults are exported and checked against the variable's own constraints.
- **Numbers** need `z.coerce.number()`: environment values are strings, so `z.number()` would reject every one, and the declaration check says so.
- **Durations**: Zod 4's `.default()` takes the parsed value, so use `duration({ default: "30s" })` (or `.prefault("30s")`, or `.default(30_000)`).
- **Booleans**: `z.coerce.boolean()` turns `"false"` into `true`, so the declaration check rejects it and points to `z.stringbool()`.
- **Not supported**, with a hint saying what to use: `z.union()` (use `z.enum`), `.nullable()` (use `.optional()`), dates, and objects or arrays outside `json()` and `list()`.
- **Patterns** are RE2 and match anywhere in the value, as `RegExp.test` does; anchor with `^...$`. Lookaround and backreferences are rejected.
- **Empty strings** count as unset for every type except `string`.
- **Parsing is strict** (SPEC §5), whatever Zod would coerce: values are never trimmed, list items included (`a, b` is `a` and ` b`, and `a,,b` has an empty middle item); a `bool` is `true` or `false` in any case, and nothing else (`1`, `yes` and `on` are `invalid_type`, though `z.stringbool()` takes them); an `int` is decimal digits with an optional sign (`+5` and `007` are fine; `0x10`, `1_000`, `1e3` and `5.0` are not); a `float` has digits on both sides of an optional point and an optional exponent (`.5`, `5.`, `inf` and `1e400` are rejected); a duration follows Go's grammar, sign included (`-5s`, `1.5h`, but not `5`, `5S` or `1d`).
- **Int list items**: the item schema's range is exported as `itemMin`/`itemMax` and checked at boot (`out_of_range`): `list(z.coerce.number().int().min(0).max(1023))`, or `list(z.int32())` for 32-bit items. Without bounds, items are capped at ±`Number.MAX_SAFE_INTEGER`, as for `int` variables.
- **Length limits** for fixed-width fields: `url({ maxLength })`, `json(schema, { maxLength })`, and `list(z.string(), { itemMinLength, itemMaxLength })` for each item after splitting. They count characters (Unicode code points), so `日本` is 2 and an emoji is 1, unlike Zod's `.max()`, which counts UTF-16 units. A `json` value is measured as received, whitespace included, before parsing. A value outside them is `out_of_range`; a secret's error gives its length, never its value. Item lengths on an int list, or `itemMinLength` above `itemMaxLength`, throw when declared.
- **Exclusive float bounds** (`.positive()`, `.gt(0)`) are exported as the nearest double inside them, so the platform rejects exactly what the app does.
- **Docs metadata**: `annotate(schema, { details, group, examples, configKey, deprecated })`. Zod's `.meta({ details, examples })` also works.
- **Deprecated** inputs (`deprecated: { message, replacedBy }`, on variables and file inputs) still load and are still checked; when one is set, boot logs a warning with its name and message, never its value. The message must not be blank and is at most 500 characters, and a required input cannot be deprecated (the platform could not stop setting it), so either is a declaration error.
- **64-bit integers**: a Zod `number` is exact only up to 2^53 - 1, so `z.coerce.number().int()` exports `min`/`max` capped there. `int64()` holds the whole signed 64-bit range, a `bigint` beyond 2^53, and exports only the bounds you give it; inside `json()` or a config file's schema it is `{"type": "integer"}`.
- **Feature flags**: names starting `FF_`, `FEATURE_`, `FEATURE_FLAG_` or `ENABLE_` produce a warning (SPEC §10): flags that change without a rollout belong in a flag service. So does `NODE_ENV`, which frameworks and test runners set.

Problems with the declaration itself (bad names, short descriptions, non-RE2 patterns, a default that breaks its own constraints, file mount clashes) throw `DocuconfDeclarationError` when `createEnv` runs, in both boot and export mode, each with what to write instead. With `exitOnError`, they print and exit 1 too.

### Key sets

A `keySet` (SPEC §4.3) is a set of secret keys that are all valid at once, so one can be rotated without an outage: the
keys that verify webhook signatures, inbound API keys, JWT HMAC keys. The platform supplies it as one Secret value,
`old,new` while rotating. It is always secret, holds 1 to 2 keys unless `minKeys` and `maxKeys` say otherwise, and an
empty key (a stray comma) or one outside `keyMinLength`..`keyMaxLength` fails at boot (`out_of_range`) without
printing any key. The value is a `KeySet`: `keys()` in the platform's order, a constant-time `contains(candidate)` for
an API key a caller presents, and `verify(check)`, which runs your check (an HMAC comparison) with every key, without
stopping at the first match. It prints as `[redacted]`.

```ts
import { createHmac, timingSafeEqual } from "node:crypto";
import { createEnv, keySet } from "@docuconf/t3";

export const env = createEnv({
  server: {
    WEBHOOK_KEYS: keySet({ keyMinLength: 32, keyMaxLength: 256 }).describe("Keys that verify webhook signatures"),
  },
  runtimeEnv: process.env,
});

/** Whether `signature` is the HMAC-SHA256 of `body` under any key in the set. */
export function signedByUs(body: Buffer, signature: Buffer): boolean {
  return env.WEBHOOK_KEYS.verify((key) => {
    const want = createHmac("sha256", key).update(body).digest();
    return want.length === signature.length && timingSafeEqual(want, signature);
  });
}
```

`docuconf docs` prints the rotation steps for every key set, so its details need not repeat them.

### Descriptions and details

Every input has a **description**: what it is, in one phrase of plain text. It comes from `.describe()` (or `.meta({ description })`), as T3 Env apps already write it, and a missing or short one fails `createEnv`. An input may also have **details**: CommonMark on why it exists and when to change it, at most 4000 characters (Unicode code points). Details go into the contract for generated docs only and are never read at runtime. Write them as the property's TSDoc/JSDoc comment:

```ts
export const env = createEnv({
  name: "orders",
  server: {
    /**
     * Number of background order workers.
     *
     * Each worker holds one database connection, so keep this below the
     * pool size of {@link DATABASE_URL}'s server.
     *
     * - Raise it when the order queue backs up.
     * - Lower it when the database is the bottleneck.
     */
    WORKER_COUNT: z.coerce.number().int().min(1).max(64).default(4).describe("Number of background order workers"),
    // Without a comment: .meta({ details }), or annotate() for other validators.
    REGION: z.string().default("eu-west-1").describe("Cloud region").meta({ details: "Set by the platform; do not change it." }),
    ZONE: annotate(z.string().default("a").describe("Availability zone"), { details: "One of the region's zones." }),
  },
  runtimeEnv: process.env,
});
```

- `docuconf-t3 export` reads the comment above each property of `server` and `files` in the file that calls `createEnv` (or in a `const` object it is given in that file), with your project's own `typescript`. Comments do not exist at runtime, so this is the export CLI's job; without `typescript` installed it warns and exports only explicit details.
- The comment's first paragraph is its summary; when it repeats the description it is left out, and the rest is the details. Otherwise the whole comment is.
- TSDoc is converted to CommonMark: `{@link X}` and `{@code x}` become code spans (a URL becomes a link), `@remarks` text is kept, `@example` becomes a code block, and other tags (`@param`, `@default`, `@see`, `@deprecated`) are dropped. Paragraphs, lists and fenced code are kept as written.
- `.meta({ details })` or `annotate(schema, { details })` win over the comment. File inputs take `details` as an option, as well as their comment.
- Blank details, or more than 4000 characters, fail the declaration (or the export, for a comment).

`docuconf docs` in the [docuconf CLI](https://github.com/docuconf/docuconf-go) generates CONFIG.md and CONFIG.agents.md from the exported contract: `docuconf docs contract.cue -o CONFIG.md`, and `--format agents -o CONFIG.agents.md`.

### `createEnv` options

docuconf adds these to T3's options (`server`, `client`, `shared`, `runtimeEnv`, `skipValidation`, `onValidationError` and the rest work as in T3):

| Option | |
|---|---|
| `name` | Service name for the contract, a DNS label. |
| `appVersion` | `metadata.appVersion` for the contract. |
| `files` | File inputs; see below. |
| `exitOnError` | On invalid configuration, print the problems and exit 1 instead of throwing. Under a test runner it throws. |
| `fileRoot` | Prefix for absolute file paths. Default: `DOCUCONF_FILE_ROOT`. |
| `terminationLog` | Where to write violations. Default: `DOCUCONF_TERMINATION_LOG`, else `/dev/termination-log` when it exists. `false` disables. |
| `onWarning` | Receives hints (feature flags, deprecated variables, likely typos). Default: `console.warn`. |
| `watch` | Watch `reload: "watch"` file inputs. Default `true`. |

T3's `onValidationError` receives the violations as Standard Schema issues, if you pass it.

### File inputs

```ts
// src/files.ts
import { createServer } from "node:https";
import { z } from "zod";
import { configFile, createEnv, tlsFile } from "@docuconf/t3";

export const env = createEnv({
  name: "orders",
  server: {},
  files: {
    settings: configFile({
      format: "json",
      path: "/etc/orders/config/settings.json",
      required: true,
      description: "Currency and order limits",
      schema: z.object({ currency: z.enum(["EUR", "USD"]), maxItemsPerOrder: z.number().int().min(1) }),
    }),
    tls: tlsFile({
      path: "/etc/orders/tls",
      required: true,
      reload: "watch",
      description: "Certificate the API serves HTTPS with",
      dnsNames: ["orders.internal"],
      minRemaining: "168h",
    }),
  },
  runtimeEnv: process.env,
  exitOnError: true,
});

const server = createServer({ ...env.files.tls }, (req, res) => res.end(env.files.settings.currency));
env.files.tls.attach(server); // serve renewed certificates without a restart
server.listen(8443);
```

| Helper | Contract type | `env.files.<name>` |
|---|---|---|
| `configFile({ format: "json" \| "yaml" \| "toml", schema })` | `config`, with `schema` from `z.toJSONSchema` | the parsed, validated value |
| `tlsFile({ dnsNames, keyAlgorithms, minRemaining, requireCA })` | `tls` (a `kubernetes.io/tls` directory) | `TlsMaterial`: `{ cert, key, ca }`, `certificate`, `getSecureContext()`, `attach(server)`, `onChange()` |
| `caBundleFile({ minCertificates })` | `caBundle` | `{ ca }` PEM, plus `certificates` |
| `keystoreFile({ format: "pkcs12", passwordVar })` | `keystore` | `{ pfx, passphrase }` |
| `textFile({ pattern, minLength, maxLength })` | `text` | `string` |
| `binaryFile()` | `binary` | `Buffer` |

Every helper takes `path`, `description`, `required`, `pathEnv`, `reload: "restart" | "watch"`, `maxSize`, `group` and `deprecated`. Optional inputs that are absent are `undefined`.

Checks at boot (SPEC §11.2 item 7):

- the file exists, is readable and within `maxSize`;
- `config`: parses as JSON, YAML or TOML (a BOM is accepted) and matches the schema;
- `tls`: `tls.crt` and `tls.key` parse and match; the certificate is valid now with at least `minRemaining` left, covers every `dnsNames` entry, uses an allowed key algorithm, and, with `requireCA`, chains to `ca.crt`. Certificates are checked with `node:crypto`'s `X509Certificate`;
- `caBundle`: at least `minCertificates` parseable certificates;
- `keystore`: PKCS#12 opens with the password in `passwordVar`, an empty password when that variable is unset (through Node's OpenSSL). JKS has no Node parser, so only its magic number is checked;
- `text`: `pattern`, `minLength`, `maxLength`.

`reload: "watch"` inputs are re-read when their mount directory changes (Kubernetes swaps a `..data` symlink). A reload that fails its checks is logged and the previous value kept. `env.files.<name>` always returns the current value; use `onFileChange(env, name, listener)` to react, and `tlsMaterial.attach(server)` to keep an HTTPS server on the current certificate. When `pathEnv` is set and present in the environment, the file is read from that path instead of `path`.

### Error codes

`missing_required`, `invalid_type`, `out_of_range`, `pattern_mismatch`, `not_in_enum`, `invalid_scheme`, `too_few_items`, `too_many_items`, `file_missing`, `file_unreadable`, `file_too_large`, `file_malformed`, `schema_mismatch`, `certificate_invalid`, `certificate_expiring`, `certificate_name_mismatch`, `key_mismatch`, `keystore_unreadable`.

`DocuconfValidationError.violations` and `checkEnv(...).violations` hold `{ input, kind, code, message }` for each.

### Kubernetes and local development

| Variable | Effect |
|---|---|
| `DOCUCONF_FILE_ROOT` | Prefix for absolute file paths, so `/etc/orders/tls` is read from `$DOCUCONF_FILE_ROOT/etc/orders/tls`. For local development and tests. Also the `fileRoot` option. A missing file's message suggests it when it is not set. |
| `DOCUCONF_TERMINATION_LOG` | Where to write violations. By default they go to `/dev/termination-log` when it exists, so `kubectl describe pod` shows why the pod failed. The `terminationLog` option overrides it; `false` disables it. |

### Injected secrets

Platforms that supply values when the container starts, such as Bank-Vaults' `vault-env`, `op run` or an operator (SPEC §4.5.1), need nothing special: `createEnv` reads `process.env` as it is when the process starts, after injection, and validates injected values like any other. It never resolves references itself.

If the injector did not run, a secret variable still holds the raw reference. A secret whose value starts with `vault:`, `op://` or `ref+` fails with `invalid_type`, naming the reference scheme but never the value:

```
DATABASE_URL [invalid_type]: holds an unresolved vault: reference; the injector that should resolve it did not run
```

### Config-file overlays

Not supported, by design. Node and T3 Env do not layer configuration files (base, profile, overlay, environment), so there is nothing for a platform-mounted overlay (SPEC §4.7) to slot into, and this SDK has no overlay API. Contracts it exports never declare `overlays`. Configure the app through variables and file inputs.

### Programmatic API

```ts
// src/api.ts
import { getDeclaration, toContract } from "@docuconf/t3";
import { env } from "./env.ts";

toContract(env, { name: "orders", appVersion: process.env.GIT_SHA }); // the CUE text
getDeclaration(env).vars.get("PORT")!.contract; // one variable as data
```

### Plain JavaScript

TypeScript is optional. The package is ESM and works the same from `.mjs` files, and from CommonJS (`.cjs`, or `.js` without `"type": "module"`) through `require()`, which Node 22.12+ supports for ES modules. Export them the same way: `npx docuconf-t3 export env.mjs`. `npm run smoke` checks this against the packed package in a clean, non-TypeScript project.

## Development

This package lives in the [docuconf-js](https://github.com/docuconf/docuconf-js) npm workspace, next to `@docuconf/core` (the shared contract writer, file checks and violations it depends on). From the repository root:

```sh
npm ci
npm run typecheck
npm test        # vets exported contracts with cue when it is installed
npm run build
npm run smoke   # installs the packed packages into clean projects (t3: from .mjs and .cjs)
```

Every TypeScript block in this README is a file under [`readme/`](readme) or [`examples/next-t3`](https://github.com/docuconf/docuconf-js/tree/main/examples/next-t3): the typecheck compiles them, `readme/src/env.test.ts` runs with the tests, and a test fails when a block here differs from its file.

The export test runs `cue vet -c` against the meta-schema in a checkout of [docuconf-go](https://github.com/docuconf/docuconf-go) (default `../docuconf-go/spec/cue`, or `DOCUCONF_SPEC_CUE`), using `cue` from `$CUE`, `~/go/bin/cue` or `PATH`. It is skipped when either is missing, unless `DOCUCONF_REQUIRE_VET=1`. Regenerate the golden file with `UPDATE_GOLDEN=1 npm test`.

Releases are published to npm from CI; see [RELEASING.md](https://github.com/docuconf/docuconf-js/blob/main/RELEASING.md).

## Licence

[MIT](https://github.com/docuconf/docuconf-js/blob/main/LICENSE).
