# next-t3: docuconf with Next.js

A Next.js App Router app whose configuration is declared once, in [`src/env.ts`](src/env.ts), with T3 Env, Zod and
`@docuconf/t3`, and used from a server component and a `"use client"` component.

- [`src/env.ts`](src/env.ts): `createEnv` with server variables (a secret, a duration, a list, a key set) and one
  `NEXT_PUBLIC_` client variable. One schema is imported through the `@/*` alias.
- [`src/instrumentation.ts`](src/instrumentation.ts): `registerEnv` from `@docuconf/t3/next` validates the environment
  when the server starts, and exits 1 if it is wrong.
- [`src/app/page.tsx`](src/app/page.tsx): a dynamic page (`await connection()`), so it reads values at request time.
- [`src/app/webhooks/payments/route.ts`](src/app/webhooks/payments/route.ts): `POST /webhooks/payments`, a route
  handler that accepts a payment webhook signed with any key in the secret key set `WEBHOOK_KEYS`
  ([`src/webhook.ts`](src/webhook.ts)).
- [`src/app/api-base.tsx`](src/app/api-base.tsx): a client component importing the same `env.ts`. Bundlers use
  `@docuconf/t3`'s browser build there, which has no Node built-ins.
- [`contract.cue`](contract.cue): exported from `src/env.ts`, and [`CONFIG.md`](CONFIG.md) and
  [`CONFIG.agents.md`](CONFIG.agents.md), generated from it.
- [`smoke.sh`](smoke.sh): installs the packed packages with Next.js in a temporary copy, and checks all of the above.

## Run it

The packages are not on npm yet, so install them from a checkout of this repository:

```sh
# in the repository root
npm ci && npm run build
npm pack -w packages/core -w packages/t3 --pack-destination /tmp
# here
cd examples/next-t3
npm install /tmp/docuconf-core-0.1.0.tgz /tmp/docuconf-t3-0.1.0.tgz
NEXT_PUBLIC_API_BASE=https://api.example.com npm run build     # no server configuration needed
DATABASE_URL=postgres://orders:secret@localhost:5432/orders npm start
```

With `DATABASE_URL` unset and `WORKER_COUNT=999`, `npm start` prints the problems and exits with status 1:

```console
$ WORKER_COUNT=999 npm start
✓ Ready in 749ms
docuconf: 2 configuration problems:
  - DATABASE_URL [missing_required]: required, but not set
  - WORKER_COUNT [out_of_range]: Too big: expected number to be <=64 (got "999")
```

`npm run smoke` does all of this in a temporary directory. `npm run check` fails when `contract.cue` is out of date.

## Rotate a key

`WEBHOOK_KEYS` is a key set (`keySet()`) of one or two keys of 32 to 256 characters each. `POST /webhooks/payments`
accepts a body whose `X-Signature` header is the hex HMAC-SHA256 of the body under any key in the set, checked with
the key set's `verify`. The server reads the variable once, at start, so a new key reaches it only when it restarts;
with two keys valid at once, no webhook is turned away while that happens:

1. Add the new key to the set (`old,new` in the Secret), and roll out.
2. Switch the sender to the new key.
3. Remove the old key (`new`), and roll out.

In a values file it is a reference, such as `WEBHOOK_KEYS: {secretKeyRef: {name: orders-webhooks, key: keys}}`. A
trailing comma or a truncated key stops `npm start` with `WEBHOOK_KEYS [out_of_range]`, without printing the keys.
`smoke.sh` posts webhooks signed with both keys.

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
