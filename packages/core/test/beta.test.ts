/**
 * The beta features in @docuconf/core: the KeySet value, deprecated rules,
 * strict parsing, and contract-first files, profiles and overlays beyond
 * what the shared suite covers.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inspect } from "node:util";
import { createHmac, timingSafeEqual } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  DocuconfDeclarationError,
  KeySet,
  VarReport,
  type VarBase,
  checkContract,
  deprecatedProblems,
  formatSignedDuration,
  keySetDeclProblems,
  parseContract,
  parseDuration,
  precheckVar,
} from "../src/index.ts";

const head = { apiVersion: "docuconf.dev/v1alpha1", kind: "ConfigContract", metadata: { name: "t" } };
const codes = (r: { violations: Array<{ input: string; code: string }> }) => r.violations.map((v) => [v.input, v.code]);

describe("KeySet", () => {
  const keys = new KeySet(["old-key-0123456789", "new-key-0123456789"]);

  it("keeps the keys in order", () => {
    expect(keys.keys()).toEqual(["old-key-0123456789", "new-key-0123456789"]);
    expect(keys.size).toBe(2);
    keys.keys().push("x");
    expect(keys.size).toBe(2);
  });

  it("contains each key, and nothing else", () => {
    expect(keys.contains("old-key-0123456789")).toBe(true);
    expect(keys.contains("new-key-0123456789")).toBe(true);
    for (const other of ["", "old-key", "old-key-0123456789x", "OLD-KEY-0123456789", "日本"]) expect(keys.contains(other)).toBe(false);
  });

  it("verifies with every key, even after one matches", () => {
    const body = "payload";
    const sig = createHmac("sha256", "old-key-0123456789").update(body).digest();
    const tried: string[] = [];
    const ok = keys.verify((key) => {
      tried.push(key);
      return timingSafeEqual(createHmac("sha256", key).update(body).digest(), sig);
    });
    expect(ok).toBe(true);
    expect(tried).toEqual(["old-key-0123456789", "new-key-0123456789"]);
    expect(keys.verify(() => false)).toBe(false);
  });

  it("never prints a key", () => {
    for (const shown of [String(keys), `${keys}`, JSON.stringify({ keys }), inspect(keys), inspect({ keys }, { depth: 5 })]) {
      expect(shown).not.toContain("key-0123456789");
      expect(shown).toContain("[redacted]");
    }
  });

  it("rejects bounds that cannot hold a key", () => {
    expect(keySetDeclProblems({ minKeys: 0 })).toEqual(["minKeys must be an integer of at least 1"]);
    expect(keySetDeclProblems({ minKeys: 3 })).toEqual(["maxKeys 2 is below minKeys 3"]);
    expect(keySetDeclProblems({ keyMinLength: 0, keyMaxLength: 8 })).toEqual(["keyMinLength must be an integer of at least 1"]);
    expect(keySetDeclProblems({ keyMinLength: 9, keyMaxLength: 8 })).toEqual(["keyMaxLength 8 is below keyMinLength 9"]);
    expect(keySetDeclProblems({ minKeys: 2, maxKeys: 3, keyMinLength: 1 })).toEqual([]);
  });
});

describe("keySet in contract-first mode", () => {
  const contract = { ...head, vars: { KEYS: { type: "keySet", description: "Keys that verify", secret: true, keyMinLength: 8 } } };

  it("must be secret", () => {
    expect(() => parseContract({ ...head, vars: { KEYS: { type: "keySet", description: "Keys that verify" } } })).toThrow(/always secret/);
  });

  it("reports each problem by position and length, never the key", () => {
    const r = checkContract(contract, { KEYS: "short,,longer-key" });
    expect(codes(r)).toEqual([
      ["KEYS", "out_of_range"],
      ["KEYS", "out_of_range"],
      ["KEYS", "too_many_items"],
    ]);
    const text = r.violations.map((v) => v.message).join("\n");
    expect(text).toContain("key 1 is 5 characters, below keyMinLength 8");
    expect(text).toContain("key 2 is empty");
    expect(text).not.toMatch(/short|longer-key/);
  });

  it("is a KeySet", () => {
    const r = checkContract(contract, { KEYS: "first-key,second-key" });
    expect(r.values["KEYS"]).toBeInstanceOf(KeySet);
    expect((r.values["KEYS"] as KeySet).keys()).toEqual(["first-key", "second-key"]);
  });
});

describe("deprecated", () => {
  it("needs a message that is not blank, at most 500 characters", () => {
    expect(deprecatedProblems({ message: " " }, false)).toEqual(["deprecated.message must not be blank"]);
    expect(deprecatedProblems({ message: "x".repeat(501) }, false)).toEqual(["deprecated.message is 501 characters, more than 500"]);
    expect(deprecatedProblems({ message: "日".repeat(500) }, false)).toEqual([]);
    expect(deprecatedProblems({ message: "Use PORT", replacedBy: "port" }, false)).toEqual(["deprecated.replacedBy must be an input name matching ^[A-Z][A-Z0-9_]*$"]);
  });

  it("is not allowed on a required input", () => {
    expect(deprecatedProblems({ message: "Use PORT instead" }, true)).toEqual([
      "a required input cannot be deprecated: the platform could not stop setting it; make it optional first",
    ]);
    const vars = { OLD: { type: "int", description: "Old listen port", required: true, deprecated: { message: "Use PORT instead" } } };
    expect(() => parseContract({ ...head, vars })).toThrow(DocuconfDeclarationError);
  });

  it("warns when a deprecated input is set, naming it and the message, never the value", () => {
    const vars = {
      OLD_TOKEN: { type: "string", description: "Token of the old API", secret: true, deprecated: { message: "The old API is gone" } },
      OLD_PORT: { type: "int", description: "Old listen port", deprecated: { message: "Use PORT instead", replacedBy: "PORT" } },
    };
    const r = checkContract({ ...head, vars }, { OLD_TOKEN: "tok-secret-value", OLD_PORT: "9090" });
    expect(r.warnings).toEqual(["OLD_TOKEN is deprecated: The old API is gone", "OLD_PORT is deprecated: Use PORT instead"]);
    expect(checkContract({ ...head, vars }, {}).warnings).toEqual([]);
  });
});

describe("strict parsing (SPEC §5)", () => {
  const decl = (type: VarBase["type"]): VarBase => ({ name: "X", type, secret: false, required: false, contract: {} });
  const pre = (type: VarBase["type"], raw: string) => precheckVar(decl(type), raw, new VarReport(decl(type))).ok;

  it("takes true and false in any case, and nothing else, for a bool", () => {
    for (const ok of ["true", "FALSE", "tRuE"]) expect(pre("bool", ok)).toBe(true);
    for (const bad of ["1", "0", "yes", "on", "t", " true", "true\n"]) expect(pre("bool", bad)).toBe(false);
  });

  it("takes only decimal floats with digits on both sides of the point", () => {
    for (const ok of ["1.5", "+1.5", "1E3", "25e-2", "007.5"]) expect(pre("float", ok)).toBe(true);
    for (const bad of [".5", "5.", "inf", "NaN", "Infinity", "0x1p4", "1_0", "1e400", "0,5", " 1"]) expect(pre("float", bad)).toBe(false);
  });

  it("parses Go durations with a sign, truncated to nanoseconds, within ±2^63-1 ns", () => {
    expect(formatSignedDuration(parseDuration("-1m30s")!)).toBe("-1m30s");
    expect(formatSignedDuration(parseDuration("+5s")!)).toBe("5s");
    expect(formatSignedDuration(parseDuration("1500us")!)).toBe("1ms500us");
    expect(parseDuration("2562047h47m16.854775807s")).toBeDefined();
    expect(parseDuration("2562047h47m16.854775808s")).toBeUndefined();
  });
});

describe("contract-first files, profiles and overlays", () => {
  const root = mkdtempSync(join(tmpdir(), "docuconf-beta-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };

  it("reads files under DOCUCONF_FILE_ROOT and warns for a deprecated file that is present", () => {
    write("/etc/app/motd/motd.txt", "hello");
    const contract = {
      ...head,
      vars: {},
      files: { motd: { type: "text", description: "Message of the day", path: "/etc/app/motd/motd.txt", deprecated: { message: "Use the banner instead" } } },
    };
    const r = checkContract(contract, { DOCUCONF_FILE_ROOT: root });
    expect(r.violations).toEqual([]);
    expect(r.files["motd"]).toBe("hello");
    expect(r.warnings).toEqual(["motd is deprecated: Use the banner instead"]);
  });

  it("rejects a profile default that breaks its variable's constraints", () => {
    const vars = { APP_ENV: { type: "string", description: "Profile selector" }, PORT: { type: "int", description: "Listen port", max: 100 } };
    const profiles = { selector: "APP_ENV", default: "prod", defaults: { prod: { PORT: 8080 } } };
    expect(() => parseContract({ ...head, vars, profiles })).toThrow(/profiles: defaults.prod: PORT must be at most 100/);
  });

  it("never takes a secret from an overlay, and never prints it", () => {
    write("/app/config/o.json", '{"Db": {"Password": "hunter2-secret"}}');
    const contract = {
      ...head,
      vars: { DB_PASSWORD: { type: "string", description: "Database password", secret: true, configKey: "Db:Password" } },
      overlays: { platform: { format: "json", path: "/app/config/o.json", keySeparator: ":" } },
    };
    const r = checkContract(contract, { DOCUCONF_FILE_ROOT: root });
    expect(codes(r)).toEqual([["DB_PASSWORD", "invalid_type"]]);
    expect(r.violations[0]!.message).not.toContain("hunter2");
  });

  it("warns when the environment and an overlay both set a variable", () => {
    write("/app/config2/o.yaml", "App:\n  Port: 30\n");
    const contract = {
      ...head,
      vars: { PORT: { type: "int", description: "Listen port", configKey: "App.Port" } },
      overlays: { platform: { format: "yaml", path: "/app/config2/o.yaml", keySeparator: "." } },
    };
    const r = checkContract(contract, { DOCUCONF_FILE_ROOT: root, PORT: "40" });
    expect(r.values["PORT"]).toBe(40);
    expect(r.warnings).toEqual(["PORT is set in the environment and in overlay platform; the environment wins"]);
    expect(checkContract(contract, { DOCUCONF_FILE_ROOT: root }).values["PORT"]).toBe(30);
  });
});
