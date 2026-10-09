// @docuconf/core: the language-agnostic part of docuconf's JavaScript SDKs
// (@docuconf/t3, @docuconf/nestjs). Apps use one of those; this package's
// API follows their needs and may change in any minor version.
export * from "./pure.ts";
export { INPUT_NAME, RESERVED_DIRS, describeFiles, type DescribeFilesOptions } from "./files/declare.ts";
export {
  FileState,
  fileRootFrom,
  loadFile,
  parseStructured,
  resolvePath,
  type LoadContext,
  type Loaded,
  type StructuredFormat,
} from "./files/load.ts";
export { TlsMaterialHolder, checkCaBundle, checkTls, parseCertificates, type TlsCheckOptions, type TlsParts } from "./files/tls.ts";
export {
  checkContract,
  loadContract,
  parseContract,
  type ContractCheckOptions,
  type ContractCheckResult,
  type ContractDeclaration,
  type ContractOverlay,
  type ContractProfiles,
  type ContractVar,
  type LoadContractOptions,
} from "./contract-first.ts";
export { type BootFailureOptions, exitWith, failBoot, underTestRunner, writeTerminationLog } from "./termination.ts";
