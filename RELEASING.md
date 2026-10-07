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

Releases are automated with [release-please](https://github.com/googleapis/release-please); see
[CONTRIBUTING.md](CONTRIBUTING.md#how-releases-happen) for the commit conventions it reads.

1. Merge the open release PR (`chore: release main`). It already bumps `version` in each changed package's
   `package.json`, `SDK_VERSION` in the SDKs' `src/version.ts`, and the SDKs' `@docuconf/core` dependency
   (`^<version>`) when core is released, and it updates `package-lock.json` and each package's `CHANGELOG.md`. The
   golden files and example contracts do not need regenerating: their comparisons ignore
   `metadata.generator.version`.
2. release-please tags the merge commit once per released package, in the formats in the table above
   (`core-vX.Y.Z`, `vX.Y.Z`, `nestjs-vX.Y.Z`), and creates a GitHub release for each.
3. `.github/workflows/release.yml` runs once per tag: it checks the tag matches the package version, runs every
   check, builds, and publishes that one package.

The SDK releases check that the `@docuconf/core` version they need is on npm, so core must be published first.

- **Without the release GitHub App** (`GITHUB_TOKEN` fallback), tags do not trigger `release.yml` by themselves.
  `.github/workflows/release-please.yml` dispatches it instead: a `core-v` tag first, waiting for that run to
  finish, then the SDK tags.
- **With the App**, each tag push triggers `release.yml` at once, so when core and an SDK are released together the
  SDK run can start before core is on npm and fail that check. Re-run it after the core run has published:
  `gh run rerun <run-id>`, or `gh workflow run release.yml --ref v0.2.0`.

To redo any release by hand: `gh workflow run release.yml --ref <tag>`.
