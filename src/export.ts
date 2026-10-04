import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type ContractOptions, renderContract } from "./contract.ts";
import type { Declaration } from "./declaration.ts";
import { beginExport, endExport } from "./env.ts";

const LOADER_ERRORS = new Set([
  "ERR_UNKNOWN_FILE_EXTENSION",
  "ERR_MODULE_NOT_FOUND",
  "ERR_UNSUPPORTED_DIR_IMPORT",
  "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX",
  "ERR_INVALID_TYPESCRIPT_SYNTAX",
  "ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING",
  "ERR_REQUIRE_ESM",
]);

function isLoaderError(e: unknown): boolean {
  const code = (e as { code?: string })?.code;
  return (code !== undefined && LOADER_ERRORS.has(code)) || e instanceof SyntaxError;
}

let generation = 0;

/**
 * Imports a module. Node 22.18+ strips TypeScript types natively, which
 * handles `.ts` files whose imports name their extensions. Anything else
 * (extensionless imports, path aliases, enums) goes through jiti.
 */
export async function importModule(file: string): Promise<unknown> {
  const abs = resolve(file);
  try {
    // A fresh URL per call, so a second export in one process re-runs the
    // module's createEnv call instead of reusing the cached module.
    return await import(`${pathToFileURL(abs).href}?docuconf-export=${++generation}`);
  } catch (e) {
    if (!isLoaderError(e)) throw e;
  }
  const { createJiti } = await import("jiti");
  return createJiti(import.meta.url, { interopDefault: true, moduleCache: false }).import(abs);
}

export interface ExportResult {
  cue: string;
  warnings: string[];
  declaration: Declaration;
}

/**
 * Loads `file` in export mode (createEnv skips validation and file loading)
 * and renders the contract of the createEnv call it makes.
 */
export async function exportModule(file: string, opts: ContractOptions = {}): Promise<ExportResult> {
  const session = beginExport();
  try {
    await importModule(file);
  } finally {
    endExport();
  }
  const decls = session.declarations;
  if (decls.length === 0) throw new Error(`docuconf: ${file} did not call createEnv from @docuconf/t3`);
  if (decls.length > 1) throw new Error(`docuconf: ${file} called createEnv ${decls.length} times; export one service per module`);
  const declaration = decls[0]!;
  return { cue: renderContract(declaration, opts), warnings: declaration.warnings, declaration };
}
