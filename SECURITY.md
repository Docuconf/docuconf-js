# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately, through GitHub's private vulnerability reporting: open the repository's
**Security** tab and choose **Report a vulnerability**
([direct link](https://github.com/docuconf/docuconf-js/security/advisories/new)). Do not open a public issue, pull
request or discussion for a suspected vulnerability.

Include what you can of:

- the affected package and version (`@docuconf/core`, `@docuconf/t3` or `@docuconf/nestjs`, and its npm version);
- what an attacker can do, and what they need first;
- steps or a minimal declaration, contract or environment that reproduces it.

We work on the fix in a private security advisory, credit you in it unless you prefer otherwise, and publish the
advisory when a fixed release is out.

## Response targets

| | |
|---|---|
| Acknowledge the report | within 3 business days |
| First assessment (confirmed or not, severity) | as soon as we can reproduce it, and we keep you updated in the advisory |
| Fix | released as a patch to the supported version, then the advisory is published |

## Supported versions

Each package is released separately (see [RELEASING.md](RELEASING.md)). Security fixes go to the latest minor release
of each, as a new patch release:

| Package | Tag | Supported |
|---|---|---|
| `@docuconf/core` | `core-v*` | latest minor |
| `@docuconf/t3` | `v*` | latest minor |
| `@docuconf/nestjs` | `nestjs-v*` | latest minor |

**During the beta, only the latest release of each package is supported.** Upgrade to it to get a fix.

## Scope

In scope:

- `@docuconf/core`, including contract-first mode (`loadContract`) and its file, profile and overlay loading;
- `@docuconf/t3`, including its `docuconf-t3` CLI, its browser build and `@docuconf/t3/next`;
- `@docuconf/nestjs`, including its `docuconf-nestjs` CLI;

for example a secret's value that reaches an error message, a log line, the termination log or a printed config object,
a check that accepts a value the contract rejects, or an exported contract that says less than the app enforces.

Out of scope: the example applications under [`examples`](examples), vulnerabilities in dependencies that docuconf does
not make reachable (report those upstream), and issues in a platform or cluster that only arise from its own
misconfiguration. The docuconf CLI, the Go SDK, the Helm chart and the CUE meta-schema live in
[docuconf-go](https://github.com/docuconf/docuconf-go) and follow its policy.

Packages published to npm carry a provenance attestation from the release workflow;
[RELEASING.md](RELEASING.md) describes how they are built and published.
