import { existsSync, writeFileSync } from "node:fs";

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

/** Thrown by createEnv when the environment or a file input is invalid. */
export class DocuconfValidationError extends Error {
  readonly violations: readonly Violation[];
  constructor(violations: readonly Violation[]) {
    super(formatViolations(violations));
    this.name = "DocuconfValidationError";
    this.violations = violations;
  }
}

/** Thrown when the declaration itself is invalid (SPEC §11.2 item 2). */
export class DocuconfDeclarationError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`docuconf: invalid declaration:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "DocuconfDeclarationError";
    this.problems = problems;
  }
}

const DEFAULT_TERMINATION_LOG = "/dev/termination-log";
/** Kubernetes reads at most 4096 bytes of the termination message. */
const TERMINATION_LOG_LIMIT = 4096;

/**
 * Writes violations to the Kubernetes termination log so `kubectl describe
 * pod` shows them. DOCUCONF_TERMINATION_LOG overrides the path (and is
 * written even if it does not exist yet); the default path is only written
 * when it exists, i.e. inside a container.
 */
export function writeTerminationLog(message: string, override?: string | false): void {
  if (override === false) return;
  const fromEnv = process.env["DOCUCONF_TERMINATION_LOG"];
  const path = override ?? (fromEnv !== undefined && fromEnv !== "" ? fromEnv : undefined);
  const target = path ?? DEFAULT_TERMINATION_LOG;
  if (path === undefined && !existsSync(target)) return;
  let buf = Buffer.from(message, "utf8");
  if (buf.length > TERMINATION_LOG_LIMIT) buf = buf.subarray(0, TERMINATION_LOG_LIMIT);
  try {
    writeFileSync(target, buf);
  } catch {
    // Best effort: the error is still thrown and logged.
  }
}
