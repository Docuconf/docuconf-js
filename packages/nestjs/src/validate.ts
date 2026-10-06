import {
  DocuconfValidationError,
  FileState,
  type LoadContext,
  exportSession,
  fileRootFrom,
  formatViolations,
  writeTerminationLog,
} from "@docuconf/core";
import { type Class, schemaAdapter } from "./classes.ts";
import { type NestDeclaration, declare } from "./declaration.ts";
import { validateEnv } from "./env.ts";

export interface DocuconfValidateOptions {
  /** Service name for the contract (a DNS label). `docuconf-nestjs export --name` overrides it. */
  name?: string;
  /** metadata.appVersion for the contract. */
  appVersion?: string;
  /** Prefix for absolute file paths. Default: DOCUCONF_FILE_ROOT. */
  fileRoot?: string;
  /** Where to write violations. Default: DOCUCONF_TERMINATION_LOG, else /dev/termination-log if it exists. `false` disables. */
  terminationLog?: string | false;
  /** Receives declaration hints (feature-flag names, deprecated variables, constraints the contract cannot express). Default: console.warn. */
  onWarning?: (message: string) => void;
  /** Watch `reload: "watch"` file inputs. Default true. */
  watch?: boolean;
}

/**
 * The `validate` function for `ConfigModule.forRoot({ validate })`, with
 * access to file inputs after boot.
 */
export interface DocuconfValidate<T extends object> {
  (config: Record<string, unknown>): T;
  /** What docuconf read from the environment class. */
  readonly declaration: NestDeclaration;
  /**
   * Calls `listener` with the new value after a `reload: "watch"` file input
   * changes and passes its checks. `name` is the input name or its property.
   * Returns an unsubscribe function.
   */
  onFileChange(name: string, listener: (value: unknown) => void): () => void;
  /** Re-reads one file input now, as a watch event would. Returns whether it was replaced. */
  reloadFile(name: string): boolean;
  /** Stops watching file inputs. */
  close(): void;
}

const session = exportSession<NestDeclaration>(Symbol.for("docuconf.nestjs.exportSession"));
export const beginExport = session.begin;
export const endExport = session.end;

const DECLARATION = Symbol.for("docuconf.nestjs.declaration");

/** The declaration behind a validate function made by docuconfValidate, if `x` is one. */
export function declarationOf(x: unknown): NestDeclaration | undefined {
  return typeof x === "function" ? ((x as unknown as Record<symbol, unknown>)[DECLARATION] as NestDeclaration | undefined) : undefined;
}

function define(target: object, key: string, value: unknown, enumerable: boolean): void {
  Object.defineProperty(target, key, { value, enumerable, writable: true, configurable: true });
}

/**
 * Makes the `validate` function for `ConfigModule.forRoot`. It runs
 * docuconf's boot validation (SPEC §11.2) on the environment Nest passes
 * in, reports every violation together with a stable code, and returns an
 * instance of `cls` holding typed values and file inputs, so
 * `ConfigService<EnvironmentVariables, true>` reads them typed.
 *
 * ```ts
 * ConfigModule.forRoot({ validate: docuconfValidate(EnvironmentVariables, { name: "orders-api" }) })
 * ```
 *
 * The class is read when this is called: problems with the declaration
 * itself throw DocuconfDeclarationError right away.
 */
export function docuconfValidate<T extends object>(cls: new () => T, opts: DocuconfValidateOptions = {}): DocuconfValidate<T> {
  const decl = declare(cls as unknown as Class, { name: opts.name, appVersion: opts.appVersion });
  session.current()?.declarations.push(decl);
  let state: FileState | undefined;
  const warn = opts.onWarning ?? ((m: string) => console.warn(`docuconf: ${m}`));
  let warned = false;

  const inputName = (name: string) => {
    if (decl.files[name] !== undefined) return name;
    for (const [n, p] of decl.fileProperties) if (p === name) return n;
    throw new TypeError(`docuconf: no file input named ${name}`);
  };
  const current = () => {
    if (!state) throw new Error("docuconf: the environment has not been validated yet");
    return state;
  };

  const validate = (config: Record<string, unknown>): T => {
    // Export mode: the module is only being loaded for its declaration.
    if (session.current()) return { ...config } as T;
    if (!warned) {
      warned = true;
      for (const w of decl.warnings) warn(w);
    }
    const env: Record<string, unknown> = { ...config };
    const instance = new cls() as Record<string, unknown>;
    const { values, violations } = validateEnv(decl.vars, env, instance);
    for (const [name, d] of decl.vars) {
      if (d.deprecated && env[name] !== undefined && env[name] !== "") warn(`${name} is deprecated: ${d.deprecated.message}`);
    }

    const rootFromEnv = typeof env["DOCUCONF_FILE_ROOT"] === "string" && env["DOCUCONF_FILE_ROOT"] !== "" ? (env["DOCUCONF_FILE_ROOT"] as string) : undefined;
    const ctx: LoadContext = { env, values, root: fileRootFrom(opts.fileRoot ?? rootFromEnv), adapter: schemaAdapter };
    state?.close();
    const files = new FileState(decl.files, ctx);
    violations.push(...files.loadAll());

    if (violations.length > 0) {
      writeTerminationLog(formatViolations(violations), opts.terminationLog);
      throw new DocuconfValidationError(violations);
    }
    state = files;

    // An instance of the class, as the Nest docs' validate returns: typed
    // values, plus the variables the class does not declare, so Nest still
    // copies .env-file entries to process.env.
    const result = new cls() as Record<string, unknown>;
    const declared = new Set([...decl.vars.keys(), ...decl.fileProperties.values()]);
    for (const [k, v] of Object.entries(config)) if (!declared.has(k)) define(result, k, v, true);
    // Durations are milliseconds; keep them out of Object.keys so Nest does
    // not write "30000" back to process.env, where it is not a Go duration.
    for (const [name, d] of decl.vars) define(result, name, values[name], d.type !== "duration");
    // File inputs are getters, so ConfigService.get() sees reloaded values,
    // and non-enumerable, so they are never copied to process.env or logged.
    for (const [name, property] of decl.fileProperties) {
      Object.defineProperty(result, property, { get: () => files.get(name), enumerable: false, configurable: true });
    }
    if (opts.watch !== false) files.watch();
    return result as T;
  };

  return Object.assign(validate, {
    [DECLARATION]: decl,
    declaration: decl,
    onFileChange: (name: string, listener: (value: unknown) => void) => current().onChange(inputName(name), listener),
    reloadFile: (name: string) => current().reload(inputName(name)),
    close: () => state?.close(),
  }) as DocuconfValidate<T>;
}
