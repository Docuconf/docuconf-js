// ESM only: used by the export CLI.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as nodeModule from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ImportOptions, importModule } from "@docuconf/core/loader";

/**
 * Nest apps are written with legacy decorators and emitted design types,
 * which neither Node's type stripping nor jiti's Babel transform handle.
 * So `.ts` files are compiled the way `nest build` compiles them: with the
 * project's own TypeScript, through Node's synchronous module hooks.
 */

interface TypeScript {
  transpileModule(
    input: string,
    opts: { compilerOptions: Record<string, unknown>; fileName: string },
  ): { outputText: string };
  ModuleKind: { CommonJS: number; ESNext: number };
  ScriptTarget: { ES2022: number };
}

type Hooks = {
  load(url: string, context: object, next: (u: string, c?: object) => object): object;
};
type RegisterHooks = (hooks: Hooks) => { deregister(): void };

const TS_FILE = /\.(c|m)?ts$/;
let registered = false;

function packageType(file: string): "module" | "commonjs" {
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { type?: string };
      return pkg.type === "module" ? "module" : "commonjs";
    } catch {
      // keep looking
    }
    if (dirname(dir) === dir) return "commonjs";
  }
}

function findTypeScript(file: string): TypeScript | undefined {
  for (const base of [file, fileURLToPath(import.meta.url)]) {
    try {
      return createRequire(base)("typescript") as TypeScript;
    } catch {
      // try the next
    }
  }
  return undefined;
}

function register(ts: TypeScript): boolean {
  const registerHooks = (nodeModule as unknown as { registerHooks?: RegisterHooks }).registerHooks;
  if (!registerHooks) return false;
  if (registered) return true;
  registered = true;
  registerHooks({
    load(url, context, next) {
      const path = url.startsWith("file:") ? fileURLToPath(url.split("?")[0]!) : "";
      if (!TS_FILE.test(path) || path.includes("/node_modules/")) return next(url, context);
      const format = path.endsWith(".mts") ? "module" : path.endsWith(".cts") ? "commonjs" : packageType(path);
      const { outputText } = ts.transpileModule(readFileSync(path, "utf8"), {
        fileName: path,
        compilerOptions: {
          module: format === "module" ? ts.ModuleKind.ESNext : ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
          useDefineForClassFields: false,
          esModuleInterop: true,
          rewriteRelativeImportExtensions: true,
          inlineSourceMap: true,
        },
      });
      return { format, source: outputText, shortCircuit: true };
    },
  });
  return true;
}

/**
 * Imports a module for export, as @docuconf/core's loader does (tsconfig
 * `paths` aliases, TypeScript-style relative imports), with `.ts` files
 * compiled by the project's own TypeScript when it has it.
 */
export async function importForExport(file: string, opts: ImportOptions = {}): Promise<unknown> {
  if (TS_FILE.test(file)) {
    const ts = findTypeScript(file);
    if (ts) register(ts);
  }
  return importModule(file, opts);
}
