// What a first-time user meets: boot failure output, secrets in logs and
// errors, testing a declaration, and declaration mistakes the contract
// would otherwise hide.
import "reflect-metadata";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import {
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUrl,
  Min,
  MinLength,
  ValidateBy,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { describe, expect, it } from "vitest";
import {
  ConfigFile,
  DocuconfDeclarationError,
  DocuconfValidationError,
  Describe,
  Duration,
  List,
  Secret,
  UrlSchemes,
  docuconfValidate,
  toContract,
} from "../src/index.ts";
import { main } from "../src/cli.ts";
import { SOURCE_CONDITIONS } from "../../core/test/support/cue.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SECRET = "hunter2-do-not-print";

class Env {
  @IsInt() @Min(1) @Describe("Port the API listens on")
  PORT: number = 3000;

  @Secret() @UrlSchemes("postgres") @Describe("Primary Postgres connection string")
  DATABASE_URL!: string;

  @Secret() @IsString() @MinLength(20) @Describe("Key for the payments API")
  @ValidateBy({ name: "startsWithSk", validator: { validate: (v) => String(v).startsWith("sk_"), defaultMessage: (a) => `bad key ${String(a?.value)}` } })
  API_KEY!: string;
}

const good = { DATABASE_URL: `postgres://app:${SECRET}@db/app`, API_KEY: `sk_${SECRET}` };
const quiet = { terminationLog: false as const, onWarning: () => {}, watch: false };

function failure(fn: () => unknown): DocuconfValidationError {
  try {
    fn();
  } catch (e) {
    if (e instanceof DocuconfValidationError) return e;
    throw e;
  }
  throw new Error("expected a DocuconfValidationError");
}

function problems(cls: new () => object): readonly string[] {
  try {
    docuconfValidate(cls, quiet);
  } catch (e) {
    if (e instanceof DocuconfDeclarationError) return e.problems;
    throw e;
  }
  return [];
}

function warnings(cls: new () => object): string[] {
  const out: string[] = [];
  try {
    docuconfValidate(cls, { ...quiet, onWarning: (w) => out.push(w) })({});
  } catch (e) {
    if (!(e instanceof DocuconfValidationError)) throw e;
  }
  return out;
}

describe("secrets never print by accident", () => {
  it("redacts secrets when the validated config is logged or serialised", () => {
    const config = docuconfValidate(Env, quiet)(good) as Env;
    for (const printed of [inspect(config), JSON.stringify(config)]) {
      expect(printed).not.toContain(SECRET);
      expect(printed).toContain("[redacted]");
      expect(printed).toContain("3000");
    }
    expect(config.DATABASE_URL).toBe(good.DATABASE_URL);
  });

  it("says which rule a secret broke, never with the value, even from a custom validator", () => {
    const e = failure(() => docuconfValidate(Env, quiet)({ DATABASE_URL: `mysql://app:${SECRET}@db/app`, API_KEY: SECRET }));
    expect(e.violations.map((v) => `${v.input} [${v.code}]: ${v.message}`)).toEqual([
      "DATABASE_URL [invalid_scheme]: scheme must be one of postgres (value hidden: secret)",
      "API_KEY [invalid_type]: value does not have the expected type (value hidden: secret)",
    ]);
    expect(inspect(e)).not.toContain(SECRET);
  });
});

describe("boot failure", () => {
  const run = (env: Record<string, string>) =>
    spawnSync(process.execPath, [SOURCE_CONDITIONS, join(here, "fixtures/boot.mjs")], {
      encoding: "utf8",
      env: { PATH: process.env["PATH"] ?? "", DOCUCONF_TERMINATION_LOG: "/dev/null", ...env },
    });

  it("exitOnError prints one line per problem and exits 1, with no stack trace", () => {
    const r = run({ BOOT_EXIT: "1", PORT: "0" });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(
      "docuconf: 2 configuration problems:\n" +
        '  - PORT [out_of_range]: must not be less than 1 (got "0")\n' +
        "  - DATABASE_URL [missing_required]: required, but not set\n",
    );
  });

  it("a thrown DocuconfValidationError prints as its list, without frames or an object dump", () => {
    const r = run({ PORT: "0" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("docuconf: 2 configuration problems:\n  - PORT [out_of_range]");
    expect(r.stderr).not.toMatch(/\n\s+at /);
    expect(r.stderr).not.toContain("violations:");
  });

  it("warns about a likely typo, naming both variables and never the value", () => {
    const out: string[] = [];
    docuconfValidate(Env, { ...quiet, onWarning: (w) => out.push(w) })({ ...good, DATABSE_URL: SECRET });
    expect(out.filter((w) => w.includes("did you mean"))).toEqual(["DATABSE_URL is set but not declared; did you mean DATABASE_URL?"]);
    expect(out.join("\n")).not.toContain(SECRET);
  });
});

describe("testing a declaration", () => {
  it("validate.check reports problems for an explicit map, without throwing or reading process.env", () => {
    const validate = docuconfValidate(Env, quiet);
    const r = validate.check({ PORT: "0" });
    expect(r.violations.map((v) => `${v.input} ${v.code}`)).toEqual(["PORT out_of_range", "DATABASE_URL missing_required", "API_KEY missing_required"]);
    expect(validate.check({ ...good, PORT: "8080" })).toEqual({ values: { ...good, PORT: 8080 }, violations: [], warnings: [] });
  });

  it("validate is a pure function of its input, so a unit test can assert on the error", () => {
    expect(() => docuconfValidate(Env, quiet)({ ...good, PORT: "0" })).toThrow(/PORT \[out_of_range\]/);
  });
});

describe("declaration mistakes the contract would hide", () => {
  it("@List() without an item type", () => {
    class E {
      @List() @Describe("Worker ports to bind")
      PORTS!: number[];
    }
    expect(problems(E)).toEqual(["PORTS: @List() needs @IsString({ each: true }) or @IsInt({ each: true }): emitDecoratorMetadata cannot see the item type"]);
  });

  it("a constraint that does not fit the type", () => {
    class E {
      @IsInt() @MinLength(3) @Describe("Number of workers")
      WORKERS!: number;
    }
    expect(problems(E)).toEqual(["WORKERS: @MinLength() does not apply to a int variable (it needs a string); remove it or change the type"]);
  });

  it("a property with a default but no decorators", () => {
    class E {
      @IsString() @Describe("Display name")
      NAME!: string;

      SENTRY_DSN = "https://sentry.example.com/1";
    }
    expect(problems(E)).toEqual([
      'SENTRY_DSN: has a default but no decorators, so docuconf cannot see it and the contract leaves it out; add @Describe("...") and a type decorator such as @IsString(), or remove the property',
    ]);
  });

  it("@IsUrl() that rejects localhost, which the contract cannot say", () => {
    class E {
      @IsUrl() @Describe("Upstream base URL")
      UPSTREAM!: string;

      @IsUrl({ require_tld: false }) @Describe("Local upstream base URL")
      LOCAL!: string;
    }
    const w = warnings(E);
    expect(w.filter((x) => x.includes("top-level domain"))).toEqual([expect.stringMatching(/^UPSTREAM: @IsUrl\(\) rejects hosts without a top-level domain/)]);
  });

  it("NODE_ENV, which test runners set to test", () => {
    class E {
      @IsOptional() @IsString() @Describe("Node environment")
      NODE_ENV?: string;
    }
    expect(warnings(E)).toEqual([expect.stringMatching(/^NODE_ENV: is a framework concern/)]);
  });

  it("accepts a duration default written as documented", () => {
    class E {
      @Duration() @Describe("Upstream request timeout")
      TIMEOUT: number = "30s" as never;
    }
    const validate = docuconfValidate(E, quiet);
    expect(validate.declaration.vars.get("TIMEOUT")!.contract["default"]).toBe("30s");
    expect((validate({}) as E).TIMEOUT).toBe(30_000);
  });

  it("exports @IsPositive on a float exactly", () => {
    class E {
      @IsNumber() @IsPositive() @Describe("Sampling ratio")
      RATIO: number = 0.5;
    }
    expect(toContract(E, { name: "x" })).toContain("min:         5e-324");
  });
});

describe("config files", () => {
  class Settings {
    @IsInt() @Min(1) maxItemsPerOrder!: number;
  }
  class Nested {
    @ValidateNested() @Type(() => Settings) limits!: Settings;
  }
  class E {
    @ConfigFile({ format: "json", path: "/etc/app/settings.json", required: true, description: "Order limits", schema: Nested })
    settings!: Nested;
  }

  it("say a missing field is required, not out of range", () => {
    const root = mkdtempSync(join(tmpdir(), "docuconf-nest-"));
    mkdirSync(join(root, "etc/app"), { recursive: true });
    writeFileSync(join(root, "etc/app/settings.json"), '{"limits":{}}');
    const r = docuconfValidate(E, quiet).check({}, { fileRoot: root });
    expect(r.violations.map((v) => `${v.input} [${v.code}]: ${v.message}`)).toEqual(["settings [schema_mismatch]: limits.maxItemsPerOrder: required"]);
  });
});

describe("CLI", () => {
  const fixture = join(here, "fixtures/sample-env.ts");

  it("--check fails with a diff when the contract is out of date", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "docuconf-nest-check-")), "contract.cue");
    const err: string[] = [];
    const io = { out: { write: () => true }, err: { write: (s: string) => (err.push(s), true) } };
    expect(await main(["export", fixture, "--out", file], io)).toBe(0);
    expect(await main(["export", fixture, "--check", file], io)).toBe(0);
    writeFileSync(file, readFileSync(file, "utf8").replace(/description: "[^"]+"/, 'description: "stale"'));
    expect(await main(["export", fixture, "--check", file], io)).toBe(1);
    expect(err.join("")).toMatch(/is out of date; run docuconf-nestjs export/);
  });

  it("docs writes Markdown", async () => {
    const out: string[] = [];
    const io = { out: { write: (s: string) => (out.push(s), true) }, err: { write: () => true } };
    expect(await main(["docs", fixture], io)).toBe(0);
    expect(out.join("")).toMatch(/^# \S+ configuration\n/);
    expect(out.join("")).toContain("| Variable | Type | Required | Secret | Description | Rules |");
  });
});
