/** @KeySet(), deprecated rules and strict parsing in @docuconf/nestjs. */
import "reflect-metadata";
import { inspect } from "node:util";
import { IsBoolean, IsNumber, IsOptional, IsString } from "class-validator";
import { describe, expect, it } from "vitest";
import { Deprecated, Describe, DocuconfDeclarationError, KeySet, docuconfValidate, toContract } from "../src/index.ts";
import { KeySet as CoreKeySet } from "@docuconf/core";

const KEY_A = "old-webhook-key-0123456789abcdef0123";
const KEY_B = "new-webhook-key-0123456789abcdef0123";

class Env {
  /** Keys that verify the signature on incoming payment webhooks. */
  @KeySet({ keyMinLength: 32, keyMaxLength: 256 })
  @IsOptional()
  @Describe("Keys that verify webhook signatures")
  WEBHOOK_KEYS?: KeySet;

  @IsOptional() @IsString() @Deprecated({ message: "The old API is gone" }) @Describe("Token of the old API")
  OLD_TOKEN?: string;

  @IsOptional() @IsBoolean() @Describe("A switch")
  FLAG?: boolean;

  @IsOptional() @IsNumber() @Describe("A ratio")
  RATIO?: number;
}

describe("@KeySet()", () => {
  const validate = docuconfValidate(Env, { terminationLog: false, onWarning: () => {} });

  it("exports a secret keySet with its bounds", () => {
    const contract = toContract(Env, { name: "keys" }).replace(/\s+/g, " ");
    expect(contract).toContain(
      'WEBHOOK_KEYS: { type: "keySet" description: "Keys that verify webhook signatures" secret: true encoding: "csv" separator: "," minKeys: 1 maxKeys: 2 keyMinLength: 32 keyMaxLength: 256 }',
    );
  });

  it("is a KeySet of the keys, in order, that never prints a key", () => {
    const config = validate({ WEBHOOK_KEYS: `${KEY_A},${KEY_B}` });
    expect(config.WEBHOOK_KEYS).toBeInstanceOf(CoreKeySet);
    expect(config.WEBHOOK_KEYS?.keys()).toEqual([KEY_A, KEY_B]);
    expect(config.WEBHOOK_KEYS?.contains(KEY_A)).toBe(true);
    expect(inspect(config)).not.toContain("webhook-key");
    expect(JSON.stringify(config)).not.toContain("webhook-key");
  });

  it("reports an empty key or a third key without printing any key", () => {
    const r = validate.check({ WEBHOOK_KEYS: `${KEY_A},` });
    expect(r.violations.map((v) => [v.input, v.code, v.message])).toEqual([["WEBHOOK_KEYS", "out_of_range", "key 2 is empty"]]);
    const many = validate.check({ WEBHOOK_KEYS: `${KEY_A},${KEY_B},${KEY_A}` });
    expect(many.violations.map((v) => v.code)).toEqual(["too_many_items"]);
    expect(JSON.stringify(many.violations)).not.toContain("webhook-key");
  });
});

describe("deprecated", () => {
  it("rejects a required deprecated variable", () => {
    class Bad {
      @IsString() @Deprecated({ message: "Use NEW instead" }) @Describe("The old name")
      OLD!: string;
    }
    expect(() => docuconfValidate(Bad, { terminationLog: false })).toThrow(DocuconfDeclarationError);
    expect(() => docuconfValidate(Bad, { terminationLog: false })).toThrow(/OLD: @Deprecated: a required input cannot be deprecated/);
  });

  it("warns when a deprecated variable is set, never printing the value", () => {
    const warnings: string[] = [];
    docuconfValidate(Env, { terminationLog: false, onWarning: (m) => warnings.push(m) })({ OLD_TOKEN: "tok-hidden" });
    expect(warnings).toEqual(["OLD_TOKEN is deprecated: The old API is gone"]);
  });
});

describe("strict parsing (SPEC §5)", () => {
  const validate = docuconfValidate(Env, { terminationLog: false, onWarning: () => {} });
  const codes = (config: Record<string, string>) => validate.check(config).violations.map((v) => `${v.input} ${v.code}`);

  it("takes true and false in any case for a bool, and nothing else", () => {
    expect(validate.check({ FLAG: "TRUE" }).values.FLAG).toBe(true);
    for (const bad of ["1", "yes", "on", "false "]) expect(codes({ FLAG: bad })).toEqual(["FLAG invalid_type"]);
  });

  it("takes only decimal floats", () => {
    expect(validate.check({ RATIO: "+1.5" }).values.RATIO).toBe(1.5);
    for (const bad of [".5", "5.", "Infinity", "1e400"]) expect(codes({ RATIO: bad })).toEqual(["RATIO invalid_type"]);
  });
});
