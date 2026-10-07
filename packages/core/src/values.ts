/**
 * Turning one variable's raw environment value into its contract type
 * (SPEC §5). The SDKs' boot validation and the contract-first mode share
 * these checks, so the conformance suite tests the code apps run.
 */
import { DURATION_EXAMPLE, type DurationEncoding, formatDuration, parseDurationAs } from "./duration.ts";
import { type ItemBounds, type VarBase, type VarReport, intItem } from "./vars.ts";
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
 * Lengths, patterns, numeric bounds and item counts are left to the
 * caller's validator.
 */
export function convertValue(
  decl: ValueDecl,
  raw: string | readonly string[],
  report: VarReport,
  validateJson?: JsonCheck,
): { value: unknown; ok: boolean } {
  const fail = (p: Problem, value: unknown = raw) => {
    report.add(p.code, `${p.message}${report.got(value)}`);
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
      return { value: Number(value), ok: true };
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
      return p ? fail(p) : { value, ok: true };
    }
    case "list": {
      const encoding = decl.listEncoding ?? "csv";
      if (encoding === "indexed") return listItems(decl, [value], report);
      if (encoding === "csv") return listItems(decl, value.split(decl.separator ?? ","), report);
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        return fail({ code: "invalid_type", message: "expected a JSON array" });
      }
      if (!Array.isArray(parsed)) return fail({ code: "invalid_type", message: "expected a JSON array" });
      // A JSON list holds typed items: [1, 2], not ["1", "2"].
      return listItems(decl, parsed, report, true);
    }
    case "json": {
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

/** Checks each item's type: strings for a string list, safe integers within the item bounds for an int list. */
function listItems(decl: ValueDecl, items: readonly unknown[], report: VarReport, typed = false): { value: unknown; ok: boolean } {
  if (decl.items !== "int") {
    const bad = items.findIndex((item) => typeof item !== "string");
    if (bad >= 0) {
      report.add("invalid_type", `item ${bad + 1}: expected a string${report.got(items[bad])}`);
      return { value: undefined, ok: false };
    }
    return { value: [...items], ok: true };
  }
  const out: number[] = [];
  for (const [i, item] of items.entries()) {
    const r = typed && typeof item !== "number" ? { code: "invalid_type" as const, message: "expected an integer" } : intItem(item, decl);
    if ("code" in r) {
      report.add(r.code, `item ${i + 1}: ${r.message}${report.got(item)}`);
      return { value: undefined, ok: false };
    }
    out.push(r.value);
  }
  return { value: out, ok: true };
}
