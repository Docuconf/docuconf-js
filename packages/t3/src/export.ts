import { resolve } from "node:path";
import { DocuconfDeclarationError, applyDocComments } from "@docuconf/core";
import { callArgumentDocs, docCommentsUnavailable, importModule } from "@docuconf/core/loader";
import { type ContractOptions, renderContract } from "./contract.ts";
import type { Declaration } from "./declaration.ts";
import { beginExport, endExport } from "./env.ts";

export { importModule };

export interface ExportResult {
  cue: string;
  warnings: string[];
  declaration: Declaration;
}

/**
 * Loads `file` in export mode (createEnv skips validation and file loading)
 * and renders the contract of the createEnv call it makes.
 */
export async function exportModule(file: string, opts: ContractOptions & { tsconfig?: string | undefined } = {}): Promise<ExportResult> {
  const { tsconfig, ...contractOpts } = opts;
  const session = beginExport();
  try {
    await importModule(file, { tsconfig });
  } finally {
    endExport();
  }
  const decls = session.declarations;
  if (decls.length === 0) throw new Error(`docuconf: ${file} did not call createEnv from @docuconf/t3`);
  if (decls.length > 1) throw new Error(`docuconf: ${file} called createEnv ${decls.length} times; export one service per module`);
  const declaration = decls[0]!;
  const warnings = [...declaration.warnings, ...addDocComments(declaration, declaration.sourceFile ?? resolve(file))];
  return { cue: renderContract(declaration, contractOpts), warnings, declaration };
}

/**
 * Details from TSDoc/JSDoc (SPEC §14.7): the doc comment of each property
 * of createEnv's `server` and `files` objects in `source`, the file that
 * called createEnv. Explicit details win. Returns warnings.
 */
export function addDocComments(declaration: Declaration, source: string): string[] {
  const unavailable = docCommentsUnavailable(source);
  if (unavailable !== undefined) return [unavailable];
  const docs = callArgumentDocs(source, "createEnv", ["server", "files"]);
  const problems: string[] = [];
  applyDocComments(
    [
      ...[...declaration.vars].map(([n, v]): [string, Record<string, unknown>, string | undefined] => [n, v.contract, docs.get("server")!.get(n)]),
      ...[...declaration.fileContracts].map(([n, c]): [string, Record<string, unknown>, string | undefined] => [`files.${n}`, c, docs.get("files")!.get(n)]),
    ],
    problems,
  );
  if (problems.length > 0) throw new DocuconfDeclarationError(problems);
  return [];
}
