import {
  type CreateEnv,
  type DefaultCombinedSchema,
  type EnvOptions,
  type StandardSchemaDictionary,
  type StandardSchemaV1,
  createEnv as t3CreateEnv,
} from "@t3-oss/env-core";
import {
  DocuconfValidationError,
  FileState,
  type FileInputs,
  type FileValues,
  type LoadContext,
  type Violation,
  exportSession,
  fileRootFrom,
  formatViolation,
  formatViolations,
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
}

const DOCUCONF_KEYS = ["name", "appVersion", "files", "fileRoot", "terminationLog", "onWarning", "watch"] as const;

export const DECLARATION: unique symbol = Symbol.for("docuconf.declaration") as never;
const FILE_STATE = Symbol.for("docuconf.fileState");
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
  const decl = declare({ name: o.name, appVersion: o.appVersion, server, files });

  const t3opts: Record<string, unknown> = { ...o };
  for (const k of DOCUCONF_KEYS) delete t3opts[k];
  const t3 = (extra: Record<string, unknown>) => t3CreateEnv({ ...t3opts, ...extra } as never) as object;

  const exporting = session.current();
  if (exporting) {
    exporting.declarations.push(decl);
    return wrap(t3({ skipValidation: true }), decl, new FileState({}, emptyCtx())) as never;
  }

  const warn = o.onWarning ?? ((m: string) => console.warn(`docuconf: ${m}`));
  for (const w of decl.warnings) warn(w);

  const isServer = (o["isServer"] as boolean | undefined) ?? isServerRuntime();
  if (o["skipValidation"] === true || !isServer) {
    return wrap(t3({}), decl, new FileState({}, emptyCtx())) as never;
  }

  const raw = (o["runtimeEnvStrict"] ?? o["runtimeEnv"] ?? process.env) as Record<string, unknown>;
  const env: Record<string, unknown> = { ...raw };
  const values: Record<string, unknown> = {};
  const violations: Violation[] = [];

  for (const [name, d] of decl.vars) {
    const r = validateVar(d, env[name]);
    if (env[name] === "" && d.type !== "string") delete env[name];
    values[name] = r.value;
    violations.push(...r.violations);
    const dep = d.contract["deprecated"] as { message: string } | undefined;
    if (dep && env[name] !== undefined) warn(`${name} is deprecated: ${dep.message}`);
  }
  // Client and shared variables are not in the contract, but T3 validates
  // them on the server too, so report them in the same pass.
  const others = { ...((o["shared"] ?? {}) as object), ...((o["client"] ?? {}) as object) } as Record<string, StandardSchemaV1>;
  for (const [name, schema] of Object.entries(others)) {
    if (!schema || decl.vars.has(name)) continue;
    const pseudo: VarDecl = { name, schema, type: "string", secret: false, required: false, contract: {} };
    violations.push(...validateVar(pseudo, env[name]).violations);
  }

  const ctx: LoadContext = { env, values, root: fileRootFrom(o.fileRoot), adapter: standardSchemaAdapter };
  const state = new FileState(files, ctx);
  violations.push(...state.loadAll());

  if (violations.length > 0) {
    const message = formatViolations(violations);
    writeTerminationLog(message, o.terminationLog);
    const onValidationError = o["onValidationError"] as ((issues: StandardSchemaV1.Issue[]) => never) | undefined;
    if (onValidationError) {
      return onValidationError(violations.map((v) => ({ message: formatViolation(v), path: [v.input] })));
    }
    throw new DocuconfValidationError(violations);
  }

  const result = wrap(t3({ runtimeEnv: env, runtimeEnvStrict: undefined }), decl, state);
  if (o.watch !== false) state.watch();
  return result as never;
}

function emptyCtx(): LoadContext {
  return { env: {}, values: {}, root: undefined, adapter: standardSchemaAdapter };
}

function wrap(t3env: object, decl: Declaration, state: FileState): object {
  return new Proxy(t3env, {
    get(target, prop) {
      if (prop === "files") return state.proxy;
      if (prop === DECLARATION) return decl;
      if (prop === FILE_STATE) return state;
      return Reflect.get(target, prop);
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
