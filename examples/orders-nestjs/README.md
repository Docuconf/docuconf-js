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
| `DATABASE_URL` | url | secret, required, scheme `postgres`, at most 2048 characters |
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

With `PORT=0` and no `DATABASE_URL`, the app does not start. With `docuconfValidate(OrdersConfig, { name: "orders", exitOnError: true })`, it prints every problem with its
error code, and nothing else, and exits with status 1:

```console
$ PORT=0 node dist/main.js
docuconf: 2 configuration problems:
  - PORT [out_of_range]: must not be less than 1 (got "0")
  - DATABASE_URL [missing_required]: required, but not set
```

In Kubernetes the same lines go to `/dev/termination-log`, so `kubectl describe pod` shows them. `smoke.sh` checks this
output line by line.

## Export the contract

```sh
npm run export   # docuconf-nestjs export src/orders.config.ts --out contract.cue
npm run check    # docuconf-nestjs export src/orders.config.ts --check contract.cue: exits 1 with a diff when it is out of date
```

In this repository, after a fresh `npm ci && npm run build`, run `npm rebuild --ignore-scripts` once from the root, so
npm links the `docuconf-nestjs` command to the build. CI runs `npm run check`.

## Generated docs

[`CONFIG.md`](CONFIG.md) (for developers), [`CONFIG.agents.md`](CONFIG.agents.md) (for AI agents) and `docs.json`
(the docs model both are rendered from) are generated from `contract.cue` by the `docuconf` CLI from
[docuconf-go](https://github.com/docuconf/docuconf-go); never edit them by hand. Regenerate them after exporting the
contract (CI runs each with `--check` in place of `-o`, against the committed `contract.cue`):

```sh
docuconf docs contract.cue -o CONFIG.md
docuconf docs contract.cue --format agents -o CONFIG.agents.md
docuconf docs contract.cue --format model -o docs.json
```

## Deploy

The contract is what the platform sees. Before a release, it validates its values for the service against
`contract.cue` with `docuconf vet` and turns them into env entries with `docuconf render`, or uses the
[docuconf Helm chart](https://github.com/docuconf/docuconf-go/tree/main/helm/docuconf) from docuconf-go, which does the
same at `helm install` time. A missing `DATABASE_URL` or a `PORT` of 0 is then rejected before anything is deployed,
not when the pod starts.
