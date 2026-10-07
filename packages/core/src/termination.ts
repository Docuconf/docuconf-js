import { existsSync, writeFileSync } from "node:fs";
import { DocuconfValidationError, type Violation, formatViolations } from "./violations.ts";

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

/** Whether the process is a test runner's worker (Vitest, Jest, node:test). */
export function underTestRunner(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return Boolean(env["VITEST"] || env["JEST_WORKER_ID"] || env["NODE_TEST_CONTEXT"]);
}

export interface BootFailureOptions {
  /** Where to write violations; see writeTerminationLog. */
  terminationLog?: string | false | undefined;
  /**
   * Print the violations to stderr and exit with status 1, instead of
   * throwing. Under a test runner it throws anyway, so a test can assert on
   * the error.
   */
  exitOnError?: boolean | undefined;
}

/**
 * What every SDK does when boot validation fails: write the termination
 * log, then print `docuconf: N configuration problems:` with one line per
 * problem and exit 1 (exitOnError), or throw DocuconfValidationError.
 */
export function failBoot(violations: readonly Violation[], opts: BootFailureOptions = {}): never {
  const message = formatViolations(violations);
  writeTerminationLog(message, opts.terminationLog);
  if (opts.exitOnError === true && !underTestRunner()) exitWith(message);
  throw new DocuconfValidationError(violations);
}

/** Prints `message` to stderr and exits 1, with no stack trace. */
export function exitWith(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
