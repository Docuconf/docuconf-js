import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "reflect-metadata";
import { ArrayMaxSize, ArrayMinSize, IsBoolean, IsEnum, IsInt, IsNumber, IsOptional, IsPositive, IsString, Matches, Max, MaxLength, Min, MinLength } from "class-validator";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Deprecated,
  Describe,
  DocuconfValidationError,
  Duration,
  type ErrorCode,
  Json,
  List,
  Secret,
  UrlSchemes,
  docuconfValidate,
} from "../src/index.ts";

enum LogLevel {
  Debug = "debug",
  Info = "info",
  Warn = "warn",
}

class Limits {
  @IsInt() @Min(1)
  perMinute!: number;
}

class Env {
  @Secret() @UrlSchemes("postgres", "postgresql") @Describe("Primary Postgres connection string")
  DATABASE_URL!: string;

  @Secret() @IsString() @Matches(/^tok_[a-z0-9]+$/) @Describe("Token for the upstream API")
  API_TOKEN!: string;

  @IsInt() @Min(1) @Max(65535) @Describe("HTTP listen port")
  PORT: number = 8080;

  @IsOptional() @IsInt() @Describe("Largest request body")
  MAX_BYTES?: number;

  @IsNumber() @Min(0) @Max(1) @Describe("Sampling ratio")
  RATIO: number = 0.5;

  @IsBoolean() @Describe("Verbose logging")
  DEBUG: boolean = true;

  @Duration({ default: "30s", max: "5m" }) @Describe("Upstream request timeout")
  TIMEOUT!: number;

  @IsEnum(LogLevel) @Describe("Minimum log level")
  LOG_LEVEL: LogLevel = LogLevel.Info;

  @IsOptional() @List() @IsString({ each: true }) @ArrayMinSize(1) @ArrayMaxSize(3) @Describe("CORS origins")
  ORIGINS?: string[];

  @IsOptional() @List({ separator: ";" }) @IsInt({ each: true }) @Min(1, { each: true }) @Describe("Worker ports")
  WORKER_PORTS?: number[];

  @IsOptional() @Json(Limits) @Describe("Rate limits")
  LIMITS?: Limits;

  @IsString() @Describe("Greeting text")
  GREETING: string = "hello";
}

const good = { DATABASE_URL: "postgres://u:p@db/app", API_TOKEN: "tok_abc123" };
const validate = docuconfValidate(Env, { name: "vars", terminationLog: false, onWarning: () => {} });

function failure(env: Record<string, unknown>, v: (c: Record<string, unknown>) => unknown = validate): DocuconfValidationError {
  try {
    v(env);
  } catch (e) {
    if (e instanceof DocuconfValidationError) return e;
    throw e;
  }
  throw new Error("expected validation to fail");
}

function codes(e: DocuconfValidationError): Array<[string, ErrorCode]> {
  return e.violations.map((v) => [v.input, v.code]);
}

afterEach(() => vi.unstubAllEnvs());

describe("boot validation of variables", () => {
  it("returns an instance of the class with typed values and defaults", () => {
    const env = validate({ ...good, ORIGINS: "a,b", WORKER_PORTS: "8081;8082", LIMITS: '{"perMinute":5}', TIMEOUT: "1m30s", HOSTNAME: "pod-1" });
    expect(env).toBeInstanceOf(Env);
    expect(env.PORT).toBe(8080);
    expect(env.RATIO).toBe(0.5);
    expect(env.DEBUG).toBe(true);
    expect(env.TIMEOUT).toBe(90_000);
    expect(env.LOG_LEVEL).toBe("info");
    expect(env.ORIGINS).toEqual(["a", "b"]);
    expect(env.WORKER_PORTS).toEqual([8081, 8082]);
    expect(env.LIMITS).toBeInstanceOf(Limits);
    expect(env.LIMITS).toEqual({ perMinute: 5 });
    expect(env.MAX_BYTES).toBeUndefined();
    expect(env.DATABASE_URL).toBe("postgres://u:p@db/app");
    // Variables the class does not declare are kept, as plainToInstance keeps them.
    expect((env as unknown as Record<string, unknown>)["HOSTNAME"]).toBe("pod-1");
    // Durations stay out of Object.keys, so Nest never writes "90000" to process.env.
    expect(Object.keys(env)).not.toContain("TIMEOUT");
    expect(Object.keys(env)).toContain("PORT");
  });

  it('parses "false" as false, case-insensitively, and nothing else as a bool', () => {
    expect(validate({ ...good, DEBUG: "false" }).DEBUG).toBe(false);
    expect(validate({ ...good, DEBUG: "FALSE" }).DEBUG).toBe(false);
    expect(validate({ ...good, DEBUG: "True" }).DEBUG).toBe(true);
    expect(codes(failure({ ...good, DEBUG: "yes" }))).toEqual([["DEBUG", "invalid_type"]]);
  });

  it("treats an empty string as unset, except for strings", () => {
    const env = validate({ ...good, PORT: "", DEBUG: "", TIMEOUT: "", GREETING: "", ORIGINS: "" });
    expect(env.PORT).toBe(8080);
    expect(env.DEBUG).toBe(true);
    expect(env.TIMEOUT).toBe(30_000);
    expect(env.GREETING).toBe("");
    expect(env.ORIGINS).toBeUndefined();
    expect(codes(failure({ ...good, DATABASE_URL: "" }))).toEqual([["DATABASE_URL", "missing_required"]]);
  });

  it("reports a missing required variable", () => {
    expect(codes(failure({ DATABASE_URL: good.DATABASE_URL }))).toEqual([["API_TOKEN", "missing_required"]]);
  });

  it("rejects bad ints, including values beyond 2^53 and loose syntax", () => {
    for (const bad of ["eighty", "80.5", " 80", "0x50", "1e3"]) expect(codes(failure({ ...good, PORT: bad }))).toEqual([["PORT", "invalid_type"]]);
    expect(codes(failure({ ...good, PORT: "70000" }))).toEqual([["PORT", "out_of_range"]]);
    expect(codes(failure({ ...good, MAX_BYTES: "9007199254740993" }))).toEqual([["MAX_BYTES", "out_of_range"]]);
    expect(validate({ ...good, MAX_BYTES: "9007199254740991" }).MAX_BYTES).toBe(Number.MAX_SAFE_INTEGER);
    expect(codes(failure({ ...good, WORKER_PORTS: "1;x" }))).toEqual([["WORKER_PORTS", "invalid_type"]]);
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
      WORKER_PORTS: "0",
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
      ["WORKER_PORTS", "out_of_range"],
      ["LIMITS", "schema_mismatch"],
    ]);
    expect(e.message).toMatch(/^docuconf: 10 configuration problems:/);
    expect(e.message).toContain('PORT [out_of_range]: must not be less than 1 (got "0")');
    expect(e.message).toContain("LIMITS [schema_mismatch]: perMinute: must not be less than 1");
  });

  it("inherits declarations from a base class", () => {
    class Extended extends Env {
      @IsOptional() @IsInt() @Describe("Extra worker count")
      WORKERS?: number;
    }
    const v = docuconfValidate(Extended, { terminationLog: false, onWarning: () => {} });
    expect(v({ ...good, WORKERS: "4" })).toMatchObject({ PORT: 8080, WORKERS: 4 });
    expect(codes(failure({ WORKERS: "x" }, v))).toEqual([
      ["DATABASE_URL", "missing_required"],
      ["API_TOKEN", "missing_required"],
      ["WORKERS", "invalid_type"],
    ]);
  });

  it("never prints secret values", () => {
    const e = failure({ DATABASE_URL: "mysql://admin:hunter2@db/app", API_TOKEN: "tok_HUNTER2-SECRET" });
    expect(codes(e)).toEqual([
      ["DATABASE_URL", "invalid_scheme"],
      ["API_TOKEN", "pattern_mismatch"],
    ]);
    expect(e.message).not.toMatch(/hunter2/i);
    expect(JSON.stringify(e.violations)).not.toMatch(/hunter2/i);
    // Non-secret values are shown, to help fix them.
    expect(failure({ ...good, PORT: "70000" }).message).toContain('"70000"');
  });

  it("reports a secret still holding an unresolved injector reference, without printing it", () => {
    const log = join(mkdtempSync(join(tmpdir(), "docuconf-nest-tl-")), "termination-log");
    const v = docuconfValidate(Env, { terminationLog: log, onWarning: () => {} });
    const e = failure({ DATABASE_URL: "vault:secret/data/orders#url", API_TOKEN: "op://prod/orders/token" }, v);
    expect(codes(e)).toEqual([
      ["DATABASE_URL", "invalid_type"],
      ["API_TOKEN", "invalid_type"],
    ]);
    const logged = readFileSync(log, "utf8");
    expect(logged).toContain("DATABASE_URL [invalid_type]: holds an unresolved vault: reference; the injector that should resolve it did not run");
    expect(logged).toContain("API_TOKEN [invalid_type]: holds an unresolved op:// reference");
    for (const text of [e.message, JSON.stringify(e.violations), logged]) {
      expect(text).not.toContain("secret/data/orders");
      expect(text).not.toContain("prod/orders/token");
    }
    expect(validate({ ...good, GREETING: "vault:hello" }).GREETING).toBe("vault:hello");
  });

  it("writes violations to the termination log, and honours DOCUCONF_TERMINATION_LOG", () => {
    const path = join(mkdtempSync(join(tmpdir(), "docuconf-nest-tl-")), "log");
    vi.stubEnv("DOCUCONF_TERMINATION_LOG", path);
    const v = docuconfValidate(Env, { onWarning: () => {} });
    expect(() => v({ API_TOKEN: "x" })).toThrow(DocuconfValidationError);
    const log = readFileSync(path, "utf8");
    expect(log).toContain("DATABASE_URL [missing_required]");
    expect(log).toContain("API_TOKEN [pattern_mismatch]");
    expect(log).not.toContain('"x"');
  });

  it("warns once about declaration hints and when a deprecated variable is set", () => {
    class Flags {
      @IsOptional() @IsBoolean() @Describe("Turns on the new checkout")
      FF_NEW_CHECKOUT?: boolean;

      @IsOptional() @IsString() @Deprecated({ message: "use REGION", replacedBy: "REGION" }) @Describe("Old region name")
      ZONE?: string;
    }
    const warnings: string[] = [];
    const v = docuconfValidate(Flags, { onWarning: (m) => warnings.push(m) });
    v({ ZONE: "eu" });
    v({});
    expect(warnings).toEqual([
      expect.stringMatching(/^FF_NEW_CHECKOUT: looks like a feature flag/),
      "ZONE is deprecated: use REGION",
    ]);
  });

  it("accepts already-typed values, as a load() factory or a test might pass", () => {
    expect(validate({ ...good, PORT: 9090, DEBUG: false }).PORT).toBe(9090);
  });
});

describe("int list item bounds (SPEC §4.3 itemMin, itemMax)", () => {
  class Items {
    @IsOptional() @List() @IsInt({ each: true }) @Min(0, { each: true }) @Max(1023, { each: true }) @Describe("Shard ids")
    SHARDS?: number[];

    @IsOptional() @List() @IsInt({ each: true }) @Describe("Record ids")
    IDS?: number[];

    @IsOptional() @List() @IsInt({ each: true }) @IsPositive({ each: true }) @Describe("Positive ids")
    POSITIVE?: number[];
  }
  const v = docuconfValidate(Items, { terminationLog: false, onWarning: () => {} });

  it("exports @Min and @Max with each: true, capped at safe integers", () => {
    const c = (n: string) => v.declaration.vars.get(n)!.contract;
    expect(c("SHARDS")).toMatchObject({ itemMin: 0, itemMax: 1023 });
    expect(c("IDS")).toMatchObject({ itemMin: -Number.MAX_SAFE_INTEGER, itemMax: Number.MAX_SAFE_INTEGER });
    expect(c("POSITIVE")).toMatchObject({ itemMin: 1, itemMax: Number.MAX_SAFE_INTEGER });
  });

  it("reports an item out of bounds or beyond safe integers as out_of_range", () => {
    expect(codes(failure({ SHARDS: "3,-1" }, v))).toEqual([["SHARDS", "out_of_range"]]);
    expect(codes(failure({ SHARDS: "1024" }, v))).toEqual([["SHARDS", "out_of_range"]]);
    expect(codes(failure({ IDS: "1,9007199254740993" }, v))).toEqual([["IDS", "out_of_range"]]);
    expect(codes(failure({ IDS: "1,x" }, v))).toEqual([["IDS", "invalid_type"]]);
    expect(codes(failure({ POSITIVE: "0" }, v))).toEqual([["POSITIVE", "out_of_range"]]);
    expect(v({ SHARDS: "0,7,1023", IDS: "-5" })).toMatchObject({ SHARDS: [0, 7, 1023], IDS: [-5] });
  });
});

describe("length limits (SPEC §4.3 maxLength on url and json, itemMinLength, itemMaxLength)", () => {
  class RunLimits {
    @IsOptional() @IsInt()
    max?: number;
  }
  class Lengths {
    @IsOptional() @UrlSchemes("https") @MaxLength(24) @Describe("Where to report each run")
    CALLBACK?: string;

    @IsOptional() @Json(RunLimits, { maxLength: 16 }) @Describe("Run limits as a JSON object")
    LIMITS?: RunLimits;

    @IsOptional() @List() @IsString({ each: true }) @MinLength(2, { each: true }) @MaxLength(4, { each: true }) @Describe("Branch codes")
    BRANCHES?: string[];

    @IsOptional() @Secret() @UrlSchemes("postgres") @MaxLength(30) @Describe("Database connection string")
    DB_URL?: string;
  }
  const v = docuconfValidate(Lengths, { terminationLog: false, onWarning: () => {} });
  const codesOf = (env: Record<string, string>) => {
    try {
      v(env);
    } catch (e) {
      return codes(e as DocuconfValidationError);
    }
    return [];
  };

  it("exports @MaxLength on a url, @Json maxLength and item lengths with each: true", () => {
    const c = (n: string) => v.declaration.vars.get(n)!.contract;
    expect(c("CALLBACK")).toMatchObject({ maxLength: 24 });
    expect(c("LIMITS")).toMatchObject({ maxLength: 16 });
    expect(c("BRANCHES")).toMatchObject({ itemMinLength: 2, itemMaxLength: 4 });
  });

  it("counts characters (code points), not bytes or UTF-16 units", () => {
    expect(codesOf({ CALLBACK: "https://a.example/runs/4" })).toEqual([]);
    expect(codesOf({ CALLBACK: "https://a.example/runs/42" })).toEqual([["CALLBACK", "out_of_range"]]);
    expect(codesOf({ CALLBACK: "https://例え.jp/日本語の道/一二三四" })).toEqual([]);
    expect(codesOf({ BRANCHES: "BE,ZÜ01,日本" })).toEqual([]);
    // An emoji is 1 code point but 2 UTF-16 units: "😀😀😀😀" is 4 characters.
    expect(codesOf({ BRANCHES: "😀😀😀😀" })).toEqual([]);
    expect(codesOf({ BRANCHES: "😀😀😀😀😀" })).toEqual([["BRANCHES", "out_of_range"]]);
    expect(codesOf({ BRANCHES: "BE,ZÜRICH" })).toEqual([["BRANCHES", "out_of_range"]]);
    expect(codesOf({ BRANCHES: "BE,B" })).toEqual([["BRANCHES", "out_of_range"]]);
  });

  it("measures a json value as received, whitespace included", () => {
    expect(codesOf({ LIMITS: '{"max":12345678}' })).toEqual([]);
    expect(codesOf({ LIMITS: '{"max":123456789}' })).toEqual([["LIMITS", "out_of_range"]]);
    expect(codesOf({ LIMITS: '{ "max": 123456 }' })).toEqual([["LIMITS", "out_of_range"]]);
  });

  it("reports a too-long secret's length, never its value", () => {
    const e = failure({ DB_URL: "postgres://app:s3cr3t@db:5432/app" }, v);
    expect(codes(e)).toEqual([["DB_URL", "out_of_range"]]);
    expect(e.violations[0]!.message).toContain("33 characters");
    expect(e.message).not.toContain("s3cr3t");
  });

  it("rejects item lengths on an int list, min above max, and defaults that break the limits", () => {
    class Bad {
      @IsOptional() @List() @IsInt({ each: true }) @MaxLength(4, { each: true }) @Describe("Shard ids")
      SHARDS?: number[];

      @IsOptional() @List() @MinLength(5, { each: true }) @MaxLength(4, { each: true }) @Describe("Branch codes")
      BRANCHES?: string[];

      @Json(RunLimits, { maxLength: -1 }) @IsOptional() @Describe("Run limits")
      LIMITS?: RunLimits;
    }
    expect(() => docuconfValidate(Bad, { terminationLog: false })).toThrow(/SHARDS: @MinLength, @MaxLength and @Length with \{ each: true \} apply to string items only[\s\S]*BRANCHES: itemMinLength 5 is above itemMaxLength 4[\s\S]*LIMITS: @Json maxLength must be a non-negative integer/);

    class BadDefaults {
      @UrlSchemes("https") @MaxLength(10) @Describe("Some URL value")
      U = "https://example.com";

      @List() @MaxLength(2, { each: true }) @Describe("Some list value")
      L = ["abc"];

      @Json(undefined, { maxLength: 5 }) @Describe("Some JSON value")
      J: unknown = { a: 1 };
    }
    expect(() => docuconfValidate(BadDefaults, { terminationLog: false })).toThrow(/U: default[\s\S]*L: default[\s\S]*J: default/);

    class GoodDefault {
      @List() @MaxLength(3, { each: true }) @Describe("Some list value")
      L = ["日本語"];
    }
    expect(() => docuconfValidate(GoodDefault, { terminationLog: false })).not.toThrow();
  });
});
