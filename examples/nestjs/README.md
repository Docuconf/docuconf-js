# NestJS example

An orders API whose configuration is validated by `@docuconf/nestjs` through `ConfigModule.forRoot({ validate })`.

- [`src/config/env.validation.ts`](src/config/env.validation.ts): the `EnvironmentVariables` class, with class-validator and docuconf decorators, and the `validate` function.
- [`src/app.module.ts`](src/app.module.ts): `ConfigModule.forRoot({ isGlobal: true, validate })`.
- [`src/app.controller.ts`](src/app.controller.ts): reads typed values with `ConfigService<EnvironmentVariables, true>`.
- [`contract.cue`](contract.cue): the exported contract (kept up to date by a test), and [`CONFIG.md`](CONFIG.md) and [`CONFIG.agents.md`](CONFIG.agents.md), generated from it.

From the repository root, after `npm ci && npm run build`:

```sh
npx tsc -p examples/nestjs
DATABASE_URL=postgres://localhost/orders DOCUCONF_FILE_ROOT=examples/nestjs/dev-root node examples/nestjs/dist/main.js
curl localhost:3000

# Export the contract from the source, or from the compiled module
npx docuconf-nestjs export examples/nestjs/src/config/env.validation.ts --out examples/nestjs/contract.cue
npx docuconf-nestjs export examples/nestjs/dist/config/env.validation.js
```

Without `DATABASE_URL`, or with `PORT=70000`, the app refuses to start and lists every problem.

## Generated docs

[`CONFIG.md`](CONFIG.md) (for developers), [`CONFIG.agents.md`](CONFIG.agents.md) (for AI agents) and `docs.json`
(the docs model both are rendered from) are generated from `contract.cue` by the `docuconf` CLI from
[docuconf-go](https://github.com/docuconf/docuconf-go); never edit them by hand. Regenerate them in `examples/nestjs` after exporting the
contract (CI runs each with `--check` in place of `-o`, against the committed `contract.cue`):

```sh
docuconf docs contract.cue -o CONFIG.md
docuconf docs contract.cue --format agents -o CONFIG.agents.md
docuconf docs contract.cue --format model -o docs.json
```
