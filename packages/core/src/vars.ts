import { formatDuration } from "./duration.ts";
import type { ErrorCode, Violation } from "./violations.ts";

export type VarType = "string" | "int" | "float" | "bool" | "duration" | "url" | "enum" | "list" | "json";

/** A variable as the contract describes it. SDKs extend it with what their loader needs. */
export interface VarBase {
  name: string;
  type: VarType;
  secret: boolean;
  required: boolean;
  /** Contract fields in output order (SPEC §11.2 item 3). */
  contract: Record<string, unknown>;
  /** For list variables: the separator used to render the default. */
  separator?: string;
  /**
   * `int` values and int list items hold the full 64-bit range: a `number`
   * within ±Number.MAX_SAFE_INTEGER, a `bigint` beyond it. Contract-first
   * mode sets it; declared variables (a Zod or class-validator `number`) are
   * limited to the safe range.
   */
  int64?: boolean;
}

export const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
const FEATURE_FLAG = /^(FF|FEATURE|FEATURE_FLAG|ENABLE)_/;

/** Name checks every SDK applies (SPEC §4.2, §10). */
export function checkVarName(name: string, problems: string[], warnings: string[]): void {
  if (!ENV_NAME.test(name)) problems.push(`${name}: variable names must match ${ENV_NAME.source}`);
  if (FEATURE_FLAG.test(name)) {
    warnings.push(
      `${name}: looks like a feature flag. Flags that change without a rollout belong in a flag service (OpenFeature), not the environment contract (SPEC §10).`,
    );
  }
  if (name === "NODE_ENV") {
    warnings.push(
      'NODE_ENV: is a framework concern (SPEC §11.1), not service configuration. Test runners set it to "test" and frameworks to "development" or "production"; read process.env.NODE_ENV directly and leave it out of the declaration.',
    );
  }
}

/** The meaning of each code, for messages that cannot say more. */
export const GENERIC: Record<ErrorCode, string> = {
  missing_required: "required, but not set",
  invalid_type: "value does not have the expected type",
  out_of_range: "value is out of range",
  pattern_mismatch: "value does not match the required pattern",
  not_in_enum: "value is not one of the allowed values",
  invalid_scheme: "URL scheme is not allowed",
  too_few_items: "list has too few items",
  too_many_items: "list has too many items",
  file_missing: "file is missing",
  file_unreadable: "file exists but cannot be read",
  file_too_large: "file is too large",
  file_malformed: "file is malformed",
  schema_mismatch: "content does not match the schema",
  certificate_invalid: "certificate is invalid",
  certificate_expiring: "certificate expires too soon",
  certificate_name_mismatch: "certificate does not cover a required name",
  key_mismatch: "private key does not match the certificate",
  keystore_unreadable: "keystore cannot be opened",
};

/**
 * Value prefixes of the references injectors resolve (SPEC §4.5.1):
 * Bank-Vaults (`vault:`), 1Password `op run` (`op://`) and vals (`ref+`).
 */
export const INJECTOR_PREFIXES = ["vault:", "op://", "ref+"] as const;

/**
 * The scheme of an injector reference that was never resolved, such as
 * `vault:` or `ref+awssecrets`, or undefined when `raw` is not one. The
 * scheme is safe to print; the rest of the reference is not.
 */
export function injectorScheme(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  if (raw.startsWith("vault:")) return "vault:";
  if (raw.startsWith("op://")) return "op://";
  if (raw.startsWith("ref+")) {
    const backend = /^ref\+([a-z0-9]{1,32}):\/\//.exec(raw)?.[1];
    return backend ? `ref+${backend}` : "ref+";
  }
  return undefined;
}

/** Collects one variable's violations. For secrets, messages come from the declaration, never from the value. */
export class VarReport {
  readonly violations: Violation[] = [];
  private readonly decl: Pick<VarBase, "name" | "secret"> & Partial<Pick<VarBase, "type" | "contract">>;
  constructor(decl: Pick<VarBase, "name" | "secret"> & Partial<Pick<VarBase, "type" | "contract">>) {
    this.decl = decl;
  }

  /** `safe` marks a message written to never contain the value, so it is kept for secrets too. */
  add(code: ErrorCode, message: string, safe = false): void {
    const shown = this.decl.secret && !safe ? secretMessage(this.decl, code) : message;
    this.violations.push({ input: this.decl.name, kind: "var", code, message: shown });
  }

  /** ` (got "value")` for non-secrets, to help fix the value; nothing for secrets. */
  got(value: unknown): string {
    return this.decl.secret ? "" : ` (got ${jsonText(value)})`;
  }
}

/** JSON.stringify that writes a bigint as its digits. */
export function jsonText(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  return JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
}

const SAFE_LIMIT = Number.MAX_SAFE_INTEGER;
const EXPECTED: Partial<Record<VarType, string>> = {
  int: "expected a base-10 integer",
  float: "expected a decimal number",
  bool: "expected true or false",
  duration: "expected a Go duration such as 30s",
  url: "expected a URL such as scheme://host",
  list: "expected a list",
  json: "expected a JSON value",
};

function range(min: unknown, max: unknown, unit = ""): string | undefined {
  // A bigint bound (contract-first, beyond 2^53) is exact and shown as is.
  const lo = (typeof min === "number" && min > -SAFE_LIMIT) || typeof min === "bigint" || typeof min === "string" ? min : undefined;
  const hi = (typeof max === "number" && max < SAFE_LIMIT) || typeof max === "bigint" || typeof max === "string" ? max : undefined;
  if (lo !== undefined && hi !== undefined) return `must be between ${lo} and ${hi}${unit}`;
  if (lo !== undefined) return `must be at least ${lo}${unit}`;
  if (hi !== undefined) return `must be at most ${hi}${unit}`;
  return undefined;
}

/**
 * What a violation says about a secret: the rule from the declaration (a
 * contract is not secret), never the value or a validator message that may
 * quote it.
 */
export function secretMessage(decl: Partial<Pick<VarBase, "type" | "contract">>, code: ErrorCode): string {
  const c = decl.contract ?? {};
  let rule: string | undefined;
  switch (code) {
    case "missing_required":
      return GENERIC.missing_required;
    case "invalid_type":
      rule = decl.type ? EXPECTED[decl.type] : undefined;
      break;
    case "out_of_range":
      if (decl.type === "string") rule = range(c["minLength"], c["maxLength"], " characters long");
      else if (decl.type === "list") rule = range(c["itemMin"], c["itemMax"])?.replace(/^must/, "each item must");
      else rule = range(c["min"], c["max"]);
      break;
    case "pattern_mismatch":
      if (typeof c["pattern"] === "string") rule = `must match ${c["pattern"]}`;
      break;
    case "not_in_enum":
      if (Array.isArray(c["values"])) rule = `must be one of ${c["values"].join(", ")}`;
      break;
    case "invalid_scheme":
      if (Array.isArray(c["schemes"])) rule = `scheme must be one of ${c["schemes"].join(", ")}`;
      break;
    case "too_few_items":
      if (typeof c["minItems"] === "number") rule = `must have at least ${c["minItems"]} items`;
      break;
    case "too_many_items":
      if (typeof c["maxItems"] === "number") rule = `must have at most ${c["maxItems"]} items`;
      break;
    default:
      break;
  }
  return `${rule ?? GENERIC[code]} (value hidden: secret)`;
}

/** Strict base-10 integer syntax: no spaces, hex, exponent or fraction. */
export const INT_SYNTAX = /^[+-]?[0-9]+$/;
const INT = INT_SYNTAX;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const UNSAFE = `integers beyond ±${MAX_SAFE} are not exact in JavaScript`;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const BEYOND_INT64 = "is beyond the 64-bit integer range";

/**
 * A base-10 integer as an exact value: a `number` within
 * ±Number.MAX_SAFE_INTEGER, a `bigint` beyond it, or undefined beyond the
 * signed 64-bit range. `text` must match INT_SYNTAX.
 */
export function exactInt(text: string): number | bigint | undefined {
  const n = Number(text);
  if (Number.isSafeInteger(n)) return n;
  const b = BigInt(text);
  return b < INT64_MIN || b > INT64_MAX ? undefined : b;
}

/** An exact integer as a `number` when safe, else kept as a `bigint`. */
export function narrowInt(n: number | bigint): number | bigint {
  return typeof n === "bigint" && n >= -MAX_SAFE && n <= MAX_SAFE ? Number(n) : n;
}

/**
 * JSON.parse that keeps every integer literal beyond ±Number.MAX_SAFE_INTEGER
 * exact, as a `bigint` (other numbers are as JSON.parse reads them).
 */
export function parseJsonExact(text: string): unknown {
  return JSON.parse(text, (_key, value: unknown, context?: { source?: string }) => {
    if (typeof value === "number" && !Number.isSafeInteger(value) && context?.source !== undefined && /^-?[0-9]+$/.test(context.source)) {
      return BigInt(context.source);
    }
    return value;
  });
}
const FLOAT = /^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;

/**
 * SPEC §5: empty means unset for every type but string. Values are never
 * trimmed.
 */
export function preprocess(decl: Pick<VarBase, "type">, raw: unknown): unknown {
  if (raw === "" && decl.type !== "string") return undefined;
  return raw;
}

/**
 * The checks every SDK makes on a raw value before its host library sees
 * it: empty means unset, a secret must not hold an unresolved injector
 * reference, and numbers use strict base-10 syntax (host coercion accepts
 * " 42", "0x2A" and "1e3"). Returns the value to hand on, or `ok: false`
 * after reporting a violation.
 */
export function precheckVar(decl: VarBase, raw: unknown, report: VarReport): { value: unknown; ok: boolean } {
  const value = preprocess(decl, raw);
  if (typeof value !== "string") return { value, ok: true };
  if (decl.secret) {
    const scheme = injectorScheme(value);
    if (scheme !== undefined) {
      report.add("invalid_type", `holds an unresolved ${scheme} reference; the injector that should resolve it did not run`, true);
      return { value: undefined, ok: false };
    }
  }
  const got = report.got(value);
  if (decl.type === "int") {
    if (!INT.test(value)) {
      report.add("invalid_type", `expected a base-10 integer${got}`);
      return { value: undefined, ok: false };
    }
    if (decl.int64 ? exactInt(value) === undefined : !Number.isSafeInteger(Number(value))) {
      report.add("out_of_range", `${decl.int64 ? BEYOND_INT64 : UNSAFE}${got}`);
      return { value: undefined, ok: false };
    }
  }
  if (decl.type === "float" && !FLOAT.test(value)) {
    report.add("invalid_type", `expected a decimal number${got}`);
    return { value: undefined, ok: false };
  }
  return { value, ok: true };
}

/** The single string form a value takes in an env entry (SPEC §5). */
export function wireValue(decl: Pick<VarBase, "type" | "separator">, value: unknown): string {
  switch (decl.type) {
    case "list":
      return (value as unknown[]).map(String).join(decl.separator ?? ",");
    case "json":
      return JSON.stringify(value);
    default:
      return String(value);
  }
}

/** A parsed default as the contract writes it, or undefined when it does not fit the type. Durations are milliseconds. */
export function contractDefault(type: VarType, v: unknown): unknown {
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


/** An int list's item bounds (SPEC §4.3 itemMin, itemMax). A `bigint` bound (contract-first) compares exactly. */
export interface ItemBounds {
  itemMin?: number | bigint | undefined;
  itemMax?: number | bigint | undefined;
}

/**
 * Checks one item of an int list: a string in strict base-10 syntax, or a
 * number (from a JSON list), that is a safe integer within the item bounds.
 * With `int64` (contract-first), any signed 64-bit integer: a `bigint` item
 * (from an exactly parsed JSON list) or a string beyond the safe range
 * becomes a `bigint`. Returns the item, or the code and a message that never
 * quotes it.
 */
export function intItem(item: unknown, bounds: ItemBounds, int64 = false): { value: number | bigint } | { code: ErrorCode; message: string } {
  let n: number | bigint | undefined;
  if (typeof item === "string") {
    if (!INT_SYNTAX.test(item)) return { code: "invalid_type", message: "expected a base-10 integer" };
    n = int64 ? exactInt(item) : Number(item);
  } else if (typeof item === "number" && Number.isInteger(item)) {
    n = item;
  } else if (int64 && typeof item === "bigint") {
    n = item < INT64_MIN || item > INT64_MAX ? undefined : narrowInt(item);
  } else {
    return { code: "invalid_type", message: "expected an integer" };
  }
  if (n === undefined) return { code: "out_of_range", message: BEYOND_INT64 };
  if (typeof n === "number" && !Number.isSafeInteger(n)) return { code: "out_of_range", message: UNSAFE };
  if (bounds.itemMin !== undefined && n < bounds.itemMin) return { code: "out_of_range", message: `must be at least ${bounds.itemMin}` };
  if (bounds.itemMax !== undefined && n > bounds.itemMax) return { code: "out_of_range", message: `must be at most ${bounds.itemMax}` };
  return { value: n };
}

/**
 * An int variable's contract bounds, or an int list's item bounds. A
 * JavaScript number is exact only up to 2^53 - 1 (SPEC §5), so the bounds
 * are always exported, capped there. `keys` names them in warnings.
 */
export function intBounds(
  name: string,
  bounds: { min?: number; max?: number; exclusiveMin?: number; exclusiveMax?: number },
  warnings: string[],
  keys: { min: string; max: string } = { min: "min", max: "max" },
): { min: number; max: number } {
  let { min, max } = bounds;
  if (bounds.exclusiveMin !== undefined) min = Math.max(min ?? -Infinity, Math.floor(bounds.exclusiveMin) + 1);
  if (bounds.exclusiveMax !== undefined) max = Math.min(max ?? Infinity, Math.ceil(bounds.exclusiveMax) - 1);
  if (min !== undefined && !Number.isInteger(min)) min = Math.ceil(min);
  if (max !== undefined && !Number.isInteger(max)) max = Math.floor(max);
  if (min === undefined || min < -MAX_SAFE) {
    if (min !== undefined) warnings.push(`${name}: ${keys.min} capped at -Number.MAX_SAFE_INTEGER`);
    min = -MAX_SAFE;
  }
  if (max === undefined || max > MAX_SAFE) {
    if (max !== undefined) warnings.push(`${name}: ${keys.max} capped at Number.MAX_SAFE_INTEGER`);
    max = MAX_SAFE;
  }
  return { min, max };
}

/** Whether a string is a description the contract accepts (at least 5 characters). */
export function validDescription(d: unknown): d is string {
  return typeof d === "string" && [...d].length >= 5;
}

/**
 * The smallest double greater than `x` (`dir` 1) or the largest one below
 * it (`dir` -1). An exclusive float bound, such as Zod's `.positive()`,
 * becomes an exact inclusive one: `> 0` is `>= 5e-324`.
 */
export function nextFloat(x: number, dir: 1 | -1): number {
  if (!Number.isFinite(x)) return x;
  if (x === 0) return dir * Number.MIN_VALUE;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  let bits = view.getBigUint64(0);
  bits += (x > 0) === (dir > 0) ? 1n : -1n;
  view.setBigUint64(0, bits);
  return view.getFloat64(0);
}

function editDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/** Variables every shell or runtime sets; never reported as typos. */
const AMBIENT = new Set([
  "HOME", "HOST", "HOSTNAME", "PATH", "PWD", "OLDPWD", "USER", "LOGNAME", "SHELL", "TERM", "LANG", "TZ", "TMPDIR",
  "NODE_ENV", "NODE_OPTIONS", "NODE_PATH", "PORT", "CI", "COLORTERM", "EDITOR", "PAGER", "SHLVL", "MAIL",
]);

/**
 * Warnings for set variables that are not declared but look like a typo of
 * one that is, such as `DATABSE_URL` for `DATABASE_URL`: within edit
 * distance 2 (1 for names of 5 characters or fewer, where 2 is too loose).
 * Only names are compared; values are never printed.
 */
export function typoWarnings(declared: Iterable<string>, env: Readonly<Record<string, unknown>>): string[] {
  const names = [...declared];
  const known = new Set(names);
  const out: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || known.has(key) || AMBIENT.has(key) || !ENV_NAME.test(key)) continue;
    if (key.startsWith("DOCUCONF_") || key.startsWith("npm_")) continue;
    let best: string | undefined;
    let bestD = Infinity;
    for (const name of names) {
      const limit = Math.min(name.length, key.length) <= 5 ? 1 : 2;
      const d = editDistance(key, name, limit);
      // An indexed list item (NAME__0) is not a typo of NAME.
      if (d <= limit && d < bestD && !key.startsWith(`${name}__`)) {
        best = name;
        bestD = d;
      }
    }
    if (best !== undefined) out.push(`${key} is set but not declared; did you mean ${best}?`);
  }
  return out.sort();
}
