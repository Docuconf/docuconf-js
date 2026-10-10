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
export { MAX_DETAILS, applyDocComments, callerFile, detailsFromDocComment, detailsProblem, jsDocText, jsDocToMarkdown, setDetails } from "./doc-text.ts";
export {
  CONTRACT_DURATION,
  DURATION_ENCODINGS,
  DURATION_EXAMPLE,
  canonicalDuration,
  formatDuration,
  formatSignedDuration,
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
  splitCsv,
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
export { KEYSET_DEFAULTS, KeySet, keySetContract, keySetDeclProblems, keySetProblems, type KeySetBounds } from "./keyset.ts";
export { cleanPattern, nonRe2Feature, re2RegExp } from "./re2.ts";
export {
  BOOL_SYNTAX,
  ENV_NAME,
  FLOAT_SYNTAX,
  GENERIC,
  MAX_DEPRECATED_MESSAGE,
  deprecatedProblems,
  deprecatedWarning,
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
  exactInt,
  intItem,
  jsonText,
  narrowInt,
  parseJsonExact,
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
  type RejectedReload,
  type ReloadStatus,
  type SchemaAdapter,
  type TextFileOptions,
  type TlsFileOptions,
  type TlsMaterial,
} from "./files/spec.ts";
export { exportSession, type ExportSession } from "./session.ts";
export { REDACTED, errorType, redactOnPrint, redactValues } from "./redact.ts";
export { renderMarkdown } from "./docs.ts";
