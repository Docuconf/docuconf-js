# shop: contract-first

The docuconf shop example: a tiny program, one image with two roles, that shows three spec features end to end in
`@docuconf/core`'s contract-first mode. The same example, with the same contract and the same test matrix, is in every
docuconf SDK.

- **Roles** (SPEC §4.9): `web` and `worker`, picked by `DOCUCONF_ROLE`; each role's inputs are required only in that
  role.
- **requiredIf** (SPEC §4.2.1): `LOG_SCHEMA_URL` is required when `LOG_FORMAT` is `json`, and the `webhook-signing-key`
  file when `WEBHOOKS_ENABLED` is `true`.
- **An included fragment** (SPEC §4.8): `otel@1`, whose `OTEL_*` variables are inline in the contract and checked at
  boot like the app's own.

`@docuconf/t3` and `@docuconf/nestjs` cannot declare roles, conditions or fragments yet, so the contract is written by
hand and loaded with `loadContract` (see [`@docuconf/core`'s README](../../packages/core/README.md#contract-first-mode)):

- [`contract.cue`](contract.cue): the contract, written by hand.
- [`contract.json`](contract.json): its JSON form, which the app loads. CI checks that the two are the same contract.
- [`src/config.ts`](src/config.ts): `loadShop`, which loads `contract.json` with `loadContract`, and `summary`, the line
  the app prints, from the typed values.
- [`src/main.ts`](src/main.ts): the app. It loads the configuration with `exitOnError: true`, prints one line and exits 0.
- [`test/matrix.test.ts`](test/matrix.test.ts): the matrix below, and a check that no message holds a secret.
- [`smoke.sh`](smoke.sh): runs the built app for cases 1, 2 and 6 and checks its output and exit status.

| Variable or file | Type | Rules |
|---|---|---|
| `DOCUCONF_ROLE` | enum | required; `web` or `worker` |
| `DATABASE_URL` | url | required, secret; scheme `postgres` or `postgresql` |
| `PORT` | int | `web` only; 1 to 65535, default `8080` |
| `ALLOWED_ORIGINS` | list of strings, comma-separated | `web` only; required |
| `QUEUES` | list of strings, comma-separated | `worker` only; required |
| `WEBHOOKS_ENABLED` | bool | `worker` only; default `false` |
| `LOG_FORMAT` | enum | `text` or `json`; default `text` |
| `LOG_SCHEMA_URL` | url | scheme `https`; required when `LOG_FORMAT` is `json` |
| `OTEL_*` | from `otel@1` | optional; `OTEL_EXPORTER_OTLP_PROTOCOL` is `grpc`, `http/protobuf` or `http/json` |
| file `webhook-signing-key` | text at `/etc/shop/webhooks/signing.key` | `worker` only; secret, at least 32 characters; required when `WEBHOOKS_ENABLED` is `true` |

## Run it

The example is a workspace member, so it builds against the packages in this repository. From the repository root:

```sh
npm ci && npm run build
cd examples/shop
```

```console
$ DOCUCONF_ROLE=web DATABASE_URL=postgres://shop@db:5432/shop ALLOWED_ORIGINS=https://shop.example npm start --silent
shop web: port 8080, origins https://shop.example
$ DOCUCONF_ROLE=worker DATABASE_URL=postgres://shop@db:5432/shop QUEUES=default,mail npm start --silent
shop worker: queues default,mail, webhooks off
```

A worker with `WEBHOOKS_ENABLED=true` reads its key from `/etc/shop/webhooks/signing.key` under `DOCUCONF_FILE_ROOT`
(`/` by default), and prints `webhooks on`:

```sh
mkdir -p /tmp/shop/etc/shop/webhooks && openssl rand -hex 32 > /tmp/shop/etc/shop/webhooks/signing.key
DOCUCONF_ROLE=worker DATABASE_URL=postgres://shop@db:5432/shop QUEUES=default WEBHOOKS_ENABLED=true \
  DOCUCONF_FILE_ROOT=/tmp/shop npm start --silent
```

With a problem, it prints every one with its error code, never a secret's value, and exits 1:

```console
$ DOCUCONF_ROLE=worker DATABASE_URL=postgres://shop@db:5432/shop QUEUES=default LOG_FORMAT=json node dist/main.js
docuconf: 1 configuration problem:
  - LOG_SCHEMA_URL [missing_required]: is required when LOG_FORMAT is "json"
```

## The test matrix

Each case starts from `DATABASE_URL=postgres://shop@db:5432/shop` and a fresh, empty file root.
[`test/matrix.test.ts`](test/matrix.test.ts) runs them all (`npm test` at the repository root), and
[`smoke.sh`](smoke.sh) (`npm run smoke`) runs 1, 2 and 6 as a real process. Lists are `csv`.

| # | env (plus the base) | expected |
|---|---|---|
| 1 | `DOCUCONF_ROLE=web ALLOWED_ORIGINS=https://shop.example` | ok: `shop web: port 8080, origins https://shop.example` |
| 2 | `DOCUCONF_ROLE=worker QUEUES=default,mail` | ok: `shop worker: queues default,mail, webhooks off`; a worker needs no `ALLOWED_ORIGINS` |
| 3 | `DOCUCONF_ROLE=web` | `ALLOWED_ORIGINS` `missing_required` |
| 4 | `QUEUES=default` (no role) | `DOCUCONF_ROLE` `missing_required`, and nothing else |
| 5 | `DOCUCONF_ROLE=cron` | `DOCUCONF_ROLE` `not_in_enum`, and nothing else |
| 6 | `DOCUCONF_ROLE=worker QUEUES=default LOG_FORMAT=json` | `LOG_SCHEMA_URL` `missing_required`: `is required when LOG_FORMAT is "json"` |
| 7 | as 6, plus `LOG_SCHEMA_URL=https://logs.example/v1.json` | ok |
| 8 | `DOCUCONF_ROLE=worker QUEUES=default WEBHOOKS_ENABLED=true` (no key file) | `webhook-signing-key` `file_missing`, the message ending `, and is required when WEBHOOKS_ENABLED is true` |
| 9 | as 8, with a key of 32 or more characters at the path under the file root | ok: `webhooks on` |
| 10 | `DOCUCONF_ROLE=web ALLOWED_ORIGINS=https://shop.example WEBHOOKS_ENABLED=true` | ok: the key file is the worker's |
| 11 | `DOCUCONF_ROLE=web ALLOWED_ORIGINS=https://shop.example OTEL_EXPORTER_OTLP_PROTOCOL=carrier-pigeon` | `OTEL_EXPORTER_OTLP_PROTOCOL` `not_in_enum`: fragment variables are checked at boot |

## Change the contract

Edit `contract.cue`, then write `contract.json` from it with `cue export` (the meta-schema is `spec/cue` in
[docuconf-go](https://github.com/docuconf/docuconf-go); copy `contract.cue` into a directory there, as CI does):

```sh
cue export ./shop --out json > contract.json
```

`cue export` fills in the meta-schema's defaults, which the app reads the same way. CI vets `contract.cue` and
`contract.json` against the meta-schema and fails when they are not the same contract.

## Generated docs

[`CONFIG.md`](CONFIG.md) (for developers), [`CONFIG.agents.md`](CONFIG.agents.md) (for AI agents) and `docs.json`
(the docs model both are rendered from) are generated from `contract.cue` by the `docuconf` CLI from
[docuconf-go](https://github.com/docuconf/docuconf-go); never edit them by hand. Regenerate them after changing the
contract (CI runs each with `--check` in place of `-o`):

```sh
docuconf docs contract.cue -o CONFIG.md
docuconf docs contract.cue --format agents -o CONFIG.agents.md
docuconf docs contract.cue --format model -o docs.json
```
