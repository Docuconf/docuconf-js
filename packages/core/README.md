# @docuconf/core

The shared, language-agnostic part of docuconf's JavaScript SDKs: the CUE contract writer, file input declarations and
boot checks (config files, TLS key pairs, CA bundles, keystores, text, binary), violations and their stable error codes,
the termination log, Go durations, RE2 checks and JSON Schema handling.

Apps do not use it directly. Use the SDK for your configuration library:

- [`@docuconf/t3`](https://www.npmjs.com/package/@docuconf/t3) for T3 Env and Zod;
- [`@docuconf/nestjs`](https://www.npmjs.com/package/@docuconf/nestjs) for NestJS (`@nestjs/config` and class-validator).

The packages are not on npm yet; install them from a checkout as the SDK READMEs describe
(`npm pack -w packages/core ...`). The exception is contract-first mode, below. The rest of the API follows what those SDKs need and may change in any
minor version. It ships ES module and CommonJS builds; the
`@docuconf/core/loader` and `@docuconf/core/cli` entry points (the export CLIs) are ES module only, and
`@docuconf/core/pure` has everything that needs no Node built-ins, for browser builds.

## Contract-first mode

For a team that writes its contract in CUE by hand, `loadContract` validates the environment against the contract
exported as JSON, with no declaration in code (SPEC §11.2, item 11), and returns typed values:

```sh
cue export ./contract.cue --out json > contract.json
```

```ts
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { loadContract } from "@docuconf/core";

// exitOnError: on a problem, print every one and exit 1.
const env = loadContract(readFileSync("contract.json", "utf8"), { exitOnError: true });
createServer((req, res) => res.end("ok")).listen(env.PORT as number);
```

It runs the same checks as the SDKs' boot validation and parses every wire encoding (SPEC §5), exactly: values are
never trimmed (`csv` items included), a `bool` is `true` or `false` in any case and nothing else, an `int` decimal
digits with an optional sign, a `float` digits on both sides of an optional point, and each duration encoding its own
grammar (a Go duration may be negative); anything wider is `invalid_type`. Lists and key sets are `csv` (with the
contract's `separator`), `json` or `indexed` (`NAME__0`, `NAME__1`, ..., numbered from 0 with no gap, else `invalid_type`; a suffix that is
not an index, such as `NAME__HOST`, is not an item), and durations as `go`, `iso8601` (`PT1M30S`,
`PT1.5S`), `seconds` (`90`, `0.25`) or `timespan` (`[d.]hh:mm:ss[.fffffff]`). Values are typed as in the SDKs:
`float` is a number, durations milliseconds, lists arrays, a `keySet` a `KeySet` (its keys in order, a constant-time
`contains`, and `verify(check)` that tries every key; it prints as `[redacted]`), `json` the parsed value, absent
optional variables `undefined`. A key set's empty key, or one outside `keyMinLength`..`keyMaxLength`, is `out_of_range`,
and too few or too many keys `too_few_items` or `too_many_items`; no message holds a key. An `int` holds the signed 64-bit range, as an `int` variable or a list item: it is a `number` within
±`Number.MAX_SAFE_INTEGER` and an exact `bigint` beyond it (so check `typeof` before arithmetic on a value that can be
that large), and is `out_of_range` beyond 64 bits. `min`, `max`, `itemMin` and `itemMax` compare exactly; a contract
given as JSON text is read with integers beyond 2^53 kept exact (an object you parsed yourself has already lost them).
Length limits (`minLength`/`maxLength` on a `string`, `maxLength` on a `url` or `json` value, `itemMinLength`/`itemMaxLength`
on each item of a `string` list after splitting) count characters, meaning Unicode code points, not UTF-16 units; a `json`
value is measured as received, before parsing. They are `out_of_range`, and a secret's message gives only its length.

On failure it writes every violation to the termination log, then, with `exitOnError: true`, prints
`docuconf: N configuration problems:` with one line per problem and exits 1; otherwise (and always under a test runner)
it throws `DocuconfValidationError`. Options: `env` (default `process.env`), `terminationLog`, `exitOnError`,
`validateJson`, `fileRoot` (default `DOCUCONF_FILE_ROOT` from `env`), `onWarning` (default `console.warn`) and `now`
(for certificate checks).

The result also holds each **file input** (SPEC §4.6) by its input name, read under `DOCUCONF_FILE_ROOT` and checked as
the SDKs check them at boot: a `config` file's data (`json`, `yaml` or `toml`, checked against its `schema` with Ajv), a
`text` file's text (UTF-8, its `pattern` and lengths in characters), a `TlsMaterial`, a `CaBundle`, a `Keystore`
(PKCS#12, opened with its `passwordVar`, an empty password when that is unset) or a `Buffer`. **Profiles** and
**overlays** (SPEC §4.4, §4.7) are layered as a host that reads config files would: the variable's default, then the
selected profile's default, then the first overlay (read from its `path` under the file root, `json`, `yaml` or `toml`)
that has a value at the variable's `configKey`, then the environment. An overlay value is converted to the string it
stands for and checked like an env value; a missing overlay is fine, and one that does not parse or is not an object
is `file_malformed` for the overlay's name. A **deprecated** input that is set loads and is checked as usual, and is
logged through `onWarning` with its name and message, never its value.

A `json` variable with a `schema` is checked against it with [Ajv](https://ajv.js.org), a dependency of this package,
as JSON Schema draft 2020-12: a value that does not match is `schema_mismatch`, with one violation per problem. Patterns
are RE2, as elsewhere in the contract; string lengths count code points; `format` is an annotation only. A schema with
a keyword Ajv does not know, or a pattern that is not RE2, is a declaration error (`DocuconfDeclarationError`), not
ignored. `validateJson`, a function `(decl, value) => { value } | { issues }`, replaces that check with the validator
of your choice. `checkContract` returns `{ values, files, violations, warnings }` instead of throwing, and
`parseContract` reads a contract once for repeated checks.

Part of [docuconf-js](https://github.com/docuconf/docuconf-js). Licensed under
[MIT](https://github.com/docuconf/docuconf-js/blob/main/LICENSE).
