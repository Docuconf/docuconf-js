import { resolve } from "node:path";
import { DocuconfDeclarationError, applyDocComments } from "@docuconf/core";
import { classPropertyDocs, docCommentsUnavailable } from "@docuconf/core/loader";
import { type ContractOptions, toContract } from "./contract.ts";
import type { NestDeclaration } from "./declaration.ts";
import { sourceFileOf } from "./decorators.ts";
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
  const warnings = [...declaration.warnings, ...addDocComments(declaration)];
  return { cue: toContract(declaration, contractOpts), warnings, declaration };
}

/**
 * Details from TSDoc/JSDoc (SPEC §14.7): the doc comment of each property
 * of the environment class and the classes it extends, read from the files
 * they were declared in. @Details wins. Returns warnings.
 */
export function addDocComments(declaration: NestDeclaration): string[] {
  const warnings: string[] = [];
  const docs = new Map<string, string>();
  const chain: object[] = [];
  for (let c: unknown = declaration.cls; typeof c === "function" && c !== Function.prototype; c = Object.getPrototypeOf(c)) chain.unshift(c);
  for (const cls of chain) {
    const file = sourceFileOf(cls);
    const name = (cls as { name?: string }).name;
    if (file === undefined || !name) continue;
    const unavailable = docCommentsUnavailable(file);
    if (unavailable !== undefined) {
      if (!warnings.includes(unavailable)) warnings.push(unavailable);
      continue;
    }
    for (const [k, v] of classPropertyDocs(file, name)) docs.set(k, v);
  }
  const problems: string[] = [];
  applyDocComments(
    [
      ...[...declaration.vars].map(([n, v]): [string, Record<string, unknown>, string | undefined] => [n, v.contract, docs.get(v.property)]),
      ...[...declaration.fileContracts].map(([n, c]): [string, Record<string, unknown>, string | undefined] => {
        const property = declaration.fileProperties.get(n)!;
        return [`${property} (file input "${n}")`, c, docs.get(property)];
      }),
    ],
    problems,
  );
  if (problems.length > 0) throw new DocuconfDeclarationError(problems);
  return warnings;
}
