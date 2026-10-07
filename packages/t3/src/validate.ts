import { type ErrorCode, VarReport, type Violation, precheckVar, splitCsv } from "@docuconf/core/pure";
import type { StandardSchemaV1 } from "@t3-oss/env-core";
import type { VarDecl } from "./introspect.ts";
import { issuePath, validateSync } from "./jsonschema.ts";

export { preprocess } from "@docuconf/core/pure";

interface ZodLikeIssue extends StandardSchemaV1.Issue {
  code?: string;
  origin?: string;
  format?: string;
  params?: { docuconfCode?: ErrorCode };
}

/** Maps a validator issue to a stable docuconf code. */
export function issueCode(issue: ZodLikeIssue, decl: Pick<VarDecl, "type">): ErrorCode {
  const own = issue.params?.docuconfCode;
  if (own) return own;
  // Inside a json variable's value, any problem is a schema mismatch.
  if (decl.type === "json" && (issue.path?.length ?? 0) > 0) return "schema_mismatch";
  switch (issue.code) {
    case "too_small":
      return issue.origin === "array" || issue.origin === "set" ? "too_few_items" : "out_of_range";
    case "too_big":
      return issue.origin === "array" || issue.origin === "set" ? "too_many_items" : "out_of_range";
    case "not_multiple_of":
      return "out_of_range";
    case "invalid_format":
      return issue.format === "regex" || issue.format === "starts_with" || issue.format === "ends_with" || issue.format === "includes"
        ? "pattern_mismatch"
        : "invalid_type";
    case "invalid_value":
      return decl.type === "enum" ? "not_in_enum" : "invalid_type";
    default:
      return "invalid_type";
  }
}

/** Validates one variable. Messages never contain a secret's value. */
export function validateVar(decl: VarDecl, raw: unknown): { value: unknown; violations: Violation[] } {
  const report = new VarReport(decl);
  const pre = precheckVar(decl, raw, report);
  if (!pre.ok) return { value: undefined, violations: report.violations };
  const value = pre.value;

  const r = validateSync(decl.schema, value);
  if (r.issues === undefined) return { value: r.value, violations: report.violations };
  if (value === undefined) {
    report.add("missing_required", "required, but not set");
    return { value: undefined, violations: report.violations };
  }
  const got = report.got(value);
  // A list's item issues name the item, and quote it rather than the whole list.
  const items = decl.type === "list" && typeof value === "string" ? splitCsv(value, decl.separator) : undefined;
  for (const issue of r.issues) {
    const first = issue.path?.[0];
    const index = typeof first === "object" && first !== null ? first.key : first;
    if (items && typeof index === "number" && issue.path?.length === 1) {
      report.add(issueCode(issue, decl), `item ${index + 1}: ${issue.message}${report.got(items[index])}`);
      continue;
    }
    const p = issuePath(issue);
    const own = issue.message.startsWith("item ") && items !== undefined;
    report.add(issueCode(issue, decl), `${p ? `${p}: ` : ""}${issue.message}${own ? "" : got}`);
  }
  return { value: undefined, violations: report.violations };
}
