import {
  DocuconfDeclarationError,
  FileState,
  type LoadContext,
  type Violation,
  exitWith,
  exportSession,
  failBoot,
  underTestRunner,
  deprecatedWarning,
  fileRootFrom,
  redactOnPrint,
  redactValues,
  typoWarnings,
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
  /**
   * On invalid configuration, print `docuconf: N configuration problems:`
   * with one line per problem to stderr and exit 1, instead of throwing a
   * DocuconfValidationError for Nest to log. Under a test runner (Vitest,
   * Jest, node:test) it throws anyway. Default false.
   */
  exitOnError?: boolean;
}

/** Options for `validate.check`. */
export interface CheckOptions {
  /** Prefix for absolute file paths, as DOCUCONF_FILE_ROOT. Default: none (DOCUCONF_FILE_ROOT is not read). */
  fileRoot?: string;
}

/** What `validate.check` found. */
export interface CheckResult<T> {
  /** Typed values of the variables that passed. Secrets included: do not log this object as is. */
  values: Partial<T>;
  /** Every problem, as validate would report it. Empty when the map is valid. */
  violations: Violation[];
  /** Hints validate would log: deprecated variables, likely typos. */
  warnings: string[];
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
  /**
   * Validates an explicit map as `validate` does, without throwing, writing
   * the termination log or watching files, and without reading
   * process.env. For tests:
   *
   * ```ts
   * expect(validate.check({ PORT: "0" }).violations.map((v) => v.code)).toContain("out_of_range");
   * ```
   */
  check(config: Record<string, unknown>, opts?: CheckOptions): CheckResult<T>;
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
  let decl: NestDeclaration;
  try {
    decl = declare(cls as unknown as Class, { name: opts.name, appVersion: opts.appVersion });
  } catch (e) {
    // With exitOnError, a broken declaration also prints its problems and exits 1.
    if (opts.exitOnError === true && e instanceof DocuconfDeclarationError && !session.current() && !underTestRunner()) exitWith(e.message);
    throw e;
  }
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

  const secrets = new Set([...decl.vars.values()].filter((d) => d.secret).map((d) => d.name));

  /** Validates `config` (the environment Nest passes in); reads nothing else but the file root. */
  const run = (config: Record<string, unknown>, root: string | undefined) => {
    const env: Record<string, unknown> = { ...config };
    const instance = new cls() as Record<string, unknown>;
    const { values, violations } = validateEnv(decl.vars, env, instance);
    const warnings: string[] = [];
    for (const [name, d] of decl.vars) {
      // Names the variable and the message, never the value.
      if (d.deprecated && env[name] !== undefined && env[name] !== "") warnings.push(deprecatedWarning(name, d.deprecated));
    }
    warnings.push(...typoWarnings(decl.vars.keys(), config));
    const ctx: LoadContext = { env, values, root, adapter: schemaAdapter };
    const files = new FileState(decl.files, ctx);
    violations.push(...files.loadAll());
    for (const [name, input] of Object.entries(decl.files)) {
      const dep = input.options.deprecated;
      if (dep && files.get(name) !== undefined) warnings.push(deprecatedWarning(name, dep));
    }
    return { values, violations, warnings, files };
  };

  const validate = (config: Record<string, unknown>): T => {
    // Export mode: the module is only being loaded for its declaration.
    if (session.current()) return { ...config } as T;
    if (!warned) {
      warned = true;
      for (const w of decl.warnings) warn(w);
    }
    const rootFromEnv = typeof config["DOCUCONF_FILE_ROOT"] === "string" && config["DOCUCONF_FILE_ROOT"] !== "" ? (config["DOCUCONF_FILE_ROOT"] as string) : undefined;
    state?.close();
    const { values, violations, warnings, files } = run(config, fileRootFrom(opts.fileRoot ?? rootFromEnv));
    for (const w of warnings) warn(w);

    if (violations.length > 0) failBoot(violations, opts);
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
    // console.log(config) and JSON.stringify(config) show the declared
    // variables, with secrets as [redacted].
    redactOnPrint(result, () => redactValues(Object.fromEntries([...decl.vars.keys()].map((k) => [k, result[k]])), secrets));
    if (opts.watch !== false) files.watch();
    return result as T;
  };

  const check = (config: Record<string, unknown>, checkOpts: CheckOptions = {}): CheckResult<T> => {
    const { values, violations, warnings } = run(config, checkOpts.fileRoot);
    const failed = new Set(violations.map((v) => v.input));
    const passed: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(values)) if (!failed.has(k) && v !== undefined) passed[k] = v;
    return { values: passed as Partial<T>, violations, warnings };
  };

  return Object.assign(validate, {
    [DECLARATION]: decl,
    declaration: decl,
    onFileChange: (name: string, listener: (value: unknown) => void) => current().onChange(inputName(name), listener),
    reloadFile: (name: string) => current().reload(inputName(name)),
    close: () => state?.close(),
    check,
  }) as DocuconfValidate<T>;
}
