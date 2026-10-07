/** Stable error codes from SPEC §11.2 item 5. */
export const ERROR_CODES = [
  "missing_required",
  "invalid_type",
  "out_of_range",
  "pattern_mismatch",
  "not_in_enum",
  "invalid_scheme",
  "too_few_items",
  "too_many_items",
  "file_missing",
  // The file exists but cannot be read, e.g. a root-owned 0400 secret
  // volume in a non-root container.
  "file_unreadable",
  "file_too_large",
  "file_malformed",
  "schema_mismatch",
  "certificate_invalid",
  "certificate_expiring",
  "certificate_name_mismatch",
  "key_mismatch",
  "keystore_unreadable",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** One problem found while validating the environment or a file input at boot. */
export interface Violation {
  /** Variable name (`PORT`) or file input name (`serving-tls`). */
  input: string;
  kind: "var" | "file";
  code: ErrorCode;
  /** Human-readable detail. Never contains a secret value. */
  message: string;
}

export function formatViolation(v: Violation): string {
  return `${v.input} [${v.code}]: ${v.message}`;
}

export function formatViolations(violations: readonly Violation[]): string {
  const n = violations.length;
  const lines = violations.map((v) => `  - ${formatViolation(v)}`);
  return `docuconf: ${n} configuration problem${n === 1 ? "" : "s"}:\n${lines.join("\n")}`;
}

const INSPECT = Symbol.for("nodejs.util.inspect.custom");

/**
 * Makes an error print as its message alone: no stack frames (they point
 * into docuconf, never at the user's mistake) and no property dump, when
 * Node prints an uncaught error, console.log or a framework logger shows it.
 */
function plain(e: Error, data: Record<string, unknown>): void {
  for (const [k, v] of Object.entries({ name: e.name, ...data })) Object.defineProperty(e, k, { value: v, enumerable: false, configurable: true });
  Object.defineProperty(e, "stack", { value: e.message, enumerable: false, writable: true, configurable: true });
  Object.defineProperty(e, INSPECT, { value: () => e.message, enumerable: false });
}

/** Thrown by createEnv or validate when the environment or a file input is invalid. */
export class DocuconfValidationError extends Error {
  declare readonly violations: readonly Violation[];
  constructor(violations: readonly Violation[]) {
    super(formatViolations(violations));
    this.name = "DocuconfValidationError";
    plain(this, { violations });
  }
}

/** Thrown when the declaration itself is invalid (SPEC §11.2 item 2). */
export class DocuconfDeclarationError extends Error {
  declare readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`docuconf: invalid declaration:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "DocuconfDeclarationError";
    plain(this, { problems });
  }
}
