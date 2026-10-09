import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { KeySet } from "@docuconf/nestjs";
import { validate } from "../src/orders.config.ts";
import { verify } from "../src/webhook.ts";

const oldKey = "o".repeat(32);
const newKey = "n".repeat(32);
const body = '{"order":"42","status":"paid"}';
const base = { DATABASE_URL: "postgres://orders:pw@db:5432/orders" };

const sign = (key: string) => createHmac("sha256", key).update(body).digest("hex");

/** WEBHOOK_KEYS as the service loads it at boot. */
function keys(value: string): KeySet | undefined {
  const { values, violations } = validate.check({ ...base, WEBHOOK_KEYS: value });
  expect(violations).toEqual([]);
  return values.WEBHOOK_KEYS;
}

describe("WEBHOOK_KEYS", () => {
  // Each step is a rollout with a new WEBHOOK_KEYS; a webhook signed with
  // the key in use always verifies.
  it.each([
    { step: "before", value: oldKey, accepts: { [oldKey]: true, [newKey]: false } },
    { step: "overlap", value: `${oldKey},${newKey}`, accepts: { [oldKey]: true, [newKey]: true } },
    { step: "after", value: newKey, accepts: { [oldKey]: false, [newKey]: true } },
  ])("rotation step $step", ({ value, accepts }) => {
    const ks = keys(value);
    for (const [key, want] of Object.entries(accepts)) expect(verify(ks, body, sign(key))).toBe(want);
  });

  it("rejects an unsigned, malformed or foreign signature, and everything without keys", () => {
    const ks = keys(oldKey);
    expect(verify(ks, body, undefined)).toBe(false);
    expect(verify(ks, body, "not hex")).toBe(false);
    expect(verify(ks, body, sign("x".repeat(32)))).toBe(false);
    expect(verify(ks, `${body} `, sign(oldKey))).toBe(false);
    expect(verify(undefined, body, sign(oldKey))).toBe(false);
  });

  it("is optional, and an empty value is unset", () => {
    expect(validate.check(base).violations).toEqual([]);
    expect(validate.check({ ...base, WEBHOOK_KEYS: "" }).values.WEBHOOK_KEYS).toBeUndefined();
  });

  // The key set's constraints catch an empty or truncated key, and a third
  // key, at boot, without printing any key.
  it.each([
    { name: "an empty second key", value: `${oldKey},`, code: "out_of_range" },
    { name: "a truncated key", value: `${oldKey},${newKey.slice(0, 10)}`, code: "out_of_range" },
    { name: "a third key", value: `${oldKey},${newKey},${"x".repeat(32)}`, code: "too_many_items" },
  ])("fails $name with $code, without printing a key", ({ value, code }) => {
    const { violations } = validate.check({ ...base, WEBHOOK_KEYS: value });
    expect(violations.map((v) => [v.input, v.code])).toEqual([["WEBHOOK_KEYS", code]]);
    expect(() => validate({ ...base, WEBHOOK_KEYS: value })).toThrow(/WEBHOOK_KEYS/);
    const text = JSON.stringify(violations);
    expect(text).not.toContain(oldKey);
    expect(text).not.toContain(newKey.slice(0, 10));
  });
});
