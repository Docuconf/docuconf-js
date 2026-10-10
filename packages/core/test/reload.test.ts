/**
 * `reload: watch` as an app uses it: change listeners, the reload status,
 * the keystore password a reload reuses, and contract-first mode reloading
 * its file inputs. Also the one wording of an empty key.
 */
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  DocuconfDeclarationError,
  type Keystore,
  type TlsMaterial,
  checkContract,
  closeWatchers,
  loadContract,
  onFileChange,
  parseContract,
  reloadFile,
  reloadStatus,
} from "../src/index.ts";
import { type Issued, days, fileRoot, issue, pkcs12 } from "./support/certs.ts";
import { writeUntilChanged } from "./support/watch.ts";

const head = { apiVersion: "docuconf.dev/v1alpha1", kind: "ConfigContract", metadata: { name: "t" } };

const contract = {
  ...head,
  vars: { KS_PASSWORD: { type: "string", description: "Keystore password", secret: true } },
  files: {
    settings: {
      type: "config",
      format: "json",
      path: "/etc/app/settings/s.json",
      description: "JSON settings",
      reload: "watch",
      schema: { type: "object", properties: { level: { type: "integer", minimum: 1 } }, required: ["level"] },
    },
    "serving-tls": { type: "tls", path: "/etc/app/tls", description: "Serving certificate", secret: true, reload: "watch", dnsNames: ["app.internal"] },
    partner: {
      type: "keystore",
      format: "pkcs12",
      path: "/etc/app/ks/ks.p12",
      description: "Partner keystore",
      secret: true,
      passwordVar: "KS_PASSWORD",
      reload: "watch",
    },
  },
};

let ca: Issued;
let leaf: Issued;
beforeAll(() => {
  ca = issue({ cn: "Test Root CA", isCA: true, notAfter: days(3650) });
  leaf = issue({ cn: "app.internal", dnsNames: ["app.internal"], ca });
});

const envs: object[] = [];
afterAll(() => envs.forEach(closeWatchers));

function boot(watch = false) {
  const fr = fileRoot();
  fr.write("/etc/app/settings/s.json", '{"level":1}');
  fr.tls("/etc/app/tls", leaf);
  fr.write("/etc/app/ks/ks.p12", pkcs12(leaf, "right-password"));
  const given = { KS_PASSWORD: "right-password", DOCUCONF_FILE_ROOT: fr.root };
  const env = loadContract(contract, { env: given, terminationLog: false, watch });
  envs.push(env);
  return { fr, env, given };
}

/** Silences console.error and returns what it was called with. */
function captureErrors() {
  const calls: string[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void calls.push(args.map(String).join(" ")));
  return { lines: () => calls, restore: () => spy.mockRestore() };
}

describe("onFileChange", () => {
  it("is called with the new value after an accepted change, and never for a rejected one", () => {
    const { fr, env } = boot();
    const seen: unknown[] = [];
    const also: unknown[] = [];
    onFileChange(env, "settings", (v) => seen.push(v));
    const off = onFileChange(env, "settings", (v) => also.push(v));

    fr.write("/etc/app/settings/s.json", '{"level":2}');
    expect(reloadFile(env, "settings")).toBe(true);
    expect(seen).toEqual([{ level: 2 }]);
    expect(also).toEqual([{ level: 2 }]);
    expect(env["settings"]).toEqual({ level: 2 });

    const errors = captureErrors();
    fr.write("/etc/app/settings/s.json", '{"level":0}');
    expect(reloadFile(env, "settings")).toBe(false);
    errors.restore();
    expect(seen).toEqual([{ level: 2 }]);
    expect(env["settings"]).toEqual({ level: 2 });

    off();
    fr.write("/etc/app/settings/s.json", '{"level":3}');
    expect(reloadFile(env, "settings")).toBe(true);
    expect(seen).toEqual([{ level: 2 }, { level: 3 }]);
    expect(also).toEqual([{ level: 2 }]);
  });

  it("logs a listener that throws by input name and error type only, and still runs the others and the reload", () => {
    const { fr, env } = boot();
    const seen: unknown[] = [];
    onFileChange(env, "settings", () => {
      throw new RangeError("level 7 is the secret-ish content");
    });
    onFileChange(env, "settings", (v) => seen.push(v));
    const errors = captureErrors();
    fr.write("/etc/app/settings/s.json", '{"level":7}');
    expect(reloadFile(env, "settings")).toBe(true);
    errors.restore();
    expect(seen).toEqual([{ level: 7 }]);
    expect(env["settings"]).toEqual({ level: 7 });
    expect(reloadStatus(env, "settings").generation).toBe(2);
    expect(errors.lines()).toEqual(["docuconf: a settings reload listener failed (RangeError)"]);
  });

  it("does the same for a TLS listener, which never sees key material in the log", () => {
    const { fr, env } = boot();
    const tls = env["serving-tls"] as TlsMaterial;
    tls.onChange((m) => {
      throw new Error(m.key);
    });
    const errors = captureErrors();
    fr.tls("/etc/app/tls", issue({ cn: "next", dnsNames: ["app.internal"], ca }));
    expect(reloadFile(env, "serving-tls")).toBe(true);
    errors.restore();
    expect(errors.lines()).toEqual(["docuconf: a serving-tls reload listener failed (Error)"]);
    expect(errors.lines().join("\n")).not.toContain("PRIVATE KEY");
  });

  it("is not called when the file did not change", () => {
    const { env } = boot();
    const seen: unknown[] = [];
    onFileChange(env, "settings", (v) => seen.push(v));
    expect(reloadFile(env, "settings")).toBe(false);
    expect(seen).toEqual([]);
    expect(reloadStatus(env, "settings").generation).toBe(1);
  });

  it("rejects an input name the contract does not declare", () => {
    const { env } = boot();
    expect(() => onFileChange(env, "nope", () => {})).toThrow("no file input named nope");
    expect(() => reloadStatus(env, "nope")).toThrow("no file input named nope");
  });
});

describe("reloadStatus", () => {
  it("counts accepted reloads and records the last rejected change, without content", () => {
    const { fr, env } = boot();
    const atBoot = reloadStatus(env, "settings");
    expect(atBoot).toEqual({ input: "settings", generation: 1, lastReloadAt: undefined, lastRejected: undefined });

    const before = Date.now();
    fr.write("/etc/app/settings/s.json", '{"level":2}');
    reloadFile(env, "settings");
    const accepted = reloadStatus(env, "settings");
    expect(accepted.generation).toBe(2);
    expect(accepted.lastReloadAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(accepted.lastRejected).toBeUndefined();

    const errors = captureErrors();
    fr.write("/etc/app/settings/s.json", "{not json at all: hunter2");
    reloadFile(env, "settings");
    errors.restore();
    const rejected = reloadStatus(env, "settings");
    expect(rejected.generation).toBe(2);
    expect(rejected.lastReloadAt).toEqual(accepted.lastReloadAt);
    expect(rejected.lastRejected).toEqual({ at: expect.any(Date), input: "settings", codes: ["file_malformed"] });
    expect(JSON.stringify(rejected)).not.toContain("hunter2");

    fr.write("/etc/app/settings/s.json", '{"level":4}');
    reloadFile(env, "settings");
    expect(reloadStatus(env, "settings")).toMatchObject({ generation: 3, lastRejected: undefined });
  });

  it("clears the rejected change when the file goes back to the accepted one", () => {
    const { fr, env } = boot();
    const errors = captureErrors();
    fr.write("/etc/app/settings/s.json", '{"level":0}');
    reloadFile(env, "settings");
    errors.restore();
    expect(reloadStatus(env, "settings").lastRejected?.codes).toEqual(["schema_mismatch"]);
    fr.write("/etc/app/settings/s.json", '{"level":1}');
    expect(reloadFile(env, "settings")).toBe(false);
    expect(reloadStatus(env, "settings")).toMatchObject({ generation: 1, lastRejected: undefined });
  });

  it("is a snapshot", () => {
    const { fr, env } = boot();
    const s = reloadStatus(env, "settings");
    fr.write("/etc/app/settings/s.json", '{"level":2}');
    reloadFile(env, "settings");
    expect(s.generation).toBe(1);
    expect(Object.isFrozen(s)).toBe(true);
  });
});

describe("a keystore reload", () => {
  it("reuses the password read at boot, and a keystore under another password is rejected", () => {
    const { fr, env, given } = boot();
    const first = env["partner"] as Keystore;
    expect(first.passphrase).toBe("right-password");

    // The environment of a running process does not change; even if the
    // object passed in did, a reload uses the password checked at boot.
    given.KS_PASSWORD = "rotated-password";
    fr.write("/etc/app/ks/ks.p12", pkcs12(leaf, "rotated-password"));
    const errors = captureErrors();
    expect(reloadFile(env, "partner")).toBe(false);
    errors.restore();
    expect(env["partner"]).toBe(first);
    expect(reloadStatus(env, "partner").lastRejected?.codes).toEqual(["keystore_unreadable"]);
    expect(errors.lines().join("\n")).toContain("partner [keystore_unreadable]");
    expect(errors.lines().join("\n")).not.toMatch(/right-password|rotated-password/);

    // A new keystore under the same password is accepted.
    const next = issue({ cn: "next", dnsNames: ["app.internal"], ca });
    fr.write("/etc/app/ks/ks.p12", pkcs12(next, "right-password"));
    expect(reloadFile(env, "partner")).toBe(true);
    expect((env["partner"] as Keystore).pfx).not.toBe(first.pfx);
    expect(reloadStatus(env, "partner")).toMatchObject({ generation: 2, lastRejected: undefined });
  });
});

describe("contract-first mode", () => {
  it("reads file inputs through getters, and a TLS input is a TlsMaterial", () => {
    const { env } = boot();
    expect(Object.keys(env)).toEqual(["KS_PASSWORD", "settings", "serving-tls", "partner"]);
    const tls = env["serving-tls"] as TlsMaterial;
    expect(tls.cert).toBe(leaf.certPem);
    expect(typeof tls.getSecureContext).toBe("function");
    expect(typeof tls.attach).toBe("function");
  });

  it("re-reads a watched file when it changes on disk", async () => {
    const { fr, env } = boot(true);
    const changed = new Promise((resolve) => onFileChange(env, "settings", resolve));
    await expect(writeUntilChanged(join(fr.root, "/etc/app/settings/s.json"), '{"level":5}', changed)).resolves.toEqual({ level: 5 });
    expect(env["settings"]).toEqual({ level: 5 });
    expect(reloadStatus(env, "settings").generation).toBe(2);
  });

  it("rejects an overlay declared reload: watch, naming it", () => {
    const withOverlay = {
      ...head,
      vars: {},
      overlays: { platform: { name: "platform", format: "json", path: "/app/config/platform.json", keySeparator: ":", reload: "watch" } },
    };
    let error: unknown;
    try {
      parseContract(withOverlay);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(DocuconfDeclarationError);
    expect((error as Error).message).toContain('overlays.platform: reload "watch" is not supported in contract-first mode');
    const restart = { ...withOverlay, overlays: { platform: { ...withOverlay.overlays.platform, reload: "restart" } } };
    expect(() => parseContract(restart)).not.toThrow();
  });

  it("is not an object loadContract returned", () => {
    expect(() => reloadStatus({}, "settings")).toThrow("not an object returned by loadContract");
  });
});

describe("an empty key", () => {
  const keys = { ...head, vars: { KEYS: { type: "keySet", description: "Keys that verify", secret: true, maxKeys: 3 } } };

  it.each([
    ["old,", "key 2 is empty"],
    [",new", "key 1 is empty"],
    ["a,,b", "key 2 is empty"],
  ])("%s: %s", (value, message) => {
    const r = checkContract(keys, { KEYS: value });
    expect(r.violations.map((v) => [v.input, v.code, v.message])).toEqual([["KEYS", "out_of_range", message]]);
  });
});
