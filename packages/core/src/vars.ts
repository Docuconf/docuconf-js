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
}

/** What a violation says about a secret: the code's meaning, never the value or a validator message that may quote it. */
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

/** Collects one variable's violations, replacing messages with GENERIC ones for secrets. */
export class VarReport {
  readonly violations: Violation[] = [];
  private readonly decl: Pick<VarBase, "name" | "secret">;
  constructor(decl: Pick<VarBase, "name" | "secret">) {
    this.decl = decl;
  }

  /** `safe` marks a message written to never contain the value, so it is kept for secrets too. */
  add(code: ErrorCode, message: string, safe = false): void {
    const shown = this.decl.secret && !safe ? GENERIC[code] : message;
    this.violations.push({ input: this.decl.name, kind: "var", code, message: shown });
  }

  /** ` (got "value")` for non-secrets, to help fix the value; nothing for secrets. */
  got(value: unknown): string {
    return this.decl.secret ? "" : ` (got ${JSON.stringify(value)})`;
  }
}

const INT = /^[+-]?[0-9]+$/;
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
    if (!Number.isSafeInteger(Number(value))) {
      report.add("out_of_range", `integers beyond ±${Number.MAX_SAFE_INTEGER} are not exact in JavaScript${got}`);
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

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/**
 * An int variable's contract bounds. A JavaScript number is exact only up
 * to 2^53 - 1 (SPEC §5), so the bounds are always exported, capped there.
 */
export function intBounds(
  name: string,
  bounds: { min?: number; max?: number; exclusiveMin?: number; exclusiveMax?: number },
  warnings: string[],
): { min: number; max: number } {
  let { min, max } = bounds;
  if (bounds.exclusiveMin !== undefined) min = Math.max(min ?? -Infinity, Math.floor(bounds.exclusiveMin) + 1);
  if (bounds.exclusiveMax !== undefined) max = Math.min(max ?? Infinity, Math.ceil(bounds.exclusiveMax) - 1);
  if (min !== undefined && !Number.isInteger(min)) min = Math.ceil(min);
  if (max !== undefined && !Number.isInteger(max)) max = Math.floor(max);
  if (min === undefined || min < -MAX_SAFE) {
    if (min !== undefined) warnings.push(`${name}: min capped at -Number.MAX_SAFE_INTEGER`);
    min = -MAX_SAFE;
  }
  if (max === undefined || max > MAX_SAFE) {
    if (max !== undefined) warnings.push(`${name}: max capped at Number.MAX_SAFE_INTEGER`);
    max = MAX_SAFE;
  }
  return { min, max };
}

/** Whether a string is a description the contract accepts (at least 5 characters). */
export function validDescription(d: unknown): d is string {
  return typeof d === "string" && [...d].length >= 5;
}
