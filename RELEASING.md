# Releasing

This repository publishes three npm packages from one workspace:

| Package | Directory | Tag | Depends on |
|---|---|---|---|
| `@docuconf/core` | `packages/core` | `core-v0.1.0` | |
| `@docuconf/t3` | `packages/t3` | `v0.1.0` (unchanged from before the workspace) | `@docuconf/core` |
| `@docuconf/nestjs` | `packages/nestjs` | `nestjs-v0.1.0` | `@docuconf/core` |

Each package has its own version. `.github/workflows/release.yml` publishes the package a pushed tag names, after the
full test suite (all packages, `cue vet`, the smoke tests) passes. It uses
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/): GitHub Actions proves its identity to npm with
OIDC, so no npm token is stored anywhere, and npm attaches a provenance attestation to every version. Pre-release
versions such as `0.2.0-beta.1` are published under the `next` dist-tag rather than `latest`.

## One-time setup

1. **npm organization.** Create the `docuconf` organization on npmjs.com, so the `@docuconf` scope exists. Require 2FA
   for its members.
2. **First publish.** npm only lets you add a trusted publisher to a package that already exists, so the first version
   of each package is published once by a maintainer, core first:
   ```sh
   npm ci && npm run build
   npm publish --workspace packages/core --access public
   npm publish --workspace packages/t3 --access public
   npm publish --workspace packages/nestjs --access public
   ```
3. **Trusted publishers.** On npmjs.com, open the settings of each of `@docuconf/core`, `@docuconf/t3` and
   `@docuconf/nestjs`, and add a trusted publisher for GitHub Actions with organization `docuconf`, repository
   `docuconf-js`, workflow `release.yml` and environment `npm`. Then set publishing access to "Require two-factor
   authentication and disallow tokens".
4. **GitHub environment.** In the repository settings, create an environment named `npm`, limited to tags matching
   `v*`, `core-v*` and `nestjs-v*`, with required reviewers if you want a human to approve each release.

## Each release

1. **@docuconf/core, if it changed.** Update `version` in `packages/core/package.json`, and the `@docuconf/core`
   dependency (`^<version>`) in `packages/t3/package.json` and `packages/nestjs/package.json` (a test fails if they
   differ). Commit, then `git tag core-v0.2.0 && git push origin core-v0.2.0`. The SDK releases check that the core
   version they need is on npm, so core goes first.
2. **An SDK.** Update `version` in its `package.json` and `SDK_VERSION` in its `src/version.ts` (a test fails if they
   differ), and commit. Then tag and push:
   - `@docuconf/t3`: `git tag v0.2.0 && git push origin v0.2.0`
   - `@docuconf/nestjs`: `git tag nestjs-v0.2.0 && git push origin nestjs-v0.2.0`
3. The workflow checks the tag matches the package version, runs every check, builds, and publishes that one package.
