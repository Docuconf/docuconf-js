/**
 * Contract-first mode (SPEC §11.2 item 11): validate an environment against
 * a contract given as JSON (`cue export` of a contract.cue), with no
 * in-language declaration, and return typed values. The checks are the
 * ones the SDKs run at boot: precheckVar and convertValue.
 */
import { DURATION_ENCODINGS, type DurationEncoding, parseDuration } from "./duration.ts";
import { detailsProblem } from "./doc-text.ts";
import { re2RegExp } from "./re2.ts";
import { type JsonCheck, LIST_ENCODINGS, type ListEncoding, type ValueDecl, convertValue, itemLengthDeclProblems } from "./values.ts";
import { type SchemaValidator, compileSchema } from "./schema-check.ts";
import { ENV_NAME, VarReport, type VarType, narrowInt, parseJsonExact, precheckVar, validDescription } from "./vars.ts";
import { failBoot } from "./termination.ts";
import { DocuconfDeclarationError, type Violation } from "./violations.ts";

const TYPES: readonly VarType[] = ["string", "int", "float", "bool", "duration", "url", "enum", "list", "json"];

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
}

/** A contract read for contract-first validation. */
export interface ContractDeclaration {
  name: string | undefined;
  vars: ReadonlyMap<string, ContractVar>;
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

/**
 * Reads a contract exported as JSON (an object, or its JSON text). Fields
 * the meta-schema defaults (`required`, `secret`, `encoding`, `separator`)
 * may be omitted. Variables are read; file inputs are not checked in this
 * mode. Throws DocuconfDeclarationError listing every problem.
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
  if (problems.length > 0) throw new DocuconfDeclarationError(problems);
  return { name: typeof metadata["name"] === "string" ? metadata["name"] : undefined, vars };
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
  const opt = <T>(k: string, ok: (x: unknown) => x is T, what: string): T | undefined => {
    const x = raw[k];
    if (x === undefined) return undefined;
    if (!ok(x)) {
      problem(`${k} must be ${what}`);
      return undefined;
    }
    return x;
  };
  const duration = (k: string) => {
    const s = opt(k, (x): x is string => typeof x === "string", "a duration");
    if (s === undefined) return undefined;
    const ms = parseDuration(s);
    if (ms === undefined || ms < 0) problem(`${k} ${JSON.stringify(s)} is not a duration`);
    return ms;
  };
  const isNumber = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
  const isString = (x: unknown): x is string => typeof x === "string";
  const isStrings = (x: unknown): x is string[] => Array.isArray(x) && x.length > 0 && x.every(isString);

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
      const enc = raw["encoding"] ?? "csv";
      if (!LIST_ENCODINGS.includes(enc as ListEncoding)) problem(`unknown list encoding ${JSON.stringify(enc)}`);
      v.listEncoding = enc as ListEncoding;
      v.separator = opt("separator", isString, "a string") ?? ",";
      if (v.separator === "") problem("separator must not be empty");
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

  const d = raw["default"];
  if (d !== undefined) {
    if (v.required) problem("a required variable cannot have a default");
    if (v.secret) problem("a secret cannot have a default");
    if (type === "duration" && typeof d === "string") v.default = parseDuration(d);
    else if (type === "int" && (typeof d === "number" || typeof d === "bigint")) v.default = narrowInt(d);
    else if (type === "list" && Array.isArray(d)) v.default = d.map((x: unknown) => (typeof x === "bigint" ? narrowInt(x) : x));
    else v.default = d;
  }
  return v;
}

/** Options for checkContract and loadContract. */
export interface ContractCheckOptions {
  /**
   * Validates a `json` variable's parsed value, replacing the built-in check
   * against the variable's JSON Schema (`decl.contract.schema`, with Ajv).
   */
  validateJson?: JsonCheck;
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
 * The raw value of a variable: its entry, or for an `indexed` list its
 * items NAME__0, NAME__1, ... Other suffixes (NAME__HOST) are not items.
 * Items must be numbered from 0 with no gap; otherwise `gap` names the
 * first missing item.
 */
function rawValue(
  v: Pick<ContractVar, "name" | "type" | "listEncoding">,
  env: Readonly<Record<string, string | undefined>>,
): { raw: unknown; gap?: undefined } | { raw?: undefined; gap: string } {
  if (v.type !== "list" || v.listEncoding !== "indexed") return { raw: env[v.name] };
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

/**
 * Validates `env` against a contract and returns every variable's typed
 * value (undefined when absent) and every violation. Variables the
 * contract does not declare are ignored. Messages never contain a secret's
 * value.
 */
export function checkContract(
  contract: ContractDeclaration | unknown,
  env: Readonly<Record<string, string | undefined>>,
  opts: ContractCheckOptions = {},
): { values: Record<string, unknown>; violations: Violation[] } {
  const decl = isDeclaration(contract) ? contract : parseContract(contract);
  const values: Record<string, unknown> = {};
  const violations: Violation[] = [];
  for (const [name, v] of decl.vars) {
    const report = new VarReport(v);
    let value: unknown = undefined;
    const raw = rawValue(v, env);
    if (raw.gap !== undefined) {
      report.add("invalid_type", `indexed items must be numbered from 0 with no gap, but ${raw.gap} is not set`, true);
      values[name] = undefined;
      violations.push(...report.violations);
      continue;
    }
    const pre = precheckVar(v, raw.raw, report);
    if (pre.ok && pre.value === undefined) {
      if (v.default !== undefined) value = v.default;
      else if (v.required) report.add("missing_required", "required, but not set");
    } else if (pre.ok) {
      const r = convertValue(v, pre.value as string | string[], report, opts.validateJson ?? schemaJsonCheck);
      if (r.ok && checkConstraints(v, r.value, report)) value = r.value;
    }
    values[name] = value;
    violations.push(...report.violations);
  }
  return { values, violations };
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
 * Contract-first boot validation: checks the environment against a
 * contract exported as JSON (`cue export ./contract.cue --out json`) and
 * returns the typed values. Throws DocuconfValidationError listing every
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
  const { values, violations } = checkContract(contract, opts.env ?? process.env, opts);
  if (violations.length > 0) failBoot(violations, opts);
  return values as T;
}
