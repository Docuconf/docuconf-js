import type { StandardSchemaV1 } from "@t3-oss/env-core";
import { DocuconfDeclarationError, type FileInput, describeFiles } from "@docuconf/core";
import { type VarDecl, describeVar } from "./introspect.ts";
import { standardSchemaAdapter } from "./jsonschema.ts";

/** Everything createEnv knows about one service's runtime inputs. */
export interface Declaration {
  /** Service name from createEnv's `name` option. */
  name: string | undefined;
  appVersion: string | undefined;
  vars: Map<string, VarDecl>;
  files: Record<string, FileInput>;
  fileContracts: Map<string, Record<string, unknown>>;
  warnings: string[];
}

/**
 * Reads and checks a declaration (SPEC §11.2 item 2). Only the `server`
 * section is runtime configuration; `client` and `shared` are not part of
 * the contract (SPEC §11.1). Throws DocuconfDeclarationError listing every
 * problem.
 */
export function declare(opts: {
  name?: string | undefined;
  appVersion?: string | undefined;
  server: Record<string, StandardSchemaV1 | undefined>;
  files: Record<string, FileInput>;
}): Declaration {
  const problems: string[] = [];
  const warnings: string[] = [];
  const vars = new Map<string, VarDecl>();
  for (const [name, schema] of Object.entries(opts.server)) {
    if (!schema) continue;
    const d = describeVar(name, schema, problems, warnings);
    if (d) vars.set(name, d);
  }
  const fileContracts = describeFiles(opts.files, vars, problems, standardSchemaAdapter);
  if (problems.length > 0) throw new DocuconfDeclarationError(problems);
  return { name: opts.name, appVersion: opts.appVersion, vars, files: opts.files, fileContracts, warnings };
}
