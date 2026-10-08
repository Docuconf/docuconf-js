# orders: T3 Env

The docuconf orders example: a Node `http` service whose configuration is declared with
[T3 Env](https://env.t3.gg), Zod and `@docuconf/t3`. The same service, with the same contract, is in every docuconf SDK;
the NestJS version is in [`../orders-nestjs`](../orders-nestjs).

- [`src/env.ts`](src/env.ts): the declaration, `createEnv` with docuconf's `secret`, `url`, `list` and `duration`.
- [`src/server.ts`](src/server.ts): `GET /healthz` returns `ok`; `GET /config` returns the typed values, with the secret
  shown as `"***"`.
- [`contract.cue`](contract.cue): the contract, exported from `src/env.ts`. Do not edit it by hand.
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
cd examples/orders-t3
DATABASE_URL=postgres://orders:secret@localhost:5432/orders npm start
```

```sh
curl localhost:8080/healthz   # ok
curl localhost:8080/config    # {"PORT":8080,"LOG_LEVEL":"info","DATABASE_URL":"***","ALLOWED_ORIGINS":["http://localhost:3000"],"REQUEST_TIMEOUT":30000,"WORKER_COUNT":4}
```

`REQUEST_TIMEOUT` is in milliseconds. `npm run smoke` runs both checks of [`smoke.sh`](smoke.sh).

## When the configuration is wrong

With `PORT=0` and no `DATABASE_URL`, the app does not start. With `exitOnError: true` in `createEnv`, it prints every problem with its
error code, and nothing else, and exits with status 1:

```console
$ PORT=0 node dist/server.js
docuconf: 2 configuration problems:
  - PORT [out_of_range]: Too small: expected number to be >=1 (got "0")
  - DATABASE_URL [missing_required]: required, but not set
```

In Kubernetes the same lines go to `/dev/termination-log`, so `kubectl describe pod` shows them. `smoke.sh` checks this
output line by line.

## Export the contract

```sh
npm run export   # docuconf-t3 export src/env.ts --out contract.cue
npm run check    # docuconf-t3 export src/env.ts --check contract.cue: exits 1 with a diff when it is out of date
```

In this repository, after a fresh `npm ci && npm run build`, run `npm rebuild --ignore-scripts` once from the root, so
npm links the `docuconf-t3` command to the build. CI runs `npm run check`.

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
