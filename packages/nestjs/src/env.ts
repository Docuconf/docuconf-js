import { validateSync } from "class-validator";
import { type ErrorCode, VarReport, type Violation, parseDuration, precheckVar } from "@docuconf/core";
import { bindAndValidate, flattenErrors, schemaAdapter } from "./classes.ts";
import type { NestVarDecl } from "./declaration.ts";

const URL_SHAPE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s]+$/;
const INT_ITEM = /^[+-]?[0-9]+$/;

/** Maps a class-validator constraint to a stable docuconf code. */
export function codeFor(constraint: string, decl: Pick<NestVarDecl, "type">): ErrorCode {
  switch (constraint) {
    case "isDefined":
      return "missing_required";
    case "min":
    case "max":
    case "isPositive":
    case "isNegative":
    case "minLength":
    case "maxLength":
    case "isLength":
    case "isNotEmpty":
      return "out_of_range";
    case "matches":
    case "contains":
    case "notContains":
      return "pattern_mismatch";
    case "isEnum":
    case "isIn":
      return "not_in_enum";
    case "arrayMinSize":
    case "arrayNotEmpty":
      return "too_few_items";
    case "arrayMaxSize":
      return "too_many_items";
    default:
      return decl.type === "json" ? "schema_mismatch" : "invalid_type";
  }
}

/**
 * Turns one raw value into the property's type, with the checks class-validator
 * cannot make on a string: strict numbers, `true`/`false`, Go durations, URL
 * shape and scheme, list splitting, JSON. `undefined` means unset.
 */
function convert(decl: NestVarDecl, value: string, report: VarReport): { value: unknown; ok: boolean } {
  const got = report.got(value);
  const fail = (code: ErrorCode, message: string) => {
    report.add(code, message);
    return { value: undefined, ok: false };
  };
  switch (decl.type) {
    case "string":
    case "enum":
      return { value, ok: true };
    case "int":
      return { value: Number(value), ok: true };
    case "float": {
      const n = Number(value);
      return Number.isFinite(n) ? { value: n, ok: true } : fail("invalid_type", `expected a finite number${got}`);
    }
    case "bool": {
      const v = value.toLowerCase();
      return v === "true" ? { value: true, ok: true } : v === "false" ? { value: false, ok: true } : fail("invalid_type", `expected true or false${got}`);
    }
    case "duration": {
      const ms = parseDuration(value);
      if (ms === undefined || ms < 0) return fail("invalid_type", `expected a Go duration such as 30s or 1m30s${got}`);
      if (decl.durationMin !== undefined && ms < decl.durationMin) return fail("out_of_range", `must be at least ${decl.contract["min"]}${got}`);
      if (decl.durationMax !== undefined && ms > decl.durationMax) return fail("out_of_range", `must be at most ${decl.contract["max"]}${got}`);
      return { value: ms, ok: true };
    }
    case "url": {
      if (!URL_SHAPE.test(value) || !URL.canParse(value)) return fail("invalid_type", `expected a URL such as https://host/path${got}`);
      const scheme = value.slice(0, value.indexOf(":")).toLowerCase();
      if (decl.schemes && !decl.schemes.includes(scheme)) return fail("invalid_scheme", `scheme must be one of ${decl.schemes.join(", ")}${got}`);
      return { value, ok: true };
    }
    case "list": {
      const items = value.split(decl.separator ?? ",");
      if (decl.items !== "int") return { value: items, ok: true };
      const out: number[] = [];
      for (const [i, item] of items.entries()) {
        if (!INT_ITEM.test(item) || !Number.isSafeInteger(Number(item))) {
          return fail("invalid_type", `item ${i + 1}: expected a base-10 integer${report.got(item)}`);
        }
        out.push(Number(item));
      }
      return { value: out, ok: true };
    }
    case "json": {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        return fail("invalid_type", `expected a JSON value${got}`);
      }
      if (decl.jsonSchema === undefined) return { value: parsed, ok: true };
      const r = typeof decl.jsonSchema === "function" ? bindAndValidate(decl.jsonSchema as never, parsed) : schemaAdapter.validate(decl.jsonSchema, parsed);
      if (r.issues !== undefined) {
        for (const issue of r.issues) report.add("schema_mismatch", `${issue.path || "(root)"}: ${issue.message}`);
        return { value: undefined, ok: false };
      }
      return { value: r.value, ok: true };
    }
  }
}

export interface EnvResult {
  /** Typed values by property. */
  values: Record<string, unknown>;
  violations: Violation[];
}

/**
 * Validates every variable of an environment class against `env` and
 * reports all violations, in declaration order. `instance` is a fresh
 * instance of the class; it receives the typed values and is validated with
 * class-validator.
 */
export function validateEnv(vars: ReadonlyMap<string, NestVarDecl>, env: Record<string, unknown>, instance: Record<string, unknown>): EnvResult {
  const reports = new Map<string, VarReport>();
  const failed = new Set<string>();
  const values: Record<string, unknown> = {};

  for (const [name, decl] of vars) {
    const report = new VarReport(decl);
    reports.set(name, report);
    const pre = precheckVar(decl, env[name], report);
    let value: unknown = undefined;
    if (!pre.ok) failed.add(name);
    else if (typeof pre.value === "string") {
      const r = convert(decl, pre.value, report);
      if (r.ok) value = r.value;
      else failed.add(name);
    } else if (pre.value !== undefined) {
      // A non-string value: the caller passed typed config. Use it as is.
      value = pre.value;
    }
    if (value === undefined && !failed.has(name)) {
      if (decl.default !== undefined) value = decl.default;
      else if (decl.required) {
        report.add("missing_required", "required, but not set");
        failed.add(name);
      }
    }
    values[name] = value;
    instance[name] = value;
  }

  const errors = validateSync(instance, { forbidUnknownValues: false });
  for (const e of errors) {
    const decl = vars.get(e.property);
    if (!decl || failed.has(e.property)) continue;
    const report = reports.get(e.property)!;
    const got = report.got(env[e.property] ?? values[e.property]);
    for (const f of flattenErrors([e])) {
      const nested = f.path !== e.property;
      const code = nested ? (decl.type === "json" ? "schema_mismatch" : codeFor(f.constraint, decl)) : codeFor(f.constraint, decl);
      const where = nested ? `${f.path.slice(e.property.length + 1)}: ` : "";
      report.add(code, `${where}${f.message}${nested ? "" : got}`);
    }
    values[e.property] = undefined;
  }

  const violations: Violation[] = [];
  for (const r of reports.values()) violations.push(...r.violations);
  return { values, violations };
}
