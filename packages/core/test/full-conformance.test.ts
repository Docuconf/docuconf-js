/**
 * Contract-first mode's 64-bit integers and JSON Schema checks (the
 * conformance suite's `int64` and `json-schema` capability tags).
 */
import { describe, expect, it } from "vitest";
import { DocuconfDeclarationError, VarReport, checkContract, intItem, parseContract, parseJsonExact, precheckVar, type VarBase } from "../src/index.ts";

const head = { apiVersion: "docuconf.dev/v1alpha1", kind: "ConfigContract", metadata: { name: "t" } };
const codes = (r: ReturnType<typeof checkContract>) => r.violations.map((v) => [v.input, v.code]);

describe("int64 in contract-first mode", () => {
  const contract = `{
    "apiVersion": "docuconf.dev/v1alpha1", "kind": "ConfigContract",
    "vars": {
      "OFFSET": { "type": "int", "description": "Signed offset" },
      "BIG": { "type": "int", "description": "A bounded big value", "min": 9007199254740993, "max": 9223372036854775806, "default": 9007199254740993 },
      "IDS": { "type": "list", "description": "Some identifiers", "items": "int", "encoding": "json", "itemMax": 9223372036854775000 },
      "CSV": { "type": "list", "description": "Some identifiers", "items": "int" }
    }
  }`;

  it("keeps numbers within the safe range and bigints beyond it, exactly", () => {
    const { values, violations } = checkContract(contract, {
      OFFSET: "9223372036854775807",
      IDS: "[1, 9223372036854774999, -9223372036854775808]",
      CSV: "-9223372036854775808,42",
    });
    expect(violations).toEqual([]);
    expect(values["OFFSET"]).toBe(9223372036854775807n);
    expect(values["BIG"]).toBe(9007199254740993n);
    expect(values["IDS"]).toEqual([1, 9223372036854774999n, -9223372036854775808n]);
    expect(values["CSV"]).toEqual([-9223372036854775808n, 42]);
    expect(checkContract(contract, { OFFSET: "-42" }).values["OFFSET"]).toBe(-42);
    expect(checkContract(contract, { OFFSET: "9007199254740991" }).values["OFFSET"]).toBe(9007199254740991);
    expect(checkContract(contract, { OFFSET: "9007199254740992" }).values["OFFSET"]).toBe(9007199254740992n);
  });

  it("is out_of_range beyond the signed 64-bit range", () => {
    for (const raw of ["9223372036854775808", "-9223372036854775809", "99999999999999999999"]) {
      const r = checkContract(contract, { OFFSET: raw });
      expect(codes(r)).toEqual([["OFFSET", "out_of_range"]]);
      expect(r.violations[0]!.message).toContain("64-bit");
    }
    expect(codes(checkContract(contract, { CSV: "1,9223372036854775808" }))).toEqual([["CSV", "out_of_range"]]);
    expect(codes(checkContract(contract, { IDS: "[9223372036854775808]" }))).toEqual([["IDS", "out_of_range"]]);
  });

  it("compares bounds exactly beyond 2^53", () => {
    // 2^53 + 1 and 2^53 are the same double; as bigints they differ.
    const below = checkContract(contract, { BIG: "9007199254740992" });
    expect(codes(below)).toEqual([["BIG", "out_of_range"]]);
    expect(below.violations[0]!.message).toBe("must be at least 9007199254740993 (got 9007199254740992)");
    expect(codes(checkContract(contract, { BIG: "9223372036854775807" }))).toEqual([["BIG", "out_of_range"]]);
    expect(checkContract(contract, { BIG: "9223372036854775806" }).values["BIG"]).toBe(9223372036854775806n);
    expect(codes(checkContract(contract, { IDS: "[9223372036854775001]" }))).toEqual([["IDS", "out_of_range"]]);
  });

  it("reads exact bigint bounds from a contract object", () => {
    const decl = parseContract({ ...head, vars: { N: { type: "int", description: "A number", min: 2n ** 62n, max: 2n ** 63n - 1n } } });
    expect(decl.vars.get("N")!.min).toBe(2n ** 62n);
    expect(codes(checkContract(decl, { N: String(2n ** 62n - 1n) }))).toEqual([["N", "out_of_range"]]);
    expect(() => parseContract({ ...head, vars: { N: { type: "int", description: "A number", max: 2n ** 63n } } })).toThrow(DocuconfDeclarationError);
  });

  it("leaves declared variables in the safe range", () => {
    const decl: VarBase = { name: "N", type: "int", secret: false, required: false, contract: {} };
    const report = new VarReport(decl);
    expect(precheckVar(decl, "9007199254740992", report).ok).toBe(false);
    expect(report.violations[0]!.code).toBe("out_of_range");
    expect(intItem("9007199254740993", {})).toMatchObject({ code: "out_of_range" });
    expect(intItem("9007199254740993", {}, true)).toEqual({ value: 9007199254740993n });
  });

  it("parseJsonExact keeps big integer literals and leaves other numbers alone", () => {
    expect(parseJsonExact('[9007199254740993, 1.5, 1e300, 42, -9223372036854775808]')).toEqual([9007199254740993n, 1.5, 1e300, 42, -9223372036854775808n]);
  });
});

describe("json-schema in contract-first mode", () => {
  const schema = {
    type: "object",
    properties: {
      perMinute: { type: "integer", minimum: 1 },
      burst: { type: "integer", minimum: 0, exclusiveMaximum: 100 },
      name: { type: "string", minLength: 2, maxLength: 3, pattern: "\\A[a-z]+\\z" },
      tags: { type: "array", items: { enum: ["a", "b"] }, minItems: 1, maxItems: 2 },
      label: { type: "string", maxLength: 3 },
      mode: { const: "fast" },
      either: { anyOf: [{ type: "string" }, { type: "null" }] },
      format: { type: "string", format: "email" },
    },
    required: ["perMinute"],
    additionalProperties: false,
  };
  const contract = {
    ...head,
    vars: {
      LIMITS: { type: "json", description: "Rate limits", schema },
      TOKEN: { type: "json", description: "A secret document", secret: true, schema: { type: "object", properties: { key: { type: "string", maxLength: 3 } } } },
      ANY: { type: "json", description: "Anything at all" },
    },
  };
  const check = (env: Record<string, string>) => checkContract(contract, env);

  it("accepts a matching value", () => {
    const r = check({ LIMITS: '{"perMinute":1,"burst":99,"name":"ab","tags":["a"],"mode":"fast","either":null,"format":"not an email"}', ANY: "[1]" });
    expect(r.violations).toEqual([]);
    expect(r.values["LIMITS"]).toMatchObject({ perMinute: 1, burst: 99 });
  });

  it("reports schema_mismatch for every keyword", () => {
    for (const [value, fragment] of [
      ['{"perMinute":0}', "/perMinute: must be >= 1"],
      ['{"perMinute":1,"perHour":5}', "(root): must NOT have additional properties (perHour)"],
      ["{}", "must have required property 'perMinute'"],
      ['{"perMinute":1.5}', "must be integer"],
      ['{"perMinute":1,"burst":100}', "/burst: must be < 100"],
      ['{"perMinute":1,"name":"a"}', "/name: must NOT have fewer than 2 characters"],
      ['{"perMinute":1,"name":"abcd"}', "/name: must NOT have more than 3 characters"],
      ['{"perMinute":1,"name":"AB"}', "/name: must match pattern"],
      ['{"perMinute":1,"tags":[]}', "/tags: must NOT have fewer than 1 items"],
      ['{"perMinute":1,"tags":["c"]}', "/tags/0: must be equal to one of the allowed values"],
      ['{"perMinute":1,"mode":"slow"}', "/mode: must be equal to constant"],
      ['{"perMinute":1,"either":1}', "/either: must match a schema in anyOf"],
      ["[]", "(root): must be object"],
    ] as const) {
      const r = check({ LIMITS: value });
      expect(r.violations.length, value).toBeGreaterThan(0);
      expect(new Set(codes(r).map((c) => c.join(" "))), value).toEqual(new Set(["LIMITS schema_mismatch"]));
      expect(r.violations.map((v) => v.message).join("\n"), value).toContain(fragment);
      expect(r.values["LIMITS"]).toBeUndefined();
    }
  });

  it("counts lengths in code points", () => {
    expect(check({ LIMITS: '{"perMinute":1,"label":"😀😀😀"}' }).violations).toEqual([]);
    const r = check({ LIMITS: '{"perMinute":1,"label":"😀😀😀😀"}' });
    expect(codes(r)).toEqual([["LIMITS", "schema_mismatch"]]);
  });

  it("hides a secret's value", () => {
    const r = check({ TOKEN: '{"key":"hunter2"}' });
    expect(codes(r)).toEqual([["TOKEN", "schema_mismatch"]]);
    expect(JSON.stringify(r.violations)).not.toContain("hunter2");
  });

  it("lets validateJson replace the schema check", () => {
    const r = checkContract(contract, { LIMITS: '{"perMinute":0}' }, { validateJson: (_d, v) => ({ value: v }) });
    expect(r.violations).toEqual([]);
  });

  it("rejects a schema with a keyword it does not know, a non-RE2 pattern or a bad shape", () => {
    const problems = (s: unknown) => {
      try {
        parseContract({ ...head, vars: { J: { type: "json", description: "A document", schema: s } } });
      } catch (e) {
        return (e as DocuconfDeclarationError).problems;
      }
      return [];
    };
    expect(problems({ type: "object", propertyNames: { maxLength: 3 }, frobnicate: true })).toEqual(['J: schema: unknown keyword: "frobnicate"']);
    expect(problems({ type: "string", pattern: "(?=a)b" })[0]).toMatch(/^J: schema: pattern "\(\?=a\)b": lookahead/);
    expect(problems([1])).toEqual(["J: schema: must be a JSON Schema object"]);
    expect(problems({ type: "strin" })[0]).toMatch(/^J: schema: /);
  });

  it("keeps numbers in a json default and schema as numbers", () => {
    const decl = parseContract(`{"apiVersion":"docuconf.dev/v1alpha1","kind":"ConfigContract","vars":{"J":{"type":"json","description":"A document","schema":{"type":"integer","maximum":100000000000000000000},"default":12345678901234567890}}}`);
    expect(decl.vars.get("J")!.default).toBe(12345678901234567890);
    expect(codes(checkContract(decl, { J: "100000000000000000001" }))).toEqual([]);
    expect(codes(checkContract(decl, { J: "200000000000000000000" }))).toEqual([["J", "schema_mismatch"]]);
  });
});
