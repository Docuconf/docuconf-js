import { plainToInstance } from "class-transformer";
import { type ValidationError, getMetadataStorage, validateSync } from "class-validator";
import { type JsonSchema, type SchemaAdapter, cleanPattern } from "@docuconf/core";
import { type JsonSchemaSource, type PropertyMeta, docuconfMetadata } from "./decorators.ts";

/** One class-validator constraint on a property, as its metadata storage holds it. */
export interface Constraint {
  /** `isInt`, `min`, `isOptional`, ... ; `nested` for @ValidateNested. */
  name: string;
  constraints: unknown[];
  each: boolean;
}

export type Class = abstract new (...args: never[]) => object;

/** class-validator's constraints for every property of `cls`, including inherited ones. */
export function getConstraints(cls: Class): Map<string, Constraint[]> {
  const metas = getMetadataStorage().getTargetValidationMetadatas(cls as never, "", true, false);
  const out = new Map<string, Constraint[]>();
  for (const m of metas) {
    const name = m.type === "nestedValidation" ? "nested" : m.type === "isDefined" ? "isDefined" : (m.name ?? m.type);
    const list = out.get(m.propertyName) ?? [];
    list.push({ name, constraints: m.constraints ?? [], each: m.each === true });
    out.set(m.propertyName, list);
  }
  return out;
}

export function find(cs: readonly Constraint[], name: string, each = false): Constraint | undefined {
  return cs.find((c) => c.name === name && c.each === each);
}

export function has(cs: readonly Constraint[], name: string, each = false): boolean {
  return find(cs, name, each) !== undefined;
}

/** A pattern from @Matches, as a contract pattern; `problem` when it cannot be one. */
export function matchesPattern(c: Constraint): { pattern: string; problem?: string } {
  const [p, modifiers] = c.constraints as [string | RegExp, string | undefined];
  const flags = typeof p === "string" ? (modifiers ?? "") : p.flags;
  const pattern = typeof p === "string" ? p : cleanPattern(p.source);
  const bad = flags.replace(/[gu]/g, "");
  return bad ? { pattern, problem: `@Matches flags "${bad}" cannot be expressed in the contract; use inline syntax` } : { pattern };
}

/** The class a nested property binds to: from class-transformer's @Type(), else its design type. */
function nestedClass(cls: Class, property: string, array: boolean): Class | undefined {
  try {
    const sample = plainToInstance(cls as never, { [property]: array ? [{}] : {} }) as Record<string, unknown>;
    const v = array ? (sample[property] as unknown[] | undefined)?.[0] : sample[property];
    const ctor = (v as object | undefined)?.constructor;
    if (typeof ctor === "function" && ctor !== Object) return ctor as Class;
  } catch {
    // fall through
  }
  const getMetadata = (Reflect as { getMetadata?: (k: string, t: object, p: string) => unknown }).getMetadata;
  const design = getMetadata?.("design:type", (cls as { prototype: object }).prototype, property);
  if (typeof design === "function" && design !== Object && design !== Array && !array) return design as Class;
  return undefined;
}

function isStandardSchema(x: unknown): x is { "~standard": { validate(v: unknown): unknown; jsonSchema?: { input?: (o: { target: string }) => JsonSchema } } } {
  return typeof x === "object" && x !== null && "~standard" in x;
}

/**
 * The JSON Schema of a class-validator class, from its decorators: the
 * structure a config file or `json` variable must have. Throws when a
 * property's type cannot be told.
 */
export function classJsonSchema(cls: Class, seen: Set<Class> = new Set()): JsonSchema {
  if (seen.has(cls)) throw new Error(`${cls.name} refers to itself; recursive types are not supported`);
  seen = new Set(seen).add(cls);
  const constraints = getConstraints(cls);
  const docs = docuconfMetadata(cls);
  // Every variable needs @Describe, so docuconf's own metadata holds declaration order.
  const names = [...new Set([...docs.keys(), ...constraints.keys()])];
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const name of names) {
    const cs = constraints.get(name) ?? [];
    properties[name] = propertySchema(cls, name, cs, docs.get(name), seen);
    if (!has(cs, "isOptional")) required.push(name);
  }
  const out: JsonSchema = { type: "object", properties };
  if (required.length > 0) out["required"] = required;
  return out;
}

function propertySchema(cls: Class, name: string, cs: Constraint[], doc: PropertyMeta | undefined, seen: Set<Class>): JsonSchema {
  const isArray = has(cs, "isArray") || cs.some((c) => c.each) || has(cs, "arrayMinSize") || has(cs, "arrayMaxSize");
  let s: JsonSchema;
  if (isArray) {
    s = { type: "array", items: valueSchema(cls, name, cs.filter((c) => c.each), true, seen) };
    const min = find(cs, "arrayMinSize")?.constraints[0] ?? (has(cs, "arrayNotEmpty") ? 1 : undefined);
    const max = find(cs, "arrayMaxSize")?.constraints[0];
    if (typeof min === "number") s["minItems"] = min;
    if (typeof max === "number") s["maxItems"] = max;
  } else {
    s = valueSchema(cls, name, cs.filter((c) => !c.each), false, seen);
  }
  if (doc?.description !== undefined) s = { description: doc.description, ...s };
  return s;
}

function valueSchema(cls: Class, name: string, cs: Constraint[], inArray: boolean, seen: Set<Class>): JsonSchema {
  const where = `${cls.name}.${name}`;
  const enumC = find(cs, "isEnum", inArray) ?? find(cs, "isIn", inArray);
  let s: JsonSchema;
  if (enumC) {
    const values = (enumC.name === "isEnum" ? enumC.constraints[1] : enumC.constraints[0]) as unknown[];
    if (values.length === 0) throw new Error(`${where}: no enum values; @IsEnum() takes an enum object, @IsIn() a list`);
    s = { enum: values };
  } else if (has(cs, "isInt", inArray)) s = { type: "integer" };
  else if (has(cs, "isNumber", inArray)) s = { type: "number" };
  else if (has(cs, "isBoolean", inArray)) s = { type: "boolean" };
  else if (has(cs, "isUrl", inArray)) s = { type: "string", format: "uri" };
  else if (has(cs, "nested", inArray) || has(cs, "isObject", inArray)) {
    const nested = nestedClass(cls, name, inArray);
    if (nested) s = classJsonSchema(nested, seen);
    else if (has(cs, "isObject", inArray)) s = { type: "object" };
    else throw new Error(`${where}: @ValidateNested() needs @Type(() => TheClass) from class-transformer`);
  } else if (["isString", "matches", "minLength", "maxLength", "isLength", "isNotEmpty"].some((n) => has(cs, n, inArray))) {
    s = { type: "string" };
  } else {
    throw new Error(`${where}: cannot tell its type; add @IsString(), @IsInt(), @IsNumber(), @IsBoolean(), @IsEnum() or @ValidateNested()`);
  }
  const num = (n: string, i = 0) => {
    const v = find(cs, n, inArray)?.constraints[i];
    return typeof v === "number" ? v : undefined;
  };
  if (s["type"] === "integer" || s["type"] === "number") {
    if (num("min") !== undefined) s["minimum"] = num("min");
    if (num("max") !== undefined) s["maximum"] = num("max");
    if (has(cs, "isPositive", inArray)) s["exclusiveMinimum"] = 0;
    if (has(cs, "isNegative", inArray)) s["exclusiveMaximum"] = 0;
  }
  if (s["type"] === "string") {
    const minLength = num("minLength") ?? num("isLength", 0) ?? (has(cs, "isNotEmpty", inArray) ? 1 : undefined);
    const maxLength = num("maxLength") ?? num("isLength", 1);
    if (minLength !== undefined) s["minLength"] = minLength;
    if (maxLength !== undefined) s["maxLength"] = maxLength;
    const m = find(cs, "matches", inArray);
    if (m) {
      const { pattern, problem } = matchesPattern(m);
      if (problem) throw new Error(`${where}: ${problem}`);
      s["pattern"] = pattern;
    }
  }
  return s;
}

/** Flattens class-validator errors to dotted paths and messages. */
export function flattenErrors(errors: readonly ValidationError[], prefix = ""): Array<{ path: string; message: string; constraint: string }> {
  const out: Array<{ path: string; message: string; constraint: string }> = [];
  for (const e of errors) {
    const path = prefix ? `${prefix}.${e.property}` : e.property;
    for (const [constraint, message] of Object.entries(e.constraints ?? {})) {
      out.push({ path, message: stripProperty(message, e.property), constraint });
    }
    if (e.children && e.children.length > 0) out.push(...flattenErrors(e.children, path));
  }
  return out;
}

/** class-validator messages start with the property name ("PORT must be ..."); the path already says it. */
export function stripProperty(message: string, property: string): string {
  for (const p of [`${property} `, `each value in ${property} `]) {
    if (message.startsWith(p)) return (p.startsWith("each") ? "each value " : "") + message.slice(p.length);
  }
  return message;
}

/** Binds plain data to a class and validates it, as the Nest docs' `validate` does. */
export function bindAndValidate(
  cls: Class,
  data: unknown,
): { value: unknown; issues?: undefined } | { issues: Array<{ path: string; message: string; constraint: string }> } {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { issues: [{ path: "", message: `must be an object matching ${cls.name}`, constraint: "isObject" }] };
  }
  const instance = plainToInstance(cls as never, data) as object;
  const errors = validateSync(instance, { forbidUnknownValues: false });
  if (errors.length > 0) return { issues: flattenErrors(errors) };
  return { value: instance };
}

/** Config files and json variables bind to class-validator classes or Standard Schema validators. */
export const schemaAdapter: SchemaAdapter = {
  jsonSchema(schema) {
    if (isStandardSchema(schema)) {
      const fn = schema["~standard"].jsonSchema?.input;
      if (!fn) throw new Error("this validator offers no JSON Schema; use a class-validator class");
      return fn({ target: "draft-2020-12" });
    }
    if (typeof schema === "function") return classJsonSchema(schema as Class);
    throw new Error("pass a class-validator class or a Zod schema");
  },
  validate(schema, data) {
    if (isStandardSchema(schema)) {
      const r = schema["~standard"].validate(data) as { value?: unknown; issues?: Array<{ message: string; path?: Array<PropertyKey | { key: PropertyKey }> }> };
      if (r instanceof Promise) throw new TypeError("docuconf: schemas must validate synchronously");
      if (!r.issues) return { value: r.value };
      return {
        issues: r.issues.map((i) => ({
          path: (i.path ?? []).map((p) => String(typeof p === "object" && p !== null ? p.key : p)).join("."),
          message: i.message,
        })),
      };
    }
    return bindAndValidate(schema as Class, data);
  },
};

export type { JsonSchemaSource };
