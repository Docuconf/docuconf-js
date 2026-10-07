# @docuconf/core

The shared, language-agnostic part of docuconf's JavaScript SDKs: the CUE contract writer, file input declarations and
boot checks (config files, TLS key pairs, CA bundles, keystores, text, binary), violations and their stable error codes,
the termination log, Go durations, RE2 checks and JSON Schema handling.

Apps do not use it directly. Use the SDK for your configuration library:

- [`@docuconf/t3`](https://www.npmjs.com/package/@docuconf/t3) for T3 Env and Zod;
- [`@docuconf/nestjs`](https://www.npmjs.com/package/@docuconf/nestjs) for NestJS (`@nestjs/config` and class-validator).

The exception is contract-first mode, below. The rest of the API follows what those SDKs need and may change in any
minor version. It ships ES module and CommonJS builds; the
`@docuconf/core/loader` entry point (module loading for the export CLIs) is ES module only.

## Contract-first mode

For a team that writes its contract in CUE by hand, `loadContract` validates the environment against the contract
exported as JSON, with no declaration in code (SPEC §11.2, item 11), and returns typed values:

```sh
cue export ./contract.cue --out json > contract.json
```

```ts
import { readFileSync } from "node:fs";
import { loadContract } from "@docuconf/core";

const env = loadContract(readFileSync("contract.json", "utf8"));
server.listen(env.PORT as number);
```

It runs the same checks as the SDKs' boot validation and parses every wire encoding (SPEC §5): lists as `csv` (with the
contract's `separator`), `json` or `indexed` (`NAME__0`, `NAME__1`, ..., numbered from 0 with no gap, else `invalid_type`; a suffix that is
not an index, such as `NAME__HOST`, is not an item), and durations as `go`, `iso8601` (`PT1M30S`,
`PT1.5S`), `seconds` (`90`, `0.25`) or `timespan` (`[d.]hh:mm:ss[.fffffff]`). Values are typed as in the SDKs: `int`
and `float` are numbers, durations milliseconds, lists arrays, `json` the parsed value, absent optional variables
`undefined`. An `int` beyond ±`Number.MAX_SAFE_INTEGER`, as an `int` variable or a list item, is `out_of_range`.

On failure it throws `DocuconfValidationError` with every violation, after writing them to the termination log.
Options: `env` (default `process.env`), `terminationLog`, and `validateJson`, a function that checks a `json` value
against the variable's JSON Schema (`decl.contract.schema`) with the validator of your choice; without it, `json` values
are only parsed. `checkContract` returns `{ values, violations }` instead of throwing, and `parseContract` reads a
contract once for repeated checks. Contract-first mode checks variables only: file inputs in the contract are not
checked yet.

Part of [docuconf-js](https://github.com/docuconf/docuconf-js). Licensed under
[MIT](https://github.com/docuconf/docuconf-js/blob/main/LICENSE).
