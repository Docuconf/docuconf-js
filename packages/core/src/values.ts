/**
 * Turning one variable's raw environment value into its contract type
 * (SPEC §5). The SDKs' boot validation and the contract-first mode share
 * these checks, so the conformance suite tests the code apps run.
 */
import { DURATION_EXAMPLE, type DurationEncoding, formatDuration, parseDurationAs } from "./duration.ts";
import { type ItemBounds, type VarBase, type VarReport, exactInt, intItem, parseJsonExact } from "./vars.ts";
import type { ErrorCode } from "./violations.ts";

/** How a list is written in the environment (SPEC §5). */
export type ListEncoding = "csv" | "json" | "indexed";

export const LIST_ENCODINGS: readonly ListEncoding[] = ["csv", "json", "indexed"];

/** What convertValue needs to know about a variable, beyond VarBase. */
export interface ValueDecl extends VarBase, ItemBounds {
  /** Duration bounds, in milliseconds. */
  durationMin?: number | undefined;
  durationMax?: number | undefined;
  /** Duration encoding. Default `go`. */
  durationEncoding?: DurationEncoding | undefined;
  /** Accepted URL schemes, lowercase. */
  schemes?: readonly string[] | undefined;
  /** List item type. Default `string`. */
  items?: "string" | "int" | undefined;
  /** List encoding. Default `csv`. */
  listEncoding?: ListEncoding | undefined;
  /**
   * For `url` and `json`: the longest accepted value, in characters (code
   * points). A `json` value is measured as received, before parsing.
   */
  maxLength?: number | undefined;
  /** For a string list: each item's length bounds, in characters (code points). */
  itemMinLength?: number | undefined;
  itemMaxLength?: number | undefined;
}

/** A problem with a value: its code and a message that never quotes the value. */
export interface Problem {
  code: ErrorCode;
  message: string;
}

/** Validates a parsed `json` value, such as against the variable's JSON Schema. */
export type JsonCheck = (
  decl: ValueDecl,
  value: unknown,
) => { value: unknown; issues?: undefined } | { issues: ReadonlyArray<{ path: string; message: string }> };

const URL_SHAPE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s]+$/;

/** A `url` value's problem: no `scheme://` shape, or a scheme not in `schemes` (lowercase). */
export function urlProblem(value: string, schemes: readonly string[] | undefined): Problem | undefined {
  if (!URL_SHAPE.test(value) || !URL.canParse(value)) return { code: "invalid_type", message: "expected a URL such as https://host/path" };
  const scheme = value.slice(0, value.indexOf(":")).toLowerCase();
  if (schemes && !schemes.includes(scheme)) return { code: "invalid_scheme", message: `scheme must be one of ${schemes.join(", ")}` };
  return undefined;
}

/** A string's length in characters: Unicode code points, never UTF-16 units (SPEC §4.3). */
export function charLength(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/**
 * A `url` or `json` value longer than `maxLength` characters. The message
 * gives the length, never the value, so it is safe for secrets.
 */
export function maxLengthProblem(value: string, maxLength: number | undefined): Problem | undefined {
  if (maxLength === undefined) return undefined;
  const n = charLength(value);
  return n > maxLength ? { code: "out_of_range", message: `is ${n} characters, above maxLength ${maxLength}` } : undefined;
}

/** A string list item outside its length bounds, in characters. The message never quotes the item. */
export function itemLengthProblem(item: string, bounds: { itemMinLength?: number | undefined; itemMaxLength?: number | undefined }): Problem | undefined {
  const n = charLength(item);
  if (bounds.itemMinLength !== undefined && n < bounds.itemMinLength) {
    return { code: "out_of_range", message: `is ${n} characters, below itemMinLength ${bounds.itemMinLength}` };
  }
  if (bounds.itemMaxLength !== undefined && n > bounds.itemMaxLength) {
    return { code: "out_of_range", message: `is ${n} characters, above itemMaxLength ${bounds.itemMaxLength}` };
  }
  return undefined;
}

/**
 * Declaration checks for item length bounds: non-negative integers, only
 * on a string list, min not above max. Returns the problems.
 */
export function itemLengthDeclProblems(
  items: "string" | "int",
  bounds: { itemMinLength?: number | undefined; itemMaxLength?: number | undefined },
): string[] {
  const out: string[] = [];
  const { itemMinLength: min, itemMaxLength: max } = bounds;
  for (const [k, v] of [["itemMinLength", min], ["itemMaxLength", max]] as const) {
    if (v !== undefined && !(Number.isInteger(v) && v >= 0)) out.push(`${k} must be a non-negative integer`);
  }
  if ((min !== undefined || max !== undefined) && items !== "string") out.push("itemMinLength and itemMaxLength apply to string items only");
  if (min !== undefined && max !== undefined && min > max) out.push(`itemMinLength ${min} is above itemMaxLength ${max}`);
  return out;
}

/** A duration outside its bounds (milliseconds). */
export function durationProblem(ms: number, min: number | undefined, max: number | undefined): Problem | undefined {
  if (min !== undefined && ms < min) return { code: "out_of_range", message: `must be at least ${formatDuration(min)}` };
  if (max !== undefined && ms > max) return { code: "out_of_range", message: `must be at most ${formatDuration(max)}` };
  return undefined;
}

/**
 * Turns one raw value, after precheckVar, into the variable's type: strict
 * numbers, `true`/`false` in any case, durations in their encoding, URL
 * shape and scheme, lists in their encoding with int items checked, JSON.
 * An `indexed` list arrives as its items (`NAME__0`, `NAME__1`, ...).
 * Reports a problem and returns `ok: false` when the value does not fit.
 * maxLength on a url or json value and item lengths on a string list are
 * checked here; a string's lengths and pattern, numeric bounds and item
 * counts are left to the caller's validator.
 */
export function convertValue(
  decl: ValueDecl,
  raw: string | readonly string[],
  report: VarReport,
  validateJson?: JsonCheck,
): { value: unknown; ok: boolean } {
  // `safe`: the message gives a length, never the value, so a secret keeps it (SPEC §11.2 item 5).
  const fail = (p: Problem, value: unknown = raw, safe = false) => {
    report.add(p.code, `${p.message}${report.got(value)}`, safe);
    return { value: undefined, ok: false };
  };
  if (typeof raw !== "string") {
    if (decl.type !== "list") return fail({ code: "invalid_type", message: "expected a single value" }, undefined);
    return listItems(decl, [...raw], report);
  }
  const value = raw;
  switch (decl.type) {
    case "string":
    case "enum":
      return { value, ok: true };
    case "int":
      // precheckVar has checked the syntax and range; with int64, a bigint beyond 2^53.
      return { value: decl.int64 ? exactInt(value) : Number(value), ok: true };
    case "float": {
      const n = Number(value);
      return Number.isFinite(n) ? { value: n, ok: true } : fail({ code: "invalid_type", message: "expected a finite number" });
    }
    case "bool": {
      const v = value.toLowerCase();
      if (v === "true") return { value: true, ok: true };
      if (v === "false") return { value: false, ok: true };
      return fail({ code: "invalid_type", message: "expected true or false" });
    }
    case "duration": {
      const encoding = decl.durationEncoding ?? "go";
      const ms = parseDurationAs(value, encoding);
      if (ms === undefined || ms < 0) return fail({ code: "invalid_type", message: `expected ${DURATION_EXAMPLE[encoding]}` });
      const p = durationProblem(ms, decl.durationMin, decl.durationMax);
      return p ? fail(p) : { value: ms, ok: true };
    }
    case "url": {
      const p = urlProblem(value, decl.schemes);
      if (p) return fail(p);
      const long = maxLengthProblem(value, decl.maxLength);
      return long ? fail(long, raw, true) : { value, ok: true };
    }
    case "list": {
      const encoding = decl.listEncoding ?? "csv";
      if (encoding === "indexed") return listItems(decl, [value], report);
      if (encoding === "csv") return listItems(decl, splitCsv(value, decl.separator), report);
      let parsed: unknown;
      try {
        // With int64, items beyond 2^53 parse exactly, as bigints.
        parsed = decl.int64 && decl.items === "int" ? parseJsonExact(value) : JSON.parse(value);
      } catch {
        return fail({ code: "invalid_type", message: "expected a JSON array" });
      }
      if (!Array.isArray(parsed)) return fail({ code: "invalid_type", message: "expected a JSON array" });
      // A JSON list holds typed items: [1, 2], not ["1", "2"].
      return listItems(decl, parsed, report, true);
    }
    case "json": {
      // Measured as received, whitespace included, before parsing (SPEC §4.3).
      const long = maxLengthProblem(value, decl.maxLength);
      if (long) return fail(long, raw, true);
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        return fail({ code: "invalid_type", message: "expected a JSON value" });
      }
      if (!validateJson) return { value: parsed, ok: true };
      const r = validateJson(decl, parsed);
      if (r.issues !== undefined) {
        for (const issue of r.issues) report.add("schema_mismatch", `${issue.path || "(root)"}: ${issue.message}`);
        return { value: undefined, ok: false };
      }
      return { value: r.value, ok: true };
    }
  }
}

/**
 * Splits a `csv` list. Whitespace around separators is dropped
 * (`"a.com, b.com"` is two clean items), as SPEC §5 allows: the platform
 * never renders it, but people writing env files do.
 */
export function splitCsv(value: string, separator = ","): string[] {
  return value.split(separator).map((item) => (separator.trim() === "" ? item : item.trim()));
}

/**
 * Checks each item's type: strings for a string list, safe integers within
 * the item bounds for an int list. Reports every bad item, quoting the item
 * (never the whole list).
 */
function listItems(decl: ValueDecl, items: readonly unknown[], report: VarReport, typed = false): { value: unknown; ok: boolean } {
  let ok = true;
  if (decl.items !== "int") {
    for (const [i, item] of items.entries()) {
      if (typeof item === "string") continue;
      report.add("invalid_type", `item ${i + 1}: expected a string${report.got(item)}`);
      ok = false;
    }
    if (!ok) return { value: undefined, ok: false };
    for (const [i, item] of (items as readonly string[]).entries()) {
      const p = itemLengthProblem(item, decl);
      if (p) {
        report.add(p.code, `item ${i + 1} ${p.message}${report.got(item)}`, true);
        ok = false;
      }
    }
    return ok ? { value: [...items], ok: true } : { value: undefined, ok: false };
  }
  const out: Array<number | bigint> = [];
  for (const [i, item] of items.entries()) {
    const numeric = typeof item === "number" || (decl.int64 === true && typeof item === "bigint");
    const r = typed && !numeric ? { code: "invalid_type" as const, message: "expected an integer" } : intItem(item, decl, decl.int64);
    if ("code" in r) {
      report.add(r.code, `item ${i + 1}: ${r.message}${report.got(item)}`);
      ok = false;
    } else out.push(r.value);
  }
  return ok ? { value: out, ok: true } : { value: undefined, ok: false };
}
