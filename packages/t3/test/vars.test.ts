import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  DocuconfValidationError,
  type ErrorCode,
  createEnv,
  getDeclaration,
  duration,
  json,
  list,
  secret,
  url,
} from "../src/index.ts";

const server = {
  DATABASE_URL: secret(url({ schemes: ["postgres", "postgresql"] })).describe("Primary Postgres connection string"),
  API_TOKEN: secret(z.string().regex(/^tok_[a-z0-9]+$/)).describe("Token for the upstream API"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080).describe("HTTP listen port"),
  MAX_BYTES: z.coerce.number().int().optional().describe("Largest request body"),
  RATIO: z.coerce.number().min(0).max(1).default(0.5).describe("Sampling ratio"),
  DEBUG: z.stringbool().default(true).describe("Verbose logging"),
  TIMEOUT: duration({ default: "30s", max: "5m" }).describe("Upstream request timeout"),
  LOG_LEVEL: z.enum(["debug", "info", "warn"]).default("info").describe("Minimum log level"),
  ORIGINS: list(z.string(), { minItems: 1, maxItems: 3 }).optional().describe("CORS origins"),
  LIMITS: json(z.object({ perMinute: z.number().int().min(1) })).optional().describe("Rate limits"),
  GREETING: z.string().default("hello").describe("Greeting text"),
};

const good = { DATABASE_URL: "postgres://u:p@db/app", API_TOKEN: "tok_abc123" };

function load(env: Record<string, string>) {
  return createEnv({ server, runtimeEnv: env, terminationLog: false, onWarning: () => {} });
}

function failure(env: Record<string, string>): DocuconfValidationError {
  try {
    load(env);
  } catch (e) {
    if (e instanceof DocuconfValidationError) return e;
    throw e;
  }
  throw new Error("expected validation to fail");
}

function codes(e: DocuconfValidationError): Array<[string, ErrorCode]> {
  return e.violations.map((v) => [v.input, v.code]);
}

describe("boot validation of variables", () => {
  it("returns typed values with defaults", () => {
    const env = load({ ...good, ORIGINS: "a,b", LIMITS: '{"perMinute":5}', TIMEOUT: "1m30s" });
    expect(env.PORT).toBe(8080);
    expect(env.RATIO).toBe(0.5);
    expect(env.DEBUG).toBe(true);
    expect(env.TIMEOUT).toBe(90_000);
    expect(env.LOG_LEVEL).toBe("info");
    expect(env.ORIGINS).toEqual(["a", "b"]);
    expect(env.LIMITS).toEqual({ perMinute: 5 });
    expect(env.MAX_BYTES).toBeUndefined();
    expect(env.DATABASE_URL).toBe("postgres://u:p@db/app");
  });

  it('parses "false" as false', () => {
    expect(load({ ...good, DEBUG: "false" }).DEBUG).toBe(false);
    expect(load({ ...good, DEBUG: "FALSE" }).DEBUG).toBe(false);
    expect(load({ ...good, DEBUG: "true" }).DEBUG).toBe(true);
  });

  it("treats an empty string as unset, except for strings", () => {
    const env = load({ ...good, PORT: "", DEBUG: "", TIMEOUT: "", GREETING: "" });
    expect(env.PORT).toBe(8080);
    expect(env.DEBUG).toBe(true);
    expect(env.TIMEOUT).toBe(30_000);
    expect(env.GREETING).toBe("");
    expect(codes(failure({ ...good, DATABASE_URL: "" }))).toEqual([["DATABASE_URL", "missing_required"]]);
  });

  it("reports a missing required variable", () => {
    expect(codes(failure({ DATABASE_URL: good.DATABASE_URL }))).toEqual([["API_TOKEN", "missing_required"]]);
  });

  it("rejects bad ints, including values beyond 2^53 and loose syntax", () => {
    expect(codes(failure({ ...good, PORT: "eighty" }))).toEqual([["PORT", "invalid_type"]]);
    expect(codes(failure({ ...good, PORT: "80.5" }))).toEqual([["PORT", "invalid_type"]]);
    expect(codes(failure({ ...good, PORT: " 80" }))).toEqual([["PORT", "invalid_type"]]);
    expect(codes(failure({ ...good, PORT: "0x50" }))).toEqual([["PORT", "invalid_type"]]);
    expect(codes(failure({ ...good, PORT: "70000" }))).toEqual([["PORT", "out_of_range"]]);
    expect(codes(failure({ ...good, MAX_BYTES: "9007199254740993" }))).toEqual([["MAX_BYTES", "out_of_range"]]);
    expect(load({ ...good, MAX_BYTES: "9007199254740991" }).MAX_BYTES).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("maps every kind of problem to its code and reports them all together", () => {
    const e = failure({
      DATABASE_URL: "mysql://db/app",
      API_TOKEN: "nope",
      PORT: "0",
      RATIO: "NaN",
      DEBUG: "maybe",
      TIMEOUT: "10m",
      LOG_LEVEL: "trace",
      ORIGINS: "a,b,c,d",
      LIMITS: '{"perMinute":0}',
    });
    expect(codes(e)).toEqual([
      ["DATABASE_URL", "invalid_scheme"],
      ["API_TOKEN", "pattern_mismatch"],
      ["PORT", "out_of_range"],
      ["RATIO", "invalid_type"],
      ["DEBUG", "invalid_type"],
      ["TIMEOUT", "out_of_range"],
      ["LOG_LEVEL", "not_in_enum"],
      ["ORIGINS", "too_many_items"],
      ["LIMITS", "schema_mismatch"],
    ]);
    expect(e.message).toMatch(/^docuconf: 9 configuration problems:/);
    expect(load({ ...good, ORIGINS: "" }).ORIGINS).toBeUndefined();
  });

  it("never prints secret values", () => {
    const secretValue = "mysql://admin:hunter2@db/app";
    const e = failure({ DATABASE_URL: secretValue, API_TOKEN: "tok_HUNTER2-SECRET" });
    expect(codes(e)).toEqual([
      ["DATABASE_URL", "invalid_scheme"],
      ["API_TOKEN", "pattern_mismatch"],
    ]);
    expect(e.message).not.toContain("hunter2");
    expect(e.message).not.toContain("HUNTER2");
    expect(JSON.stringify(e.violations)).not.toContain("hunter2");
    // Non-secret values are shown, to help fix them.
    expect(failure({ ...good, PORT: "70000" }).message).toContain('"70000"');
  });

  it("reports a secret still holding an unresolved injector reference, without printing it", () => {
    const cases: Array<[string, string]> = [
      ["vault:secret/data/orders#DATABASE_URL", "vault:"],
      ["op://prod-vault/orders-db/url", "op://"],
      ["ref+awssecrets://orders/db#/url", "ref+awssecrets"],
    ];
    for (const [ref, scheme] of cases) {
      const log = join(mkdtempSync(join(tmpdir(), "docuconf-tl-")), "termination-log");
      let e: unknown;
      try {
        createEnv({ server, runtimeEnv: { ...good, DATABASE_URL: ref }, terminationLog: log, onWarning: () => {} });
      } catch (err) {
        e = err;
      }
      expect(e).toBeInstanceOf(DocuconfValidationError);
      const err = e as DocuconfValidationError;
      expect(codes(err)).toEqual([["DATABASE_URL", "invalid_type"]]);
      expect(err.violations[0]!.message).toBe(
        `holds an unresolved ${scheme} reference; the injector that should resolve it did not run`,
      );
      const path = ref.slice(ref.indexOf(scheme.endsWith(":") ? ":" : "/") + 1);
      const logged = readFileSync(log, "utf8");
      expect(logged).toContain(`DATABASE_URL [invalid_type]: holds an unresolved ${scheme} reference`);
      for (const text of [err.message, JSON.stringify(err.violations), logged]) {
        expect(text).not.toContain(ref);
        expect(text).not.toContain(path);
      }
    }
    // Only secrets: a non-secret string may legitimately start with "vault:".
    expect(load({ ...good, GREETING: "vault:hello" }).GREETING).toBe("vault:hello");
  });

  it("writes violations to the termination log", () => {
    const path = join(mkdtempSync(join(tmpdir(), "docuconf-tl-")), "termination-log");
    expect(() => createEnv({ server, runtimeEnv: { API_TOKEN: "x" }, terminationLog: path, onWarning: () => {} })).toThrow(
      DocuconfValidationError,
    );
    const log = readFileSync(path, "utf8");
    expect(log).toContain("DATABASE_URL [missing_required]");
    expect(log).toContain("API_TOKEN [pattern_mismatch]");
    expect(log).not.toContain('"x"');
  });

  it("honours DOCUCONF_TERMINATION_LOG", () => {
    const path = join(mkdtempSync(join(tmpdir(), "docuconf-tl-")), "log");
    vi.stubEnv("DOCUCONF_TERMINATION_LOG", path);
    try {
      expect(() => createEnv({ server, runtimeEnv: {}, onWarning: () => {} })).toThrow(DocuconfValidationError);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(readFileSync(path, "utf8")).toContain("[missing_required]");
  });

  it("passes issues to a custom onValidationError", () => {
    let seen: readonly { message: string }[] = [];
    expect(() =>
      createEnv({
        server,
        runtimeEnv: {},
        terminationLog: false,
        onWarning: () => {},
        onValidationError: (issues) => {
          seen = issues;
          throw new Error("custom");
        },
      }),
    ).toThrow("custom");
    expect(seen.map((i) => i.message)).toEqual([
      "DATABASE_URL [missing_required]: required, but not set",
      "API_TOKEN [missing_required]: required, but not set",
    ]);
  });

  it("also validates client and shared variables on the server", () => {
    expect(() =>
      createEnv({
        server: { PORT: z.coerce.number().int().default(1).describe("HTTP listen port") },
        clientPrefix: "PUBLIC_",
        client: { PUBLIC_ID: z.string().describe("Site identifier") },
        runtimeEnv: { PORT: "x" },
        terminationLog: false,
      }),
    ).toThrow(/PORT \[invalid_type\][\s\S]*PUBLIC_ID \[missing_required\]/);
  });

  it("skips validation when T3's skipValidation is set", () => {
    const env = createEnv({ server, runtimeEnv: {}, skipValidation: true, onWarning: () => {} });
    expect(env.PORT).toBeUndefined();
  });
});

describe("int list item bounds (SPEC §4.3 itemMin, itemMax)", () => {
  const items = {
    SHARDS: list(z.coerce.number().int().min(0).max(1023)).optional().describe("Shard ids"),
    PARTITIONS: list(z.int32()).optional().describe("Partitions to consume"),
    IDS: list(z.coerce.number().int()).optional().describe("Record ids"),
    POSITIVE: list(z.coerce.number().int().positive()).optional().describe("Positive ids"),
  };
  const contractOf = (env: object) => getDeclaration(env).vars;

  it("exports the item schema's range, capped at safe integers", () => {
    const env = createEnv({ server: items, runtimeEnv: {}, terminationLog: false, onWarning: () => {} });
    const c = (n: string) => contractOf(env).get(n)!.contract;
    expect(c("SHARDS")).toMatchObject({ itemMin: 0, itemMax: 1023 });
    expect(c("PARTITIONS")).toMatchObject({ itemMin: -2147483648, itemMax: 2147483647 });
    expect(c("IDS")).toMatchObject({ itemMin: -Number.MAX_SAFE_INTEGER, itemMax: Number.MAX_SAFE_INTEGER });
    expect(c("POSITIVE")).toMatchObject({ itemMin: 1, itemMax: Number.MAX_SAFE_INTEGER });
  });

  it("reports an item out of bounds or beyond safe integers as out_of_range", () => {
    const run = (env: Record<string, string>) => {
      try {
        createEnv({ server: items, runtimeEnv: env, terminationLog: false, onWarning: () => {} });
      } catch (e) {
        return codes(e as DocuconfValidationError);
      }
      return [];
    };
    expect(run({ SHARDS: "3,-1" })).toEqual([["SHARDS", "out_of_range"]]);
    expect(run({ SHARDS: "1024" })).toEqual([["SHARDS", "out_of_range"]]);
    expect(run({ IDS: "1,9007199254740993" })).toEqual([["IDS", "out_of_range"]]);
    expect(run({ IDS: "1, 2" })).toEqual([["IDS", "invalid_type"]]);
    expect(run({ IDS: "0x10" })).toEqual([["IDS", "invalid_type"]]);
    expect(run({ SHARDS: "0,7,1023", IDS: "-5" })).toEqual([]);
  });
});
