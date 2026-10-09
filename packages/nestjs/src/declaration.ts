import {
  CONTRACT_DURATION,
  DocuconfDeclarationError,
  type FileInput,
  type ValueDecl,
  type VarType,
  canonicalDuration,
  checkVarName,
  closeSchema,
  contractDefault,
  deprecatedProblems,
  describeFiles,
  keySetContract,
  keySetDeclProblems,
  detailsProblem,
  intBounds,
  itemLengthDeclProblems,
  nextFloat,
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

/** Constraints that only mean something for one kind of value; on another they would be dropped from the contract. */
const ONLY_FOR: Record<string, { types: VarType[]; use: string }> = {
  minLength: { types: ["string"], use: "a string" },
  maxLength: { types: ["string", "url"], use: "a string or a url" },
  isLength: { types: ["string"], use: "a string" },
  matches: { types: ["string"], use: "a string" },
  isNotEmpty: { types: ["string"], use: "a string" },
  min: { types: ["int", "float"], use: "a number; for a duration use @Duration({ min })" },
  max: { types: ["int", "float"], use: "a number; for a duration use @Duration({ max })" },
  isPositive: { types: ["int", "float"], use: "a number" },
  isNegative: { types: ["int", "float"], use: "a number" },
  arrayMinSize: { types: ["list"], use: "a @List()" },
  arrayMaxSize: { types: ["list"], use: "a @List()" },
  arrayNotEmpty: { types: ["list"], use: "a @List()" },
};

function decoratorName(constraint: string): string {
  return `@${constraint[0]!.toUpperCase()}${constraint.slice(1)}()`;
}

/** `servingTls` → `serving-tls`. */
export function kebab(property: string): string {
  return property
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase();
}

function detectType(cs: Constraint[], doc: PropertyMeta, design: unknown): VarType | undefined {
  if (doc.keySet) return "keySet";
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
      warnings.push(`${name}: ${decoratorName(c.name)} is checked at boot, but the contract cannot express it`);
    }
    const only = c.each ? undefined : ONLY_FOR[c.name];
    if (only && !only.types.includes(type)) p(`${decoratorName(c.name)} does not apply to a ${type} variable (it needs ${only.use}); remove it or change the type`);
  }
  const isUrl = find(cs, "isUrl")?.constraints[0] as { require_tld?: boolean } | undefined;
  if (has(cs, "isUrl") && isUrl?.require_tld !== false) {
    warnings.push(
      `${name}: @IsUrl() rejects hosts without a top-level domain, such as localhost or db, and the contract cannot express that, so the platform would accept values the app rejects. Use @UrlSchemes("https", ...) or @IsUrl({ require_tld: false })`,
    );
  }
  if ((type === "duration" || type === "list" || type === "keySet" || type === "json") && has(cs, "isString")) {
    p(`a ${type} property holds the parsed value, not the string; remove @IsString()`);
  }
  if (!validDescription(doc.description)) p('needs a description of at least 5 characters (@Describe("..."))');

  // A key set is always secret (SPEC §4.3).
  const secret = doc.secret === true || type === "keySet";
  const c: Record<string, unknown> = { type, description: doc.description ?? "" };
  if (doc.details !== undefined) {
    const bad = detailsProblem(doc.details);
    if (bad !== undefined) p(`@Details: ${bad}`);
    else c["details"] = doc.details;
  }
  const decl: NestVarDecl = { name, property: name, type, secret, required: false, contract: c, constraints: cs, default: undefined };

  let def = initial;
  // A duration default may be written as documented ("30s"), in
  // @Duration({ default }) or as the initializer, or as milliseconds.
  const durationDefault = doc.duration?.default ?? (type === "duration" && typeof initial === "string" ? initial : undefined);
  if (type === "duration" && durationDefault !== undefined) {
    const ms = parseDuration(durationDefault);
    if (ms === undefined || ms < 0) p(`@Duration default "${durationDefault}" is not a Go duration such as "30s" or "1m30s"`);
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
    for (const m of deprecatedProblems(doc.deprecated, required)) p(`@Deprecated: ${m}`);
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
      // @IsPositive is > 0: exported as the smallest double above 0, so
      // the platform rejects exactly what the app does.
      if (has(cs, "isPositive")) min = Math.max(min ?? -Infinity, nextFloat(0, 1));
      if (has(cs, "isNegative")) max = Math.min(max ?? Infinity, nextFloat(0, -1));
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
      // @MaxLength() bounds the URL, in characters (SPEC §4.3).
      const maxLength = num(cs, "maxLength") ?? num(cs, "isLength", 1);
      if (maxLength !== undefined) c["maxLength"] = decl.maxLength = maxLength;
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
      } else if (!has(cs, "isInt", true) && !has(cs, "isString", true)) {
        p("@List() needs @IsString({ each: true }) or @IsInt({ each: true }): emitDecoratorMetadata cannot see the item type");
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
      // @MinLength(n, { each: true }) and @MaxLength(n, { each: true }) bound each string item (SPEC §4.3).
      const eachNum = (n: string, i = 0) => {
        const v = find(cs, n, true)?.constraints[i];
        return typeof v === "number" && Number.isFinite(v) ? v : undefined;
      };
      const itemMinLength = eachNum("minLength") ?? eachNum("isLength", 0);
      const itemMaxLength = eachNum("maxLength") ?? eachNum("isLength", 1);
      for (const m of itemLengthDeclProblems(items, { itemMinLength, itemMaxLength })) p(m.replace(/^itemMinLength and itemMaxLength/, "@MinLength, @MaxLength and @Length with { each: true }"));
      if (items === "string") {
        if (itemMinLength !== undefined) c["itemMinLength"] = decl.itemMinLength = itemMinLength;
        if (itemMaxLength !== undefined) c["itemMaxLength"] = decl.itemMaxLength = itemMaxLength;
      }
      break;
    }
    case "keySet": {
      const o = doc.keySet ?? {};
      const separator = o.separator ?? ",";
      if (separator === "") p("@KeySet separator must not be empty");
      for (const m of keySetDeclProblems(o)) p(`@KeySet ${m}`);
      Object.assign(c, keySetContract(o, "csv", separator));
      Object.assign(decl, { listEncoding: "csv", separator, minKeys: o.minKeys, maxKeys: o.maxKeys, keyMinLength: o.keyMinLength, keyMaxLength: o.keyMaxLength });
      break;
    }
    case "json": {
      const maxLength = doc.json?.options?.maxLength;
      if (maxLength !== undefined) {
        if (!(Number.isInteger(maxLength) && maxLength >= 0)) p("@Json maxLength must be a non-negative integer");
        else c["maxLength"] = decl.maxLength = maxLength;
      }
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
      const input = doc.file.input;
      files[name] = doc.details === undefined ? input : { ...input, options: { ...input.options, details: doc.details } };
      fileProperties.set(name, property);
      continue;
    }
    const d = describeVar(cls, property, cs, doc, defaults[property], problems, warnings);
    if (d) vars.set(property, d);
  }
  // A property with a value but no decorator is invisible to docuconf: it
  // is not exported, yet the app may read it through ConfigService.
  for (const property of Object.keys(defaults)) {
    if (names.includes(property)) continue;
    problems.push(
      `${property}: has a default but no decorators, so docuconf cannot see it and the contract leaves it out; add @Describe("...") and a type decorator such as @IsString(), or remove the property`,
    );
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
