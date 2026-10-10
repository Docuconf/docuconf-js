import { writeFileSync } from "node:fs";
import { join } from "node:path";
import "reflect-metadata";
import { Type } from "class-transformer";
import { ArrayMinSize, IsArray, IsInt, IsOptional, IsString, Matches, ValidateNested } from "class-validator";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { type Issued, days, fileRoot, issue, pkcs12 } from "../../core/test/support/certs.ts";
import {
  BinaryFile,
  type CaBundle,
  CaBundleFile,
  ConfigFile,
  Describe,
  type DocuconfValidate,
  DocuconfValidationError,
  type ErrorCode,
  type Keystore,
  KeystoreFile,
  Secret,
  TextFile,
  TlsFile,
  type TlsMaterial,
  docuconfValidate,
  toContract,
} from "../src/index.ts";

let ca: Issued;
let otherCa: Issued;
let leaf: Issued;

beforeAll(() => {
  ca = issue({ cn: "Test Root CA", isCA: true, notAfter: days(3650) });
  otherCa = issue({ cn: "Other CA", isCA: true, notAfter: days(3650) });
  leaf = issue({ cn: "gateway.internal", dnsNames: ["gateway.internal", "api.example.com"], ca });
});

class Route {
  @IsString() @Matches(/^\//)
  match!: string;

  @IsString() @Matches(/^https:\/\//)
  upstream!: string;
}

class Routes {
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => Route)
  routes!: Route[];
}

class Env {
  @IsOptional() @Secret() @IsString() @Describe("Partner keystore password")
  KS_PASSWORD?: string;

  @ConfigFile({ format: "yaml", path: "/etc/gw/routes/routes.yaml", pathEnv: "ROUTES_FILE", description: "Routing table", required: true, schema: Routes })
  routes!: Routes;

  @ConfigFile({ format: "json", path: "/etc/gw/settings/settings.json", description: "JSON settings", schema: z.object({ level: z.number() }) })
  settings?: { level: number };

  @TlsFile({
    path: "/etc/gw/tls",
    description: "Serving certificate",
    required: true,
    dnsNames: ["gateway.internal", "api.example.com"],
    keyAlgorithms: ["RSA", "ECDSA"],
    minRemaining: "720h",
    requireCA: true,
  })
  servingTls!: TlsMaterial;

  @CaBundleFile({ path: "/etc/gw/ca/bundle.pem", description: "Upstream CAs" })
  upstreamCa?: CaBundle;

  @KeystoreFile({ name: "partner", path: "/etc/gw/partner/ks.p12", description: "Partner keystore", passwordVar: "KS_PASSWORD" })
  partnerKeystore?: Keystore;

  @TextFile({ path: "/etc/gw/license/license.key", description: "Licence key", required: true, pattern: "^[A-Z0-9]{5}(-[A-Z0-9]{5}){3}\\n?$" })
  license!: string;

  @BinaryFile({ path: "/data/geoip/db.mmdb", description: "GeoIP database", maxSize: 1024 })
  geoip?: Buffer;
}

const ROUTES_YAML = "routes:\n  - match: /api\n    upstream: https://api.internal\n";
const LICENSE = "ABCDE-12345-FGHIJ-67890\n";

function validRoot() {
  const fr = fileRoot();
  fr.write("/etc/gw/routes/routes.yaml", ROUTES_YAML);
  fr.write("/etc/gw/settings/settings.json", '﻿{"level": 3}');
  fr.tls("/etc/gw/tls", leaf, { ca });
  fr.write("/etc/gw/ca/bundle.pem", ca.certPem + otherCa.certPem);
  fr.write("/etc/gw/partner/ks.p12", pkcs12(leaf, "s3cret-pw"));
  fr.write("/etc/gw/license/license.key", LICENSE);
  fr.write("/data/geoip/db.mmdb", Buffer.from([1, 2, 3, 4]));
  return fr;
}

const validators: Array<DocuconfValidate<object>> = [];
afterAll(() => validators.forEach((v) => v.close()));
afterEach(() => vi.unstubAllEnvs());

function load(root: string, env: Record<string, string> = { KS_PASSWORD: "s3cret-pw" }) {
  const v = docuconfValidate(Env, { fileRoot: root, terminationLog: false, watch: false });
  validators.push(v);
  return v(env);
}

function failure(root: string, env?: Record<string, string>): DocuconfValidationError {
  try {
    load(root, env);
  } catch (e) {
    if (e instanceof DocuconfValidationError) return e;
    throw e;
  }
  throw new Error("expected validation to fail");
}

function codes(e: DocuconfValidationError): Array<[string, ErrorCode]> {
  return e.violations.map((v) => [v.input, v.code]);
}

describe("file inputs at boot", () => {
  it("loads every file type onto its property", () => {
    const env = load(validRoot().root);
    expect(env.routes).toBeInstanceOf(Routes);
    expect(env.routes.routes[0]).toBeInstanceOf(Route);
    expect(env.routes.routes[0]).toEqual({ match: "/api", upstream: "https://api.internal" });
    expect(env.settings).toEqual({ level: 3 });
    expect(env.servingTls.cert).toBe(leaf.certPem);
    expect(env.servingTls.ca).toBe(ca.certPem);
    expect(Object.keys({ ...env.servingTls })).toEqual(["cert", "key", "ca"]);
    expect(env.upstreamCa?.certificates).toHaveLength(2);
    expect(env.partnerKeystore?.passphrase).toBe("s3cret-pw");
    expect(env.license).toBe(LICENSE);
    expect(env.geoip).toEqual(Buffer.from([1, 2, 3, 4]));
    // File inputs never reach Object.keys, so Nest never copies them to process.env.
    expect(Object.keys(env)).not.toContain("license");
  });

  it("exports file inputs named after their properties, with the Zod schema too", () => {
    const out = toContract(Env, { name: "files" });
    expect(out).toContain('"serving-tls": {');
    expect(out).toContain('"upstream-ca": {');
    expect(out).toContain("partner: {");
    expect(out).toMatch(/settings: \{[\s\S]*level: \{[\s\S]*type: "number"/);
  });

  it("reports missing required files, and variable and file problems together", () => {
    const fr = fileRoot();
    fr.write("/etc/gw/tls/tls.crt", leaf.certPem);
    expect(codes(failure(fr.root, {}))).toEqual([
      ["routes", "file_missing"],
      ["serving-tls", "file_missing"],
      ["license", "file_missing"],
    ]);
    expect(codes(failure(fr.root, { KS_PASSWORD: "vault:secret/ks#pw" }))[0]).toEqual(["KS_PASSWORD", "invalid_type"]);
  });

  it("reports an expiring certificate, a DNS mismatch and a key mismatch", () => {
    const fr = validRoot();
    fr.tls("/etc/gw/tls", issue({ cn: "gateway.internal", dnsNames: ["gateway.internal", "api.example.com"], ca, notAfter: days(10) }), { ca });
    expect(codes(failure(fr.root))).toEqual([["serving-tls", "certificate_expiring"]]);

    fr.tls("/etc/gw/tls", issue({ cn: "gateway.internal", dnsNames: ["gateway.internal"], ca }), { ca });
    const e = failure(fr.root);
    expect(codes(e)).toEqual([["serving-tls", "certificate_name_mismatch"]]);
    expect(e.message).toContain("does not cover api.example.com");

    fr.tls("/etc/gw/tls", leaf, { ca, key: issue({ cn: "other", ca }).key.keyPem });
    const k = failure(fr.root);
    expect(codes(k)).toEqual([["serving-tls", "key_mismatch"]]);
    expect(k.message).not.toContain("PRIVATE KEY");
  });

  it("checks the chain to ca.crt", () => {
    const fr = validRoot();
    fr.tls("/etc/gw/tls", leaf, { ca: otherCa });
    expect(failure(fr.root).message).toContain("does not chain to a certificate in ca.crt");
  });

  it("reports malformed config files and schema violations with their path", () => {
    const fr = validRoot();
    fr.write("/etc/gw/routes/routes.yaml", "routes: [unclosed\n");
    fr.write("/etc/gw/settings/settings.json", "{level: 3}");
    expect(codes(failure(fr.root))).toEqual([
      ["routes", "file_malformed"],
      ["settings", "file_malformed"],
    ]);
    fr.write("/etc/gw/routes/routes.yaml", "routes:\n  - match: api\n    upstream: https://x\n");
    fr.write("/etc/gw/settings/settings.json", '{"level": "high"}');
    const e = failure(fr.root);
    expect(codes(e)).toEqual([
      ["routes", "schema_mismatch"],
      ["settings", "schema_mismatch"],
    ]);
    expect(e.violations[0]!.message).toBe("routes.0.match: must match /^\\// regular expression");
    expect(e.violations[1]!.message).toMatch(/^level: /);
    fr.write("/etc/gw/routes/routes.yaml", "- just a list\n");
    expect(failure(fr.root).violations[0]!.message).toBe("(root): must be an object matching Routes");
  });

  it("opens the keystore with its password variable, and never prints the password", () => {
    const e = failure(validRoot().root, { KS_PASSWORD: "wrong-password-value" });
    expect(codes(e)).toEqual([["partner", "keystore_unreadable"]]);
    expect(e.message).toContain("KS_PASSWORD");
    expect(e.message).not.toContain("wrong-password-value");
  });

  it("enforces maxSize and text patterns", () => {
    const fr = validRoot();
    fr.write("/data/geoip/db.mmdb", Buffer.alloc(2048));
    fr.write("/etc/gw/license/license.key", "not-a-licence");
    expect(codes(failure(fr.root))).toEqual([
      ["license", "pattern_mismatch"],
      ["geoip", "file_too_large"],
    ]);
  });

  it("remaps paths with DOCUCONF_FILE_ROOT, from the process or from the config Nest passes", () => {
    const fr = validRoot();
    const v = docuconfValidate(Env, { terminationLog: false, watch: false });
    validators.push(v);
    expect(v({ KS_PASSWORD: "s3cret-pw", DOCUCONF_FILE_ROOT: fr.root }).license).toBe(LICENSE);
    vi.stubEnv("DOCUCONF_FILE_ROOT", fr.root);
    expect(v({ KS_PASSWORD: "s3cret-pw" }).license).toBe(LICENSE);
  });

  it("reads the path from pathEnv when it is set", () => {
    const fr = validRoot();
    fr.write("/elsewhere/r.yaml", "routes:\n  - match: /other\n    upstream: https://other.internal\n");
    // DOCUCONF_FILE_ROOT prefixes pathEnv paths too.
    const env = load(fr.root, { KS_PASSWORD: "s3cret-pw", ROUTES_FILE: "/elsewhere/r.yaml" });
    expect(env.routes.routes[0]!.match).toBe("/other");
  });
});

describe("reload: watch", () => {
  class Watched {
    @TlsFile({ path: "/etc/w/tls", description: "Serving certificate", required: true, reload: "watch", dnsNames: ["gateway.internal"] })
    servingTls!: TlsMaterial;

    @ConfigFile({ format: "json", path: "/etc/w/settings/s.json", description: "JSON settings", reload: "watch", schema: z.object({ level: z.number() }) })
    settings?: { level: number };
  }

  function setup(watch: boolean) {
    const fr = fileRoot();
    fr.tls("/etc/w/tls", leaf);
    fr.write("/etc/w/settings/s.json", '{"level":1}');
    const v = docuconfValidate(Watched, { fileRoot: fr.root, terminationLog: false, watch });
    validators.push(v);
    return { fr, v, env: v({}) };
  }

  it("swaps in a new certificate and keeps the old one when the new one fails", () => {
    const { fr, v, env } = setup(false);
    const tls = env.servingTls;
    const next = issue({ cn: "next", dnsNames: ["gateway.internal"], ca });
    fr.tls("/etc/w/tls", next);
    expect(v.reloadFile("servingTls")).toBe(true);
    expect(tls.cert).toBe(next.certPem);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    fr.tls("/etc/w/tls", issue({ cn: "bad", dnsNames: ["other.internal"], ca }));
    expect(v.reloadFile("serving-tls")).toBe(false);
    expect(tls.cert).toBe(next.certPem);
    expect(errors.mock.calls[0]?.[0]).toContain("certificate_name_mismatch");
    errors.mockRestore();
  });

  it("re-reads a watched config file when it changes on disk, and the property follows", async () => {
    const { fr, v, env } = setup(true);
    expect(env.settings).toEqual({ level: 1 });
    const changed = new Promise((resolve) => v.onFileChange("settings", resolve));
    writeFileSync(join(fr.root, "/etc/w/settings/s.json"), '{"level":2}');
    await expect(changed).resolves.toEqual({ level: 2 });
    expect(env.settings).toEqual({ level: 2 });
  });

  it("reports the reload status, and a throwing listener does not stop the others", () => {
    const { fr, v, env } = setup(false);
    expect(v.reloadStatus("servingTls")).toEqual({ input: "serving-tls", generation: 1, lastReloadAt: undefined, lastRejected: undefined });
    const seen: unknown[] = [];
    v.onFileChange("settings", () => {
      throw new TypeError("level 2");
    });
    v.onFileChange("settings", (s) => seen.push(s));
    const logged: string[] = [];
    const errors = vi.spyOn(console, "error").mockImplementation((m: unknown) => void logged.push(String(m)));
    fr.write("/etc/w/settings/s.json", '{"level":2}');
    expect(v.reloadFile("settings")).toBe(true);
    fr.write("/etc/w/settings/s.json", '{"level":"high"}');
    expect(v.reloadFile("settings")).toBe(false);
    errors.mockRestore();
    expect(seen).toEqual([{ level: 2 }]);
    expect(env.settings).toEqual({ level: 2 });
    expect(logged[0]).toBe("docuconf: a settings reload listener failed (TypeError)");
    const status = v.reloadStatus("settings");
    expect(status.generation).toBe(2);
    expect(status.lastReloadAt).toBeInstanceOf(Date);
    expect(status.lastRejected).toEqual({ at: expect.any(Date), input: "settings", codes: ["schema_mismatch"] });
  });
});
