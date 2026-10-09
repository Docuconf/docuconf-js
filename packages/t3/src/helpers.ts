import * as z from "zod";
import type { StandardSchemaV1 } from "@t3-oss/env-core";
import {
  CONTRACT_DURATION,
  DURATION_EXAMPLE,
  INT_SYNTAX,
  exactInt,
  narrowInt,
  type ErrorCode,
  KeySet,
  type KeySetBounds,
  keySetDeclProblems,
  keySetProblems,
  durationProblem,
  formatDuration,
  intItem,
  itemLengthDeclProblems,
  itemLengthProblem,
  maxLengthProblem,
  parseDuration,
  splitCsv,
  urlProblem,
} from "@docuconf/core/pure";
import { contractSchema, jsonSchemaOf } from "./jsonschema.ts";
import {
  ANNOTATIONS_KEY,
  type Annotations,
  type DocuconfTypeMeta,
  SECRET_KEY,
  TYPE_KEY,
  annotatedSchemas,
  hasMeta,
  secretSchemas,
} from "./meta.ts";

function typeMeta(m: DocuconfTypeMeta): Record<string, unknown> {
  return { [TYPE_KEY]: m };
}

/** A custom issue with its docuconf code. `safe`: the message never holds the value, so it is kept for secrets. */
function issue(code: ErrorCode, message: string, input: unknown, safe = false) {
  return { code: "custom" as const, message, input, params: { docuconfCode: code, ...(safe ? { docuconfSafe: true } : {}) } };
}

function requireMaxLength(fn: string, maxLength: number | undefined): void {
  if (maxLength !== undefined && !(Number.isInteger(maxLength) && maxLength >= 0)) {
    throw new TypeError(`${fn}: maxLength must be a non-negative integer`);
  }
}

/**
 * Marks a variable as secret. The platform must supply it from a Secret
 * (SPEC §6), it can have no default or examples, and its value is never
 * printed in errors.
 *
 * ```ts
 * DATABASE_URL: secret(url({ schemes: ["postgres"] })).describe("Primary database"),
 * ```
 */
export function secret<T extends StandardSchemaV1>(schema: T): T {
  if (hasMeta(schema)) return schema.meta({ [SECRET_KEY]: true }) as T;
  secretSchemas.add(schema);
  return schema;
}

/**
 * Adds documentation metadata that has no Zod equivalent: `group`,
 * `examples`, `configKey` and `deprecated` (SPEC §4.2).
 */
export function annotate<T extends StandardSchemaV1>(schema: T, annotations: Annotations): T {
  if (hasMeta(schema)) return schema.meta({ [ANNOTATIONS_KEY]: annotations }) as T;
  annotatedSchemas.set(schema, annotations);
  return schema;
}

export interface DurationOptions {
  /** Smallest accepted duration, Go syntax ("1s"). */
  min?: string;
  /** Largest accepted duration, Go syntax ("5m"). */
  max?: string;
  /** Default, Go syntax ("30s"). Applied before parsing (Zod `prefault`). */
  default?: string;
}

function requireDuration(label: string, value: string): number {
  const ms = parseDuration(value);
  if (ms === undefined || ms < 0) throw new TypeError(`duration(): ${label} "${value}" is not a Go duration such as "30s"`);
  return ms;
}

/**
 * A Go-syntax duration ("30s", "1m30s", "250ms"), parsed to milliseconds.
 * Contract type `duration` with encoding `go`.
 */
export function duration(opts?: Omit<DurationOptions, "default">): z.ZodType<number, string>;
export function duration(opts: DurationOptions & { default: string }): z.ZodType<number, string | undefined>;
export function duration(opts: DurationOptions = {}): z.ZodType<number, string | undefined> {
  const min = opts.min === undefined ? undefined : requireDuration("min", opts.min);
  const max = opts.max === undefined ? undefined : requireDuration("max", opts.max);
  const meta: DocuconfTypeMeta = { type: "duration", encoding: "go" };
  if (min !== undefined) meta.min = formatDuration(min);
  if (max !== undefined) meta.max = formatDuration(max);
  const schema = z
    .string()
    .meta(typeMeta(meta))
    .transform((value, ctx) => {
      // Go's grammar, sign included (SPEC §5); min bounds a negative value.
      const ms = parseDuration(value);
      if (ms === undefined) {
        ctx.addIssue(issue("invalid_type", `expected ${DURATION_EXAMPLE.go}`, value));
        return z.NEVER;
      }
      const p = durationProblem(ms, min, max);
      if (p) {
        ctx.addIssue(issue(p.code, p.message, value));
        return z.NEVER;
      }
      return ms;
    });
  if (opts.default !== undefined) {
    if (!CONTRACT_DURATION.test(opts.default) && parseDuration(opts.default) === undefined) {
      throw new TypeError(`duration(): default "${opts.default}" is not a Go duration`);
    }
    return schema.prefault(opts.default);
  }
  return schema;
}

export interface ListOptions {
  /** Separator between items. Default ",". */
  separator?: string;
  minItems?: number;
  maxItems?: number;
  /** Shortest accepted item of a string list, in characters (code points). */
  itemMinLength?: number;
  /** Longest accepted item of a string list, in characters (code points), such as a fixed-width field's size. */
  itemMaxLength?: number;
}

/**
 * A list in one variable, split on `separator` (contract encoding `csv`).
 * Items must be strings or integers:
 *
 * ```ts
 * ALLOWED_ORIGINS: list(z.url(), { minItems: 1 }).describe("CORS origins"),
 * WORKER_PORTS: list(z.coerce.number().int()).describe("Ports workers bind"),
 * ```
 */
export function list<T extends z.ZodType>(item: T, opts: ListOptions = {}): z.ZodType<z.output<T>[], string> {
  const separator = opts.separator ?? ",";
  if (separator === "") throw new TypeError("list(): separator must not be empty");
  const itemJs = jsonSchemaOf(item, "input") ?? {};
  const outJs = jsonSchemaOf(item, "output") ?? {};
  const items = itemJs["type"] === "integer" || outJs["type"] === "integer" ? "int" : itemJs["type"] === "string" ? "string" : undefined;
  if (items === undefined) {
    throw new TypeError("list(): items must be strings or integers (for example z.string() or z.coerce.number().int())");
  }
  const meta: DocuconfTypeMeta = { type: "list", items, encoding: "csv", separator };
  const lengths = { itemMinLength: opts.itemMinLength, itemMaxLength: opts.itemMaxLength };
  const lengthProblems = itemLengthDeclProblems(items, lengths);
  if (lengthProblems.length > 0) throw new TypeError(`list(): ${lengthProblems.join("; ")}`);
  if (lengths.itemMinLength !== undefined) meta.itemMinLength = lengths.itemMinLength;
  if (lengths.itemMaxLength !== undefined) meta.itemMaxLength = lengths.itemMaxLength;
  if (items === "int") {
    // The item type's range, such as z.int32() or .min(0), becomes itemMin
    // and itemMax (SPEC §4.3); the exporter caps them at safe integers.
    const js = outJs["type"] === "integer" ? outJs : itemJs;
    const n = (k: string) => (typeof js[k] === "number" && Number.isFinite(js[k]) ? (js[k] as number) : undefined);
    meta.itemBounds = { min: n("minimum"), max: n("maximum"), exclusiveMin: n("exclusiveMinimum"), exclusiveMax: n("exclusiveMaximum") };
  }
  let arr = z.array(item);
  if (opts.minItems !== undefined) {
    meta.minItems = opts.minItems;
    arr = arr.min(opts.minItems);
  }
  if (opts.maxItems !== undefined) {
    meta.maxItems = opts.maxItems;
    arr = arr.max(opts.maxItems);
  }
  return z
    .string()
    .meta(typeMeta(meta))
    .transform((v, ctx) => {
      // Whitespace around separators is dropped, as SPEC §5 allows.
      const parts = splitCsv(v, separator);
      if (items === "int") {
        // Strict base-10 items: z.coerce.number() alone takes " 5", "0x5" and "5e0".
        let bad = false;
        for (const [i, part] of parts.entries()) {
          const r = intItem(part, {});
          if ("code" in r && r.code === "invalid_type") {
            ctx.addIssue({ ...issue("invalid_type", r.message, part), path: [i] });
            bad = true;
          }
        }
        if (bad) return z.NEVER;
      } else {
        // Lengths in code points (SPEC §4.3); Zod's .min()/.max() count UTF-16 units.
        let bad = false;
        for (const [i, part] of parts.entries()) {
          const p = itemLengthProblem(part, lengths);
          if (p) {
            ctx.addIssue(issue(p.code, `item ${i + 1} ${p.message}`, v));
            bad = true;
          }
        }
        if (bad) return z.NEVER;
      }
      return parts;
    })
    .pipe(arr as unknown as z.ZodType<z.output<T>[], string[]>) as unknown as z.ZodType<z.output<T>[], string>;
}

export interface Int64Options {
  /** Smallest accepted value. A bigint beyond 2^53 is exact. */
  min?: number | bigint;
  /** Largest accepted value. A bigint beyond 2^53 is exact. */
  max?: number | bigint;
}

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/**
 * A signed 64-bit integer (contract type `int`), exact over its whole
 * range: a `number` within ±Number.MAX_SAFE_INTEGER and a `bigint` beyond
 * it. `z.coerce.number().int()` holds only the safe range, so its contract
 * says so with `min` and `max`; an int64() is bounded only by its own
 * `min` and `max`. It reads an environment value in strict decimal syntax
 * (SPEC §5), and, inside a `json` value or a config file, an integer number
 * or bigint (TOML's, beyond 2^53). Its JSON Schema is `{"type": "integer"}`
 * with those bounds.
 *
 * ```ts
 * OFFSET: int64({ min: 0 }).optional().describe("Starting offset in the event log"),
 * ```
 */
export function int64(opts: Int64Options = {}): z.ZodType<number | bigint, string | number | bigint> {
  const bound = (k: "min" | "max") => {
    const v = opts[k];
    if (v === undefined) return undefined;
    const b = typeof v === "bigint" ? v : Number.isSafeInteger(v) ? BigInt(v) : undefined;
    if (b === undefined || b < INT64_MIN || b > INT64_MAX) throw new TypeError(`int64(): ${k} must be a 64-bit integer`);
    return narrowInt(b);
  };
  const min = bound("min");
  const max = bound("max");
  if (min !== undefined && max !== undefined && min > max) throw new TypeError(`int64(): min ${min} is above max ${max}`);
  const meta: DocuconfTypeMeta = { type: "int", int64: true };
  const js: Record<string, unknown> = { type: "integer" };
  // The JSON Schema bound is a JSON number (inexact beyond 2^53); the contract's is exact.
  if (min !== undefined) {
    js["minimum"] = Number(min);
    meta.min = String(min);
  }
  if (max !== undefined) {
    js["maximum"] = Number(max);
    meta.max = String(max);
  }
  return z
    .any()
    .transform((x: unknown, ctx) => {
      let n: number | bigint | undefined;
      if (typeof x === "string") {
        if (!INT_SYNTAX.test(x)) {
          ctx.addIssue(issue("invalid_type", "expected a base-10 integer", x));
          return z.NEVER;
        }
        n = exactInt(x);
      } else if (typeof x === "number" && Number.isInteger(x)) {
        n = Number.isSafeInteger(x) ? x : undefined;
      } else if (typeof x === "bigint") {
        n = x < INT64_MIN || x > INT64_MAX ? undefined : narrowInt(x);
      } else {
        ctx.addIssue(issue("invalid_type", "expected an integer", x));
        return z.NEVER;
      }
      if (n === undefined) {
        ctx.addIssue(issue("out_of_range", "is beyond the 64-bit integer range, or not exact", x));
        return z.NEVER;
      }
      if (min !== undefined && n < min) ctx.addIssue(issue("out_of_range", `must be at least ${min}`, x));
      else if (max !== undefined && n > max) ctx.addIssue(issue("out_of_range", `must be at most ${max}`, x));
      else return n;
      return z.NEVER;
    })
    .meta({ ...js, ...typeMeta(meta) }) as unknown as z.ZodType<number | bigint, string | number | bigint>;
}

export interface KeySetOptions extends KeySetBounds {
  /** Separator between keys. Default ",". */
  separator?: string;
}

/**
 * A key set (SPEC §4.3): secret keys that are all valid at once, so one can
 * be rotated without an outage, such as the keys that verify webhook
 * signatures. Always secret. The platform supplies it as one Secret value,
 * `old,new` while rotating. `minKeys` defaults to 1 and `maxKeys` to 2;
 * `keyMinLength` and `keyMaxLength` bound each key, in characters. Keys are
 * never trimmed, and an empty key (a stray separator) always fails. The
 * value is a KeySet: `keys()`, a constant-time `contains(candidate)`, and
 * `verify(check)` for an HMAC.
 *
 * ```ts
 * WEBHOOK_KEYS: keySet({ keyMinLength: 32, keyMaxLength: 256 }).describe("Keys that verify webhook signatures"),
 * ```
 */
export function keySet(opts: KeySetOptions = {}): z.ZodType<KeySet, string> {
  const separator = opts.separator ?? ",";
  if (separator === "") throw new TypeError("keySet(): separator must not be empty");
  const problems = keySetDeclProblems(opts);
  if (problems.length > 0) throw new TypeError(`keySet(): ${problems.join("; ")}`);
  const meta: DocuconfTypeMeta = { type: "keySet", encoding: "csv", separator };
  for (const k of ["minKeys", "maxKeys", "keyMinLength", "keyMaxLength"] as const) if (opts[k] !== undefined) meta[k] = opts[k];
  return z
    .string()
    .meta({ ...typeMeta(meta), [SECRET_KEY]: true })
    .transform((value, ctx) => {
      // Never trimmed (SPEC §5): "a,,b" holds an empty key.
      const keys = splitCsv(value, separator);
      const bad = keySetProblems(keys, opts);
      for (const p of bad) ctx.addIssue(issue(p.code, p.message, "", true));
      return bad.length > 0 ? z.NEVER : new KeySet(keys);
    }) as unknown as z.ZodType<KeySet, string>;
}

export interface UrlOptions {
  /** Accepted schemes, without "://", e.g. ["https"] or ["postgres", "postgresql"]. */
  schemes?: [string, ...string[]];
  /** Longest accepted URL, in characters (code points). */
  maxLength?: number;
}

/**
 * A URL with a `scheme://` prefix, optionally restricted to `schemes` and
 * bounded by `maxLength`. The value stays a string. Contract type `url`.
 */
export function url(opts: UrlOptions = {}): z.ZodString {
  requireMaxLength("url()", opts.maxLength);
  const schemes = opts.schemes?.map((s) => s.toLowerCase());
  const meta: DocuconfTypeMeta = { type: "url" };
  if (opts.schemes) meta.schemes = [...opts.schemes];
  if (opts.maxLength !== undefined) meta.maxLength = opts.maxLength;
  return z
    .string()
    .meta(typeMeta(meta))
    .superRefine((value, ctx) => {
      const p = urlProblem(value, schemes) ?? maxLengthProblem(value, opts.maxLength);
      if (p) ctx.addIssue(issue(p.code, p.message, value));
    });
}

export interface JsonOptions {
  /** Longest accepted value as received, in characters (code points), whitespace included. */
  maxLength?: number;
}

/**
 * A structured value in one variable, sent as compact JSON and checked
 * against `schema`. Contract type `json`, with `schema` generated from it.
 * `maxLength` bounds the value as the app receives it, before parsing.
 */
export function json<T extends z.ZodType>(schema: T, opts: JsonOptions = {}): z.ZodType<z.output<T>, string> {
  requireMaxLength("json()", opts.maxLength);
  const meta: DocuconfTypeMeta = { type: "json", schema: contractSchema(schema) };
  if (opts.maxLength !== undefined) meta.maxLength = opts.maxLength;
  return z
    .string()
    .meta(typeMeta(meta))
    .transform((value, ctx) => {
      const long = maxLengthProblem(value, opts.maxLength);
      if (long) {
        ctx.addIssue(issue(long.code, long.message, value));
        return z.NEVER;
      }
      try {
        return JSON.parse(value) as unknown;
      } catch {
        ctx.addIssue(issue("invalid_type", "expected a JSON value", value));
        return z.NEVER;
      }
    })
    .pipe(schema) as unknown as z.ZodType<z.output<T>, string>;
}
