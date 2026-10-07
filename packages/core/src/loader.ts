// ESM only (subpath "@docuconf/core/loader"): used by the SDKs' export CLIs.
import { existsSync, readFileSync, statSync } from "node:fs";
import * as nodeModule from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const LOADER_ERRORS = new Set([
  "ERR_UNKNOWN_FILE_EXTENSION",
  "ERR_MODULE_NOT_FOUND",
  "ERR_UNSUPPORTED_DIR_IMPORT",
  "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX",
  "ERR_INVALID_TYPESCRIPT_SYNTAX",
  "ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING",
  "ERR_REQUIRE_ESM",
]);

function errorCode(e: unknown): string | undefined {
  return (e as { code?: string } | undefined)?.code;
}

function isLoaderError(e: unknown): boolean {
  const code = errorCode(e);
  return (code !== undefined && LOADER_ERRORS.has(code)) || e instanceof SyntaxError;
}

/** tsconfig `paths`, resolved to absolute targets. */
export interface PathAliases {
  /** The tsconfig.json they came from. */
  tsconfig: string;
  /** `@/*` → [`/abs/src/*`], in tsconfig order. */
  paths: Array<[pattern: string, targets: string[]]>;
}

/** tsconfig.json is JSON with comments and trailing commas. */
function parseJsonc(text: string): unknown {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
      out += text.slice(start, i + 1);
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2);
      if (i < 0) break;
      i++;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

interface TsConfig {
  extends?: string | string[];
  compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
}

function readTsConfig(file: string, seen = new Set<string>()): { baseUrl?: string; paths?: Record<string, string[]>; pathsBase?: string } {
  if (seen.has(file)) return {};
  seen.add(file);
  const cfg = parseJsonc(readFileSync(file, "utf8")) as TsConfig;
  let out: { baseUrl?: string; paths?: Record<string, string[]>; pathsBase?: string } = {};
  const parents = cfg.extends === undefined ? [] : Array.isArray(cfg.extends) ? cfg.extends : [cfg.extends];
  for (const parent of parents) {
    let target: string;
    try {
      target = parent.startsWith(".") || isAbsolute(parent)
        ? resolve(dirname(file), parent.endsWith(".json") ? parent : `${parent}.json`)
        : nodeModule.createRequire(file).resolve(parent);
    } catch {
      continue;
    }
    if (existsSync(target)) out = { ...out, ...readTsConfig(target, seen) };
  }
  const co = cfg.compilerOptions ?? {};
  if (co.baseUrl !== undefined) out.baseUrl = resolve(dirname(file), co.baseUrl);
  if (co.paths !== undefined) {
    out.paths = co.paths;
    out.pathsBase = dirname(file);
  }
  return out;
}

/** The nearest tsconfig.json above `file` (or `tsconfig` itself), and its `paths`. */
export function readPathAliases(file: string, tsconfig?: string): PathAliases | undefined {
  let config = tsconfig === undefined ? undefined : resolve(tsconfig);
  if (config === undefined) {
    for (let dir = dirname(resolve(file)); ; dir = dirname(dir)) {
      const candidate = join(dir, "tsconfig.json");
      if (existsSync(candidate)) {
        config = candidate;
        break;
      }
      if (dirname(dir) === dir || existsSync(join(dir, ".git"))) return undefined;
    }
  }
  const { baseUrl, paths, pathsBase } = readTsConfig(config);
  if (!paths) return { tsconfig: config, paths: [] };
  // TypeScript resolves `paths` against baseUrl when set, else the tsconfig declaring them.
  const base = baseUrl ?? pathsBase ?? dirname(config);
  return { tsconfig: config, paths: Object.entries(paths).map(([k, targets]) => [k, targets.map((t) => resolve(base, t))]) };
}

/** The files an aliased specifier may name, in the order TypeScript tries them. */
function aliasCandidates(specifier: string, aliases: PathAliases): string[] {
  const out: string[] = [];
  for (const [pattern, targets] of aliases.paths) {
    const star = pattern.indexOf("*");
    let rest: string | undefined;
    if (star < 0) rest = specifier === pattern ? "" : undefined;
    else {
      const prefix = pattern.slice(0, star);
      const suffix = pattern.slice(star + 1);
      if (specifier.startsWith(prefix) && specifier.endsWith(suffix) && specifier.length >= prefix.length + suffix.length) {
        rest = specifier.slice(prefix.length, specifier.length - suffix.length);
      }
    }
    if (rest === undefined) continue;
    for (const t of targets) out.push(t.replace("*", rest));
  }
  return out;
}

const TS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"];

/** A file for a TypeScript-style specifier: as is, with an extension, `.js` naming `.ts`, or a directory's index. */
function fileFor(base: string): string | undefined {
  const isFile = (p: string) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (isFile(base)) return base;
  for (const ext of TS_EXTENSIONS) if (isFile(base + ext)) return base + ext;
  const swapped = base.replace(/\.(c|m)?js$/, ".$1ts");
  if (swapped !== base && isFile(swapped)) return swapped;
  for (const ext of TS_EXTENSIONS) if (isFile(join(base, `index${ext}`))) return join(base, `index${ext}`);
  return undefined;
}

type ResolveHook = (specifier: string, context: { parentURL?: string }, next: (s: string, c?: object) => { url: string }) => { url: string };
type RegisterHooks = (hooks: { resolve: ResolveHook }) => { deregister(): void };

let hooksActive = false;
let currentAliases: PathAliases | undefined;
/** The last bare specifier the hooks could not resolve, for the error message. */
let unresolved: { specifier: string; candidates: string[] } | undefined;
const TS_PARENT = /\.(c|m)?tsx?$/;

/**
 * Lets Node's own loader import what a TypeScript project writes: tsconfig
 * `paths` aliases (`@/lib/schemas`) and, from `.ts` files, extensionless and
 * `.js`-for-`.ts` relative imports. Needs `module.registerHooks` (Node
 * 22.15+); returns false without it.
 */
function registerResolveHooks(): boolean {
  if (hooksActive) return true;
  const registerHooks = (nodeModule as unknown as { registerHooks?: RegisterHooks }).registerHooks;
  if (!registerHooks) return false;
  hooksActive = true;
  registerHooks({
    resolve(specifier, context, next) {
      try {
        return next(specifier, context);
      } catch (e) {
        const parent = context.parentURL?.startsWith("file:") ? fileURLToPath(context.parentURL.split("?")[0]!) : undefined;
        if (parent === undefined || parent.includes("/node_modules/")) throw e;
        let candidates: string[] = [];
        if (specifier.startsWith("./") || specifier.startsWith("../")) {
          if (TS_PARENT.test(parent)) candidates = [resolve(dirname(parent), specifier)];
        } else if (currentAliases) {
          candidates = aliasCandidates(specifier, currentAliases);
        }
        for (const c of candidates) {
          const file = fileFor(c);
          if (file) return next(pathToFileURL(file).href, context);
        }
        if (!specifier.startsWith(".") && !specifier.startsWith("/") && !specifier.includes(":")) unresolved = { specifier, candidates };
        throw e;
      }
    },
  });
  return true;
}

/**
 * Runs `fn` with Node's MODULE_TYPELESS_PACKAGE_JSON warning silenced: a
 * Next.js app's package.json has no "type", so Node warns on every `.ts`
 * module with import syntax, which tells the user nothing about export.
 */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const original = process.emitWarning;
  process.emitWarning = function (this: unknown, warning: string | Error, ...rest: unknown[]) {
    const code = typeof rest[0] === "object" && rest[0] !== null ? (rest[0] as { code?: string }).code : rest[1];
    if (code === "MODULE_TYPELESS_PACKAGE_JSON") return;
    return (original as (...a: unknown[]) => void).call(process, warning, ...rest);
  } as typeof process.emitWarning;
  try {
    return await fn();
  } finally {
    process.emitWarning = original;
  }
}

let generation = 0;

/** Options for importModule. */
export interface ImportOptions {
  /** The tsconfig.json whose `paths` apply. Default: the nearest one above the module. */
  tsconfig?: string | undefined;
}

/** Thrown when the module under export cannot be loaded, or throws while it loads. */
export class ExportLoadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ExportLoadError";
    Object.defineProperty(this, "stack", { value: message, enumerable: false, writable: true, configurable: true });
  }
}

function describeFailure(file: string, e: unknown, aliases: PathAliases | undefined): ExportLoadError {
  const shown = relative(process.cwd(), resolve(file)) || file;
  let message = e instanceof Error ? e.message.split("\n")[0]! : String(e);
  const hints: string[] = [];
  const missing = /Cannot find (module|package) '([^']+)'/.exec(message)?.[2];
  const miss = unresolved;
  unresolved = undefined;
  if (missing !== undefined && miss !== undefined && miss.specifier.startsWith(missing)) {
    // Node names only the package part ("@/lib"); say what the code wrote.
    message = `Cannot find module '${miss.specifier}'`;
    const config = aliases ? relative(process.cwd(), aliases.tsconfig) : undefined;
    if (miss.candidates.length > 0) {
      hints.push(`tsconfig "paths" in ${config} map it to ${miss.candidates.map((c) => relative(process.cwd(), c)).join(", ")}, which does not exist`);
    } else if (/^[@~#]\//.test(miss.specifier) || miss.specifier.startsWith("#")) {
      hints.push(
        config === undefined
          ? `no tsconfig.json was found to read "paths" from; import it with a relative path or pass --tsconfig`
          : `no tsconfig "paths" entry in ${config} matches it; import it with a relative path or pass --tsconfig`,
      );
    } else hints.push(`is "${missing}" installed?`);
  } else if (missing !== undefined && !missing.startsWith(".") && !missing.startsWith("/")) {
    hints.push(`is "${missing}" installed?`);
  } else if (errorCode(e) === "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX" || errorCode(e) === "ERR_UNKNOWN_FILE_EXTENSION") {
    hints.push("Node cannot run this TypeScript as is (enums, namespaces, or Node before 22.18); install jiti (npm install --save-dev jiti) and docuconf uses it");
  } else if (!isLoaderError(e)) {
    hints.push("the module ran code while it loaded; if it uses env at import time (a server, a route), export the module that declares the configuration instead");
  }
  return new ExportLoadError(`docuconf: cannot load ${shown}: ${message}${hints.map((h) => `\n  hint: ${h}`).join("")}`, { cause: e });
}

/**
 * Imports a module for export. Node 22.18+ strips TypeScript types
 * natively; resolve hooks add tsconfig `paths` aliases and TypeScript-style
 * relative imports. Syntax Node cannot strip (enums, decorators) goes
 * through jiti, when the project has it installed.
 */
export async function importModule(file: string, opts: ImportOptions = {}): Promise<unknown> {
  const abs = resolve(file);
  let aliases: PathAliases | undefined;
  try {
    aliases = readPathAliases(abs, opts.tsconfig);
  } catch (e) {
    throw new ExportLoadError(`docuconf: cannot read ${opts.tsconfig ?? "tsconfig.json"}: ${(e as Error).message}`, { cause: e });
  }
  currentAliases = aliases;
  unresolved = undefined;
  registerResolveHooks();
  let firstError: unknown;
  try {
    // A fresh URL per call, so a second export in one process re-runs the
    // module instead of reusing the cached one.
    return await quietly(() => import(`${pathToFileURL(abs).href}?docuconf-export=${++generation}`));
  } catch (e) {
    if (!isLoaderError(e)) throw describeFailure(file, e, aliases);
    firstError = e;
  }
  let jiti: typeof import("jiti");
  try {
    jiti = await import("jiti");
  } catch {
    throw describeFailure(file, firstError, aliases);
  }
  const alias: Record<string, string> = {};
  for (const [pattern, targets] of aliases?.paths ?? []) {
    if (targets[0] !== undefined) alias[pattern.replace(/\*$/, "")] = targets[0].replace(/\*$/, "");
  }
  try {
    return await jiti.createJiti(pathToFileURL(abs).href, { interopDefault: true, moduleCache: false, alias }).import(abs);
  } catch (e) {
    // When neither loader finds an import, Node's message names it as written.
    const notFound = errorCode(e) === "MODULE_NOT_FOUND" && errorCode(firstError) === "ERR_MODULE_NOT_FOUND";
    throw describeFailure(file, notFound ? firstError : e, aliases);
  }
}
