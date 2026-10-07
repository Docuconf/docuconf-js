# next-t3: docuconf with Next.js

A Next.js App Router app whose configuration is declared once, in [`src/env.ts`](src/env.ts), with T3 Env, Zod and
`@docuconf/t3`, and used from a server component and a `"use client"` component.

- [`src/env.ts`](src/env.ts): `createEnv` with server variables (a secret, a duration, a list) and one `NEXT_PUBLIC_`
  client variable. One schema is imported through the `@/*` alias.
- [`src/instrumentation.ts`](src/instrumentation.ts): `registerEnv` from `@docuconf/t3/next` validates the environment
  when the server starts, and exits 1 if it is wrong.
- [`src/app/page.tsx`](src/app/page.tsx): a dynamic page (`await connection()`), so it reads values at request time.
- [`src/app/api-base.tsx`](src/app/api-base.tsx): a client component importing the same `env.ts`. Bundlers use
  `@docuconf/t3`'s browser build there, which has no Node built-ins.
- [`contract.cue`](contract.cue): exported from `src/env.ts`.
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
