# docuconf-js

JavaScript and TypeScript SDKs for [docuconf](https://github.com/docuconf): typed configuration contracts between an
application and the Kubernetes platform that runs it. Each SDK extends a configuration library you already use,
exports your declaration as a CUE contract, and validates the real environment and mounted files at boot.

Documentation: [docuconf.dev](https://docuconf.dev) · [TypeScript guide](https://docuconf.dev/languages/typescript/) · [NestJS guide](https://docuconf.dev/languages/nestjs/)

**Examples:** the orders service [with T3 Env](examples/orders-t3/) and [with NestJS](examples/orders-nestjs/), and a
[Next.js app](examples/next-t3/) that validates at server start and shares `env.ts` with client components.

The packages are not on npm yet. Each SDK's README starts with how to install it from a checkout (`npm pack`, then
`npm install` of the tarballs); `npm install @docuconf/t3` and `npm install @docuconf/nestjs` work from the first release.

| Package | For | |
|---|---|---|
| [`@docuconf/t3`](packages/t3) | [T3 Env](https://env.t3.gg) with Zod 4, in any Node app and in Next.js (`@docuconf/t3/next`) | [README](packages/t3/README.md), [example](examples/orders-t3), [Next.js](examples/next-t3) |
| [`@docuconf/nestjs`](packages/nestjs) | NestJS: `@nestjs/config` with a class-validator class | [README](packages/nestjs/README.md), [example](examples/orders-nestjs) |
| [`@docuconf/core`](packages/core) | Shared by both: contract writer, file checks, violations, durations, RE2, JSON Schema; contract-first mode | [README](packages/core/README.md) |

Both SDKs implement [spec v1alpha1](https://github.com/docuconf/docuconf-go/blob/main/spec/SPEC.md), write contracts
with `generator.language: "typescript"`, and report the same error codes. Neither has a config-file overlay API: Node
does not layer configuration files, so there is nothing for an overlay to slot into.

Every input's `description` comes from `.describe()` (T3 Env) or `@Describe` (NestJS); longer `details` come from the
property's TSDoc comment, or an explicit `details` option. `docuconf docs` in the docuconf CLI generates CONFIG.md and
CONFIG.agents.md from the exported contract.

## Layout

```
packages/core           @docuconf/core    ESM + CommonJS
packages/t3             @docuconf/t3      ESM (CommonJS apps load it with require(), Node 22.12+), a browser build, /next
packages/nestjs         @docuconf/nestjs  ESM + CommonJS
examples/orders-t3      the orders example: a Node http service with T3 Env (workspace member)
examples/orders-nestjs  the orders example: a NestJS app (workspace member)
examples/next-t3        a Next.js app (not a workspace member: its smoke.sh installs the packed packages)
examples/t3             test fixture: an HTTPS server with file inputs, against the t3 sources
examples/nestjs         test fixture: a NestJS app with file inputs
```

Each example also commits `CONFIG.md`, `CONFIG.agents.md` and `docs.json`, generated from its `contract.cue` by
`docuconf docs` (for example [`examples/orders-t3/CONFIG.md`](examples/orders-t3/CONFIG.md) and
[`CONFIG.agents.md`](examples/orders-t3/CONFIG.agents.md)); the examples' READMEs give the commands, and CI checks them.

The repository is an npm workspace. In development, the packages and tests resolve each other's TypeScript sources
through the `@docuconf/source` export condition (`customConditions` in `tsconfig.base.json`, aliases in
`vitest.shared.ts`); builds and published packages use `dist`.

## Development

```sh
npm ci
npm run typecheck   # every package
npm test            # every package's tests (vitest projects); vets exported contracts with cue when installed
npm run build       # core first, then the SDKs, then the orders examples
npm run smoke       # installs the packed packages into clean projects; runs the orders examples' smoke.sh
bash examples/next-t3/smoke.sh   # the Next.js example: installs Next.js and the packed packages in a temporary copy
```

The SDK CLIs are `docuconf-t3` and `docuconf-nestjs` (the platform's Go CLI is `docuconf`). Every TypeScript block in a
package README is a file under that package's `readme/` directory (or an example), compiled by the typecheck; a test
fails when a README block and its file differ.

`npx vitest run --project nestjs` runs one package's tests. The export tests run `cue vet -c` against the meta-schema
in a checkout of [docuconf-go](https://github.com/docuconf/docuconf-go) (default `../docuconf-go/spec/cue`, or
`DOCUCONF_SPEC_CUE`), using `cue` from `$CUE`, `~/go/bin/cue` or `PATH`. They are skipped when either is missing, unless
`DOCUCONF_REQUIRE_VET=1`. Regenerate golden files with `UPDATE_GOLDEN=1 npm test`.

## Conformance

`@docuconf/core`'s tests run the shared [conformance suite](https://github.com/docuconf/docuconf-go/tree/main/conformance)
(SPEC §12) through contract-first mode (`loadContract`, see the [core README](packages/core/README.md)), one test per case
named by its id. The cases come from `DOCUCONF_CONFORMANCE` (the path to `cases.json`), else
`../docuconf-go/conformance/cases.json`; the suite is skipped when neither exists, unless `DOCUCONF_REQUIRE_CONFORMANCE=1`,
as in CI:

```sh
DOCUCONF_CONFORMANCE=../docuconf-go/conformance/cases.json DOCUCONF_REQUIRE_CONFORMANCE=1 npx vitest run --project core
```

Cases that require these capability tags are skipped:

| Tag | Why |
|---|---|
| `int64` | A JavaScript `number` holds integers exactly only up to 2^53 - 1, so `int` values and list items beyond ±`Number.MAX_SAFE_INTEGER` are `out_of_range`, and the SDKs export `min`/`max` and `itemMin`/`itemMax` within that range. |
| `json-schema` | `@docuconf/core` has no JSON Schema validator. Contract-first mode checks `json` values against their schema only through a `validateJson` function you pass. |

Releases are published to npm from CI, one package per tag; see [RELEASING.md](RELEASING.md).

## Licence

[MIT](LICENSE).
