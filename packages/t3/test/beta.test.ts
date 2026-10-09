/** keySet(), deprecated rules and strict parsing in @docuconf/t3. */
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DocuconfDeclarationError, DocuconfValidationError, KeySet, annotate, checkEnv, createEnv, int64, json, keySet, textFile, toContract } from "../src/index.ts";

const quiet = { terminationLog: false as const, onWarning: () => {} };
const KEY_A = "old-webhook-key-0123456789abcdef0123";
const KEY_B = "new-webhook-key-0123456789abcdef0123";

function failure(fn: () => unknown): DocuconfValidationError {
  try {
    fn();
  } catch (e) {
    if (e instanceof DocuconfValidationError) return e;
    throw e;
  }
  throw new Error("expected validation to fail");
}

describe("keySet()", () => {
  const server = {
    WEBHOOK_KEYS: keySet({ keyMinLength: 32, keyMaxLength: 256 }).optional().describe("Keys that verify webhook signatures"),
    API_KEYS: keySet({ maxKeys: 3, separator: ";" }).describe("Keys that callers present"),
  };
  const load = (runtimeEnv: Record<string, string>) => createEnv({ server, runtimeEnv, ...quiet });

  it("exports a secret keySet with its bounds", () => {
    const contract = toContract(load({ API_KEYS: "a" }), { name: "keys" });
    expect(contract.replace(/\s+/g, " ")).toContain(
      'WEBHOOK_KEYS: { type: "keySet" description: "Keys that verify webhook signatures" secret: true encoding: "csv" separator: "," minKeys: 1 maxKeys: 2 keyMinLength: 32 keyMaxLength: 256 }',
    );
    expect(contract).toMatch(/API_KEYS: \{[^}]*required: +true[^}]*secret: +true[^}]*separator: +";"[^}]*maxKeys: +3/);
  });

  it("is a KeySet of the keys, in order", () => {
    const env = load({ WEBHOOK_KEYS: `${KEY_A},${KEY_B}`, API_KEYS: "one;two" });
    expect(env.WEBHOOK_KEYS).toBeInstanceOf(KeySet);
    expect(env.WEBHOOK_KEYS?.keys()).toEqual([KEY_A, KEY_B]);
    expect(env.WEBHOOK_KEYS?.contains(KEY_B)).toBe(true);
    expect(env.API_KEYS.contains("three")).toBe(false);
    expect(inspect(env)).not.toContain("webhook-key");
    expect(JSON.stringify(env)).not.toContain("webhook-key");
  });

  it("reports an empty, short or extra key without printing any key", () => {
    for (const [raw, code] of [
      [`${KEY_A},`, "out_of_range"],
      [`${KEY_A},short-key`, "out_of_range"],
      ["k".repeat(257), "out_of_range"],
      [`${KEY_A},${KEY_B},${KEY_A}`, "too_many_items"],
    ] as const) {
      const e = failure(() => load({ WEBHOOK_KEYS: raw, API_KEYS: "one" }));
      expect(e.violations.map((v) => [v.input, v.code])).toEqual([["WEBHOOK_KEYS", code]]);
      expect(e.message).not.toMatch(/webhook-key|short-key|kkkk/);
    }
    const e = failure(() => load({ WEBHOOK_KEYS: `${KEY_A},`, API_KEYS: "one" }));
    expect(e.violations[0]!.message).toBe("key 2 is empty");
  });

  it("is always secret, so it takes no default", () => {
    expect(() => createEnv({ server: { K: keySet().default(new KeySet(["k"])).describe("Some signing keys") }, runtimeEnv: {}, ...quiet })).toThrow(
      DocuconfDeclarationError,
    );
    expect(() => keySet({ minKeys: 0 })).toThrow("keySet(): minKeys must be an integer of at least 1");
  });
});

describe("deprecated", () => {
  it("rejects a required deprecated variable, and a blank message", () => {
    const e = (() => {
      try {
        createEnv({
          server: {
            OLD: annotate(z.string(), { deprecated: { message: "Use NEW instead" } }).describe("The old name"),
            GONE: annotate(z.string().optional(), { deprecated: { message: "  " } }).describe("A retired input"),
          },
          runtimeEnv: {},
          ...quiet,
        });
      } catch (err) {
        return err as DocuconfDeclarationError;
      }
      throw new Error("expected a declaration error");
    })();
    expect(e.problems).toEqual([
      "OLD: a required input cannot be deprecated: the platform could not stop setting it; make it optional first",
      "GONE: deprecated.message must not be blank",
    ]);
  });

  it("warns at boot for a deprecated variable that is set, naming the message, never the value, and not for an absent file", () => {
    const warnings: string[] = [];
    createEnv({
      server: {
        OLD_TOKEN: annotate(z.string().optional(), { deprecated: { message: "The old API is gone" } }).describe("Token of the old API"),
        OLD_PORT: annotate(z.coerce.number().int().optional(), { deprecated: { message: "Use PORT", replacedBy: "PORT" } }).describe("Old listen port"),
      },
      files: { motd: textFile({ path: "/nonexistent/motd/motd.txt", description: "Message of the day", deprecated: { message: "Use the banner" } }) },
      runtimeEnv: { OLD_TOKEN: "tok-hidden-value", OLD_PORT: "9090" },
      terminationLog: false,
      onWarning: (m) => warnings.push(m),
    });
    expect(warnings).toEqual(["OLD_TOKEN is deprecated: The old API is gone", "OLD_PORT is deprecated: Use PORT"]);
  });
});

describe("strict parsing (SPEC §5)", () => {
  const server = {
    FLAG: z.stringbool().optional().describe("A switch"),
    RATIO: z.coerce.number().optional().describe("A ratio"),
  };
  const run = (runtimeEnv: Record<string, string>) => {
    try {
      return createEnv({ server, runtimeEnv, ...quiet });
    } catch (e) {
      return (e as DocuconfValidationError).violations.map((v) => `${v.input} ${v.code}`);
    }
  };

  it("takes true and false in any case for a bool, and nothing else", () => {
    expect((run({ FLAG: "TRUE" }) as { FLAG: boolean }).FLAG).toBe(true);
    expect((run({ FLAG: "False" }) as { FLAG: boolean }).FLAG).toBe(false);
    for (const bad of ["1", "yes", "on", " true"]) expect(run({ FLAG: bad })).toEqual(["FLAG invalid_type"]);
  });

  it("takes only decimal floats", () => {
    expect((run({ RATIO: "25e-2" }) as { RATIO: number }).RATIO).toBe(0.25);
    for (const bad of [".5", "5.", "Infinity", "1e400", "0x1p4"]) expect(run({ RATIO: bad })).toEqual(["RATIO invalid_type"]);
  });
});

describe("int64()", () => {
  const env = createEnv({
    server: {
      OFFSET: int64().optional().describe("Starting offset"),
      SHARD: int64({ min: 0, max: 9_223_372_036_854_775_000n }).optional().describe("Shard number"),
      LIMITS: json(z.strictObject({ burst: int64({ min: 1 }) })).optional().describe("Rate limits"),
    },
    runtimeEnv: {},
    ...quiet,
  });

  it("exports an int bounded only by its own min and max", () => {
    const contract = toContract(env, { name: "ints" }).replace(/\s+/g, " ");
    expect(contract).toContain('OFFSET: { type: "int" description: "Starting offset" }');
    expect(contract).toContain('SHARD: { type: "int" description: "Shard number" min: 0 max: 9223372036854775000 }');
    expect(contract).toContain('burst: { type: "integer" minimum: 1 }');
  });

  it("holds the whole 64-bit range exactly", () => {
    expect(checkEnv(env, { OFFSET: "-9223372036854775808" }).values.OFFSET).toBe(-9223372036854775808n);
    expect(checkEnv(env, { OFFSET: "+007" }).values.OFFSET).toBe(7);
    expect(checkEnv(env, { OFFSET: "9223372036854775808" }).violations.map((v) => v.code)).toEqual(["out_of_range"]);
    expect(checkEnv(env, { OFFSET: "1e3" }).violations.map((v) => v.code)).toEqual(["invalid_type"]);
    expect(checkEnv(env, { SHARD: "9223372036854775001" }).violations.map((v) => v.code)).toEqual(["out_of_range"]);
    expect(checkEnv(env, { LIMITS: '{"burst": 5}' }).values.LIMITS).toEqual({ burst: 5 });
    expect(checkEnv(env, { LIMITS: '{"burst": 0}' }).violations.map((v) => v.code)).toEqual(["out_of_range"]);
  });
});
