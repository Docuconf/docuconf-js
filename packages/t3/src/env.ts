import {
  type CreateEnv,
  type DefaultCombinedSchema,
  type EnvOptions,
  type StandardSchemaDictionary,
  type StandardSchemaV1,
  createEnv as t3CreateEnv,
} from "@t3-oss/env-core";
import {
  FileState,
  type FileInputs,
  type FileValues,
  type LoadContext,
  type Violation,
  DocuconfDeclarationError,
  exitWith,
  exportSession,
  failBoot,
  underTestRunner,
  fileRootFrom,
  formatViolation,
  formatViolations,
  redactValues,
  typoWarnings,
  writeTerminationLog,
} from "@docuconf/core";
import { type ContractOptions, renderContract } from "./contract.ts";
import { type Declaration, declare } from "./declaration.ts";
import type { VarDecl } from "./introspect.ts";
import { standardSchemaAdapter } from "./jsonschema.ts";
import { validateVar } from "./validate.ts";

/** Options docuconf adds to T3's createEnv. */
export interface DocuconfOptions<TFiles extends FileInputs> {
  /** Service name for the contract (a DNS label). `docuconf export --name` overrides it. */
  name?: string;
  /** metadata.appVersion for the contract. */
  appVersion?: string;
  /** File inputs (SPEC §4.6): configFile(), tlsFile(), caBundleFile(), keystoreFile(), textFile(), binaryFile(). */
  files?: TFiles;
  /** Prefix for absolute file paths. Defaults to DOCUCONF_FILE_ROOT. */
  fileRoot?: string;
  /** Where to write violations. Default: DOCUCONF_TERMINATION_LOG, else /dev/termination-log if it exists. `false` disables. */
  terminationLog?: string | false;
  /** Receives declaration hints (feature-flag names, deprecated variables). Default: console.warn. */
  onWarning?: (message: string) => void;
  /** Watch `reload: "watch"` file inputs. Default true. */
  watch?: boolean;
  /**
   * On invalid configuration, print `docuconf: N configuration problems:`
   * with one line per problem to stderr and exit 1, instead of throwing a
   * DocuconfValidationError. Under a test runner (Vitest, Jest, node:test)
   * it throws anyway. Default false.
   */
  exitOnError?: boolean;
}

const DOCUCONF_KEYS = ["name", "appVersion", "files", "fileRoot", "terminationLog", "onWarning", "watch", "exitOnError"] as const;

export const DECLARATION: unique symbol = Symbol.for("docuconf.declaration") as never;
const FILE_STATE = Symbol.for("docuconf.fileState");
const OTHERS = Symbol.for("docuconf.otherSchemas");
const INSPECT = Symbol.for("nodejs.util.inspect.custom");
/**
 * Export mode: createEnv records declarations and skips validation and
 * file loading. Kept on globalThis so it works even when the module under
 * export resolves its own copy of @docuconf/t3.
 */
const session = exportSession<Declaration>(Symbol.for("docuconf.exportSession"));
export const beginExport = session.begin;
export const endExport = session.end;

/** T3's default: no `window`, or Deno. */
function isServerRuntime(): boolean {
  const w = (globalThis as { window?: object }).window;
  return w === undefined || "Deno" in w;
}

export type DocuconfEnv<TEnv, TFiles extends FileInputs> = TEnv & { readonly files: FileValues<TFiles> };

/**
 * T3 Env's createEnv, plus docuconf: it records the server schemas for
 * `docuconf export`, checks the declaration, validates the environment and
 * file inputs at boot with stable error codes, and exposes loaded files as
 * `env.files`.
 */
export function createEnv<
  TPrefix extends string | undefined,
  TServer extends StandardSchemaDictionary = NonNullable<unknown>,
  TClient extends StandardSchemaDictionary = NonNullable<unknown>,
  TShared extends StandardSchemaDictionary = NonNullable<unknown>,
  const TExtends extends Array<Record<string, unknown>> = [],
  TFinalSchema extends StandardSchemaV1<{}, {}> = DefaultCombinedSchema<TServer, TClient, TShared>,
  const TFiles extends FileInputs = {},
>(
  opts: EnvOptions<TPrefix, TServer, TClient, TShared, TExtends, TFinalSchema> & DocuconfOptions<TFiles>,
): DocuconfEnv<CreateEnv<TFinalSchema, TExtends>, TFiles> {
  const o = opts as unknown as Record<string, unknown> & DocuconfOptions<FileInputs>;
  const server = (o["server"] ?? {}) as Record<string, StandardSchemaV1>;
  const files = o.files ?? {};
  const decl = declareOrExit(() => declare({ name: o.name, appVersion: o.appVersion, server, files }), o.exitOnError === true && !session.current());

  const t3opts: Record<string, unknown> = { ...o };
  for (const k of DOCUCONF_KEYS) delete t3opts[k];
  const t3 = (extra: Record<string, unknown>) => t3CreateEnv({ ...t3opts, ...extra } as never) as object;

  // Client and shared variables are not in the contract, but T3 validates
  // them on the server too, so docuconf reports them in the same pass.
  const others = { ...((o["shared"] ?? {}) as object), ...((o["client"] ?? {}) as object) } as Record<string, StandardSchemaV1>;

  const exporting = session.current();
  if (exporting) {
    exporting.declarations.push(decl);
    return wrap(t3({ skipValidation: true }), decl, others, exportFiles(decl)) as never;
  }

  const warn = o.onWarning ?? ((m: string) => console.warn(`docuconf: ${m}`));
  for (const w of decl.warnings) warn(w);

  const isServer = (o["isServer"] as boolean | undefined) ?? isServerRuntime();
  // `next build` imports every module that reads env to collect page data;
  // configuration is never read at build time (SPEC §11.2), so skip, and
  // validate at boot instead (`register` from @docuconf/t3/next).
  const skip = o["skipValidation"] === true || isNextBuild();
  if (skip || !isServer) {
    return wrap(t3(skip ? { skipValidation: true } : {}), decl, others, new FileState({}, emptyCtx())) as never;
  }

  const raw = (o["runtimeEnvStrict"] ?? o["runtimeEnv"] ?? process.env) as Record<string, unknown>;
  const r = check(decl, others, raw, fileRootFrom(o.fileRoot));
  for (const w of r.warnings) warn(w);

  if (r.violations.length > 0) {
    const onValidationError = o["onValidationError"] as ((issues: StandardSchemaV1.Issue[]) => never) | undefined;
    if (onValidationError) {
      writeTerminationLog(formatViolations(r.violations), o.terminationLog);
      return onValidationError(r.violations.map((v) => ({ message: formatViolation(v), path: [v.input] })));
    }
    failBoot(r.violations, { terminationLog: o.terminationLog, exitOnError: o.exitOnError });
  }

  const result = wrap(t3({ runtimeEnv: r.env, runtimeEnvStrict: undefined }), decl, others, r.files);
  if (o.watch !== false) r.files.watch();
  return result as never;
}

/** With exitOnError, a broken declaration also prints its problems and exits 1, instead of an uncaught error. */
function declareOrExit<T>(fn: () => T, exit: boolean): T {
  try {
    return fn();
  } catch (e) {
    if (exit && e instanceof DocuconfDeclarationError && !underTestRunner()) exitWith(e.message);
    throw e;
  }
}

function isNextBuild(): boolean {
  return typeof process !== "undefined" && process.env["NEXT_PHASE"] === "phase-production-build";
}

interface CheckResult {
  /** The environment as T3 should see it: empty non-strings removed. */
  env: Record<string, unknown>;
  values: Record<string, unknown>;
  files: FileState;
  violations: Violation[];
  warnings: string[];
}

/** Boot validation: every server variable, then client and shared ones, then file inputs. Reads only `raw`. */
function check(decl: Declaration, others: Record<string, StandardSchemaV1>, raw: Record<string, unknown>, root: string | undefined): CheckResult {
  const env: Record<string, unknown> = { ...raw };
  const values: Record<string, unknown> = {};
  const violations: Violation[] = [];
  const warnings: string[] = [];

  for (const [name, d] of decl.vars) {
    const r = validateVar(d, env[name]);
    if (env[name] === "" && d.type !== "string") delete env[name];
    values[name] = r.value;
    violations.push(...r.violations);
    const dep = d.contract["deprecated"] as { message: string } | undefined;
    if (dep && env[name] !== undefined) warnings.push(`${name} is deprecated: ${dep.message}`);
  }
  for (const [name, schema] of Object.entries(others)) {
    if (!schema || decl.vars.has(name)) continue;
    const pseudo: VarDecl = { name, schema, type: "string", secret: false, required: false, contract: {} };
    violations.push(...validateVar(pseudo, env[name]).violations);
  }
  warnings.push(...typoWarnings([...decl.vars.keys(), ...Object.keys(others)], raw));

  const ctx: LoadContext = { env, values, root, adapter: standardSchemaAdapter };
  const files = new FileState(decl.files, ctx);
  violations.push(...files.loadAll());
  return { env, values, files, violations, warnings };
}

/** Options for checkEnv. */
export interface CheckEnvOptions {
  /** Prefix for absolute file paths, as DOCUCONF_FILE_ROOT. Default: none (DOCUCONF_FILE_ROOT is not read). */
  fileRoot?: string;
}

/** What checkEnv found. */
export interface CheckEnvResult<TEnv> {
  /** Typed values of the variables that passed. Secrets included: do not log this object as is. */
  values: Partial<Omit<TEnv, "files">>;
  /** Loaded file inputs that passed their checks. */
  files: Partial<TEnv extends { readonly files: infer F } ? F : Record<string, unknown>>;
  /** Every problem, as createEnv would report it. Empty when the map is valid. */
  violations: Violation[];
  /** Hints createEnv would log: deprecated variables, likely typos. */
  warnings: string[];
}

/**
 * Validates an explicit map against the declaration behind `env`, as
 * createEnv does at boot, without reading or changing process.env, writing
 * the termination log, throwing, or watching files. For tests:
 *
 * ```ts
 * const { violations } = checkEnv(env, { PORT: "0" });
 * expect(violations.map((v) => `${v.input} ${v.code}`)).toContain("PORT out_of_range");
 * ```
 */
export function checkEnv<TEnv extends object>(env: TEnv, map: Readonly<Record<string, string | undefined>>, opts: CheckEnvOptions = {}): CheckEnvResult<TEnv> {
  const decl = getDeclaration(env);
  const others = ((env as Record<symbol, unknown>)[OTHERS] ?? {}) as Record<string, StandardSchemaV1>;
  const r = check(decl, others, { ...map }, opts.fileRoot);
  const files: Record<string, unknown> = {};
  for (const name of Object.keys(decl.files)) files[name] = r.files.get(name);
  const values: Record<string, unknown> = {};
  const failed = new Set(r.violations.map((v) => v.input));
  for (const [k, v] of Object.entries(r.values)) if (!failed.has(k)) values[k] = v;
  return { values, files, violations: r.violations, warnings: r.warnings } as CheckEnvResult<TEnv>;
}

/** In export mode no file is read; say so instead of failing on `undefined`. */
function exportFiles(decl: Declaration): FileState {
  const state = new FileState({}, emptyCtx());
  const proxy = new Proxy(
    {},
    {
      get(_t, prop) {
        if (typeof prop !== "string" || !(prop in decl.files)) return undefined;
        throw new Error(
          `docuconf: env.files.${prop} is not loaded during export. This module uses env at import time; export the module that calls createEnv instead.`,
        );
      },
    },
  );
  Object.defineProperty(state, "proxy", { value: proxy });
  return state;
}

function emptyCtx(): LoadContext {
  return { env: {}, values: {}, root: undefined, adapter: standardSchemaAdapter };
}

/**
 * The env object: T3's values, plus `files` and docuconf's hidden state.
 * It prints with secrets redacted, in console.log, util.inspect and
 * JSON.stringify; reading `env.DATABASE_URL` still gives the value.
 */
function wrap(t3env: object, decl: Declaration, others: Record<string, StandardSchemaV1>, state: FileState): object {
  const secrets = new Set([...decl.vars.values()].filter((d) => d.secret).map((d) => d.name));
  // util.inspect looks through a Proxy at its target, so the target itself
  // carries the printable copy and the inspect hook.
  const target: Record<string | symbol, unknown> = {};
  for (const k of Object.keys(t3env)) target[k] = (t3env as Record<string, unknown>)[k];
  const view = () => redactValues(Object.fromEntries(Object.keys(t3env).map((k) => [k, (t3env as Record<string, unknown>)[k]])), secrets);
  const printable = (_depth: number, options: object, inspect?: (v: unknown, o: object) => string) => (inspect ? inspect(view(), options) : view());
  Object.defineProperty(target, INSPECT, { value: printable, enumerable: false });
  return new Proxy(target, {
    get(_target, prop) {
      if (prop === "files") return state.proxy;
      if (prop === DECLARATION) return decl;
      if (prop === FILE_STATE) return state;
      if (prop === OTHERS) return others;
      if (prop === INSPECT) return printable;
      if (prop === "toJSON") return view;
      return Reflect.get(t3env, prop);
    },
    has(_target, prop) {
      return prop === "files" || Reflect.has(t3env, prop);
    },
  });
}

function stateOf(env: object): FileState {
  const s = (env as Record<symbol, unknown>)[FILE_STATE];
  if (!(s instanceof FileState)) throw new TypeError("docuconf: not an env created by @docuconf/t3 createEnv");
  return s;
}

/** The declaration behind an env created by createEnv. */
export function getDeclaration(env: object): Declaration {
  const d = (env as Record<symbol, unknown>)[DECLARATION];
  if (!d) throw new TypeError("docuconf: not an env created by @docuconf/t3 createEnv");
  return d as Declaration;
}

/** The contract for an env, as CUE (what `docuconf export` writes). */
export function toContract(env: object, opts?: ContractOptions): string {
  return renderContract(getDeclaration(env), opts);
}

/**
 * Calls `listener` with the new value after a `reload: "watch"` file input
 * changes and passes its checks. Returns an unsubscribe function.
 */
export function onFileChange<TFiles extends FileInputs, K extends keyof TFiles & string>(
  env: { readonly files: FileValues<TFiles> },
  name: K,
  listener: (value: FileValues<TFiles>[K]) => void,
): () => void {
  return stateOf(env).onChange(name, listener as (v: unknown) => void);
}

/** Re-reads one file input now, as a watch event would. Returns whether it was replaced. */
export function reloadFile(env: object, name: string): boolean {
  return stateOf(env).reload(name);
}

/** Stops watching file inputs. */
export function closeWatchers(env: object): void {
  stateOf(env).close();
}
