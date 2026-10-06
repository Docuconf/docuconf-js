import { validateSync } from "class-validator";
import { type ErrorCode, type JsonCheck, VarReport, type Violation, convertValue, precheckVar } from "@docuconf/core";
import { bindAndValidate, flattenErrors, schemaAdapter } from "./classes.ts";
import type { NestVarDecl } from "./declaration.ts";


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

/** A `@Json` variable's value, bound to and validated with its class or schema. */
const validateJson: JsonCheck = (decl, parsed) => {
  const schema = (decl as NestVarDecl).jsonSchema;
  if (schema === undefined) return { value: parsed };
  return typeof schema === "function" ? bindAndValidate(schema as never, parsed) : schemaAdapter.validate(schema, parsed);
};

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
      const r = convertValue(decl, pre.value, report, validateJson);
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
