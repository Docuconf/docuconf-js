import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import forge from "node-forge";

const DAY = 86_400_000;

export interface KeyPair {
  keyPem: string;
  forgeKey: forge.pki.rsa.PrivateKey;
  forgePublic: forge.pki.rsa.PublicKey;
}

/** RSA keys from node:crypto (fast), converted for node-forge to sign with. */
export function rsaKey(): KeyPair {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const keyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const forgeKey = forge.pki.privateKeyFromPem(keyPem) as forge.pki.rsa.PrivateKey;
  const forgePublic = forge.pki.setRsaPublicKey(forgeKey.n, forgeKey.e);
  return { keyPem, forgeKey, forgePublic };
}

let serial = 1;

export interface Issued {
  certPem: string;
  cert: forge.pki.Certificate;
  key: KeyPair;
}

export function issue(opts: {
  cn: string;
  dnsNames?: string[];
  ca?: Issued;
  isCA?: boolean;
  notBefore?: Date;
  notAfter?: Date;
  key?: KeyPair;
}): Issued {
  const key = opts.key ?? rsaKey();
  const cert = forge.pki.createCertificate();
  cert.publicKey = key.forgePublic;
  cert.serialNumber = (serial++).toString(16).padStart(2, "0");
  cert.validity.notBefore = opts.notBefore ?? new Date(Date.now() - DAY);
  cert.validity.notAfter = opts.notAfter ?? new Date(Date.now() + 90 * DAY);
  const subject = [{ name: "commonName", value: opts.cn }];
  cert.setSubject(subject);
  cert.setIssuer(opts.ca ? opts.ca.cert.subject.attributes : subject);
  const extensions: object[] = [{ name: "basicConstraints", cA: opts.isCA === true }];
  if (opts.isCA) extensions.push({ name: "keyUsage", keyCertSign: true, cRLSign: true, digitalSignature: true });
  if (opts.dnsNames) extensions.push({ name: "subjectAltName", altNames: opts.dnsNames.map((value) => ({ type: 2, value })) });
  cert.setExtensions(extensions);
  cert.sign(opts.ca ? opts.ca.key.forgeKey : key.forgeKey, forge.md.sha256.create());
  return { certPem: forge.pki.certificateToPem(cert), cert, key };
}

export function pkcs12(leaf: Issued, password: string): Buffer {
  const asn1 = forge.pkcs12.toPkcs12Asn1(leaf.key.forgeKey, [leaf.cert], password, { algorithm: "3des" });
  return Buffer.from(forge.asn1.toDer(asn1).getBytes(), "binary");
}

export const days = (n: number) => new Date(Date.now() + n * DAY);

/** A temporary file root: write(path, content) places files under it. */
export function fileRoot() {
  const root = mkdtempSync(join(tmpdir(), "docuconf-test-"));
  return {
    root,
    write(path: string, content: string | Buffer) {
      const full = join(root, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
      return full;
    },
    tls(dir: string, leaf: Issued, opts: { ca?: Issued; chain?: Issued[]; key?: string } = {}) {
      const chain = [leaf.certPem, ...(opts.chain ?? []).map((c) => c.certPem)].join("");
      this.write(join(dir, "tls.crt"), chain);
      this.write(join(dir, "tls.key"), opts.key ?? leaf.key.keyPem);
      if (opts.ca) this.write(join(dir, "ca.crt"), opts.ca.certPem);
    },
  };
}
