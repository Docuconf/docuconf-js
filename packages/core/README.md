# @docuconf/core

The shared, language-agnostic part of docuconf's JavaScript SDKs: the CUE contract writer, file input declarations and
boot checks (config files, TLS key pairs, CA bundles, keystores, text, binary), violations and their stable error codes,
the termination log, Go durations, RE2 checks and JSON Schema handling.

Apps do not use it directly. Use the SDK for your configuration library:

- [`@docuconf/t3`](https://www.npmjs.com/package/@docuconf/t3) for T3 Env and Zod;
- [`@docuconf/nestjs`](https://www.npmjs.com/package/@docuconf/nestjs) for NestJS (`@nestjs/config` and class-validator).

Its API follows what those SDKs need and may change in any minor version. It ships ES module and CommonJS builds; the
`@docuconf/core/loader` entry point (module loading for the export CLIs) is ES module only.

Part of [docuconf-js](https://github.com/docuconf/docuconf-js). The licence is pending and will be added before the
first release.
