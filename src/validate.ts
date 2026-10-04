import type { StandardSchemaV1 } from "@t3-oss/env-core";
import { type VarDecl, validateSync } from "./introspect.ts";
import type { ErrorCode, Violation } from "./violations.ts";

const INT = /^[+-]?[0-9]+$/;
const FLOAT = /^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;

const GENERIC: Record<ErrorCode, string> = {
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

function pathOf(issue: StandardSchemaV1.Issue): string {
  if (!issue.path || issue.path.length === 0) return "";
  return issue.path.map((p) => String(typeof p === "object" && p !== null ? p.key : p)).join(".");
}

/**
 * Normalises a raw environment value before the host validator sees it
 * (SPEC §5): empty means unset for every type but string. Values are never
 * trimmed.
 */
export function preprocess(decl: Pick<VarDecl, "type">, raw: unknown): unknown {
  if (raw === "" && decl.type !== "string") return undefined;
  return raw;
}

/** Validates one variable. Messages never contain a secret's value. */
export function validateVar(decl: VarDecl, raw: unknown): { value: unknown; violations: Violation[] } {
  const value = preprocess(decl, raw);
  const violations: Violation[] = [];
  const add = (code: ErrorCode, message: string) =>
    violations.push({ input: decl.name, kind: "var", code, message: decl.secret ? GENERIC[code] : message });
  const shown = decl.secret ? "" : ` (got ${JSON.stringify(value)})`;

  // Strict number syntax: host coercion accepts " 42", "0x2A" and "1e3".
  if (typeof value === "string") {
    if (decl.type === "int") {
      if (!INT.test(value)) {
        add("invalid_type", `expected a base-10 integer${shown}`);
        return { value: undefined, violations };
      }
      if (!Number.isSafeInteger(Number(value))) {
        add("out_of_range", `integers beyond ±${Number.MAX_SAFE_INTEGER} are not exact in JavaScript${shown}`);
        return { value: undefined, violations };
      }
    }
    if (decl.type === "float" && !FLOAT.test(value)) {
      add("invalid_type", `expected a decimal number${shown}`);
      return { value: undefined, violations };
    }
  }

  const r = validateSync(decl.schema, value);
  if (r.issues === undefined) return { value: r.value, violations };
  if (value === undefined) {
    add("missing_required", "required, but not set");
    return { value: undefined, violations };
  }
  for (const issue of r.issues) {
    const p = pathOf(issue);
    add(issueCode(issue, decl), `${p ? `${p}: ` : ""}${issue.message}${shown}`);
  }
  return { value: undefined, violations };
}
