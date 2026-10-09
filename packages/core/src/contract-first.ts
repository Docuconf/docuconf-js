/**
 * Contract-first mode (SPEC §11.2 item 11): validate an environment against
 * a contract given as JSON (`cue export` of a contract.cue), with no
 * in-language declaration, and return typed values. The checks are the
 * ones the SDKs run at boot: precheckVar, convertValue and loadFile. A
 * contract written for a host that reads config files may also declare
 * profiles and overlays (SPEC §4.4, §4.7); they are layered as that host
 * would: the variable's default, then the selected profile's default, then
 * an overlay, then the environment.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { DURATION_ENCODINGS, type DurationEncoding, parseDuration } from "./duration.ts";
import { detailsProblem } from "./doc-text.ts";
import { INPUT_NAME, describeFiles } from "./files/declare.ts";
import { type LoadContext, type StructuredFormat, loadFile, parseStructured } from "./files/load.ts";
import { type FileInput, type FileType, type SchemaAdapter, makeFileInput } from "./files/spec.ts";
import { keySetDeclProblems } from "./keyset.ts";
import { re2RegExp } from "./re2.ts";
import { type JsonCheck, LIST_ENCODINGS, type ListEncoding, type ValueDecl, convertValue, itemLengthDeclProblems, urlProblem } from "./values.ts";
import { type SchemaValidator, compileSchema } from "./schema-check.ts";
import {
  ENV_NAME,
  VarReport,
  type VarType,
  deprecatedProblems,
  deprecatedWarning,
  narrowInt,
  parseJsonExact,
  precheckVar,
  validDescription,
} from "./vars.ts";
import { failBoot } from "./termination.ts";
import { DocuconfDeclarationError, type Violation } from "./violations.ts";

const TYPES: readonly VarType[] = ["string", "int", "float", "bool", "duration", "url", "enum", "list", "keySet", "json"];
const FILE_TYPES: readonly FileType[] = ["config", "tls", "caBundle", "keystore", "text", "binary"];

/** A contract variable, ready to check values against. */
export interface ContractVar extends ValueDecl {
  /** int and float bounds. An int bound beyond ±Number.MAX_SAFE_INTEGER is a bigint. */
  min?: number | bigint | undefined;
  max?: number | bigint | undefined;
  /** string length bounds, in characters (code points); maxLength also bounds a url or json value. */
  minLength?: number | undefined;
  maxLength?: number | undefined;
  /** string pattern: RE2, matched anywhere unless anchored. */
  pattern?: RegExp | undefined;
  /** enum values. */
  values?: readonly string[] | undefined;
  minItems?: number | undefined;
  maxItems?: number | undefined;
  /** The default as a typed value (milliseconds for a duration). */
  default?: unknown;
  /** For a `json` variable with a `schema`: the compiled JSON Schema check. */
  schemaCheck?: SchemaValidator | undefined;
  /** The app's own configuration key, where an overlay carries the value (SPEC §4.7). */
  configKey?: string | undefined;
  /** Staged removal (SPEC §4.2): a set value loads, with a warning. */
  deprecated?: { message: string; replacedBy?: string } | undefined;
}

/** A contract's profiles (SPEC §4.4), with each profile default typed. */
export interface ContractProfiles {
  /** The variable that picks the profile. */
  selector: string;
  /** The profile in effect when the selector is unset. */
  default: string;
  /** Profile name, then variable, then typed value. */
  defaults: ReadonlyMap<string, ReadonlyMap<string, unknown>>;
}

/** One config-file overlay (SPEC §4.7). */
export interface ContractOverlay {
  name: string;
  format: StructuredFormat;
  /** Absolute; read under DOCUCONF_FILE_ROOT. */
  path: string;
  keySeparator: ":" | ".";
}

/** A contract read for contract-first validation. */
export interface ContractDeclaration {
  name: string | undefined;
  vars: ReadonlyMap<string, ContractVar>;
  /** File inputs (SPEC §4.6), by input name. */
  files: Readonly<Record<string, FileInput>>;
  profiles: ContractProfiles | undefined;
  /** Sorted by name. */
  overlays: readonly ContractOverlay[];
}

type Json = Record<string, unknown>;

const isObject = (x: unknown): x is Json => typeof x === "object" && x !== null && !Array.isArray(x);
const isInt = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x);
const isCount = (x: unknown): x is number => isInt(x) && x >= 0;
/** An int bound: a number, or a bigint beyond 2^53 from an exactly parsed contract. */
const isInt64 = (x: unknown): x is number | bigint =>
  isInt(x) ? Math.abs(x) <= 2 ** 63 : typeof x === "bigint" && x >= -(2n ** 63n) && x < 2n ** 63n;

/** A bigint, anywhere in `x`, as a number: for fields that are not int64. */
function unbig(x: unknown): unknown {
  if (typeof x === "bigint") return Number(x);
  if (Array.isArray(x)) return x.map(unbig);
  if (isObject(x)) return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, unbig(v)]));
  return x;
}

/** The fields that keep a bigint (int64), by type; elsewhere a bigint is read as a number. */
const INT64_FIELDS: Partial<Record<VarType, readonly string[]>> = { int: ["min", "max", "default"], list: ["itemMin", "itemMax", "default"] };

/** Compiled config-file schemas, by the schema object loadFile hands back. */
const fileSchemas = new WeakMap<object, SchemaValidator>();

/** Config files in contract-first mode are checked against their JSON Schema, with Ajv. */
const contractSchemaAdapter: SchemaAdapter = {
  // A config file may have no schema in a hand-written contract.
  jsonSchema: (schema) => (schema ?? {}) as Record<string, unknown>,
  validate(schema, data) {
    const check = isObject(schema) ? fileSchemas.get(schema) : undefined;
    const issues = check ? check(data) : [];
    return issues.length > 0 ? { issues } : { value: data };
  },
};

/**
 * Reads a contract exported as JSON (an object, or its JSON text). Fields
 * the meta-schema defaults (`required`, `secret`, `encoding`, `separator`)
 * may be omitted. Reads variables, file inputs, profiles and overlays.
 * Throws DocuconfDeclarationError listing every problem.
 */
export function parseContract(contract: unknown): ContractDeclaration {
  // Integers beyond 2^53 (an int's min, max or default) are read exactly.
  const doc: unknown = typeof contract === "string" ? parseJsonExact(contract) : contract;
  const problems: string[] = [];
  if (!isObject(doc)) throw new DocuconfDeclarationError(["the contract must be a JSON object"]);
  if (doc["apiVersion"] !== "docuconf.dev/v1alpha1") problems.push(`apiVersion must be "docuconf.dev/v1alpha1"`);
  if (doc["kind"] !== "ConfigContract") problems.push(`kind must be "ConfigContract"`);
  const metadata = isObject(doc["metadata"]) ? doc["metadata"] : {};
  const rawVars = doc["vars"] ?? {};
  if (!isObject(rawVars)) problems.push("vars must be an object");
  const vars = new Map<string, ContractVar>();
  for (const [name, raw] of Object.entries(isObject(rawVars) ? rawVars : {})) {
    const v = readVar(name, raw, (m) => problems.push(`${name}: ${m}`));
    if (v) vars.set(name, v);
  }
  const files = readFiles(doc["files"], vars, problems);
  const profiles = doc["profiles"] === undefined ? undefined : readProfiles(doc["profiles"], vars, problems);
  const overlays = doc["overlays"] === undefined ? [] : readOverlays(doc["overlays"], problems);
  if (problems.length > 0) throw new DocuconfDeclarationError(problems);
  return { name: typeof metadata["name"] === "string" ? metadata["name"] : undefined, vars, files, profiles, overlays };
}

function readVar(name: string, given: unknown, problem: (m: string) => void): ContractVar | undefined {
  if (!ENV_NAME.test(name)) problem(`variable names must match ${ENV_NAME.source}`);
  if (!isObject(given)) {
    problem("must be an object");
    return undefined;
  }
  const type = given["type"] as VarType;
  const keep = INT64_FIELDS[type] ?? [];
  const raw = Object.fromEntries(Object.entries(given).map(([k, x]) => [k, keep.includes(k) ? x : unbig(x)]));
  if (!TYPES.includes(type)) {
    problem(`unknown type ${JSON.stringify(raw["type"])}`);
    return undefined;
  }
  if (!validDescription(raw["description"])) problem("needs a description of at least 5 characters");
  // details is documentation only (SPEC §4.2): checked like the meta-schema does, never used.
  if (raw["details"] !== undefined) {
    const bad = detailsProblem(raw["details"]);
    if (bad !== undefined) problem(bad);
  }
  const flag = (k: string) => {
    const x = raw[k] ?? false;
    if (typeof x !== "boolean") problem(`${k} must be a boolean`);
    return x === true;
  };
  // int values hold the full 64-bit range (a bigint beyond 2^53).
  const v: ContractVar = { name, type, secret: flag("secret"), required: flag("required"), contract: raw, int64: true };
  for (const m of deprecatedProblems(raw["deprecated"], v.required)) problem(m);
  if (isObject(raw["deprecated"])) v.deprecated = raw["deprecated"] as ContractVar["deprecated"];
  const opt = <T>(k: string, ok: (x: unknown) => x is T, what: string): T | undefined => {
    const x = raw[k];
    if (x === undefined) return undefined;
    if (!ok(x)) {
      problem(`${k} must be ${what}`);
      return undefined;
    }
    return x;
  };
  const isString = (x: unknown): x is string => typeof x === "string";
  v.configKey = opt("configKey", isString, "a string");
  const duration = (k: string) => {
    const s = opt(k, isString, "a duration");
    if (s === undefined) return undefined;
    const ms = parseDuration(s);
    if (ms === undefined || ms < 0) problem(`${k} ${JSON.stringify(s)} is not a duration`);
    return ms;
  };
  const isNumber = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
  const isStrings = (x: unknown): x is string[] => Array.isArray(x) && x.length > 0 && x.every(isString);
  const listShape = (fallback: ListEncoding) => {
    const enc = raw["encoding"] ?? fallback;
    if (!LIST_ENCODINGS.includes(enc as ListEncoding)) problem(`unknown ${type} encoding ${JSON.stringify(enc)}`);
    v.listEncoding = enc as ListEncoding;
    v.separator = opt("separator", isString, "a string") ?? ",";
    if (v.separator === "") problem("separator must not be empty");
  };

  switch (type) {
    case "string": {
      v.minLength = opt("minLength", isCount, "a non-negative integer");
      v.maxLength = opt("maxLength", isCount, "a non-negative integer");
      const pattern = opt("pattern", isString, "a string");
      if (pattern !== undefined) {
        const re = re2RegExp(pattern);
        if (re instanceof RegExp) v.pattern = re;
        else problem(`pattern: ${re.problem}`);
      }
      break;
    }
    case "int":
      v.min = narrowBound(opt("min", isInt64, "a 64-bit integer"));
      v.max = narrowBound(opt("max", isInt64, "a 64-bit integer"));
      break;
    case "float":
      v.min = opt("min", isNumber, "a number");
      v.max = opt("max", isNumber, "a number");
      break;
    case "duration": {
      const enc = raw["encoding"] ?? "go";
      if (!DURATION_ENCODINGS.includes(enc as DurationEncoding)) problem(`unknown duration encoding ${JSON.stringify(enc)}`);
      v.durationEncoding = enc as DurationEncoding;
      v.durationMin = duration("min");
      v.durationMax = duration("max");
      break;
    }
    case "url": {
      const schemes = opt("schemes", isStrings, "a non-empty list of strings");
      v.schemes = schemes?.map((s) => s.toLowerCase());
      v.maxLength = opt("maxLength", isCount, "a non-negative integer");
      break;
    }
    case "enum":
      v.values = opt("values", isStrings, "a non-empty list of strings");
      if (v.values === undefined) problem("needs values");
      break;
    case "list": {
      const items = raw["items"];
      if (items !== "string" && items !== "int") problem(`items must be "string" or "int"`);
      v.items = items === "int" ? "int" : "string";
      listShape("csv");
      v.minItems = opt("minItems", isCount, "a non-negative integer");
      v.maxItems = opt("maxItems", isCount, "a non-negative integer");
      v.itemMin = narrowBound(opt("itemMin", isInt64, "a 64-bit integer"));
      v.itemMax = narrowBound(opt("itemMax", isInt64, "a 64-bit integer"));
      if (v.items !== "int" && (v.itemMin !== undefined || v.itemMax !== undefined)) problem("itemMin and itemMax apply to int items only");
      v.itemMinLength = opt("itemMinLength", isCount, "a non-negative integer");
      v.itemMaxLength = opt("itemMaxLength", isCount, "a non-negative integer");
      for (const m of itemLengthDeclProblems(v.items, v)) problem(m);
      break;
    }
    case "keySet": {
      // Always secret (SPEC §4.3): no default, no examples.
      if (!v.secret) problem("a keySet is always secret: set secret: true");
      if (raw["examples"] !== undefined) problem("a keySet must not have examples");
      listShape("csv");
      v.minKeys = opt("minKeys", isCount, "an integer of at least 1");
      v.maxKeys = opt("maxKeys", isCount, "an integer of at least 1");
      v.keyMinLength = opt("keyMinLength", isCount, "an integer of at least 1");
      v.keyMaxLength = opt("keyMaxLength", isCount, "an integer of at least 1");
      for (const m of keySetDeclProblems(v)) problem(m);
      break;
    }
    case "json": {
      v.maxLength = opt("maxLength", isCount, "a non-negative integer");
      if (raw["schema"] !== undefined) {
        const check = compileSchema(raw["schema"]);
        if (typeof check === "function") v.schemaCheck = check;
        else problem(`schema: ${check.problem}`);
      }
      break;
    }
    case "bool":
      break;
  }

  const d = given["default"];
  if (d !== undefined) {
    if (v.required) problem("a required variable cannot have a default");
    if (v.secret) problem("a secret cannot have a default");
    const typed = typedValue(v, keep.includes("default") ? d : unbig(d));
    if ("problem" in typed) problem(`default ${typed.problem}`);
    else v.default = typed.value;
  }
  return v;
}

/**
 * A typed value as a contract writes it (a default, or a profile file's
 * value), converted to what the app receives: milliseconds for a duration,
 * an exact integer, a list's items. It must fit the variable's type and
 * constraints, as SPEC §4.3 and §4.4 require.
 */
function typedValue(v: ContractVar, x: unknown): { value: unknown } | { problem: string } {
  const report = new VarReport({ ...v, secret: false });
  let value: unknown;
  switch (v.type) {
    case "string":
    case "enum":
    case "url":
      if (typeof x !== "string") return { problem: `${jsonKind(x)} is not a string` };
      value = x;
      if (v.type === "url") {
        const p = urlProblem(x, v.schemes);
        if (p) return { problem: p.message };
      }
      break;
    case "int":
      if (!(isInt(x) || typeof x === "bigint")) return { problem: `${jsonKind(x)} is not an integer` };
      value = narrowInt(x);
      break;
    case "float":
      if (typeof x !== "number" || !Number.isFinite(x)) return { problem: `${jsonKind(x)} is not a number` };
      value = x;
      break;
    case "bool":
      if (typeof x !== "boolean") return { problem: `${jsonKind(x)} is not a bool` };
      value = x;
      break;
    case "duration": {
      const ms = typeof x === "string" ? parseDuration(x) : undefined;
      if (ms === undefined) return { problem: `${JSON.stringify(x)} is not a Go duration` };
      if ((v.durationMin !== undefined && ms < v.durationMin) || (v.durationMax !== undefined && ms > v.durationMax)) {
        return { problem: `${JSON.stringify(x)} is outside the variable's bounds` };
      }
      value = ms;
      break;
    }
    case "list": {
      if (!Array.isArray(x)) return { problem: `${jsonKind(x)} is not a list` };
      // Checked item by item, as the platform's items would be.
      const r = convertValue({ ...v, secret: false }, x.map((i) => (typeof i === "string" ? i : String(i))), report);
      if (!r.ok) return { problem: report.violations.map((x) => x.message).join("; ") };
      value = r.value;
      break;
    }
    case "keySet":
      return { problem: "is not allowed: a key set is secret" };
    case "json":
      value = x;
      if (v.schemaCheck) {
        const issues = v.schemaCheck(x);
        if (issues.length > 0) return { problem: `does not match the schema: ${issues.map((i) => `${i.path || "(root)"} ${i.message}`).join("; ")}` };
      }
      break;
  }
  if (!checkConstraints(v, value, report)) return { problem: report.violations.map((x) => x.message).join("; ") };
  return { value };
}

function jsonKind(x: unknown): string {
  if (x === null) return "null";
  if (Array.isArray(x)) return "a list";
  if (typeof x === "object") return "an object";
  if (typeof x === "bigint") return "a number";
  return `a ${typeof x}`;
}

/** File inputs, as contract fields (SPEC §4.6), turned into FileInputs that loadFile reads. */
function readFiles(given: unknown, vars: ReadonlyMap<string, ContractVar>, problems: string[]): Record<string, FileInput> {
  if (given === undefined) return {};
  if (!isObject(given)) {
    problems.push("files must be an object");
    return {};
  }
  const files: Record<string, FileInput> = {};
  for (const [name, raw] of Object.entries(given)) {
    const p = (m: string) => problems.push(`files.${name}: ${m}`);
    if (!isObject(raw)) {
      p("must be an object");
      continue;
    }
    const f = unbig(raw) as Json;
    const type = f["type"] as FileType;
    if (!FILE_TYPES.includes(type)) {
      p(`unknown type ${JSON.stringify(f["type"])}`);
      continue;
    }
    if (type === "config" && f["schema"] !== undefined) {
      const check = compileSchema(f["schema"]);
      if (typeof check === "function" && isObject(f["schema"])) fileSchemas.set(f["schema"], check);
      else if (typeof check !== "function") p(`schema: ${check.problem}`);
    }
    if (type === "text" && typeof f["pattern"] === "string") {
      const re = re2RegExp(f["pattern"]);
      if (!(re instanceof RegExp)) p(`pattern: ${re.problem}`);
    }
    if (type === "config" && f["format"] === undefined) p("needs a format");
    files[name] = makeFileInput(type, f);
  }
  // The declaration checks every SDK makes: names, paths, mount rules, passwordVar.
  describeFiles(files, vars, problems, contractSchemaAdapter, { varNoun: "variable", secretHint: "set secret: true" });
  return files;
}

function readProfiles(given: unknown, vars: ReadonlyMap<string, ContractVar>, problems: string[]): ContractProfiles | undefined {
  const p = (m: string) => problems.push(`profiles: ${m}`);
  if (!isObject(given)) {
    p("must be an object");
    return undefined;
  }
  for (const k of Object.keys(given)) if (!["selector", "default", "defaults"].includes(k)) p(`unknown field ${k}`);
  const selector = given["selector"];
  if (typeof selector !== "string" || !vars.has(selector)) p(`selector ${JSON.stringify(selector)} must be a declared variable`);
  const def = given["default"];
  if (typeof def !== "string") p("default must be a string");
  const defaults = new Map<string, Map<string, unknown>>();
  const raw = given["defaults"] ?? {};
  if (!isObject(raw)) p("defaults must be an object");
  for (const [profile, values] of Object.entries(isObject(raw) ? raw : {})) {
    if (!isObject(values)) {
      p(`defaults.${profile} must be an object`);
      continue;
    }
    const typed = new Map<string, unknown>();
    for (const [name, x] of Object.entries(values)) {
      const v = vars.get(name);
      if (!v) p(`defaults.${profile}: ${name} is not a declared variable`);
      else if (v.secret) p(`defaults.${profile}: ${name} is secret, and a secret has no value in a config file`);
      else {
        const r = typedValue(v, (INT64_FIELDS[v.type] ?? []).includes("default") ? x : unbig(x));
        if ("problem" in r) p(`defaults.${profile}: ${name} ${r.problem}`);
        else typed.set(name, r.value);
      }
    }
    defaults.set(profile, typed);
  }
  return { selector: String(selector), default: String(def), defaults };
}

function readOverlays(given: unknown, problems: string[]): ContractOverlay[] {
  if (!isObject(given)) {
    problems.push("overlays must be an object");
    return [];
  }
  const out: ContractOverlay[] = [];
  for (const name of Object.keys(given).sort()) {
    const p = (m: string) => problems.push(`overlays.${name}: ${m}`);
    const o = given[name];
    if (!isObject(o)) {
      p("must be an object");
      continue;
    }
    if (!INPUT_NAME.test(name)) p(`names must be DNS labels matching ${INPUT_NAME.source}`);
    for (const k of Object.keys(o)) if (!["name", "description", "format", "path", "keySeparator", "reload"].includes(k)) p(`unknown field ${k}`);
    const format = o["format"];
    if (format !== "json" && format !== "yaml" && format !== "toml") p('format must be "json", "yaml" or "toml"');
    const path = o["path"];
    if (typeof path !== "string" || !/^\/[A-Za-z0-9._/-]+$/.test(path) || /(^|\/)\.\.?(\/|$)/.test(path) || path.includes("//") || path.endsWith("/")) {
      p(`path ${JSON.stringify(path)} must be absolute and normalised`);
    }
    const keySeparator = o["keySeparator"];
    if (keySeparator !== ":" && keySeparator !== ".") p('keySeparator must be ":" or "."');
    if (o["reload"] !== undefined && o["reload"] !== "restart" && o["reload"] !== "watch") p('reload must be "restart" or "watch"');
    out.push({ name, format: format as StructuredFormat, path: String(path), keySeparator: keySeparator as ":" | "." });
  }
  return out;
}

/** Options for checkContract and loadContract. */
export interface ContractCheckOptions {
  /**
   * Validates a `json` variable's parsed value, replacing the built-in check
   * against the variable's JSON Schema (`decl.contract.schema`, with Ajv).
   */
  validateJson?: JsonCheck;
  /**
   * Prefix for absolute file input and overlay paths, for local development
   * and tests. Default: `DOCUCONF_FILE_ROOT` from the environment checked.
   */
  fileRoot?: string;
  /**
   * Receives warnings: a deprecated input that is set, a variable set both
   * in the environment and in an overlay. Never a value. loadContract's
   * default is console.warn; checkContract returns them instead.
   */
  onWarning?: (message: string) => void;
  /** The time certificates are checked at. Default: now. */
  now?: number;
}

/** The built-in `json` check: the variable's compiled schema, if it has one. */
const schemaJsonCheck: JsonCheck = (decl, value) => {
  const check = (decl as ContractVar).schemaCheck;
  const issues = check ? check(value) : [];
  return issues.length > 0 ? { issues } : { value };
};

/** An indexed item's suffix: a decimal index with no leading zero (SPEC §5). */
const INDEX = /^(?:0|[1-9][0-9]*)$/;

/**
 * The raw value of a variable: its entry, or for an `indexed` list or key
 * set its items NAME__0, NAME__1, ... Other suffixes (NAME__HOST) are not
 * items. Items must be numbered from 0 with no gap; otherwise `gap` names
 * the first missing item.
 */
function rawValue(
  v: Pick<ContractVar, "name" | "type" | "listEncoding">,
  env: Readonly<Record<string, string | undefined>>,
): { raw: unknown; gap?: undefined } | { raw?: undefined; gap: string } {
  if ((v.type !== "list" && v.type !== "keySet") || v.listEncoding !== "indexed") return { raw: env[v.name] };
  const prefix = `${v.name}__`;
  const items = new Map<number, string>();
  for (const [k, value] of Object.entries(env)) {
    if (value === undefined || !k.startsWith(prefix)) continue;
    const suffix = k.slice(prefix.length);
    if (INDEX.test(suffix)) items.set(Number(suffix), value);
  }
  if (items.size === 0) return { raw: undefined };
  const out: string[] = [];
  for (let i = 0; i < items.size; i++) {
    if (!items.has(i)) return { gap: `${prefix}${i}` };
    out.push(items.get(i)!);
  }
  return { raw: out };
}

/** Bounds, lengths, patterns, enum values and item counts. */
function checkConstraints(v: ContractVar, value: unknown, report: VarReport): boolean {
  const before = report.violations.length;
  const got = report.got(value);
  switch (v.type) {
    case "int":
    case "float": {
      // number or bigint: mixed comparisons are exact.
      const n = value as number | bigint;
      if (v.min !== undefined && n < v.min) report.add("out_of_range", `must be at least ${v.min}${got}`);
      else if (v.max !== undefined && n > v.max) report.add("out_of_range", `must be at most ${v.max}${got}`);
      break;
    }
    case "string": {
      const s = value as string;
      const length = [...s].length;
      if (v.minLength !== undefined && length < v.minLength) report.add("out_of_range", `must be at least ${v.minLength} characters${got}`);
      else if (v.maxLength !== undefined && length > v.maxLength) report.add("out_of_range", `must be at most ${v.maxLength} characters${got}`);
      if (v.pattern !== undefined) {
        v.pattern.lastIndex = 0;
        if (!v.pattern.test(s)) report.add("pattern_mismatch", `must match ${v.contract["pattern"] as string}${got}`);
      }
      break;
    }
    case "enum":
      if (v.values && !v.values.includes(value as string)) report.add("not_in_enum", `must be one of ${v.values.join(", ")}${got}`);
      break;
    case "list": {
      const n = (value as unknown[]).length;
      if (v.minItems !== undefined && n < v.minItems) report.add("too_few_items", `must have at least ${v.minItems} items, has ${n}`, true);
      else if (v.maxItems !== undefined && n > v.maxItems) report.add("too_many_items", `must have at most ${v.maxItems} items, has ${n}`, true);
      break;
    }
    default:
      break;
  }
  return report.violations.length === before;
}

/** A variable's value from below the environment (SPEC §4.4, §4.7). */
type Layer =
  /** A profile default, already typed. */
  | { kind: "profile"; source: string; value: unknown }
  /** An overlay value, as the wire string (or items) it stands for, checked like an env value. */
  | { kind: "overlay"; source: string; raw: string | string[] }
  /** An overlay value that is already reported. */
  | { kind: "bad"; source: string };

/**
 * The profile in effect: the selector's value when the environment sets it,
 * read as the selector's type reads it (for a string the empty string is a
 * value), else profiles.default.
 */
function selectedProfile(decl: ContractDeclaration, env: Readonly<Record<string, string | undefined>>): string | undefined {
  const p = decl.profiles;
  if (!p) return undefined;
  const raw = env[p.selector];
  if (raw !== undefined && (raw !== "" || decl.vars.get(p.selector)?.type === "string")) return raw;
  return p.default;
}

/**
 * Each variable's value from the highest layer below the environment that
 * sets it, and the violations of the overlay files themselves.
 */
function loadLayers(
  decl: ContractDeclaration,
  env: Readonly<Record<string, string | undefined>>,
  root: string | undefined,
  warn: (m: string) => void,
): { layers: Map<string, Layer>; violations: Violation[] } {
  const layers = new Map<string, Layer>();
  const violations: Violation[] = [];
  const profile = selectedProfile(decl, env);
  if (profile !== undefined) {
    for (const [name, value] of decl.profiles?.defaults.get(profile) ?? []) layers.set(name, { kind: "profile", source: `profile ${profile}`, value });
  }
  const fromOverlay = new Map<string, string>();
  for (const ov of decl.overlays) {
    const path = root && isAbsolute(ov.path) ? join(root, ov.path) : ov.path;
    const fail = (code: Violation["code"], message: string) => violations.push({ input: ov.name, kind: "file", code, message });
    let data: Buffer;
    try {
      data = readFileSync(path);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      // An overlay is optional.
      if (code !== "ENOENT" && code !== "ENOTDIR") fail(code === "EISDIR" ? "file_malformed" : "file_unreadable", `${path} cannot be read (${code ?? "error"})`);
      continue;
    }
    let text = data.toString("utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const parsed = parseStructured(ov.format, text, false, true);
    if ("problem" in parsed) {
      fail("file_malformed", `${path} is ${parsed.problem}`);
      continue;
    }
    if (!isObject(parsed.data)) {
      fail("file_malformed", `${path} does not hold an object at its top level`);
      continue;
    }
    for (const v of decl.vars.values()) {
      if (v.configKey === undefined || v.name === decl.profiles?.selector) continue;
      const found = lookupKey(parsed.data, v.configKey.split(ov.keySeparator));
      // A null is unset, like an empty env value.
      if (!found.ok || found.value === null) continue;
      const prev = fromOverlay.get(v.name);
      if (prev !== undefined) {
        warn(`${v.name} is set in overlays ${prev} and ${ov.name}; the first wins`);
        continue;
      }
      fromOverlay.set(v.name, ov.name);
      const source = `overlay ${ov.name}`;
      const report = (message: string) => {
        violations.push({ input: v.name, kind: "var", code: "invalid_type", message: `${source}, at ${v.configKey}: ${message}` });
        layers.set(v.name, { kind: "bad", source });
      };
      if (v.secret) {
        // Never printed: the value is secret material in a ConfigMap.
        report("is secret, so it must come from the environment, not an overlay");
        continue;
      }
      const raw = overlayValue(v, found.value);
      if ("problem" in raw) report(raw.problem);
      else layers.set(v.name, { kind: "overlay", source, raw: raw.raw });
    }
  }
  return { layers, violations };
}

/** The value at a key path in a parsed overlay. Keys match exactly, as #Render writes them. */
function lookupKey(doc: Json, parts: readonly string[]): { ok: true; value: unknown } | { ok: false } {
  let cur: unknown = doc;
  for (const k of parts) {
    if (!isObject(cur) || !Object.hasOwn(cur, k)) return { ok: false };
    cur = cur[k];
  }
  return { ok: true, value: cur };
}

/**
 * A native overlay value as the wire string it stands for (SPEC §4.7): a
 * string as it is, a bool as true or false, an integral number as a base-10
 * integer and any other in shortest round-trip decimal, a list item by
 * item, and a `json` variable's value as compact JSON.
 */
function overlayValue(v: ContractVar, x: unknown): { raw: string | string[] } | { problem: string } {
  if (v.type === "json") return { raw: JSON.stringify(x, (_k, y: unknown) => (typeof y === "bigint" ? Number(y) : y)) };
  if (v.type === "list" || v.type === "keySet") {
    if (!Array.isArray(x)) return { problem: `is ${jsonKind(x)}, not a list` };
    const items: string[] = [];
    for (const [i, item] of x.entries()) {
      const s = scalarText(item);
      if (s === undefined) return { problem: `item ${i + 1} is ${jsonKind(item)}, not a scalar` };
      items.push(s);
    }
    return { raw: items };
  }
  const s = scalarText(x);
  return s === undefined ? { problem: `is ${jsonKind(x)}, not a scalar` } : { raw: s };
}

function scalarText(x: unknown): string | undefined {
  if (typeof x === "string") return x;
  if (typeof x === "boolean") return String(x);
  if (typeof x === "bigint") return x.toString();
  if (typeof x === "number" && Number.isFinite(x)) {
    return Number.isInteger(x) && Math.abs(x) < 2 ** 63 ? BigInt(x).toString() : String(x);
  }
  return undefined;
}

/** What checkContract found. */
export interface ContractCheckResult {
  /** Every variable's typed value (undefined when absent or invalid). */
  values: Record<string, unknown>;
  /** Every file input's loaded value, by input name (undefined when absent or invalid). */
  files: Record<string, unknown>;
  violations: Violation[];
  /** Deprecated inputs that are set, and variables set in two places. Never a value. */
  warnings: string[];
}

/**
 * Validates `env` against a contract and returns every variable's typed
 * value, every file input's loaded value, every violation and every
 * warning. Variables the contract does not declare are ignored. Messages
 * never contain a secret's value.
 */
export function checkContract(
  contract: ContractDeclaration | unknown,
  env: Readonly<Record<string, string | undefined>>,
  opts: ContractCheckOptions = {},
): ContractCheckResult {
  const decl = isDeclaration(contract) ? contract : parseContract(contract);
  const values: Record<string, unknown> = {};
  const violations: Violation[] = [];
  const warnings: string[] = [];
  const warn = (m: string) => {
    warnings.push(m);
    opts.onWarning?.(m);
  };
  const root = opts.fileRoot ?? (env["DOCUCONF_FILE_ROOT"] || undefined);
  const layered = loadLayers(decl, env, root, warn);
  violations.push(...layered.violations);
  const jsonCheck = opts.validateJson ?? schemaJsonCheck;

  for (const [name, v] of decl.vars) {
    const report = new VarReport(v);
    values[name] = undefined;
    const raw = rawValue(v, env);
    if (raw.gap !== undefined) {
      report.add("invalid_type", `indexed items must be numbered from 0 with no gap, but ${raw.gap} is not set`, true);
      violations.push(...report.violations);
      continue;
    }
    // A string (or indexed items) to parse: from the environment, else an overlay.
    let given: unknown = raw.raw;
    const pre = precheckVar(v, given, report);
    const layer = layered.layers.get(name);
    let value: unknown = undefined;
    if (pre.ok && pre.value === undefined) {
      if (layer?.kind === "overlay") {
        given = layer.raw;
        const fromLayer = precheckVar(v, layer.raw, report);
        if (fromLayer.ok && fromLayer.value !== undefined) value = parse(v, fromLayer.value as string | string[], report, jsonCheck);
        else if (fromLayer.ok) value = fallback(v, report);
      } else if (layer?.kind === "profile") value = layer.value;
      else if (layer?.kind !== "bad") value = fallback(v, report);
    } else if (pre.ok) {
      if (layer?.kind === "overlay") warn(`${name} is set in the environment and in ${layer.source}; the environment wins`);
      value = parse(v, pre.value as string | string[], report, jsonCheck);
    }
    const set = (given !== undefined && given !== "") || layer?.kind === "overlay";
    // A deprecated input that is set is still checked; the warning comes either way (SPEC §11.2).
    if (v.deprecated && set) warn(deprecatedWarning(name, v.deprecated));
    values[name] = value;
    violations.push(...report.violations);
  }

  const ctx: LoadContext = { env: { ...env }, values, root, adapter: contractSchemaAdapter };
  const files: Record<string, unknown> = {};
  for (const [name, input] of Object.entries(decl.files)) {
    const r = loadFile(name, input, ctx, opts.now);
    files[name] = r.violations.length > 0 ? undefined : r.value;
    violations.push(...r.violations);
    const dep = input.options.deprecated;
    if (dep && r.value !== undefined && r.violations.length === 0) warn(deprecatedWarning(name, dep));
  }
  return { values, files, violations, warnings };
}

/** Parses one present value and checks its constraints; undefined after reporting a violation. */
function parse(v: ContractVar, raw: string | string[], report: VarReport, jsonCheck: JsonCheck): unknown {
  const r = convertValue(v, raw, report, jsonCheck);
  return r.ok && checkConstraints(v, r.value, report) ? r.value : undefined;
}

/** An unset variable: its default, or missing_required. */
function fallback(v: ContractVar, report: VarReport): unknown {
  if (v.default !== undefined) return v.default;
  if (v.required) report.add("missing_required", "required, but not set");
  return undefined;
}

/** An int bound as a number when it is safe. */
function narrowBound(x: number | bigint | undefined): number | bigint | undefined {
  return x === undefined ? undefined : narrowInt(x);
}

function isDeclaration(x: unknown): x is ContractDeclaration {
  return isObject(x) && x["vars"] instanceof Map;
}

/** Options for loadContract. */
export interface LoadContractOptions extends ContractCheckOptions {
  /** The environment. Default: process.env. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Where to write violations. Default: DOCUCONF_TERMINATION_LOG, else /dev/termination-log if it exists. `false` disables. */
  terminationLog?: string | false;
  /** On violations, print them and exit 1 instead of throwing (except under a test runner). */
  exitOnError?: boolean;
}

/**
 * Contract-first boot validation: checks the environment, the file inputs,
 * the profile and the overlays against a contract exported as JSON
 * (`cue export ./contract.cue --out json`) and returns the typed values:
 * each variable by its name, and each file input by its input name (a
 * config file's data, a text file's text, a `TlsMaterial`, `CaBundle`,
 * `Keystore` or `Buffer`). A key set is a KeySet. Logs a warning for each
 * deprecated input that is set. Throws DocuconfValidationError listing every
 * violation, after writing them to the termination log.
 *
 * ```ts
 * const env = loadContract(readFileSync("contract.json", "utf8"));
 * server.listen(env.PORT as number);
 * ```
 */
export function loadContract<T extends Record<string, unknown> = Record<string, unknown>>(
  contract: ContractDeclaration | unknown,
  opts: LoadContractOptions = {},
): T {
  const onWarning = opts.onWarning ?? ((m: string) => console.warn(`docuconf: ${m}`));
  const { values, files, violations } = checkContract(contract, opts.env ?? process.env, { ...opts, onWarning });
  if (violations.length > 0) failBoot(violations, opts);
  return { ...values, ...files } as T;
}
