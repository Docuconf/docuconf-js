import { resolve } from "node:path";
import { type ContractOptions, toContract } from "./contract.ts";
import type { NestDeclaration } from "./declaration.ts";
import { importForExport } from "./ts-loader.ts";
import { beginExport, declarationOf, endExport } from "./validate.ts";

export interface ExportResult {
  cue: string;
  warnings: string[];
  declaration: NestDeclaration;
}

/**
 * Loads `file` in export mode and renders the contract of the
 * docuconfValidate call it makes. In export mode the validate function
 * returns its input unchanged, so a module that also calls
 * ConfigModule.forRoot() loads without a real environment.
 */
export async function exportModule(
  file: string,
  opts: ContractOptions & { exportName?: string; tsconfig?: string | undefined } = {},
): Promise<ExportResult> {
  const { exportName, tsconfig, ...contractOpts } = opts;
  const session = beginExport();
  let mod: Record<string, unknown>;
  try {
    mod = ((await importForExport(resolve(file), { tsconfig })) ?? {}) as Record<string, unknown>;
  } finally {
    endExport();
  }
  let decls = [...new Set(session.declarations)];
  if (exportName !== undefined) {
    const d = declarationOf(mod[exportName]);
    if (!d) throw new Error(`docuconf: ${file} has no export "${exportName}" made by docuconfValidate`);
    decls = [d];
  }
  if (decls.length === 0) throw new Error(`docuconf: ${file} did not call docuconfValidate from @docuconf/nestjs`);
  if (decls.length > 1) {
    throw new Error(`docuconf: ${file} called docuconfValidate ${decls.length} times; pick one with --export <name>`);
  }
  const declaration = decls[0]!;
  return { cue: toContract(declaration, contractOpts), warnings: declaration.warnings, declaration };
}
