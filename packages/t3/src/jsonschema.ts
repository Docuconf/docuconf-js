import * as z from "zod";
import { type JsonSchema, type SchemaAdapter, closeSchema } from "@docuconf/core/pure";
import type { StandardSchemaV1 } from "@t3-oss/env-core";

export type { JsonSchema };

interface StandardJSONSchemaProps {
  jsonSchema?: {
    input?: (opts: { target: string }) => JsonSchema;
    output?: (opts: { target: string }) => JsonSchema;
  };
}

function isZodSchema(schema: unknown): schema is z.ZodType {
  return typeof schema === "object" && schema !== null && "_zod" in schema;
}

/**
 * The JSON Schema of a schema's input (`io: "input"`) or output. Uses
 * Standard JSON Schema (`~standard.jsonSchema`) when the validator provides
 * it, and `z.toJSONSchema` for Zod schemas it cannot represent strictly.
 * Returns undefined when the schema cannot be represented.
 */
export function jsonSchemaOf(schema: StandardSchemaV1, io: "input" | "output"): JsonSchema | undefined {
  const std = (schema as { "~standard": StandardSchemaV1["~standard"] & StandardJSONSchemaProps })["~standard"];
  const fn = std.jsonSchema?.[io];
  if (fn) {
    try {
      return strip(fn({ target: "draft-2020-12" }));
    } catch {
      // fall through
    }
  }
  if (isZodSchema(schema)) {
    try {
      return strip(z.toJSONSchema(schema, { io, unrepresentable: "any" }) as JsonSchema);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function strip(s: JsonSchema): JsonSchema {
  const { $schema: _ignored, ...rest } = s;
  return rest;
}

/**
 * A JSON Schema for the platform to check a structured value against
 * (a config file or a `json` variable). See closeSchema in @docuconf/core.
 */
export function contractSchema(schema: StandardSchemaV1): JsonSchema {
  const js = jsonSchemaOf(schema, "input");
  if (!js) throw new Error("schema cannot be represented as JSON Schema");
  return closeSchema(js);
}

export function validateSync(schema: StandardSchemaV1, value: unknown): StandardSchemaV1.Result<unknown> {
  const r = schema["~standard"].validate(value);
  if (r instanceof Promise) throw new TypeError("docuconf: schemas must validate synchronously");
  return r;
}

export function issuePath(issue: StandardSchemaV1.Issue): string {
  if (!issue.path || issue.path.length === 0) return "";
  return issue.path.map((p) => String(typeof p === "object" && p !== null ? p.key : p)).join(".");
}

/** Config files bind to Standard Schema validators (Zod 4). */
export const standardSchemaAdapter: SchemaAdapter = {
  jsonSchema(schema) {
    const js = jsonSchemaOf(schema as StandardSchemaV1, "input");
    if (!js) throw new Error("");
    return js;
  },
  validate(schema, data) {
    const r = validateSync(schema as StandardSchemaV1, data);
    if (r.issues === undefined) return { value: r.value };
    return { issues: r.issues.map((i) => ({ path: issuePath(i), message: i.message })) };
  },
};
