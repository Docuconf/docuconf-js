// @docuconf/core: the language-agnostic part of docuconf's JavaScript SDKs
// (@docuconf/t3, @docuconf/nestjs). Apps use one of those; this package's
// API follows their needs and may change in any minor version.
export {
  buildContract,
  packageNameFor,
  renderContract,
  type ContractOptions,
  type ContractSource,
  type Generator,
} from "./contract.ts";
export { cueFields, cueLabel, cueValue } from "./cue.ts";
export {
  CONTRACT_DURATION,
  DURATION_ENCODINGS,
  DURATION_EXAMPLE,
  canonicalDuration,
  formatDuration,
  parseDuration,
  parseDurationAs,
  parseIso8601Duration,
  parseSecondsDuration,
  parseTimespan,
  type DurationEncoding,
} from "./duration.ts";
export {
  LIST_ENCODINGS,
  charLength,
  convertValue,
  durationProblem,
  itemLengthDeclProblems,
  itemLengthProblem,
  maxLengthProblem,
  urlProblem,
  type JsonCheck,
  type ListEncoding,
  type Problem,
  type ValueDecl,
} from "./values.ts";
export { closeSchema, type JsonSchema } from "./jsonschema.ts";
export { cleanPattern, nonRe2Feature, re2RegExp } from "./re2.ts";
export {
  ENV_NAME,
  GENERIC,
  INJECTOR_PREFIXES,
  INT_SYNTAX,
  VarReport,
  checkVarName,
  contractDefault,
  injectorScheme,
  intBounds,
  intItem,
  precheckVar,
  preprocess,
  validDescription,
  wireValue,
  type ItemBounds,
  type VarBase,
  type VarType,
} from "./vars.ts";
export {
  DocuconfDeclarationError,
  DocuconfValidationError,
  ERROR_CODES,
  formatViolation,
  formatViolations,
  writeTerminationLog,
  type ErrorCode,
  type Violation,
} from "./violations.ts";
export { INPUT_NAME, RESERVED_DIRS, describeFiles, type DescribeFilesOptions } from "./files/declare.ts";
export { FileState, fileRootFrom, loadFile, resolvePath, type LoadContext, type Loaded } from "./files/load.ts";
export {
  binaryFile,
  caBundleFile,
  isFileInput,
  keystoreFile,
  makeFileInput,
  textFile,
  tlsFile,
  type BinaryFileOptions,
  type CaBundle,
  type CaBundleFileOptions,
  type ConfigFileOptions,
  type FileCommonOptions,
  type FileInput,
  type FileInputs,
  type FileType,
  type FileValues,
  type KeyAlgorithm,
  type Keystore,
  type KeystoreFileOptions,
  type SchemaAdapter,
  type TextFileOptions,
  type TlsFileOptions,
  type TlsMaterial,
} from "./files/spec.ts";
export { TlsMaterialHolder, checkCaBundle, checkTls, parseCertificates, type TlsCheckOptions, type TlsParts } from "./files/tls.ts";
export { exportSession, type ExportSession } from "./session.ts";
export {
  checkContract,
  loadContract,
  parseContract,
  type ContractCheckOptions,
  type ContractDeclaration,
  type ContractVar,
  type LoadContractOptions,
} from "./contract-first.ts";
