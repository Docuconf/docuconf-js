# Releasing @docuconf/t3

Releases are published to npm by `.github/workflows/release.yml` when a version tag is pushed. It uses
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/): GitHub Actions proves its identity to npm with
OIDC, so no npm token is stored anywhere, and npm attaches a provenance attestation to every version.

## One-time setup

1. **npm organization.** Create the `docuconf` organization on npmjs.com, so the `@docuconf` scope exists. Require 2FA
   for its members.
2. **First publish.** npm only lets you add a trusted publisher to a package that already exists, so the first
   version is published once by a maintainer:
   ```sh
   npm ci && npm run build && npm publish --access public
   ```
3. **Trusted publisher.** On npmjs.com, open the `@docuconf/t3` package settings, add a trusted publisher
   for GitHub Actions with organization `docuconf`, repository `docuconf-js`, workflow `release.yml` and
   environment `npm`. Then set publishing access to "Require two-factor authentication and disallow tokens".
4. **GitHub environment.** In the repository settings, create an environment named `npm`, limited to tags matching `v*`,
   with required reviewers if you want a human to approve each release.

## Each release

1. Update `version` in `package.json` and `SDK_VERSION` in `src/version.ts` (a test fails if they differ), and commit.
2. Tag and push: `git tag v0.2.0 && git push origin v0.2.0`.
3. The workflow checks the tag matches `package.json`, runs the full test suite (including `cue vet` and the
   `.mjs`/`.cjs` smoke test), builds, and publishes. Pre-release versions such as `v0.2.0-beta.1` are published
   under the `next` dist-tag rather than `latest`.
