import type { StandardSchemaV1 } from "@t3-oss/env-core";
import { formatDuration } from "./duration.ts";
import { type JsonSchema, jsonSchemaOf } from "./jsonschema.ts";
import {
  ANNOTATIONS_KEY,
  type Annotations,
  type DocuconfTypeMeta,
  SECRET_KEY,
  TYPE_KEY,
  annotatedSchemas,
  secretSchemas,
} from "./meta.ts";
import { cleanPattern, nonRe2Feature } from "./re2.ts";

export type VarType = "string" | "int" | "float" | "bool" | "duration" | "url" | "enum" | "list" | "json";

/** A variable as the contract describes it, plus what the loader needs. */
export interface VarDecl {
  name: string;
  schema: StandardSchemaV1;
  type: VarType;
  secret: boolean;
  required: boolean;
  /** Contract fields in output order (SPEC §11.2 item 3). */
  contract: Record<string, unknown>;
  /** For list variables: the separator used to render the default. */
  separator?: string;
}

export const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const FEATURE_FLAG = /^(FF|FEATURE|FEATURE_FLAG|ENABLE)_/;

export function validateSync(schema: StandardSchemaV1, value: unknown): StandardSchemaV1.Result<unknown> {
  const r = schema["~standard"].validate(value);
  if (r instanceof Promise) throw new TypeError("docuconf: schemas must validate synchronously");
  return r;
}

function num(js: JsonSchema | undefined, key: string): number | undefined {
  const v = js?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function detectType(inJs: JsonSchema, outJs: JsonSchema | undefined, meta: DocuconfTypeMeta | undefined): VarType | undefined {
  if (meta) return meta.type;
  const t = inJs["type"];
  const ot = outJs?.["type"];
  if (ot === "boolean" || t === "boolean") return "bool";
  if (t === "integer" || ot === "integer") return "int";
  if (t === "number" || ot === "number") return "float";
  if (Array.isArray(inJs["enum"]) || typeof inJs["const"] === "string") return "enum";
  if (t === "string" && inJs["format"] === "uri") return "url";
  if (t === "string") return "string";
  return undefined;
}

/** The single string form a value takes in an env entry (SPEC §5). */
export function wireValue(decl: Pick<VarDecl, "type" | "separator">, value: unknown): string {
  switch (decl.type) {
    case "list":
      return (value as unknown[]).map(String).join(decl.separator ?? ",");
    case "json":
      return JSON.stringify(value);
    default:
      return String(value);
  }
}

/**
 * Reads a server variable's schema and turns it into a contract variable.
 * Problems with the declaration itself are appended to `problems`; hints
 * (SPEC §10 feature flags, lossy conversions) to `warnings`.
 */
export function describeVar(
  name: string,
  schema: StandardSchemaV1,
  problems: string[],
  warnings: string[],
): VarDecl | undefined {
  if (!ENV_NAME.test(name)) problems.push(`${name}: variable names must match ${ENV_NAME.source}`);
  if (FEATURE_FLAG.test(name)) {
    warnings.push(
      `${name}: looks like a feature flag. Flags that change without a rollout belong in a flag service (OpenFeature), not the environment contract (SPEC §10).`,
    );
  }
  const inJs = jsonSchemaOf(schema, "input");
  if (!inJs) {
    problems.push(`${name}: the schema cannot be converted to JSON Schema, so it cannot be exported`);
    return undefined;
  }
  const outJs = jsonSchemaOf(schema, "output");
  const meta = inJs[TYPE_KEY] as DocuconfTypeMeta | undefined;
  const isSecret = inJs[SECRET_KEY] === true || secretSchemas.has(schema);
  const ann = (inJs[ANNOTATIONS_KEY] as Annotations | undefined) ?? annotatedSchemas.get(schema);
  const description = typeof inJs["description"] === "string" ? inJs["description"] : (outJs?.["description"] as string | undefined);

  const type = detectType(inJs, outJs, meta);
  if (!type) {
    problems.push(
      `${name}: unsupported schema (JSON Schema type ${JSON.stringify(inJs["type"])}). Use a string, number, z.stringbool(), z.enum, url(), duration(), list() or json().`,
    );
    return undefined;
  }

  if (description === undefined || [...description].length < 5) {
    problems.push(`${name}: needs a description of at least 5 characters (.describe("...") or .meta({ description }))`);
  }

  // A variable is required when the schema rejects "unset".
  const unset = validateSync(schema, undefined);
  const required = unset.issues !== undefined;
  const defaultOut = unset.issues === undefined ? unset.value : undefined;

  const c: Record<string, unknown> = { type, description: description ?? "" };
  if (required) c["required"] = true;
  if (isSecret) c["secret"] = true;
  if (ann?.group !== undefined) c["group"] = ann.group;
  if (ann?.configKey !== undefined) c["configKey"] = ann.configKey;
  const examples = ann?.examples ?? (Array.isArray(inJs["examples"]) ? (inJs["examples"] as unknown[]).map(String) : undefined);
  if (examples !== undefined) {
    if (isSecret) problems.push(`${name}: a secret must not have examples`);
    else c["examples"] = examples;
  }
  if (ann?.deprecated !== undefined) {
    if (ann.deprecated.replacedBy !== undefined && !ENV_NAME.test(ann.deprecated.replacedBy)) {
      problems.push(`${name}: deprecated.replacedBy must be a variable name`);
    }
    c["deprecated"] = ann.deprecated;
  }

  const decl: VarDecl = { name, schema, type, secret: isSecret, required, contract: c };

  switch (type) {
    case "string": {
      const minLength = num(inJs, "minLength");
      const maxLength = num(inJs, "maxLength");
      if (minLength !== undefined) c["minLength"] = minLength;
      if (maxLength !== undefined) c["maxLength"] = maxLength;
      const pattern = inJs["pattern"];
      if (typeof pattern === "string") {
        const bad = nonRe2Feature(pattern);
        if (bad) problems.push(`${name}: pattern uses ${bad}, which RE2 does not support (SPEC §4.3)`);
        c["pattern"] = cleanPattern(pattern);
      }
      break;
    }
    case "int": {
      const js = outJs?.["type"] === "integer" ? outJs : inJs;
      let min = num(js, "minimum");
      let max = num(js, "maximum");
      const exMin = num(js, "exclusiveMinimum");
      const exMax = num(js, "exclusiveMaximum");
      if (exMin !== undefined) min = Math.max(min ?? -Infinity, Math.floor(exMin) + 1);
      if (exMax !== undefined) max = Math.min(max ?? Infinity, Math.ceil(exMax) - 1);
      if (min !== undefined && !Number.isInteger(min)) min = Math.ceil(min);
      if (max !== undefined && !Number.isInteger(max)) max = Math.floor(max);
      // A JavaScript number is exact only up to 2^53 - 1 (EDGE_CASES.md).
      if (min === undefined || min < -MAX_SAFE) {
        if (min !== undefined) warnings.push(`${name}: min capped at -Number.MAX_SAFE_INTEGER`);
        min = -MAX_SAFE;
      }
      if (max === undefined || max > MAX_SAFE) {
        if (max !== undefined) warnings.push(`${name}: max capped at Number.MAX_SAFE_INTEGER`);
        max = MAX_SAFE;
      }
      c["min"] = min;
      c["max"] = max;
      break;
    }
    case "float": {
      const js = outJs?.["type"] === "number" ? outJs : inJs;
      const min = num(js, "minimum") ?? num(js, "exclusiveMinimum");
      const max = num(js, "maximum") ?? num(js, "exclusiveMaximum");
      if (num(js, "exclusiveMinimum") !== undefined || num(js, "exclusiveMaximum") !== undefined) {
        warnings.push(`${name}: exclusive bounds are exported as inclusive min/max`);
      }
      if (min !== undefined) c["min"] = min;
      if (max !== undefined) c["max"] = max;
      break;
    }
    case "bool": {
      // z.coerce.boolean() turns "false" into true (EDGE_CASES.md).
      const f = validateSync(schema, "false");
      if (f.issues === undefined && f.value === true) {
        problems.push(`${name}: parses "false" as true (z.coerce.boolean()?). Use z.stringbool() instead.`);
      } else if (f.issues !== undefined) {
        problems.push(`${name}: a bool must accept "true" and "false" (use z.stringbool())`);
      }
      break;
    }
    case "duration": {
      const m = meta as Extract<DocuconfTypeMeta, { type: "duration" }>;
      c["encoding"] = m.encoding;
      if (m.min !== undefined) c["min"] = m.min;
      if (m.max !== undefined) c["max"] = m.max;
      break;
    }
    case "url": {
      const m = meta as Extract<DocuconfTypeMeta, { type: "url" }> | undefined;
      if (m?.schemes) c["schemes"] = m.schemes;
      else if (!m && zodUrlProtocol(schema)) {
        warnings.push(`${name}: z.url({ protocol }) cannot be exported; use url({ schemes }) from @docuconf/t3`);
      }
      break;
    }
    case "enum": {
      const values = Array.isArray(inJs["enum"]) ? (inJs["enum"] as unknown[]) : [inJs["const"]];
      if (values.length === 0 || !values.every((v) => typeof v === "string")) {
        problems.push(`${name}: enum values must be strings`);
      }
      c["values"] = values;
      break;
    }
    case "list": {
      const m = meta as Extract<DocuconfTypeMeta, { type: "list" }>;
      c["items"] = m.items;
      c["encoding"] = m.encoding;
      c["separator"] = m.separator;
      if (m.minItems !== undefined) c["minItems"] = m.minItems;
      if (m.maxItems !== undefined) c["maxItems"] = m.maxItems;
      decl.separator = m.separator;
      break;
    }
    case "json": {
      const m = meta as Extract<DocuconfTypeMeta, { type: "json" }>;
      c["schema"] = m.schema;
      break;
    }
  }

  if (defaultOut !== undefined) {
    if (isSecret) {
      problems.push(`${name}: a secret must not have a default`);
    } else {
      const d = contractDefault(type, defaultOut);
      if (d === undefined) {
        problems.push(`${name}: default ${JSON.stringify(defaultOut)} does not fit type ${type}`);
      } else {
        // SPEC §4.3: the default must satisfy the variable's own constraints.
        const wire = type === "duration" ? (d as string) : wireValue(decl, d);
        const check = validateSync(schema, wire);
        if (check.issues !== undefined) {
          problems.push(`${name}: default ${JSON.stringify(d)} violates its own constraints: ${check.issues[0]?.message ?? ""}`);
        }
        c["default"] = d;
      }
    }
  }

  return decl;
}

/** Whether a Zod schema (through wrappers) is z.url() with a `protocol` restriction. */
function zodUrlProtocol(schema: unknown, depth = 0): boolean {
  const def = (schema as { _zod?: { def?: Record<string, unknown> } })?._zod?.def;
  if (!def || depth > 10) return false;
  if (def["protocol"] !== undefined) return true;
  const checks = (def["checks"] as Array<{ _zod?: { def?: Record<string, unknown> } }> | undefined) ?? [];
  if (checks.some((c) => c._zod?.def?.["protocol"] !== undefined)) return true;
  return ["innerType", "in", "schema"].some((k) => def[k] !== undefined && zodUrlProtocol(def[k], depth + 1));
}

function contractDefault(type: VarType, v: unknown): unknown {
  switch (type) {
    case "string":
    case "url":
    case "enum":
      return typeof v === "string" ? v : undefined;
    case "int":
      return typeof v === "number" && Number.isSafeInteger(v) ? v : undefined;
    case "float":
      return typeof v === "number" && Number.isFinite(v) ? v : undefined;
    case "bool":
      return typeof v === "boolean" ? v : undefined;
    case "duration":
      return typeof v === "number" && v >= 0 ? formatDuration(v) : undefined;
    case "list":
      return Array.isArray(v) ? v : undefined;
    case "json":
      return v;
  }
}
