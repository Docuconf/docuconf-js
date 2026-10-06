// ESM only (subpath "@docuconf/core/loader"): used by the SDKs' export CLIs.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

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
 * Imports a module for export. Node 22.18+ strips TypeScript types
 * natively, which handles `.ts` files whose imports name their extensions.
 * Anything else (extensionless imports, path aliases, enums, decorators)
 * goes through jiti.
 */
export async function importModule(file: string): Promise<unknown> {
  const abs = resolve(file);
  try {
    // A fresh URL per call, so a second export in one process re-runs the
    // module instead of reusing the cached one.
    return await import(`${pathToFileURL(abs).href}?docuconf-export=${++generation}`);
  } catch (e) {
    if (!isLoaderError(e)) throw e;
  }
  const { createJiti } = await import("jiti");
  return createJiti(pathToFileURL(abs).href, { interopDefault: true, moduleCache: false }).import(abs);
}
