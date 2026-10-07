import { importModule } from "@docuconf/core/loader";
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
  return { cue: renderContract(declaration, contractOpts), warnings: declaration.warnings, declaration };
}
