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

## GitHub Packages and Releases

The `github` job in `.github/workflows/release.yml` runs on the same tags. It repeats the checks, then:

- publishes the package the tag names to GitHub Packages (`https://npm.pkg.github.com`), pre-releases under the `next`
  dist-tag;
- creates the GitHub Release for the tag if it does not exist, and attaches the package's `npm pack` tarball
  (`docuconf-core-0.1.0.tgz`, for example).

It does not depend on the npmjs.org `publish` job, so it works before the npm organization and trusted publishers
exist. It authenticates with the workflow's own `GITHUB_TOKEN` (`packages: write`, `contents: write`); there are no
secrets or accounts to set up. The only requirement is that the `docuconf` organization lets `GITHUB_TOKEN` write
packages, which it does unless package creation has been restricted under Organization settings > Packages. As with npm, push
`core-v...` before an SDK tag: the job checks that the `@docuconf/core` version the SDK needs is already on GitHub
Packages.

npmjs.org stays the default registry: the packages' `publishConfig` names no registry, and only this job points the
`@docuconf` scope at GitHub.

### Installing from GitHub Packages

GitHub's npm registry requires a token even for public packages. Create a personal access token (classic) with the
`read:packages` scope, then add to the project's `.npmrc` (or `~/.npmrc`):

```ini
@docuconf:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

and install as usual (`npm install @docuconf/t3`) with `GITHUB_TOKEN` set in the environment. In GitHub Actions,
`actions/setup-node` with `registry-url: https://npm.pkg.github.com`, `scope: "@docuconf"` and
`NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}` does the same. Note that this sends every `@docuconf/*` package to
GitHub, so all of them must come from there.

Without a token, download the tarball from the GitHub Release and install the file:
`npm install ./docuconf-t3-0.1.0.tgz ./docuconf-core-0.1.0.tgz`.

## docuconf-go version

docuconf-go owns the spec, the CUE meta-schema (`spec/cue`), the conformance suite (`conformance/cases.json`) and the
`docuconf` CLI. This SDK is tested against one docuconf-go commit, pinned in `.github/docuconf-go.ref` (a full SHA).

- **CI** checks out that commit on pushes and pull requests. The nightly scheduled run uses docuconf-go `main` instead,
  so a spec change that breaks this SDK shows up within a day. To try another docuconf-go commit or branch, run the CI
  workflow by hand (Actions, CI, Run workflow) with `docuconf_go_ref` set. Releases always build against the pinned commit.
- **Bump PRs.** `.github/workflows/docuconf-go-bump.yml` opens (or updates) a `build(deps): bump docuconf-go to <sha>`
  pull request from the `docuconf-go-bump` branch whenever docuconf-go `main` moves: immediately when docuconf-go sends
  a `docuconf-go-updated` dispatch (this needs the release GitHub App), otherwise on its daily schedule. CI on that PR
  is the compatibility check; merge it when it is green, or fix the SDK on the same branch. It can also be run by hand
  with a specific `sha`.
- **`scripts/conformance.sh`** runs only the docuconf-go-facing checks (the conformance suite and the `cue vet` of
  exported contracts) against any checkout: `DOCUCONF_GO_DIR=../docuconf-go scripts/conformance.sh`. CI runs it, and
  so does docuconf-go's downstream workflow, which runs it against every docuconf-go pull request that touches the spec,
  the conformance suite or the CLI. It needs Node.js 22+, npm and `cue` on `PATH`.

Without the release App (secrets `RELEASE_APP_ID` and `RELEASE_APP_PRIVATE_KEY`) the bump workflow uses
`GITHUB_TOKEN`: the repository setting "Allow GitHub Actions to create and approve pull requests" must be on, and
because a PR opened that way triggers no workflows, the bump workflow starts CI on the branch itself
(`workflow_dispatch`, whose checks show on the PR).
