# @docuconf/t3

The TypeScript SDK for [docuconf](https://github.com/docuconf): typed configuration contracts between an application and the Kubernetes platform that runs it.

It extends [T3 Env](https://env.t3.gg) rather than replacing it. You keep writing `createEnv({ server: {...} })` with Zod 4 (or any [Standard Schema](https://standardschema.dev) validator). docuconf adds three things:

1. **Declaration metadata** T3 has no field for: `secret`, Go durations, CSV lists, URL schemes, and file inputs (config files, TLS key pairs, CA bundles, keystores).
2. **Boot validation.** Every problem with variables *and* mounted files is reported at once, each with a stable error code. Secret values are never printed.
3. **Contract export.** `docuconf export` turns the same declaration into a `contract.cue`, so the platform can reject bad configuration before it deploys.

> Status: v0.1, implementing [spec v1alpha1](https://github.com/docuconf/docuconf-go/blob/main/spec/SPEC.md). Expect breaking changes until v1.

## Install

```sh
npm install @docuconf/t3 @t3-oss/env-core zod
```

Requires Node 22.12 or later and Zod 4. `@t3-oss/env-core` and `zod` are peer dependencies.

## Example

```ts
// src/env.ts
import { z } from "zod";
import { createEnv, secret, duration, url, configFile, tlsFile } from "@docuconf/t3";

export const env = createEnv({
  name: "orders-api",
  server: {
    DATABASE_URL: secret(url({ schemes: ["postgres"] })).describe("Primary Postgres connection string"),
    PORT: z.coerce.number().int().min(1).max(65535).default(8443).describe("Port the API listens on"),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info").describe("Minimum log level"),
    REQUEST_TIMEOUT: duration({ default: "30s", max: "5m" }).describe("Upstream request timeout"),
    DEBUG: z.stringbool().default(false).describe("Verbose request logging"),
  },
  files: {
    settings: configFile({ format: "json", path: "/etc/orders/config/settings.json", required: true,
      description: "Currency and order limits", schema: z.object({ currency: z.enum(["EUR", "USD"]) }) }),
    tls: tlsFile({ path: "/etc/orders/tls", required: true, reload: "watch",
      description: "Certificate the API serves HTTPS with", dnsNames: ["orders.internal"], minRemaining: "168h" }),
  },
  runtimeEnv: process.env,
});
```

```ts
// src/server.ts
import { createServer } from "node:https";
import { env } from "./env.ts";

const server = createServer({ ...env.files.tls }, (req, res) => res.end(env.files.settings.currency));
env.files.tls.attach(server); // serve renewed certificates without a restart
server.listen(env.PORT);
```

`env.PORT` is a `number`, `env.REQUEST_TIMEOUT` is milliseconds, `env.files.settings` is the parsed, validated object, and `env.files.tls` holds `{ cert, key, ca }` as PEM strings. A runnable version is in [`examples/t3`](https://github.com/docuconf/docuconf-js/tree/main/examples/t3).

If anything is wrong, `createEnv` throws a `DocuconfValidationError` listing every problem:

```
docuconf: 3 configuration problems:
  - DATABASE_URL [invalid_scheme]: URL scheme is not allowed
  - PORT [out_of_range]: Too big: expected number to be <=65535 (got "70000")
  - tls [certificate_name_mismatch]: certificate does not cover orders.internal
```

## Export the contract

```sh
npx docuconf export src/env.ts --out contract.cue
```

| Option | |
|---|---|
| `--out`, `-o` | File to write. Default: stdout. |
| `--name`, `-n` | Service name (a DNS label). Default: `createEnv`'s `name`. |
| `--app-version` | `metadata.appVersion`, such as the git SHA. |
| `--package` | CUE package name. Default: the service name with `-` replaced by `_`. |

The module is imported in **export mode**: `createEnv` records the declaration and skips validation and file loading, so no real environment is needed. Keep `createEnv` in its own module (as above), so exporting it does not start your server.

TypeScript modules load with Node's built-in type stripping when their relative imports name the `.ts` extension; otherwise (extensionless imports, path aliases, enums) the CLI falls back to [jiti](https://github.com/unjs/jiti).

### Plain JavaScript

TypeScript is optional. The package is ESM and works the same from `.mjs` files, and from CommonJS (`.cjs`, or `.js` without `"type": "module"`) through `require()`, which Node 22.12+ supports for ES modules:

```js
// env.mjs
import { z } from "zod";
import { createEnv, secret, url } from "@docuconf/t3";

export const env = createEnv({
  name: "orders-api",
  server: {
    DATABASE_URL: secret(url({ schemes: ["postgres"] })).describe("Primary Postgres connection string"),
    PORT: z.coerce.number().int().min(1).max(65535).default(8080).describe("HTTP listen port"),
  },
  runtimeEnv: process.env,
});
```

```js
// env.cjs
const { createEnv, secret, url } = require("@docuconf/t3");
```

Export them the same way: `npx docuconf export env.mjs` or `npx docuconf export env.cjs`. `npm run smoke` checks all of this against the packed package in a clean, non-TypeScript project.

The output is plain CUE data that unifies with the meta-schema's `contract.#Contract`, with variables and files sorted by name:

```cue
// Code generated by docuconf. DO NOT EDIT.
package orders_api

import "docuconf.dev/contract"

contract.#Contract & {
	apiVersion: "docuconf.dev/v1alpha1"
	kind:       "ConfigContract"
	vars: {
		PORT: {
			type:        "int"
			description: "Port the API listens on"
			min:         1
			max:         65535
			default:     8443
		}
		// ...
```

## How values flow to the platform

```
 app repo (CI)                                     platform (GitOps)
 src/env.ts ──docuconf export──▶ contract.cue ──▶ #Validate(values, file sources, policy) ──▶ #Render
                                                                                             │
 createEnv() at boot ◀──── env vars, mounted Secrets and ConfigMaps ◀────────────────────────┘
```

1. CI exports `contract.cue` and publishes it with the image (SPEC §8).
2. The platform writes typed values (`PORT: 9090`, `REQUEST_TIMEOUT: "45s"`), secret references (`DATABASE_URL: secretKeyRef: {...}`) and file sources (a cert-manager Certificate for `tls`, a ConfigMap for `settings`). `#Validate` checks them against the contract before anything is deployed.
3. `#Render` turns them into env entries in the wire encoding this SDK parses (`duration` with encoding `go`, `list` as `csv`), and volumes mounted at the declared paths.
4. At boot `createEnv` checks what the platform could not see: secret contents, certificate expiry and key match, file contents.

## Declaring variables

Only the `server` section is runtime configuration. T3's `client` section (and `shared`) is inlined at build time, so it is never exported (SPEC §11.1); it is still validated as T3 would.

| Contract type | Declare with | Value |
|---|---|---|
| `string` | `z.string()`, with `.min()`, `.max()`, `.regex()` | `string` |
| `int` | `z.coerce.number().int()`, with `.min()`, `.max()` | `number`, within ±`Number.MAX_SAFE_INTEGER` |
| `float` | `z.coerce.number()` | `number` |
| `bool` | `z.stringbool()` | `boolean` |
| `duration` | `duration({ min, max, default })`, Go syntax (`30s`, `1m30s`) | milliseconds |
| `url` | `url({ schemes })` | `string` |
| `enum` | `z.enum([...])` | union of the values |
| `list` | `list(item, { separator, minItems, maxItems })`, items strings or ints | array |
| `json` | `json(schema)` | parsed object |

- **Descriptions** come from `.describe()` or `.meta({ description })`, and need at least 5 characters.
- **Secrets**: `secret(schema)`. A secret cannot have a default or examples, and its value never appears in errors.
- **Required** means the schema rejects `undefined`. A `.default()`, `.prefault()` or `.optional()` makes a variable optional; defaults are exported and checked against the variable's own constraints.
- **Docs metadata**: `annotate(schema, { group, examples, configKey, deprecated })`. Zod's `.meta({ examples })` also works.
- **Durations**: Zod 4's `.default()` takes the parsed value, so use `duration({ default: "30s" })` (or `.prefault("30s")`, or `.default(30_000)`).
- **Booleans**: `z.coerce.boolean()` turns `"false"` into `true`, so the declaration check rejects it and points to `z.stringbool()`.
- **Patterns** are RE2 and match anywhere in the value, as `RegExp.test` does; anchor with `^...$`. Lookaround and backreferences are rejected.
- **Empty strings** count as unset for every type except `string`. Values are never trimmed. Integers must be plain base-10 (`" 42"`, `0x2A` and `1e3` are rejected).
- **Int list items**: the item schema's range is exported as `itemMin`/`itemMax` and checked at boot (`out_of_range`): `list(z.coerce.number().int().min(0).max(1023))`, or `list(z.int32())` for 32-bit items. Without bounds, items are capped at ±`Number.MAX_SAFE_INTEGER`, as for `int` variables.
- **Feature flags**: names starting `FF_`, `FEATURE_`, `FEATURE_FLAG_` or `ENABLE_` produce a warning (SPEC §10): flags that change without a rollout belong in a flag service.

Problems with the declaration itself (bad names, short descriptions, non-RE2 patterns, a default that breaks its own constraints, file mount clashes) throw `DocuconfDeclarationError` at definition time, in both boot and export mode.

## File inputs

| Helper | Contract type | `env.files.<name>` |
|---|---|---|
| `configFile({ format: "json" \| "yaml", schema })` | `config`, with `schema` from `z.toJSONSchema` | the parsed, validated value |
| `tlsFile({ dnsNames, keyAlgorithms, minRemaining, requireCA })` | `tls` (a `kubernetes.io/tls` directory) | `TlsMaterial`: `{ cert, key, ca }`, `certificate`, `getSecureContext()`, `attach(server)`, `onChange()` |
| `caBundleFile({ minCertificates })` | `caBundle` | `{ ca }` PEM, plus `certificates` |
| `keystoreFile({ format: "pkcs12", passwordVar })` | `keystore` | `{ pfx, passphrase }` |
| `textFile({ pattern, minLength, maxLength })` | `text` | `string` |
| `binaryFile()` | `binary` | `Buffer` |

Every helper takes `path`, `description`, `required`, `pathEnv`, `reload: "restart" | "watch"`, `maxSize`, `group` and `deprecated`. Optional inputs that are absent are `undefined`.

Checks at boot (SPEC §11.2 item 7):

- the file exists, is readable and within `maxSize`;
- `config`: parses as JSON or YAML (a BOM is accepted) and matches the schema;
- `tls`: `tls.crt` and `tls.key` parse and match; the certificate is valid now with at least `minRemaining` left, covers every `dnsNames` entry, uses an allowed key algorithm, and, with `requireCA`, chains to `ca.crt`. Certificates are checked with `node:crypto`'s `X509Certificate`;
- `caBundle`: at least `minCertificates` parseable certificates;
- `keystore`: PKCS#12 opens with the password in `passwordVar` (through Node's OpenSSL). JKS has no Node parser, so only its magic number is checked;
- `text`: `pattern`, `minLength`, `maxLength`.

`reload: "watch"` inputs are re-read when their mount directory changes (Kubernetes swaps a `..data` symlink). A reload that fails its checks is logged and the previous value kept. `env.files.<name>` always returns the current value; use `onFileChange(env, name, listener)` to react, and `tlsMaterial.attach(server)` to keep an HTTPS server on the current certificate.

When `pathEnv` is set and present in the environment, the file is read from that path instead of `path`.

## Error codes

`missing_required`, `invalid_type`, `out_of_range`, `pattern_mismatch`, `not_in_enum`, `invalid_scheme`, `too_few_items`, `too_many_items`, `file_missing`, `file_unreadable`, `file_too_large`, `file_malformed`, `schema_mismatch`, `certificate_invalid`, `certificate_expiring`, `certificate_name_mismatch`, `key_mismatch`, `keystore_unreadable`.

`DocuconfValidationError.violations` holds `{ input, kind, code, message }` for each. Passing T3's `onValidationError` receives them as Standard Schema issues instead.

## Kubernetes and local development

| Variable | Effect |
|---|---|
| `DOCUCONF_FILE_ROOT` | Prefix for absolute file paths, so `/etc/orders/tls` is read from `$DOCUCONF_FILE_ROOT/etc/orders/tls`. For local development and tests. Also the `fileRoot` option. |
| `DOCUCONF_TERMINATION_LOG` | Where to write violations. By default they go to `/dev/termination-log` when it exists, so `kubectl describe pod` shows why the pod failed. The `terminationLog` option overrides it; `false` disables it. |

T3's `skipValidation` still works, for builds and tests that run without configuration.

## Injected secrets

Platforms that supply values when the container starts, such as Bank-Vaults' `vault-env`, `op run` or an operator (SPEC §4.5.1), need nothing special: `createEnv` reads `process.env` as it is when the process starts, after injection, and validates injected values like any other. It never resolves references itself.

If the injector did not run, a secret variable still holds the raw reference. A secret whose value starts with `vault:`, `op://` or `ref+` fails with `invalid_type`, naming the reference scheme but never the value:

```
DATABASE_URL [invalid_type]: holds an unresolved vault: reference; the injector that should resolve it did not run
```

## Config-file overlays

Not supported, by design. Node and T3 Env do not layer configuration files (base, profile, overlay, environment), so there is nothing for a platform-mounted overlay (SPEC §4.7) to slot into, and this SDK has no overlay API. Contracts it exports never declare `overlays`. Configure the app through variables and file inputs.

## Programmatic API

```ts
import { toContract, getDeclaration } from "@docuconf/t3";

toContract(env, { name: "orders-api", appVersion: process.env.GIT_SHA }); // the CUE text
getDeclaration(env).vars.get("PORT")!.contract;                          // one variable as data
```

## Development

This package lives in the [docuconf-js](https://github.com/docuconf/docuconf-js) npm workspace, next to `@docuconf/core` (the shared contract writer, file checks and violations it depends on). From the repository root:

```sh
npm ci
npm run typecheck
npm test        # vets exported contracts with cue when it is installed
npm run build
npm run smoke   # installs the packed packages into clean projects (t3: from .mjs and .cjs)
```

Releases are published to npm from CI; see [RELEASING.md](https://github.com/docuconf/docuconf-js/blob/main/RELEASING.md).

The export test runs `cue vet -c` against the meta-schema in a checkout of [docuconf-go](https://github.com/docuconf/docuconf-go) (default `../docuconf-go/spec/cue`, or `DOCUCONF_SPEC_CUE`), using `cue` from `$CUE`, `~/go/bin/cue` or `PATH`. It is skipped when either is missing, unless `DOCUCONF_REQUIRE_VET=1`. Regenerate the golden file with `UPDATE_GOLDEN=1 npm test`.

## Licence

[MIT](https://github.com/docuconf/docuconf-js/blob/main/LICENSE).
