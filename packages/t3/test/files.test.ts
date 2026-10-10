import { chmodSync } from "node:fs";
import { request, createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  DocuconfValidationError,
  type ErrorCode,
  binaryFile,
  caBundleFile,
  closeWatchers,
  configFile,
  createEnv,
  keystoreFile,
  onFileChange,
  reloadFile,
  reloadStatus,
  secret,
  textFile,
  tlsFile,
} from "../src/index.ts";
import { type Issued, days, fileRoot, issue, pkcs12 } from "../../core/test/support/certs.ts";
import { writeUntilChanged } from "../../core/test/support/watch.ts";

let ca: Issued;
let otherCa: Issued;
let leaf: Issued;

beforeAll(() => {
  ca = issue({ cn: "Test Root CA", isCA: true, notAfter: days(3650) });
  otherCa = issue({ cn: "Other CA", isCA: true, notAfter: days(3650) });
  leaf = issue({ cn: "gateway.internal", dnsNames: ["gateway.internal", "api.example.com"], ca });
});

const routes = z.object({
  routes: z.array(z.object({ match: z.string().regex(/^\//), upstream: z.url() })).min(1),
});

const files = {
  routes: configFile({
    format: "yaml",
    path: "/etc/gw/routes/routes.yaml",
    pathEnv: "ROUTES_FILE",
    description: "Routing table",
    required: true,
    maxSize: 4096,
    schema: routes,
  }),
  settings: configFile({ format: "json", path: "/etc/gw/settings/settings.json", description: "JSON settings", schema: z.object({ level: z.number() }) }),
  "serving-tls": tlsFile({
    path: "/etc/gw/tls",
    description: "Serving certificate",
    required: true,
    dnsNames: ["gateway.internal", "api.example.com"],
    keyAlgorithms: ["RSA", "ECDSA"],
    minRemaining: "720h",
    requireCA: true,
  }),
  "upstream-ca": caBundleFile({ path: "/etc/gw/ca/bundle.pem", description: "Upstream CAs" }),
  partner: keystoreFile({ path: "/etc/gw/partner/ks.p12", description: "Partner keystore", passwordVar: "KS_PASSWORD" }),
  license: textFile({ path: "/etc/gw/license/license.key", description: "Licence key", required: true, pattern: "^[A-Z0-9]{5}(-[A-Z0-9]{5}){3}\\n?$" }),
  geoip: binaryFile({ path: "/data/geoip/db.mmdb", description: "GeoIP database", maxSize: 1024 }),
};

const server = {
  KS_PASSWORD: secret(z.string()).optional().describe("Partner keystore password"),
};

const ROUTES_YAML = "routes:\n  - match: /api\n    upstream: https://api.internal\n";
const LICENSE = "ABCDE-12345-FGHIJ-67890\n";

/** A file root with every input valid. */
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

function load(root: string, env: Record<string, string> = { KS_PASSWORD: "s3cret-pw" }, overrides: Partial<typeof files> = {}) {
  return createEnv({
    server,
    files: { ...files, ...overrides },
    runtimeEnv: env,
    fileRoot: root,
    terminationLog: false,
    watch: false,
  });
}

function failure(root: string, env?: Record<string, string>, overrides?: Partial<typeof files>): DocuconfValidationError {
  try {
    load(root, env, overrides);
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
  it("loads every file type", () => {
    const fr = validRoot();
    const env = load(fr.root);
    expect(env.files.routes.routes[0]).toEqual({ match: "/api", upstream: "https://api.internal" });
    expect(env.files.settings).toEqual({ level: 3 });
    const tls = env.files["serving-tls"];
    expect(tls.cert).toBe(leaf.certPem);
    expect(tls.key).toBe(leaf.key.keyPem);
    expect(tls.ca).toBe(ca.certPem);
    expect(tls.certificate.subject).toContain("gateway.internal");
    expect(Object.keys({ ...tls })).toEqual(["cert", "key", "ca"]);
    expect(tls.getSecureContext()).toBe(tls.getSecureContext());
    expect(env.files["upstream-ca"]?.certificates).toHaveLength(2);
    expect(env.files.partner?.passphrase).toBe("s3cret-pw");
    expect(env.files.license).toBe(LICENSE);
    expect(env.files.geoip).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it("serves HTTPS with the loaded key pair and trusts the CA bundle", async () => {
    const env = load(validRoot().root);
    const srv = createServer({ ...env.files["serving-tls"] }, (_req, res) => res.end("ok"));
    env.files["serving-tls"].attach(srv);
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    try {
      const { port } = srv.address() as AddressInfo;
      const body = await new Promise<string>((resolve, reject) => {
        const req = request(
          { host: "127.0.0.1", port, servername: "api.example.com", ...env.files["upstream-ca"], checkServerIdentity: () => undefined },
          (res) => {
            let data = "";
            res.on("data", (c) => (data += c));
            res.on("end", () => resolve(data));
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(body).toBe("ok");
    } finally {
      srv.close();
    }
  });

  it("leaves optional absent files undefined", () => {
    const fr = fileRoot();
    fr.write("/etc/gw/routes/routes.yaml", ROUTES_YAML);
    fr.tls("/etc/gw/tls", leaf, { ca });
    fr.write("/etc/gw/license/license.key", LICENSE);
    const env = load(fr.root, {});
    expect(env.files.settings).toBeUndefined();
    expect(env.files["upstream-ca"]).toBeUndefined();
    expect(env.files.partner).toBeUndefined();
    expect(env.files.geoip).toBeUndefined();
  });

  it("reports missing required files", () => {
    const fr = fileRoot();
    fr.write("/etc/gw/tls/tls.crt", leaf.certPem);
    expect(codes(failure(fr.root))).toEqual([
      ["routes", "file_missing"],
      ["serving-tls", "file_missing"],
      ["license", "file_missing"],
    ]);
  });

  it("reports an expiring certificate", () => {
    const fr = validRoot();
    const soon = issue({ cn: "gateway.internal", dnsNames: ["gateway.internal", "api.example.com"], ca, notAfter: days(10) });
    fr.tls("/etc/gw/tls", soon, { ca });
    const e = failure(fr.root);
    expect(codes(e)).toEqual([["serving-tls", "certificate_expiring"]]);
    expect(e.message).toMatch(/less than 720h from now/);
  });

  it("reports an expired or not yet valid certificate", () => {
    const fr = validRoot();
    fr.tls("/etc/gw/tls", issue({ cn: "x", dnsNames: ["gateway.internal", "api.example.com"], ca, notBefore: days(-30), notAfter: days(-1) }), { ca });
    expect(codes(failure(fr.root))).toEqual([["serving-tls", "certificate_invalid"]]);
    fr.tls("/etc/gw/tls", issue({ cn: "x", dnsNames: ["gateway.internal", "api.example.com"], ca, notBefore: days(1), notAfter: days(90) }), { ca });
    expect(failure(fr.root).message).toMatch(/not valid until/);
  });

  it("reports a DNS name the certificate does not cover", () => {
    const fr = validRoot();
    fr.tls("/etc/gw/tls", issue({ cn: "gateway.internal", dnsNames: ["gateway.internal"], ca }), { ca });
    const e = failure(fr.root);
    expect(codes(e)).toEqual([["serving-tls", "certificate_name_mismatch"]]);
    expect(e.message).toContain("does not cover api.example.com");
  });

  it("accepts a wildcard certificate for a single-label name", () => {
    const fr = validRoot();
    fr.tls("/etc/gw/tls", issue({ cn: "wild", dnsNames: ["gateway.internal", "*.example.com"], ca }), { ca });
    expect(() => load(fr.root)).not.toThrow();
  });

  it("reports a key that does not match the certificate", () => {
    const fr = validRoot();
    const other = issue({ cn: "other", dnsNames: ["gateway.internal"], ca });
    fr.tls("/etc/gw/tls", leaf, { ca, key: other.key.keyPem });
    const e = failure(fr.root);
    expect(codes(e)).toEqual([["serving-tls", "key_mismatch"]]);
    expect(e.message).not.toContain("PRIVATE KEY");
  });

  it("checks the key algorithm and the chain to ca.crt", () => {
    const fr = validRoot();
    expect(
      codes(failure(fr.root, undefined, { "serving-tls": tlsFile({ path: "/etc/gw/tls", description: "Serving certificate", keyAlgorithms: ["ECDSA"] }) })),
    ).toEqual([["serving-tls", "certificate_invalid"]]);
    fr.tls("/etc/gw/tls", leaf, { ca: otherCa });
    const e = failure(fr.root);
    expect(codes(e)).toEqual([["serving-tls", "certificate_invalid"]]);
    expect(e.message).toContain("does not chain to a certificate in ca.crt");
  });

  it("accepts an intermediate chain in tls.crt and rejects a wrong order", () => {
    const fr = validRoot();
    const inter = issue({ cn: "Intermediate", isCA: true, ca });
    const viaInter = issue({ cn: "gw", dnsNames: ["gateway.internal", "api.example.com"], ca: inter });
    fr.tls("/etc/gw/tls", viaInter, { ca, chain: [inter] });
    expect(() => load(fr.root)).not.toThrow();
    fr.write("/etc/gw/tls/tls.crt", inter.certPem + viaInter.certPem);
    fr.write("/etc/gw/tls/tls.key", viaInter.key.keyPem);
    expect(codes(failure(fr.root)).map(([, c]) => c)).toContain("certificate_invalid");
  });

  it("reports malformed config files", () => {
    const fr = validRoot();
    fr.write("/etc/gw/routes/routes.yaml", "routes: [unclosed\n");
    fr.write("/etc/gw/settings/settings.json", "{level: 3}");
    expect(codes(failure(fr.root))).toEqual([
      ["routes", "file_malformed"],
      ["settings", "file_malformed"],
    ]);
  });

  it("reports config that violates its schema, with the path", () => {
    const fr = validRoot();
    fr.write("/etc/gw/routes/routes.yaml", "routes:\n  - match: api\n    upstream: https://x\n");
    const e = failure(fr.root);
    expect(codes(e)).toEqual([["routes", "schema_mismatch"]]);
    expect(e.violations[0]!.message).toMatch(/^routes\.0\.match: /);
  });

  it("enforces maxSize", () => {
    const fr = validRoot();
    fr.write("/data/geoip/db.mmdb", Buffer.alloc(2048));
    expect(codes(failure(fr.root))).toEqual([["geoip", "file_too_large"]]);
  });

  it("reports a CA bundle with too few certificates as file_malformed", () => {
    const fr = validRoot();
    const overrides = { "upstream-ca": caBundleFile({ path: "/etc/gw/ca/bundle.pem", description: "Upstream CAs", minCertificates: 3 }) };
    expect(codes(failure(fr.root, undefined, overrides))).toEqual([["upstream-ca", "file_malformed"]]);
  });

  it("checks text patterns and CA bundles", () => {
    const fr = validRoot();
    fr.write("/etc/gw/license/license.key", "not-a-licence");
    fr.write("/etc/gw/ca/bundle.pem", "garbage");
    expect(codes(failure(fr.root))).toEqual([
      ["upstream-ca", "file_malformed"],
      ["license", "pattern_mismatch"],
    ]);
  });

  it("opens the keystore with its password variable, and never prints the password", () => {
    const fr = validRoot();
    const e = failure(fr.root, { KS_PASSWORD: "wrong-password-value" });
    expect(codes(e)).toEqual([["partner", "keystore_unreadable"]]);
    expect(e.message).toContain("KS_PASSWORD");
    expect(e.message).not.toContain("wrong-password-value");
  });

  it.skipIf(process.getuid?.() === 0)("reports a file that exists but cannot be read", () => {
    const fr = validRoot();
    const p = fr.write("/etc/gw/license/license.key", LICENSE);
    chmodSync(p, 0o000);
    const e = failure(fr.root);
    expect(codes(e)).toEqual([["license", "file_unreadable"]]);
    expect(e.message).toContain("fsGroup");
  });

  it("reads the path from pathEnv when it is set", () => {
    const fr = validRoot();
    const alt = fr.write("/elsewhere/r.yaml", "routes: []\n");
    // pathEnv values are taken as given (the file root applies to absolute paths).
    const e = failure(fr.root, { KS_PASSWORD: "s3cret-pw", ROUTES_FILE: "/elsewhere/r.yaml" });
    expect(codes(e)).toEqual([["routes", "schema_mismatch"]]);
    expect(alt).toContain("elsewhere");
  });

  it("remaps paths with DOCUCONF_FILE_ROOT", () => {
    const fr = validRoot();
    vi.stubEnv("DOCUCONF_FILE_ROOT", fr.root);
    try {
      const env = createEnv({ server, files, runtimeEnv: { KS_PASSWORD: "s3cret-pw" }, terminationLog: false, watch: false });
      expect(env.files.license).toBe(LICENSE);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("reports variable and file problems together", () => {
    const fr = fileRoot();
    const e = (() => {
      try {
        createEnv({
          server: { PORT: z.coerce.number().int().describe("HTTP listen port") },
          files: { license: files.license },
          runtimeEnv: {},
          fileRoot: fr.root,
          terminationLog: false,
        });
      } catch (err) {
        return err as DocuconfValidationError;
      }
      throw new Error("expected failure");
    })();
    expect(codes(e)).toEqual([
      ["PORT", "missing_required"],
      ["license", "file_missing"],
    ]);
  });
});

describe("reload: watch", () => {
  const watched = {
    "serving-tls": tlsFile({ path: "/etc/w/tls", description: "Serving certificate", required: true, reload: "watch", dnsNames: ["gateway.internal"] }),
    settings: configFile({ format: "json", path: "/etc/w/settings/s.json", description: "JSON settings", reload: "watch", schema: z.object({ level: z.number() }) }),
  };
  let envs: object[] = [];
  afterAll(() => envs.forEach(closeWatchers));

  function setup(watch: boolean) {
    const fr = fileRoot();
    fr.tls("/etc/w/tls", leaf);
    fr.write("/etc/w/settings/s.json", '{"level":1}');
    const env = createEnv({ server: {}, files: watched, runtimeEnv: {}, fileRoot: fr.root, terminationLog: false, watch });
    envs.push(env);
    return { fr, env };
  }

  it("swaps in a new certificate and keeps the old one when the new one fails", () => {
    const { fr, env } = setup(false);
    const tls = env.files["serving-tls"];
    const seen: string[] = [];
    tls.onChange((m) => seen.push(m.cert));
    const next = issue({ cn: "next", dnsNames: ["gateway.internal"], ca });
    fr.tls("/etc/w/tls", next);
    expect(reloadFile(env, "serving-tls")).toBe(true);
    expect(tls.cert).toBe(next.certPem);
    expect(seen).toEqual([next.certPem]);

    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    fr.tls("/etc/w/tls", issue({ cn: "bad", dnsNames: ["other.internal"], ca }));
    expect(reloadFile(env, "serving-tls")).toBe(false);
    expect(tls.cert).toBe(next.certPem);
    expect(errors.mock.calls[0]?.[0]).toContain("certificate_name_mismatch");
    errors.mockRestore();
  });

  it("re-reads a watched config file when it changes on disk", async () => {
    const { fr, env } = setup(true);
    expect(env.files.settings).toEqual({ level: 1 });
    const changed = new Promise((resolve) => onFileChange(env, "settings", resolve));
    await expect(writeUntilChanged(join(fr.root, "/etc/w/settings/s.json"), '{"level":2}', changed)).resolves.toEqual({ level: 2 });
    expect(env.files.settings).toEqual({ level: 2 });
  });

  it("reports the reload status, and a throwing listener does not stop the others", () => {
    const { fr, env } = setup(false);
    expect(reloadStatus(env, "serving-tls")).toEqual({ input: "serving-tls", generation: 1, lastReloadAt: undefined, lastRejected: undefined });
    const seen: unknown[] = [];
    onFileChange(env, "settings", () => {
      throw new TypeError("level 2");
    });
    onFileChange(env, "settings", (s) => seen.push(s));
    const logged: string[] = [];
    const errors = vi.spyOn(console, "error").mockImplementation((m: unknown) => void logged.push(String(m)));
    fr.write("/etc/w/settings/s.json", '{"level":2}');
    expect(reloadFile(env, "settings")).toBe(true);
    fr.write("/etc/w/settings/s.json", '{"level":"high"}');
    expect(reloadFile(env, "settings")).toBe(false);
    errors.mockRestore();
    expect(seen).toEqual([{ level: 2 }]);
    expect(env.files.settings).toEqual({ level: 2 });
    expect(logged[0]).toBe("docuconf: a settings reload listener failed (TypeError)");
    const status = reloadStatus(env, "settings");
    expect(status.generation).toBe(2);
    expect(status.lastReloadAt).toBeInstanceOf(Date);
    expect(status.lastRejected).toEqual({ at: expect.any(Date), input: "settings", codes: ["schema_mismatch"] });
  });
});
