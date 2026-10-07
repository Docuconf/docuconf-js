// src/config/env.validation.spec.ts
import { describe, expect, it } from "vitest";
import { validate } from "./env.validation";

const deployed = { DATABASE_URL: "postgres://orders:secret@db:5432/orders" };

describe("orders configuration", () => {
  it("accepts what a deployment sets", () => {
    const { values, violations } = validate.check({ ...deployed, REQUEST_TIMEOUT: "1m30s" });
    expect(violations).toEqual([]);
    expect(values.REQUEST_TIMEOUT).toBe(90_000);
  });

  it("rejects port 0 and a missing database", () => {
    const { violations } = validate.check({ PORT: "0" });
    expect(violations.map((v) => `${v.input} ${v.code}`)).toEqual(["PORT out_of_range", "DATABASE_URL missing_required"]);
  });
});
