import * as z from "zod";
import type { StandardSchemaV1 } from "@t3-oss/env-core";
import { CONTRACT_DURATION, type ErrorCode, formatDuration, parseDuration } from "@docuconf/core";
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

function issue(code: ErrorCode, message: string, input: unknown) {
  return { code: "custom" as const, message, input, params: { docuconfCode: code } };
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
      const ms = parseDuration(value);
      if (ms === undefined) {
        ctx.addIssue(issue("invalid_type", "expected a Go duration such as 30s or 1m30s", value));
        return z.NEVER;
      }
      if (min !== undefined && ms < min) {
        ctx.addIssue(issue("out_of_range", `must be at least ${meta.min}`, value));
        return z.NEVER;
      }
      if (max !== undefined && ms > max) {
        ctx.addIssue(issue("out_of_range", `must be at most ${meta.max}`, value));
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
    .transform((v) => v.split(separator))
    .pipe(arr as unknown as z.ZodType<z.output<T>[], string[]>) as unknown as z.ZodType<z.output<T>[], string>;
}

export interface UrlOptions {
  /** Accepted schemes, without "://", e.g. ["https"] or ["postgres", "postgresql"]. */
  schemes?: [string, ...string[]];
}

const URL_SHAPE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s]+$/;

/**
 * A URL with a `scheme://` prefix, optionally restricted to `schemes`.
 * The value stays a string. Contract type `url`.
 */
export function url(opts: UrlOptions = {}): z.ZodString {
  const schemes = opts.schemes?.map((s) => s.toLowerCase());
  const meta: DocuconfTypeMeta = { type: "url" };
  if (opts.schemes) meta.schemes = [...opts.schemes];
  return z
    .string()
    .meta(typeMeta(meta))
    .superRefine((value, ctx) => {
      if (!URL_SHAPE.test(value) || !URL.canParse(value)) {
        ctx.addIssue(issue("invalid_type", "expected a URL such as https://host/path", value));
        return;
      }
      if (schemes) {
        const scheme = value.slice(0, value.indexOf(":")).toLowerCase();
        if (!schemes.includes(scheme)) {
          ctx.addIssue(issue("invalid_scheme", `scheme must be one of ${schemes.join(", ")}`, value));
        }
      }
    });
}

/**
 * A structured value in one variable, sent as compact JSON and checked
 * against `schema`. Contract type `json`, with `schema` generated from it.
 */
export function json<T extends z.ZodType>(schema: T): z.ZodType<z.output<T>, string> {
  const meta: DocuconfTypeMeta = { type: "json", schema: contractSchema(schema) };
  return z
    .string()
    .meta(typeMeta(meta))
    .transform((value, ctx) => {
      try {
        return JSON.parse(value) as unknown;
      } catch {
        ctx.addIssue(issue("invalid_type", "expected a JSON value", value));
        return z.NEVER;
      }
    })
    .pipe(schema) as unknown as z.ZodType<z.output<T>, string>;
}
