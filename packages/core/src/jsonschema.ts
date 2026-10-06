import { cleanPattern } from "./re2.ts";

export type JsonSchema = Record<string, unknown>;

/**
 * Prepares a JSON Schema for the platform to check a structured value
 * against (a config file or a `json` variable): `$schema` and docuconf
 * extension keywords are removed, patterns are written the way every SDK
 * writes them, and objects that do not say otherwise reject unknown keys, so
 * a misspelt key fails before deploy.
 */
export function closeSchema(schema: JsonSchema): JsonSchema {
  const { $schema: _ignored, ...rest } = schema;
  return closeObjects(rest) as JsonSchema;
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
