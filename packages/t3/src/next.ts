// @docuconf/t3/next: boot validation for Next.js, from instrumentation.ts.
// Next.js compiles instrumentation.ts for the Node.js and the Edge runtime,
// so this module imports no Node built-ins and reaches `process` at run time.

/** What Next.js calls once when a server instance starts. */
export type Register = () => Promise<void>;

export interface RegisterEnvOptions {
  /**
   * Print the problems and exit 1 when the configuration is invalid
   * (default), so the pod fails to start and `kubectl describe pod` shows
   * why. `false` rethrows instead, and Next.js logs the error and serves 500s.
   */
  exitOnError?: boolean;
}

interface Proc {
  env: Record<string, string | undefined>;
  stderr?: { write(s: string): unknown };
  exit?: (code: number) => never;
}

function proc(): Proc | undefined {
  return (globalThis as { process?: Proc }).process;
}

function isDocuconfError(e: unknown): e is Error {
  const name = (e as { name?: unknown } | null)?.name;
  return name === "DocuconfValidationError" || name === "DocuconfDeclarationError";
}

/**
 * Validates the environment when the Next.js server starts, by importing
 * the module that calls createEnv. On invalid configuration it prints
 * `docuconf: N configuration problems:` and exits 1 (the violations are
 * already in the termination log), instead of serving 500s.
 *
 * ```ts
 * // src/instrumentation.ts
 * import { registerEnv } from "@docuconf/t3/next";
 *
 * export const register = registerEnv(() => import("./env"));
 * ```
 *
 * It does nothing in the Edge runtime, which has no process to exit, and
 * during `next build`, where createEnv skips validation: configuration is
 * read when the server starts, never at build time.
 */
export function registerEnv(load: () => Promise<unknown>, opts: RegisterEnvOptions = {}): Register {
  return async function register() {
    const p = proc();
    if (p?.env["NEXT_RUNTIME"] === "edge" || p?.env["NEXT_PHASE"] === "phase-production-build") return;
    try {
      await load();
    } catch (e) {
      const testRunner = Boolean(p?.env["VITEST"] || p?.env["JEST_WORKER_ID"] || p?.env["NODE_TEST_CONTEXT"]);
      if (!isDocuconfError(e) || opts.exitOnError === false || testRunner || !p?.exit) throw e;
      p.stderr?.write(`${e.message}\n`);
      p.exit(1);
    }
  };
}
