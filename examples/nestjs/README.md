# NestJS example

An orders API whose configuration is validated by `@docuconf/nestjs` through `ConfigModule.forRoot({ validate })`.

- [`src/config/env.validation.ts`](src/config/env.validation.ts): the `EnvironmentVariables` class, with class-validator and docuconf decorators, and the `validate` function.
- [`src/app.module.ts`](src/app.module.ts): `ConfigModule.forRoot({ isGlobal: true, validate })`.
- [`src/app.controller.ts`](src/app.controller.ts): reads typed values with `ConfigService<EnvironmentVariables, true>`.
- [`contract.cue`](contract.cue): the exported contract (kept up to date by a test).

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
