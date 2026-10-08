import {
  ENV_NAME,
  type VarBase,
  type VarType,
  checkVarName,
  cleanPattern,
  detailsProblem,
  contractDefault,
  intBounds,
  nextFloat,
  nonRe2Feature,
  wireValue,
} from "@docuconf/core/pure";
import type { StandardSchemaV1 } from "@t3-oss/env-core";
import { type JsonSchema, jsonSchemaOf, validateSync } from "./jsonschema.ts";
import {
  ANNOTATIONS_KEY,
  type Annotations,
  type DocuconfTypeMeta,
  SECRET_KEY,
  TYPE_KEY,
  annotatedSchemas,
  secretSchemas,
} from "./meta.ts";

export type { VarType };
export { ENV_NAME, wireValue };
export { validateSync } from "./jsonschema.ts";

/** A variable as the contract describes it, plus its schema for the loader. */
export interface VarDecl extends VarBase {
  schema: StandardSchemaV1;
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
  checkVarName(name, problems, warnings);
  const inJs = jsonSchemaOf(schema, "input");
  if (!inJs) {
    problems.push(
      `${name}: cannot export: this schema has no Standard JSON Schema (~standard.jsonSchema). Zod 4 and ArkType schemas have one; for Valibot, wrap the schema in toStandardJsonSchema() from @valibot/to-json-schema.`,
    );
    return undefined;
  }
  const outJs = jsonSchemaOf(schema, "output");
  const meta = inJs[TYPE_KEY] as DocuconfTypeMeta | undefined;
  const isSecret = inJs[SECRET_KEY] === true || secretSchemas.has(schema);
  const ann = (inJs[ANNOTATIONS_KEY] as Annotations | undefined) ?? annotatedSchemas.get(schema);
  const description = typeof inJs["description"] === "string" ? inJs["description"] : (outJs?.["description"] as string | undefined);

  const type = detectType(inJs, outJs, meta);
  if (!type) {
    problems.push(`${name}: ${unsupportedHint(schema, inJs)}`);
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
  // details: annotate(schema, { details }) or Zod's .meta({ details }).
  const details = ann?.details ?? (typeof inJs["details"] === "string" ? inJs["details"] : outJs?.["details"]);
  if (details !== undefined) {
    const bad = detailsProblem(details);
    if (bad !== undefined) problems.push(`${name}: ${bad}`);
    else c["details"] = details;
  }
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

  // Environment values are strings: z.number() (without coerce) rejects
  // every one of them, so the variable could never be set.
  if ((type === "int" || type === "float") && !meta && validateSync(schema, "1").issues !== undefined && validateSync(schema, 1).issues === undefined) {
    problems.push(`${name}: z.number() receives strings from the environment and always fails; use z.coerce.number()${type === "int" ? ".int()" : ""}`);
  }

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
      const { min, max } = intBounds(
        name,
        {
          min: num(js, "minimum"),
          max: num(js, "maximum"),
          exclusiveMin: num(js, "exclusiveMinimum"),
          exclusiveMax: num(js, "exclusiveMaximum"),
        },
        warnings,
      );
      c["min"] = min;
      c["max"] = max;
      break;
    }
    case "float": {
      const js = outJs?.["type"] === "number" ? outJs : inJs;
      // An exclusive bound (.positive(), .gt()) is exported as the nearest
      // double inside it, so the platform rejects exactly what the app does.
      const exMin = num(js, "exclusiveMinimum");
      const exMax = num(js, "exclusiveMaximum");
      const min = num(js, "minimum") ?? (exMin === undefined ? undefined : nextFloat(exMin, 1));
      const max = num(js, "maximum") ?? (exMax === undefined ? undefined : nextFloat(exMax, -1));
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
      if (m?.maxLength !== undefined) c["maxLength"] = m.maxLength;
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
      if (m.items === "int") {
        const { min, max } = intBounds(name, m.itemBounds ?? {}, warnings, { min: "itemMin", max: "itemMax" });
        c["itemMin"] = min;
        c["itemMax"] = max;
      }
      if (m.itemMinLength !== undefined) c["itemMinLength"] = m.itemMinLength;
      if (m.itemMaxLength !== undefined) c["itemMaxLength"] = m.itemMaxLength;
      decl.separator = m.separator;
      break;
    }
    case "json": {
      const m = meta as Extract<DocuconfTypeMeta, { type: "json" }>;
      if (m.maxLength !== undefined) c["maxLength"] = m.maxLength;
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
        problems.push(`${name}: ${defaultHint(type, defaultOut)}`);
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

/** Why a default does not fit, and what to write instead. */
function defaultHint(type: VarType, value: unknown): string {
  const shown = JSON.stringify(value);
  if (type === "duration" && typeof value === "string") {
    return `default ${shown} does not fit type duration: Zod's .default() takes the parsed value (milliseconds). Use duration({ default: ${shown} }), or .default(${Number.isFinite(Number(value)) ? value : "30_000"})`;
  }
  if ((type === "int" || type === "float") && typeof value === "string") {
    return `default ${shown} does not fit type ${type}: .default() takes the parsed value; write .default(${Number(value)}) without quotes`;
  }
  if (type === "list" && typeof value === "string") {
    return `default ${shown} does not fit type list: .default() takes the parsed value; write .default(${JSON.stringify(value.split(","))})`;
  }
  if (type === "bool" && typeof value === "string") {
    return `default ${shown} does not fit type bool: .default() takes the parsed value; write .default(${value === "true"})`;
  }
  return `default ${shown} does not fit type ${type}`;
}

/** The Zod type under wrappers (optional, default, pipe), such as "union" or "date". */
function zodKind(schema: unknown, depth = 0): string | undefined {
  const def = (schema as { _zod?: { def?: Record<string, unknown> } })?._zod?.def;
  if (!def || depth > 10) return undefined;
  const t = def["type"] as string | undefined;
  if (t === "optional" || t === "default" || t === "prefault" || t === "readonly" || t === "catch") return zodKind(def["innerType"], depth + 1);
  if (t === "pipe") return zodKind(def["in"], depth + 1) ?? zodKind(def["out"], depth + 1);
  return t;
}

/** What to use instead of a schema that maps to no contract type. */
function unsupportedHint(schema: StandardSchemaV1, inJs: JsonSchema): string {
  const kind = zodKind(schema);
  const types = Array.isArray(inJs["type"]) ? (inJs["type"] as unknown[]) : [];
  if (kind === "nullable" || types.includes("null") || (Array.isArray(inJs["anyOf"]) && (inJs["anyOf"] as JsonSchema[]).some((s) => s["type"] === "null"))) {
    return ".nullable() has no meaning for an env var (an unset variable is undefined, never null); use .optional()";
  }
  if (kind === "union" || Array.isArray(inJs["anyOf"]) || Array.isArray(inJs["oneOf"])) {
    return 'z.union() is not supported; for a choice of strings use z.enum(["a", "b"])';
  }
  if (kind === "date") return "dates are not a contract type; use z.string() for an ISO 8601 date, or duration() for a span of time";
  if (kind === "object" || kind === "array" || inJs["type"] === "object" || inJs["type"] === "array") {
    return "objects and arrays come in one variable as JSON or a list: use json(schema) or list(item)";
  }
  return "unsupported schema; use z.string(), z.coerce.number(), z.stringbool(), z.enum([...]), url(), duration(), list() or json()";
}
