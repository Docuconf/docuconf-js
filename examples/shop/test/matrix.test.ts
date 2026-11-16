/**
 * The shop example's test matrix, the same in every docuconf SDK: roles
 * (SPEC §4.9), requiredIf (SPEC §4.2.1) and the included otel@1 fragment
 * (SPEC §4.8). Each case starts from the base env and a fresh, empty file root.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DocuconfValidationError, type Violation } from "@docuconf/core";
import { type ShopConfig, loadShop, summary } from "../src/config.ts";

const base = { DATABASE_URL: "postgres://shop@db:5432/shop" };
const keyPath = "/etc/shop/webhooks/signing.key";
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "docuconf-shop-"));
  roots.push(root);
  return root;
}

function writeKey(root: string, key: string): void {
  const path = join(root, keyPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, key);
}

/** The config, or the violations loadShop throws. */
function load(env: Record<string, string>, root = freshRoot()): { config?: ShopConfig; violations: readonly Violation[] } {
  try {
    return { config: loadShop({ env: { ...base, ...env }, fileRoot: root, terminationLog: false, watch: false }), violations: [] };
  } catch (e) {
    if (!(e instanceof DocuconfValidationError)) throw e;
    return { violations: e.violations };
  }
}

const ok = (env: Record<string, string>, root?: string): string => {
  const { config, violations } = load(env, root);
  expect(violations).toEqual([]);
  return summary(config!);
};
const codes = (env: Record<string, string>) => load(env).violations.map((v) => [v.input, v.code]);
const only = (env: Record<string, string>): Violation => {
  const { violations } = load(env);
  expect(violations).toHaveLength(1);
  return violations[0]!;
};

describe("shop matrix", () => {
  it("1: web with ALLOWED_ORIGINS is ok", () => {
    expect(ok({ DOCUCONF_ROLE: "web", ALLOWED_ORIGINS: "https://shop.example" })).toBe("shop web: port 8080, origins https://shop.example");
  });

  it("2: worker with QUEUES is ok, without ALLOWED_ORIGINS", () => {
    expect(ok({ DOCUCONF_ROLE: "worker", QUEUES: "default,mail" })).toBe("shop worker: queues default,mail, webhooks off");
  });

  it("3: web without ALLOWED_ORIGINS is missing_required", () => {
    expect(codes({ DOCUCONF_ROLE: "web" })).toEqual([["ALLOWED_ORIGINS", "missing_required"]]);
  });

  it("4: no role is DOCUCONF_ROLE missing_required, and nothing else", () => {
    expect(codes({ QUEUES: "default" })).toEqual([["DOCUCONF_ROLE", "missing_required"]]);
  });

  it("5: an unknown role is DOCUCONF_ROLE not_in_enum, and nothing else", () => {
    expect(codes({ DOCUCONF_ROLE: "cron" })).toEqual([["DOCUCONF_ROLE", "not_in_enum"]]);
  });

  it('6: LOG_FORMAT=json requires LOG_SCHEMA_URL', () => {
    const v = only({ DOCUCONF_ROLE: "worker", QUEUES: "default", LOG_FORMAT: "json" });
    expect([v.input, v.code]).toEqual(["LOG_SCHEMA_URL", "missing_required"]);
    expect(v.message).toContain('is required when LOG_FORMAT is "json"');
  });

  it("7: LOG_FORMAT=json with LOG_SCHEMA_URL is ok", () => {
    const env = { DOCUCONF_ROLE: "worker", QUEUES: "default", LOG_FORMAT: "json", LOG_SCHEMA_URL: "https://logs.example/v1.json" };
    expect(ok(env)).toBe("shop worker: queues default, webhooks off");
  });

  it("8: WEBHOOKS_ENABLED=true without the key file is file_missing", () => {
    const v = only({ DOCUCONF_ROLE: "worker", QUEUES: "default", WEBHOOKS_ENABLED: "true" });
    expect([v.input, v.code]).toEqual(["webhook-signing-key", "file_missing"]);
    expect(v.message).toContain(", and is required when WEBHOOKS_ENABLED is true");
  });

  it("9: WEBHOOKS_ENABLED=true with a 32+ character key file is ok, webhooks on", () => {
    const root = freshRoot();
    writeKey(root, "k".repeat(40));
    expect(ok({ DOCUCONF_ROLE: "worker", QUEUES: "default", WEBHOOKS_ENABLED: "true" }, root)).toBe("shop worker: queues default, webhooks on");
  });

  it("10: web ignores WEBHOOKS_ENABLED: the key file belongs to the worker", () => {
    expect(ok({ DOCUCONF_ROLE: "web", ALLOWED_ORIGINS: "https://shop.example", WEBHOOKS_ENABLED: "true" })).toBe(
      "shop web: port 8080, origins https://shop.example",
    );
  });

  it("11: the otel@1 fragment's variables are checked at boot", () => {
    expect(codes({ DOCUCONF_ROLE: "web", ALLOWED_ORIGINS: "https://shop.example", OTEL_EXPORTER_OTLP_PROTOCOL: "carrier-pigeon" })).toEqual([
      ["OTEL_EXPORTER_OTLP_PROTOCOL", "not_in_enum"],
    ]);
  });
});

describe("shop", () => {
  it("prints the worker's queues from the typed list", () => {
    const { config } = load({ DOCUCONF_ROLE: "worker", QUEUES: "mail,default" });
    expect(config!.QUEUES).toEqual(["mail", "default"]);
    expect(summary({ ...config!, QUEUES: ["a", "b"] })).toBe("shop worker: queues a,b, webhooks off");
  });

  it("never prints a secret", () => {
    const secretKey = "short-secret-key";
    const root = freshRoot();
    writeKey(root, secretKey);
    const { violations } = load({ DOCUCONF_ROLE: "worker", QUEUES: "default", WEBHOOKS_ENABLED: "true", DATABASE_URL: "mysql://shop:hunter2@db/shop" }, root);
    expect(violations.map((v) => [v.input, v.code])).toEqual([
      ["DATABASE_URL", "invalid_scheme"],
      ["webhook-signing-key", "out_of_range"],
    ]);
    const text = violations.map((v) => v.message).join("\n");
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain(secretKey);
  });
});
