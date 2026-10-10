import { X509Certificate, createPrivateKey } from "node:crypto";
import { type SecureContext, createSecureContext } from "node:tls";
import { parseDuration } from "../duration.ts";
import { errorType } from "../redact.ts";
import type { ErrorCode } from "../violations.ts";
import type { CaBundle, KeyAlgorithm, TlsMaterial } from "./spec.ts";

const PEM_CERT = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

export type Report = (code: ErrorCode, message: string) => void;

/** Splits and parses every PEM certificate in `pem`. */
export function parseCertificates(pem: string, label: string, report: Report): X509Certificate[] | undefined {
  const blocks = pem.match(PEM_CERT) ?? [];
  if (blocks.length === 0) {
    // SPEC §11.2 item 5: no PEM certificate at all is a malformed file.
    report("file_malformed", `${label} holds no PEM certificate`);
    return undefined;
  }
  const out: X509Certificate[] = [];
  for (const [i, block] of blocks.entries()) {
    try {
      out.push(new X509Certificate(block));
    } catch (e) {
      report("certificate_invalid", `${label}: certificate ${i + 1} cannot be parsed (${(e as Error).message})`);
      return undefined;
    }
  }
  return out;
}

const ALGORITHMS: Record<string, KeyAlgorithm> = { rsa: "RSA", "rsa-pss": "RSA", ec: "ECDSA", ed25519: "Ed25519" };

export interface TlsCheckOptions {
  dnsNames?: string[];
  keyAlgorithms?: KeyAlgorithm[];
  minRemaining?: string;
  requireCA?: boolean;
}

export interface TlsParts {
  cert: string;
  key: string;
  ca: string | undefined;
  certificate: X509Certificate;
}

/**
 * SPEC §11.2 item 7: the certificate and key parse and match, the
 * certificate is valid now with at least minRemaining left, covers every
 * dnsName, uses an allowed key algorithm, and chains to ca.crt when
 * requireCA is set.
 */
export function checkTls(
  files: { cert: string; key: string; ca: string | undefined },
  opts: TlsCheckOptions,
  report: Report,
  now = Date.now(),
): TlsParts | undefined {
  let ok = true;
  const fail: Report = (code, message) => {
    ok = false;
    report(code, message);
  };
  const chain = parseCertificates(files.cert, "tls.crt", fail);
  let key;
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(files.key)) {
    fail("file_malformed", "tls.key holds no PEM private key");
  } else {
    try {
      key = createPrivateKey(files.key);
    } catch {
      // The parser's message could quote key material; keep it generic.
      fail("certificate_invalid", "tls.key is not a readable PEM private key");
    }
  }
  if (!chain) return undefined;
  const leaf = chain[0]!;

  if (key && !leaf.checkPrivateKey(key)) fail("key_mismatch", "tls.key does not match the certificate in tls.crt");

  const from = Date.parse(leaf.validFrom);
  const to = Date.parse(leaf.validTo);
  if (now < from) fail("certificate_invalid", `certificate is not valid until ${new Date(from).toISOString()}`);
  else if (now > to) fail("certificate_invalid", `certificate expired at ${new Date(to).toISOString()}`);
  else if (opts.minRemaining !== undefined) {
    const min = parseDuration(opts.minRemaining) ?? 0;
    if (to - now < min) {
      fail(
        "certificate_expiring",
        `certificate expires at ${new Date(to).toISOString()}, less than ${opts.minRemaining} from now`,
      );
    }
  }

  for (const name of opts.dnsNames ?? []) {
    if (leaf.checkHost(name) === undefined) fail("certificate_name_mismatch", `certificate does not cover ${name}`);
  }

  if (opts.keyAlgorithms && opts.keyAlgorithms.length > 0) {
    const raw = leaf.publicKey.asymmetricKeyType ?? "unknown";
    const alg = ALGORITHMS[raw];
    if (!alg || !opts.keyAlgorithms.includes(alg)) {
      fail("certificate_invalid", `key algorithm ${alg ?? raw} is not one of ${opts.keyAlgorithms.join(", ")}`);
    }
  }

  // tls.crt must be ordered leaf first, each certificate issued by the next.
  for (let i = 0; i + 1 < chain.length; i++) {
    const [c, issuer] = [chain[i]!, chain[i + 1]!];
    if (!c.checkIssued(issuer) || !c.verify(issuer.publicKey)) {
      fail("certificate_invalid", `tls.crt: certificate ${i + 1} is not issued by certificate ${i + 2}; order the chain leaf first`);
      break;
    }
  }

  if (opts.requireCA) {
    if (files.ca === undefined) {
      fail("file_missing", "ca.crt is required (requireCA) but missing");
    } else {
      const cas = parseCertificates(files.ca, "ca.crt", fail);
      if (cas) {
        const top = chain[chain.length - 1]!;
        const chains = cas.some(
          (ca) => ca.fingerprint256 === top.fingerprint256 || (top.checkIssued(ca) && top.verify(ca.publicKey)),
        );
        if (!chains) fail("certificate_invalid", "tls.crt does not chain to a certificate in ca.crt");
      }
    }
  }

  if (!ok || !key) return undefined;
  return { cert: files.cert, key: files.key, ca: files.ca, certificate: leaf };
}

/** A stable object whose getters always return the current key pair. */
export class TlsMaterialHolder {
  private parts: TlsParts;
  private ctx: SecureContext | undefined;
  private readonly listeners = new Set<(m: TlsMaterial) => void>();
  readonly material: TlsMaterial;
  /** The input name, for logs. */
  private readonly name: string;

  constructor(parts: TlsParts, name = "tls") {
    this.parts = parts;
    this.name = name;
    const self = this;
    const m = {} as TlsMaterial;
    // cert, key and ca are enumerable, so `{ ...material }` is valid
    // https.createServer / tls.createSecureContext options.
    Object.defineProperties(m, {
      cert: { enumerable: true, get: () => self.parts.cert },
      key: { enumerable: true, get: () => self.parts.key },
      ca: { enumerable: true, get: () => self.parts.ca },
      certificate: { enumerable: false, get: () => self.parts.certificate },
      getSecureContext: { enumerable: false, value: () => self.secureContext() },
      attach: {
        enumerable: false,
        value: (server: { setSecureContext(o: object): void }) =>
          self.subscribe(() => server.setSecureContext(self.options())),
      },
      onChange: { enumerable: false, value: (l: (m: TlsMaterial) => void) => self.subscribe(l) },
      toJSON: { enumerable: false, value: () => ({ certificate: self.parts.certificate.subject, key: "[redacted]" }) },
    });
    this.material = Object.freeze(m);
  }

  private options() {
    return { cert: this.parts.cert, key: this.parts.key, ...(this.parts.ca ? { ca: this.parts.ca } : {}) };
  }

  secureContext(): SecureContext {
    this.ctx ??= createSecureContext(this.options());
    return this.ctx;
  }

  subscribe(l: (m: TlsMaterial) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  update(parts: TlsParts): void {
    this.parts = parts;
    this.ctx = undefined;
    for (const l of this.listeners) {
      try {
        l(this.material);
      } catch (e) {
        // The input name and the error's type only: a message could quote key material.
        console.error(`docuconf: a ${this.name} reload listener failed (${errorType(e)})`);
      }
    }
  }
}

export function checkCaBundle(pem: string, minCertificates: number, report: Report): CaBundle | undefined {
  if ((pem.match(PEM_CERT) ?? []).length === 0) {
    report("file_malformed", "no PEM certificate found");
    return undefined;
  }
  const certs = parseCertificates(pem, "bundle", report);
  if (!certs) return undefined;
  if (certs.length < minCertificates) {
    report("file_malformed", `holds ${certs.length} certificate(s), needs at least ${minCertificates}`);
    return undefined;
  }
  const bundle = {} as CaBundle;
  Object.defineProperties(bundle, {
    ca: { enumerable: true, value: pem },
    certificates: { enumerable: false, value: Object.freeze(certs) },
  });
  return Object.freeze(bundle);
}
