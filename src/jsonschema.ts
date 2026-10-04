import * as z from "zod";
import { cleanPattern } from "./re2.ts";
import type { StandardSchemaV1 } from "@t3-oss/env-core";

export type JsonSchema = Record<string, unknown>;

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
 * (a config file or a `json` variable): docuconf extension keywords are
 * removed, and objects that do not say otherwise reject unknown keys, so a
 * misspelt key fails before deploy.
 */
export function contractSchema(schema: StandardSchemaV1): JsonSchema {
  const js = jsonSchemaOf(schema, "input");
  if (!js) throw new Error("schema cannot be represented as JSON Schema");
  return closeObjects(js) as JsonSchema;
}

function closeObjects(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(closeObjects);
  if (typeof node !== "object" || node === null) return node;
  const out: JsonSchema = {};
  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith("x-docuconf")) continue;
    // `properties`, `$defs` and similar are maps of schemas, not schemas.
    out[k] = k === "pattern" && typeof v === "string" ? cleanPattern(v) : closeObjects(v);
  }
  if (out["type"] === "object" && out["properties"] !== undefined && !("additionalProperties" in out)) {
    out["additionalProperties"] = false;
  }
  return out;
}
