import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  DocuconfDeclarationError,
  DocuconfValidationError,
  convertValue,
  failBoot,
  nextFloat,
  secretMessage,
  typoWarnings,
  underTestRunner,
  type ValueDecl,
  GENERIC,
  VarReport,
  checkContract,
  closeSchema,
  formatDuration,
  injectorScheme,
  loadContract,
  intBounds,
  intItem,
  nonRe2Feature,
  parseContract,
  parseDuration,
  parseDurationAs,
  precheckVar,
  re2RegExp,
  renderContract,
  type VarBase,
} from "../src/index.ts";

const secretUrl: VarBase = { name: "DATABASE_URL", type: "url", secret: true, required: true, contract: {} };
const port: VarBase = { name: "PORT", type: "int", secret: false, required: false, contract: {} };

describe("injector references (SPEC §4.5.1)", () => {
  it("recognises vault:, op:// and ref+ and names only the scheme", () => {
    expect(injectorScheme("vault:secret/data/db#url")).toBe("vault:");
    expect(injectorScheme("op://vault/item/field")).toBe("op://");
    expect(injectorScheme("ref+vault://secret/db#/url")).toBe("ref+vault");
    expect(injectorScheme("ref+not a backend")).toBe("ref+");
    expect(injectorScheme("postgres://db/app")).toBeUndefined();
    expect(injectorScheme("Vault:x")).toBeUndefined();
  });

  it("fails a secret with invalid_type and a message without the value", () => {
    const report = new VarReport(secretUrl);
    const r = precheckVar(secretUrl, "vault:secret/data/hunter2#url", report);
    expect(r.ok).toBe(false);
    expect(report.violations).toEqual([
      {
        input: "DATABASE_URL",
        kind: "var",
        code: "invalid_type",
        message: "holds an unresolved vault: reference; the injector that should resolve it did not run",
      },
    ]);
  });

  it("leaves non-secrets alone", () => {
    const decl: VarBase = { ...secretUrl, secret: false, type: "string" };
    expect(precheckVar(decl, "vault:x", new VarReport(decl))).toEqual({ value: "vault:x", ok: true });
  });
});

describe("precheckVar", () => {
  it("treats empty as unset except for strings, and checks number syntax", () => {
    expect(precheckVar(port, "", new VarReport(port))).toEqual({ value: undefined, ok: true });
    const report = new VarReport(port);
    expect(precheckVar(port, "0x50", report).ok).toBe(false);
    expect(report.violations[0]).toMatchObject({ code: "invalid_type", message: 'expected a base-10 integer (got "0x50")' });
  });

  it("redacts secret messages", () => {
    const decl: VarBase = { ...port, secret: true };
    const report = new VarReport(decl);
    precheckVar(decl, "12a", report);
    expect(report.violations[0]!.message).toBe("expected a base-10 integer (value hidden: secret)");
    expect(report.violations[0]!.message).not.toContain("12a");
  });

  it("says which rule a secret broke, from the declaration and never the value", () => {
    const msg = (contract: Record<string, unknown>, type: VarBase["type"], code: Parameters<typeof secretMessage>[1]) =>
      secretMessage({ type, contract }, code);
    expect(msg({ schemes: ["postgres"] }, "url", "invalid_scheme")).toBe("scheme must be one of postgres (value hidden: secret)");
    expect(msg({ minLength: 20 }, "string", "out_of_range")).toBe("must be at least 20 characters long (value hidden: secret)");
    expect(msg({ pattern: "^sk_" }, "string", "pattern_mismatch")).toBe("must match ^sk_ (value hidden: secret)");
    expect(msg({}, "url", "invalid_type")).toBe("expected a URL such as scheme://host (value hidden: secret)");
    expect(msg({ min: 1, max: Number.MAX_SAFE_INTEGER }, "int", "out_of_range")).toBe("must be at least 1 (value hidden: secret)");
    expect(msg({}, "string", "missing_required")).toBe(GENERIC.missing_required);
    // A user-written message that quotes the value is never used.
    const report = new VarReport({ name: "API_KEY", secret: true, type: "string", contract: { minLength: 20 } });
    report.add("out_of_range", 'too short: "hunter2"');
    expect(report.violations[0]!.message).toBe("must be at least 20 characters long (value hidden: secret)");
  });
});

describe("boot failure", () => {
  it("prints as the list of problems alone: no stack frames, no property dump", () => {
    const e = new DocuconfValidationError([{ input: "PORT", kind: "var", code: "out_of_range", message: "must be at least 1" }]);
    const printed = inspect(e);
    expect(printed).toBe("docuconf: 1 configuration problem:\n  - PORT [out_of_range]: must be at least 1");
    expect(e.stack).toBe(e.message);
    expect(Object.keys(e)).toEqual([]);
    expect(e.violations).toHaveLength(1);
    expect(inspect(new DocuconfDeclarationError(["PORT: needs a description"]))).toBe("docuconf: invalid declaration:\n  - PORT: needs a description");
  });

  it("exits 1 with only the list of problems on stderr", () => {
    const script = `
      import { failBoot } from ${JSON.stringify(new URL("../src/index.ts", import.meta.url).href)};
      failBoot([{ input: "PORT", kind: "var", code: "out_of_range", message: "must be at least 1" }], { exitOnError: true });
    `;
    const log = join(mkdtempSync(join(tmpdir(), "docuconf-exit-")), "termination-log");
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      env: { PATH: process.env["PATH"], DOCUCONF_TERMINATION_LOG: log },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toBe("docuconf: 1 configuration problem:\n  - PORT [out_of_range]: must be at least 1\n");
    expect(r.stdout).toBe("");
    expect(readFileSync(log, "utf8")).toContain("PORT [out_of_range]");
  });

  it("throws instead of exiting under a test runner", () => {
    expect(underTestRunner()).toBe(true);
    expect(() => failBoot([{ input: "P", kind: "var", code: "missing_required", message: "required, but not set" }], { exitOnError: true, terminationLog: false })).toThrow(
      DocuconfValidationError,
    );
  });
});

describe("typo hints", () => {
  it("names the declared variable an undeclared one looks like, never the value", () => {
    const w = typoWarnings(["DATABASE_URL", "WORKER_COUNT", "PORT"], {
      DATABSE_URL: "postgres://user:hunter2@db/x",
      WORKERS_COUNT: "8",
      HOME: "/root",
      PATH: "/bin",
      PORTS: "1",
      UNRELATED_THING: "x",
      WORKER_COUNT: "4",
    });
    expect(w).toEqual([
      "DATABSE_URL is set but not declared; did you mean DATABASE_URL?",
      "PORTS is set but not declared; did you mean PORT?",
      "WORKERS_COUNT is set but not declared; did you mean WORKER_COUNT?",
    ]);
    expect(w.join()).not.toContain("hunter2");
    // Short names only match at distance 1, and indexed list items are not typos.
    expect(typoWarnings(["HOST_A"], { HOME_B: "x" })).toEqual([]);
    expect(typoWarnings(["TAGS"], { TAGS__0: "a" })).toEqual([]);
  });
});

describe("lists", () => {
  const decl = (items: "string" | "int"): ValueDecl => ({ name: "L", type: "list", secret: false, required: false, contract: {}, items });
  it("drops whitespace around csv separators", () => {
    const r = convertValue(decl("string"), "https://a.com, https://b.com", new VarReport(decl("string")));
    expect(r.value).toEqual(["https://a.com", "https://b.com"]);
    expect(convertValue(decl("int"), "1, 2 ,3", new VarReport(decl("int"))).value).toEqual([1, 2, 3]);
  });
  it("reports every bad item, quoting the item", () => {
    const report = new VarReport(decl("int"));
    convertValue({ ...decl("int"), itemMin: 1 }, "1,0,x", report);
    expect(report.violations.map((v) => v.message)).toEqual(['item 2: must be at least 1 (got "0")', 'item 3: expected a base-10 integer (got "x")']);
  });
});

describe("exclusive float bounds", () => {
  it("become the nearest inclusive double", () => {
    expect(nextFloat(0, 1)).toBe(Number.MIN_VALUE);
    expect(nextFloat(1, 1)).toBe(1 + Number.EPSILON);
    expect(nextFloat(1, -1)).toBeLessThan(1);
    expect(nextFloat(-2, 1)).toBeGreaterThan(-2);
    expect(nextFloat(0, -1)).toBe(-Number.MIN_VALUE);
  });
});

describe("shared helpers", () => {
  it("formats durations canonically", () => {
    expect(formatDuration(5_400_000)).toBe("1h30m");
    expect(parseDuration("1m30s")).toBe(90_000);
  });

  it("caps int bounds to safe integers", () => {
    const warnings: string[] = [];
    expect(intBounds("N", { exclusiveMin: 0 }, warnings)).toEqual({ min: 1, max: Number.MAX_SAFE_INTEGER });
    expect(intBounds("N", { max: 2 ** 60 }, warnings).max).toBe(Number.MAX_SAFE_INTEGER);
    expect(warnings).toEqual(["N: max capped at Number.MAX_SAFE_INTEGER"]);
  });

  it("finds non-RE2 features", () => {
    expect(nonRe2Feature("^(?=a)")).toBe("lookahead (?=...)");
    expect(nonRe2Feature("^[a-z]+$")).toBeUndefined();
  });

  it("closes object schemas and strips docuconf keywords", () => {
    expect(
      closeSchema({ $schema: "x", type: "object", properties: { a: { type: "string", pattern: "^\\/a", "x-docuconf": 1 } } }),
    ).toEqual({ type: "object", properties: { a: { type: "string", pattern: "^/a" } }, additionalProperties: false });
  });

  it("renders a contract with the generator it is given", () => {
    const out = renderContract(
      { name: "svc", appVersion: undefined, vars: new Map([["PORT", { contract: { type: "int", description: "Listen port" } }]]), fileContracts: new Map() },
      {},
      { language: "typescript", sdk: "@docuconf/test", version: "1.2.3" },
    );
    expect(out).toContain('sdk:      "@docuconf/test"');
    expect(out.startsWith("// Code generated by docuconf. DO NOT EDIT.\npackage svc\n")).toBe(true);
  });
});

describe("int list items (SPEC §4.3 itemMin, itemMax)", () => {
  it("checks syntax, safe range and item bounds", () => {
    const b = { itemMin: 0, itemMax: 1023 };
    expect(intItem("7", b)).toEqual({ value: 7 });
    expect(intItem(7, b)).toEqual({ value: 7 });
    expect(intItem("x", b)).toMatchObject({ code: "invalid_type" });
    expect(intItem(" 7", b)).toMatchObject({ code: "invalid_type" });
    expect(intItem("1", b)).toEqual({ value: 1 });
    expect(intItem(1.5, b)).toMatchObject({ code: "invalid_type" });
    expect(intItem("7", {})).toEqual({ value: 7 });
    expect(intItem("-1", b)).toMatchObject({ code: "out_of_range" });
    expect(intItem("1024", b)).toMatchObject({ code: "out_of_range" });
    expect(intItem("9007199254740993", {})).toMatchObject({ code: "out_of_range" });
  });

  it("names itemMin and itemMax when capping them", () => {
    const warnings: string[] = [];
    expect(intBounds("IDS", { min: -1e300 }, warnings, { min: "itemMin", max: "itemMax" })).toEqual({
      min: -Number.MAX_SAFE_INTEGER,
      max: Number.MAX_SAFE_INTEGER,
    });
    expect(warnings).toEqual(["IDS: itemMin capped at -Number.MAX_SAFE_INTEGER"]);
  });
});

describe("duration encodings (SPEC §5)", () => {
  it("parses iso8601, seconds and timespan to milliseconds", () => {
    expect(parseDurationAs("PT90S", "iso8601")).toBe(90_000);
    expect(parseDurationAs("PT1.5S", "iso8601")).toBe(1500);
    expect(parseDurationAs("P1DT2H3M4.5S", "iso8601")).toBe(93_784_500);
    expect(parseDurationAs("pt1m", "iso8601")).toBe(60_000);
    for (const bad of ["P", "PT", "P1DT", "PT-1S", "P1M", "1m30s", "PT1.5M"]) expect(parseDurationAs(bad, "iso8601")).toBeUndefined();
    expect(parseDurationAs("90", "seconds")).toBe(90_000);
    expect(parseDurationAs("0.25", "seconds")).toBe(250);
    for (const bad of ["90s", "-1", "1e3", ".5", ""]) expect(parseDurationAs(bad, "seconds")).toBeUndefined();
    expect(parseDurationAs("00:01:30", "timespan")).toBe(90_000);
    expect(parseDurationAs("1.02:03:04.5", "timespan")).toBe(93_784_500);
    for (const bad of ["1m30s", "24:00:00", "00:60:00", "01:30", "00:00:00.12345678"]) expect(parseDurationAs(bad, "timespan")).toBeUndefined();
    expect(formatDuration(parseDurationAs("1.02:03:04.5", "timespan")!)).toBe("26h3m4s500ms");
  });
});

describe("re2RegExp", () => {
  it("compiles RE2 patterns, with a leading flag group, \\A, \\z and \\pL", () => {
    const re = (p: string) => re2RegExp(p) as RegExp;
    expect(re("(?i)^abc$").test("ABC")).toBe(true);
    expect(re("\\Aab\\z").test("ab")).toBe(true);
    expect(re("\\Aab\\z").test("ab\n")).toBe(false);
    expect(re("^\\pL+$").test("héllo")).toBe(true);
    expect(re("[0-9]{3}").test("x999y")).toBe(true);
    expect(re2RegExp("(?=x)")).toEqual({ problem: "lookahead (?=...) is not RE2" });
    expect(re2RegExp("(?U)a+")).toMatchObject({ problem: expect.stringMatching(/ungreedy/) });
  });
});

describe("contract-first mode (SPEC §11.2 item 11)", () => {
  const contract = {
    apiVersion: "docuconf.dev/v1alpha1",
    kind: "ConfigContract",
    metadata: { name: "orders", generator: { language: "go", sdk: "docuconf-go", version: "0.1.0" } },
    vars: {
      PORT: { type: "int", description: "HTTP listen port", min: 1, max: 65535, default: 8080 },
      TIMEOUT: { type: "duration", description: "Checkout timeout", encoding: "timespan", default: "30s" },
      PARTITIONS: { type: "list", description: "Partitions to consume", items: "int", encoding: "indexed", itemMin: 0, itemMax: 31 },
      DATABASE_URL: { type: "url", description: "Primary database", secret: true, required: true, schemes: ["postgres"] },
      LIMITS: { type: "json", description: "Rate limits", schema: { type: "object" } },
    },
  };

  it("returns typed values, with omitted defaults filled in", () => {
    const env = loadContract(JSON.stringify(contract), {
      env: { DATABASE_URL: "postgres://db/app", PARTITIONS__0: "3", PARTITIONS__1: "7", TIMEOUT: "00:01:30", LIMITS: "[1]" },
      terminationLog: false,
    });
    expect(env).toEqual({ PORT: 8080, TIMEOUT: 90_000, PARTITIONS: [3, 7], DATABASE_URL: "postgres://db/app", LIMITS: [1] });
  });

  it("reports every violation without secret values, and calls validateJson", () => {
    const { violations } = checkContract(
      contract,
      { PORT: "0", PARTITIONS__0: "32", DATABASE_URL: "mysql://u:hunter2@db", LIMITS: "[1]" },
      { validateJson: (_d, v) => (Array.isArray(v) ? { issues: [{ path: "", message: "must be an object" }] } : { value: v }) },
    );
    expect(violations.map((v) => [v.input, v.code])).toEqual([
      ["PORT", "out_of_range"],
      ["PARTITIONS", "out_of_range"],
      ["DATABASE_URL", "invalid_scheme"],
      ["LIMITS", "schema_mismatch"],
    ]);
    expect(JSON.stringify(violations)).not.toContain("hunter2");
  });

  it("reads indexed items from 0 with no gap, and ignores other suffixes", () => {
    const check = (env: Record<string, string>) => checkContract(contract, { DATABASE_URL: "postgres://db/app", ...env });
    expect(check({ PARTITIONS__1: "7", PARTITIONS__0: "3", PARTITIONS__HOST: "x", PARTITIONS__01: "9" }).values["PARTITIONS"]).toEqual([3, 7]);
    for (const env of [{ PARTITIONS__0: "3", PARTITIONS__2: "7" }, { PARTITIONS__1: "7" }] as Record<string, string>[]) {
      const { values, violations } = check(env);
      expect(values["PARTITIONS"]).toBeUndefined();
      expect(violations.map((v) => [v.input, v.code])).toEqual([["PARTITIONS", "invalid_type"]]);
      expect(violations[0]!.message).toMatch(/^indexed items must be numbered from 0 with no gap, but PARTITIONS__[01] is not set$/);
    }
    expect(check({ PARTITIONS__HOST: "x" }).values["PARTITIONS"]).toBeUndefined();
  });

  it("rejects a contract it cannot check", () => {
    expect(() =>
      parseContract({ ...contract, vars: { bad: { type: "list", description: "Some tags", items: "string", itemMax: 3 }, X: { type: "money" } } }),
    ).toThrow(DocuconfDeclarationError);
    let error: unknown;
    try {
      parseContract({ apiVersion: "v2", kind: "ConfigContract", vars: { TAGS: { type: "list", description: "Some tags", items: "string", itemMax: 3 } } });
    } catch (e) {
      error = e;
    }
    {
      expect((error as DocuconfDeclarationError).problems).toEqual([
        'apiVersion must be "docuconf.dev/v1alpha1"',
        "TAGS: itemMin and itemMax apply to int items only",
      ]);
    }
  });
});
