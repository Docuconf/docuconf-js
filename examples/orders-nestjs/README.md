# orders: NestJS

The docuconf orders example: a [NestJS](https://nestjs.com) app whose configuration is validated by
`@nestjs/config` and `@docuconf/nestjs`. The same service, with the same contract, is in every docuconf SDK;
the T3 Env version is in [`../orders-t3`](../orders-t3).

- [`src/orders.config.ts`](src/orders.config.ts): the declaration, an `OrdersConfig` class with class-validator and
  docuconf decorators, and the `validate` function.
- [`src/app.module.ts`](src/app.module.ts): `ConfigModule.forRoot({ isGlobal: true, validate })`.
- [`src/app.controller.ts`](src/app.controller.ts): `GET /healthz` returns `ok`; `GET /config` returns the typed values
  from `ConfigService`, with the secrets shown as `"***"`; `POST /webhooks/payments` accepts a payment webhook signed
  with any key in `WEBHOOK_KEYS`.
- [`src/webhook.ts`](src/webhook.ts): `verify`, which checks a webhook's `X-Signature` against every key.
- [`contract.cue`](contract.cue): the contract, exported from `src/orders.config.ts`. Do not edit it by hand.
- [`smoke.sh`](smoke.sh): starts the built app with valid and invalid env and checks both, and posts signed webhooks.
- [`test/webhook.test.ts`](test/webhook.test.ts): a key rotation, step by step, and the key sets that fail at boot.

| Variable | Type | Rules |
|---|---|---|
| `PORT` | int | 1 to 65535, default `8080` |
| `LOG_LEVEL` | enum | `debug`, `info`, `warn`, `error`; default `info` |
| `DATABASE_URL` | url | secret, required, scheme `postgres`, at most 2048 characters |
| `ALLOWED_ORIGINS` | list of strings, comma-separated | at least 1 item; default `http://localhost:3000` |
| `REQUEST_TIMEOUT` | duration (`30s`, `1m30s`) | 1s to 5m, default `30s` |
| `WORKER_COUNT` | int | 1 to 64, default `4` |
| `WEBHOOK_KEYS` | key set, comma-separated | secret, optional; 1 to 2 keys of 32 to 256 characters each |

## Run it

The example is a workspace member, so it builds against the packages in this repository. From the repository root:

```sh
npm ci && npm run build
cd examples/orders-nestjs
DATABASE_URL=postgres://orders:secret@localhost:5432/orders npm start
```

```sh
curl localhost:8080/healthz   # ok
curl localhost:8080/config    # {"PORT":8080,"LOG_LEVEL":"info","DATABASE_URL":"***","ALLOWED_ORIGINS":["http://localhost:3000"],"REQUEST_TIMEOUT":30000,"WORKER_COUNT":4,"WEBHOOK_KEYS":"***"}
```

`REQUEST_TIMEOUT` is in milliseconds; secrets are always `"***"`, set or not. `npm run smoke` runs the checks of
[`smoke.sh`](smoke.sh).

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

## Rotate a key

`WEBHOOK_KEYS` is a key set, declared with `@KeySet()`: `POST /webhooks/payments` accepts a body whose `X-Signature`
header is the hex HMAC-SHA256 of the body under any key in the set, checked with the key set's `verify`
([`src/webhook.ts`](src/webhook.ts); [`src/main.ts`](src/main.ts) creates the app with `rawBody: true`, so the
signature is checked over the body exactly as sent). A variable is read once, at start, so a new key reaches the
service only when it restarts; with two keys valid at once, no webhook is turned away while that happens:

1. Add the new key to the set (`old,new` in the Secret), and roll out.
2. Switch the sender to the new key.
3. Remove the old key (`new`), and roll out.

The generated [`CONFIG.md`](CONFIG.md) prints these steps for every key set, so the variable's own documentation does
not repeat them.

In the platform's values file the key set is, like every secret, a reference: one Secret key holding `old,new` while
rotating.

```yaml
WEBHOOK_KEYS:
  secretKeyRef: {name: orders-webhooks, key: keys}
```

The contract allows 1 or 2 keys of 32 to 256 characters each, so a trailing comma or a truncated key stops the service
at boot instead of locking out the sender, and the error does not print the keys:

```console
$ DATABASE_URL=postgres://orders:secret@localhost:5432/orders \
    WEBHOOK_KEYS=old-webhook-key-0123456789abcdef0123, node dist/main.js
docuconf: 1 configuration problem:
  - WEBHOOK_KEYS [out_of_range]: key 2 is empty
```

[`test/webhook.test.ts`](test/webhook.test.ts) walks through a rotation (`npm test` at the repository root runs it),
and [`smoke.sh`](smoke.sh) posts webhooks signed with both keys. [docuconf-go's SPEC section
6.1](https://github.com/docuconf/docuconf-go/blob/main/spec/SPEC.md#61-rotation) covers rotation in general.

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
