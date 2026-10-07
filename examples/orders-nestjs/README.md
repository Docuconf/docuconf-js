# orders: NestJS

The docuconf orders example: a [NestJS](https://nestjs.com) app whose configuration is validated by
`@nestjs/config` and `@docuconf/nestjs`. The same service, with the same contract, is in every docuconf SDK;
the T3 Env version is in [`../orders-t3`](../orders-t3).

- [`src/orders.config.ts`](src/orders.config.ts): the declaration, an `OrdersConfig` class with class-validator and
  docuconf decorators, and the `validate` function.
- [`src/app.module.ts`](src/app.module.ts): `ConfigModule.forRoot({ isGlobal: true, validate })`.
- [`src/app.controller.ts`](src/app.controller.ts): `GET /healthz` returns `ok`; `GET /config` returns the typed values
  from `ConfigService`, with the secret shown as `"***"`.
- [`contract.cue`](contract.cue): the contract, exported from `src/orders.config.ts`. Do not edit it by hand.
- [`smoke.sh`](smoke.sh): starts the built app with valid and invalid env and checks both.

| Variable | Type | Rules |
|---|---|---|
| `PORT` | int | 1 to 65535, default `8080` |
| `LOG_LEVEL` | enum | `debug`, `info`, `warn`, `error`; default `info` |
| `DATABASE_URL` | url | secret, required, scheme `postgres` |
| `ALLOWED_ORIGINS` | list of strings, comma-separated | at least 1 item; default `http://localhost:3000` |
| `REQUEST_TIMEOUT` | duration (`30s`, `1m30s`) | 1s to 5m, default `30s` |
| `WORKER_COUNT` | int | 1 to 64, default `4` |

## Run it

The example is a workspace member, so it builds against the packages in this repository. From the repository root:

```sh
npm ci && npm run build
cd examples/orders-nestjs
DATABASE_URL=postgres://orders:secret@localhost:5432/orders npm start
```

```sh
curl localhost:8080/healthz   # ok
curl localhost:8080/config    # {"PORT":8080,"LOG_LEVEL":"info","DATABASE_URL":"***","ALLOWED_ORIGINS":["http://localhost:3000"],"REQUEST_TIMEOUT":30000,"WORKER_COUNT":4}
```

`REQUEST_TIMEOUT` is in milliseconds. `npm run smoke` runs both checks of [`smoke.sh`](smoke.sh).

## When the configuration is wrong

With `PORT=0` and no `DATABASE_URL`, the app does not start. `validate` throws a `DocuconfValidationError` listing every
problem with its error code, Nest logs it, and the process exits with status 1:

```console
$ PORT=0 node dist/main.js
[Nest] 31796  - 10/07/2026, 12:14:23 AM     LOG [NestFactory] Starting Nest application...
[Nest] 31796  - 10/07/2026, 12:14:23 AM   ERROR [ExceptionHandler] DocuconfValidationError: docuconf: 2 configuration problems:
  - PORT [out_of_range]: must not be less than 1 (got "0")
  - DATABASE_URL [missing_required]: required, but not set
    at Object.validate (file:///home/user/docuconf-js/packages/nestjs/dist/esm/validate.js:72:19)
    at ConfigModule.forRoot (file:///home/user/docuconf-js/node_modules/@nestjs/config/dist/config.module.js:53:45)
    at file:///home/user/docuconf-js/examples/orders-nestjs/dist/app.module.js:17:32
    at ModuleJob.run (node:internal/modules/esm/module_job:343:25)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:665:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5) {
  violations: [
    {
      input: 'PORT',
      kind: 'var',
      code: 'out_of_range',
      message: 'must not be less than 1 (got "0")'
    },
    {
      input: 'DATABASE_URL',
      kind: 'var',
      code: 'missing_required',
      message: 'required, but not set'
    }
  ]
}
```

In Kubernetes the same lines go to `/dev/termination-log`, so `kubectl describe pod` shows them.

## Export the contract

```sh
npm run export   # docuconf-nestjs export src/orders.config.ts --out contract.cue
```

In this repository, after a fresh `npm ci && npm run build`, run `npm rebuild --ignore-scripts` once from the root, so
npm links the `docuconf-nestjs` command to the build. CI re-exports the contract and fails if it differs from the committed
file.

## Deploy

The contract is what the platform sees. Before a release, it validates its values for the service against
`contract.cue` with `docuconf vet` and turns them into env entries with `docuconf render`, or uses the
[docuconf Helm chart](https://github.com/docuconf/docuconf-go/tree/main/helm/docuconf) from docuconf-go, which does the
same at `helm install` time. A missing `DATABASE_URL` or a `PORT` of 0 is then rejected before anything is deployed,
not when the pod starts.
