/**
 * Contract-first mode's JSON Schema check for `json` variables (SPEC §4.3
 * `schema`), with Ajv's JSON Schema draft 2020-12 validator. Unknown
 * keywords are a declaration error rather than ignored; `format` is an
 * annotation, as in the other SDKs. Patterns are RE2 (SPEC §4.3), compiled
 * the way the rest of the contract's patterns are. Lengths count code points.
 */
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import { re2RegExp } from "./re2.ts";

const ajv = new Ajv2020({
  allErrors: true,
  // Unknown keywords fail compilation; types, tuples and required are not linted.
  strict: true,
  strictTypes: false,
  strictTuples: false,
  strictRequired: false,
  validateFormats: false,
  // The same $id in two variables' schemas is not a conflict.
  addUsedSchema: false,
  logger: false,
  code: {
    regExp: Object.assign(
      (pattern: string) => {
        const re = re2RegExp(pattern);
        if (re instanceof RegExp) return re;
        throw new Error(`pattern ${JSON.stringify(pattern)}: ${re.problem}`);
      },
      { code: "re2RegExp" },
    ),
  },
});

/** One schema violation: a JSON Pointer to the offending value and what is wrong. */
export interface SchemaIssue {
  path: string;
  message: string;
}

/** Validates a parsed value; returns its issues, empty when it matches. */
export type SchemaValidator = (value: unknown) => SchemaIssue[];

/**
 * Compiles a JSON Schema, or returns the problem (an unknown keyword, a
 * malformed schema or a pattern that is not RE2).
 */
export function compileSchema(schema: unknown): SchemaValidator | { problem: string } {
  if (typeof schema !== "boolean" && (typeof schema !== "object" || schema === null || Array.isArray(schema))) {
    return { problem: "must be a JSON Schema object" };
  }
  let validate: ReturnType<typeof ajv.compile>;
  try {
    validate = ajv.compile(schema as object);
  } catch (e) {
    return { problem: (e as Error).message.replace(/^strict mode: /, "") };
  }
  return (value) => (validate(value) ? [] : (validate.errors ?? []).map(issue));
}

function issue(e: ErrorObject): SchemaIssue {
  const extra = e.keyword === "additionalProperties" ? ` (${String((e.params as { additionalProperty: string }).additionalProperty)})` : "";
  return { path: e.instancePath, message: `${e.message ?? "does not match the schema"}${extra}` };
}
