import type { StandardSchemaV1 } from "@t3-oss/env-core";

/**
 * docuconf metadata travels inside the schema's JSON Schema, as extension
 * keywords, so the exporter can read it through Standard JSON Schema or
 * `z.toJSONSchema` without knowing the validator. Zod 4 copies `.meta()`
 * entries into its JSON Schema output.
 */

/** Type information set by the helpers (duration, list, url, json). */
export const TYPE_KEY = "x-docuconf";
/** `true` when the variable is a secret. A separate key so wrappers never hide the type. */
export const SECRET_KEY = "x-docuconf-secret";
/** Optional docs metadata: group, examples, configKey, deprecated. */
export const ANNOTATIONS_KEY = "x-docuconf-annotations";

export type DocuconfTypeMeta =
  | { type: "duration"; encoding: "go"; min?: string; max?: string }
  | {
      type: "list";
      items: "string" | "int";
      encoding: "csv";
      separator: string;
      minItems?: number;
      maxItems?: number;
    }
  | { type: "url"; schemes?: string[] }
  | { type: "json"; schema: Record<string, unknown> };

export interface Annotations {
  group?: string;
  examples?: string[];
  configKey?: string;
  deprecated?: { message: string; replacedBy?: string };
}

/**
 * Validators other than Zod may not support metadata; their schemas are
 * tracked here instead. Zod schemas are cloned by `.describe()` and friends,
 * so for Zod the metadata is attached with `.meta()`.
 */
export const secretSchemas = new WeakSet<object>();
export const annotatedSchemas = new WeakMap<object, Annotations>();

export function hasMeta(schema: unknown): schema is StandardSchemaV1 & {
  meta(m: Record<string, unknown>): unknown;
} {
  return (
    typeof schema === "object" &&
    schema !== null &&
    "_zod" in schema &&
    typeof (schema as { meta?: unknown }).meta === "function"
  );
}
