import {
  CONTRACT_DURATION,
  DocuconfDeclarationError,
  ENV_NAME,
  type FileInput,
  type ValueDecl,
  type VarType,
  canonicalDuration,
  checkVarName,
  closeSchema,
  contractDefault,
  describeFiles,
  intBounds,
  nonRe2Feature,
  parseDuration,
  validDescription,
  wireValue,
} from "@docuconf/core";
import { type Class, type Constraint, find, getConstraints, has, matchesPattern, schemaAdapter } from "./classes.ts";
import { type JsonSchemaSource, type PropertyMeta, docuconfMetadata } from "./decorators.ts";
import { validateEnv } from "./env.ts";

/** A variable read from a class-validator property, plus what the validator needs. */
export interface NestVarDecl extends ValueDecl {
  /** The property, which is also the variable name. */
  property: string;
  constraints: Constraint[];
  /** The parsed default (milliseconds for durations), when the variable has one. */
  default: unknown;
  jsonSchema?: JsonSchemaSource;
  deprecated?: { message: string; replacedBy?: string };
}

/** Everything docuconf reads from an environment class. */
export interface NestDeclaration {
  name: string | undefined;
  appVersion: string | undefined;
  cls: Class;
  vars: Map<string, NestVarDecl>;
  /** File inputs by input name. */
  files: Record<string, FileInput>;
  /** The property each file input is exposed as. */
  fileProperties: Map<string, string>;
  fileContracts: Map<string, Record<string, unknown>>;
  warnings: string[];
}

/** Constraints the contract can express. Others are still checked at boot, and produce a warning. */
const EXPORTED = new Set([
  "isOptional", "isDefined", "isString", "isInt", "isNumber", "isBoolean", "isEnum", "isIn", "isUrl",
  "min", "max", "isPositive", "isNegative", "minLength", "maxLength", "isLength", "matches", "isNotEmpty",
  "arrayMinSize", "arrayMaxSize", "arrayNotEmpty", "isArray",
]);

const STRING_CONSTRAINTS = ["isString", "matches", "minLength", "maxLength", "isLength", "isNotEmpty"];

/** `servingTls` → `serving-tls`. */
export function kebab(property: string): string {
  return property
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase();
}

function detectType(cs: Constraint[], doc: PropertyMeta, design: unknown): VarType | undefined {
  if (doc.duration) return "duration";
  if (doc.list) return "list";
  if (doc.json) return "json";
  if (doc.schemes) return "url";
  if (has(cs, "isEnum") || has(cs, "isIn")) return "enum";
  if (has(cs, "isInt")) return "int";
  if (has(cs, "isNumber")) return "float";
  if (has(cs, "isBoolean")) return "bool";
  if (has(cs, "isUrl")) return "url";
  if (STRING_CONSTRAINTS.some((n) => has(cs, n))) return "string";
  // emitDecoratorMetadata, when the build has it.
  if (design === String) return "string";
  if (design === Number) return "float";
  if (design === Boolean) return "bool";
  return undefined;
}

function designType(cls: Class, property: string): unknown {
  const getMetadata = (Reflect as { getMetadata?: (k: string, t: object, p: string) => unknown }).getMetadata;
  return getMetadata?.("design:type", (cls as { prototype: object }).prototype, property);
}

function num(cs: Constraint[], name: string, i = 0): number | undefined {
  const v = find(cs, name)?.constraints[i];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function describeVar(
  cls: Class,
  name: string,
  cs: Constraint[],
  doc: PropertyMeta,
  initial: unknown,
  problems: string[],
  warnings: string[],
): NestVarDecl | undefined {
  checkVarName(name, problems, warnings);
  const p = (msg: string) => problems.push(`${name}: ${msg}`);
  const type = detectType(cs, doc, designType(cls, name));
  if (!type) {
    p("cannot tell its type; add @IsString(), @IsInt(), @IsNumber(), @IsBoolean(), @IsEnum(), @UrlSchemes(), @Duration(), @List() or @Json()");
    return undefined;
  }
  for (const c of cs) {
    if (!c.each && !EXPORTED.has(c.name) && !(type === "json" && (c.name === "nested" || c.name === "isObject"))) {
      warnings.push(`${name}: @${c.name[0]!.toUpperCase()}${c.name.slice(1)}() is checked at boot, but the contract cannot express it`);
    }
  }
  if ((type === "duration" || type === "list" || type === "json") && has(cs, "isString")) {
    p(`a ${type} property holds the parsed value, not the string; remove @IsString()`);
  }
  if (!validDescription(doc.description)) p('needs a description of at least 5 characters (@Describe("..."))');

  const secret = doc.secret === true;
  const c: Record<string, unknown> = { type, description: doc.description ?? "" };
  const decl: NestVarDecl = { name, property: name, type, secret, required: false, contract: c, constraints: cs, default: undefined };

  let def = initial;
  if (type === "duration" && doc.duration?.default !== undefined) {
    const ms = parseDuration(doc.duration.default);
    if (ms === undefined || ms < 0) p(`@Duration default "${doc.duration.default}" is not a Go duration`);
    else def = ms;
  }
  const required = !has(cs, "isOptional") && def === undefined;
  decl.required = required;
  if (required) c["required"] = true;
  if (secret) c["secret"] = true;
  if (doc.group !== undefined) c["group"] = doc.group;
  if (doc.examples !== undefined) {
    if (secret) p("a secret must not have examples");
    else c["examples"] = doc.examples;
  }
  if (doc.deprecated !== undefined) {
    if (doc.deprecated.replacedBy !== undefined && !ENV_NAME.test(doc.deprecated.replacedBy)) p("deprecated.replacedBy must be a variable name");
    c["deprecated"] = doc.deprecated;
    decl.deprecated = doc.deprecated;
  }

  switch (type) {
    case "string": {
      const minLength = num(cs, "minLength") ?? num(cs, "isLength", 0) ?? (has(cs, "isNotEmpty") ? 1 : undefined);
      const maxLength = num(cs, "maxLength") ?? num(cs, "isLength", 1);
      if (minLength !== undefined) c["minLength"] = minLength;
      if (maxLength !== undefined) c["maxLength"] = maxLength;
      const m = find(cs, "matches");
      if (m) {
        const { pattern, problem } = matchesPattern(m);
        if (problem) p(problem);
        const bad = nonRe2Feature(pattern);
        if (bad) p(`pattern uses ${bad}, which RE2 does not support (SPEC §4.3)`);
        c["pattern"] = pattern;
      }
      break;
    }
    case "int": {
      const { min, max } = intBounds(
        name,
        {
          min: num(cs, "min"),
          max: num(cs, "max"),
          exclusiveMin: has(cs, "isPositive") ? 0 : undefined,
          exclusiveMax: has(cs, "isNegative") ? 0 : undefined,
        },
        warnings,
      );
      c["min"] = min;
      c["max"] = max;
      break;
    }
    case "float": {
      let min = num(cs, "min");
      let max = num(cs, "max");
      if (has(cs, "isPositive") || has(cs, "isNegative")) {
        warnings.push(`${name}: exclusive bounds (@IsPositive, @IsNegative) are exported as inclusive min/max`);
        if (has(cs, "isPositive")) min = Math.max(min ?? 0, 0);
        if (has(cs, "isNegative")) max = Math.min(max ?? 0, 0);
      }
      if (min !== undefined) c["min"] = min;
      if (max !== undefined) c["max"] = max;
      break;
    }
    case "bool":
      break;
    case "duration": {
      c["encoding"] = "go";
      for (const k of ["min", "max"] as const) {
        const v = doc.duration?.[k];
        if (v === undefined) continue;
        const canon = CONTRACT_DURATION.test(v) ? v : canonicalDuration(v);
        if (canon === undefined) {
          p(`@Duration ${k} "${v}" is not a Go duration such as "30s"`);
          continue;
        }
        c[k] = canon;
        if (k === "min") decl.durationMin = parseDuration(canon);
        else decl.durationMax = parseDuration(canon);
      }
      break;
    }
    case "url": {
      const isUrl = find(cs, "isUrl")?.constraints[0] as { protocols?: string[] } | undefined;
      const schemes = doc.schemes ?? isUrl?.protocols;
      if (schemes) {
        c["schemes"] = [...schemes];
        decl.schemes = schemes.map((s) => s.toLowerCase());
      }
      break;
    }
    case "enum": {
      const e = find(cs, "isEnum") ?? find(cs, "isIn");
      const values = (e?.name === "isEnum" ? e.constraints[1] : e?.constraints[0]) as unknown[] | undefined;
      if (!values || values.length === 0) p("no enum values; @IsEnum() takes an enum object, @IsIn() a list");
      else if (!values.every((v) => typeof v === "string")) p("enum values must be strings");
      c["values"] = values ?? [];
      break;
    }
    case "list": {
      const separator = doc.list?.separator ?? ",";
      if (separator === "") p("@List separator must not be empty");
      const items = has(cs, "isInt", true) ? "int" : "string";
      if (items === "string" && (has(cs, "isNumber", true) || has(cs, "isBoolean", true))) {
        p("list items must be strings or integers (@IsInt({ each: true }))");
      }
      decl.items = items;
      decl.separator = separator;
      c["items"] = items;
      c["encoding"] = "csv";
      c["separator"] = separator;
      const minItems = num(cs, "arrayMinSize") ?? (has(cs, "arrayNotEmpty") ? 1 : undefined);
      const maxItems = num(cs, "arrayMaxSize");
      if (minItems !== undefined) c["minItems"] = minItems;
      if (maxItems !== undefined) c["maxItems"] = maxItems;
      if (items === "int") {
        // @Min(0, { each: true }) and friends bound each item (SPEC §4.3).
        const each = (n: string) => {
          const v = find(cs, n, true)?.constraints[0];
          return typeof v === "number" && Number.isFinite(v) ? v : undefined;
        };
        const { min, max } = intBounds(
          name,
          {
            min: each("min"),
            max: each("max"),
            exclusiveMin: has(cs, "isPositive", true) ? 0 : undefined,
            exclusiveMax: has(cs, "isNegative", true) ? 0 : undefined,
          },
          warnings,
          { min: "itemMin", max: "itemMax" },
        );
        c["itemMin"] = decl.itemMin = min;
        c["itemMax"] = decl.itemMax = max;
      }
      break;
    }
    case "json": {
      const schema = doc.json?.schema;
      if (schema !== undefined) {
        try {
          c["schema"] = closeSchema(schemaAdapter.jsonSchema(schema));
          decl.jsonSchema = schema;
        } catch (e) {
          p(`@Json schema cannot be converted to JSON Schema (${(e as Error).message})`);
        }
      }
      break;
    }
  }

  if (def !== undefined) {
    if (secret) p("a secret must not have a default");
    else {
      const d = contractDefault(type, def);
      if (d === undefined) p(`default ${JSON.stringify(def)} does not fit type ${type}`);
      else {
        c["default"] = d;
        decl.default = def;
      }
    }
  }
  return decl;
}

export interface DeclareOptions {
  /** Service name for the contract (a DNS label). */
  name?: string | undefined;
  /** metadata.appVersion for the contract. */
  appVersion?: string | undefined;
}

/**
 * Reads an environment class: class-validator decorators give each
 * variable's type and constraints, docuconf decorators the rest. Throws
 * DocuconfDeclarationError listing every problem (SPEC §11.2 item 2).
 */
export function declare(cls: Class, opts: DeclareOptions = {}): NestDeclaration {
  if (typeof cls !== "function") throw new TypeError("docuconf: pass the environment class, such as EnvironmentVariables");
  const problems: string[] = [];
  const warnings: string[] = [];
  let defaults: Record<string, unknown> = {};
  try {
    defaults = new (cls as unknown as new () => Record<string, unknown>)();
  } catch (e) {
    problems.push(`${cls.name} must be constructible without arguments (${(e as Error).message})`);
  }
  const constraints = getConstraints(cls);
  const docs = docuconfMetadata(cls);
  const vars = new Map<string, NestVarDecl>();
  const files: Record<string, FileInput> = {};
  const fileProperties = new Map<string, string>();
  // Every variable needs @Describe, so docuconf's own metadata holds declaration order.
  const names = [...new Set([...docs.keys(), ...constraints.keys()])];

  for (const property of names) {
    const doc = docs.get(property) ?? {};
    const cs = constraints.get(property) ?? [];
    if (doc.file) {
      const name = doc.file.name ?? kebab(property);
      if (files[name] !== undefined) problems.push(`${property}: file input name "${name}" is also used by ${fileProperties.get(name)}`);
      files[name] = doc.file.input;
      fileProperties.set(name, property);
      continue;
    }
    const d = describeVar(cls, property, cs, doc, defaults[property], problems, warnings);
    if (d) vars.set(property, d);
  }
  checkDefaults(cls, vars, problems);
  const fileContracts = describeFiles(files, vars, problems, schemaAdapter, {
    label: (name) => `${fileProperties.get(name)} (file input "${name}")`,
    secretHint: "add @Secret()",
    varNoun: "variable",
  });
  if (problems.length > 0) throw new DocuconfDeclarationError(problems);
  return { name: opts.name, appVersion: opts.appVersion, cls, vars, files, fileProperties, fileContracts, warnings };
}

/** SPEC §4.3: a default must satisfy its variable's own constraints. */
function checkDefaults(cls: Class, vars: Map<string, NestVarDecl>, problems: string[]): void {
  const env: Record<string, unknown> = {};
  for (const [name, d] of vars) {
    if (d.default !== undefined) env[name] = d.type === "duration" ? d.contract["default"] : wireValue(d, d.contract["default"]);
  }
  if (Object.keys(env).length === 0) return;
  let instance: Record<string, unknown>;
  try {
    instance = new (cls as unknown as new () => Record<string, unknown>)();
  } catch {
    return;
  }
  for (const v of validateEnv(vars, env, instance).violations) {
    if (env[v.input] === undefined) continue;
    problems.push(`${v.input}: default ${JSON.stringify(vars.get(v.input)!.contract["default"])} violates its own constraints: ${v.message}`);
  }
}
