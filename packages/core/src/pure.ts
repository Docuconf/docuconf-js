// @docuconf/core/pure: the part of @docuconf/core that imports no Node
// built-ins, so it bundles for browsers and edge runtimes. @docuconf/t3's
// browser entry builds on it.
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
  convertValue,
  splitCsv,
  durationProblem,
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
  nextFloat,
  secretMessage,
  typoWarnings,
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
  type ErrorCode,
  type Violation,
} from "./violations.ts";
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
export { exportSession, type ExportSession } from "./session.ts";
export { REDACTED, redactOnPrint, redactValues } from "./redact.ts";
