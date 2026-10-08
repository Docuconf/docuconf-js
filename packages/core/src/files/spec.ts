import type { X509Certificate } from "node:crypto";
import type { SecureContext, Server as TlsServer } from "node:tls";

export type FileType = "config" | "tls" | "caBundle" | "keystore" | "text" | "binary";
export type KeyAlgorithm = "RSA" | "ECDSA" | "Ed25519";

/** Options every file input takes (SPEC §4.6). */
export interface FileCommonOptions<R extends boolean = boolean> {
  /** Where the app reads the input: a file, or a directory for TLS. Absolute. */
  path: string;
  /** What the input is, in one sentence or phrase: plain text, at least 5 characters. */
  description: string;
  /**
   * Longer documentation for generated docs (SPEC §4.2): CommonMark, not
   * blank, at most 4000 characters. Never read at runtime. The export CLI
   * also takes it from the input's doc comment.
   */
  details?: string;
  /** Boot fails if the file is absent. Default false. */
  required?: R;
  /** Content must come from a secret store. Forced for TLS and keystores. */
  secret?: boolean;
  /** An env var the platform sets to `path`; when set at boot it overrides `path`. */
  pathEnv?: string;
  /** `restart` (default): read once. `watch`: docuconf re-reads it when it changes. */
  reload?: "restart" | "watch";
  /** Upper bound in bytes. */
  maxSize?: number;
  group?: string;
  deprecated?: { message: string; replacedBy?: string };
}

/** A structured config file. `S` is whatever the SDK binds files to: a Zod schema, a class. */
export interface ConfigFileOptions<S, R extends boolean> extends FileCommonOptions<R> {
  format: "json" | "yaml";
  /** The type the file binds to. Its JSON Schema goes into the contract. */
  schema: S;
}

export interface TlsFileOptions<R extends boolean> extends Omit<FileCommonOptions<R>, "secret"> {
  /** Names the certificate must cover (SAN). */
  dnsNames?: [string, ...string[]];
  keyAlgorithms?: KeyAlgorithm[];
  /** Least validity the certificate must have left, Go syntax ("720h"). */
  minRemaining?: string;
  /** Require ca.crt and verify tls.crt chains to it. */
  requireCA?: boolean;
}

export interface CaBundleFileOptions<R extends boolean> extends FileCommonOptions<R> {
  /** Default 1. */
  minCertificates?: number;
}

export interface KeystoreFileOptions<R extends boolean> extends Omit<FileCommonOptions<R>, "secret"> {
  /** Default "pkcs12". JKS keystores are only checked for existence and magic bytes. */
  format?: "pkcs12" | "jks";
  /** A declared secret variable holding the keystore password. */
  passwordVar?: string;
}

export interface TextFileOptions<R extends boolean> extends FileCommonOptions<R> {
  /** RE2-compatible pattern the whole content must match. */
  pattern?: string | RegExp;
  minLength?: number;
  maxLength?: number;
}

export type BinaryFileOptions<R extends boolean> = FileCommonOptions<R>;

/** A TLS key pair loaded from a kubernetes.io/tls directory. */
export interface TlsMaterial {
  /** PEM certificate chain (tls.crt). Always the latest when reload is "watch". */
  readonly cert: string;
  /** PEM private key (tls.key). */
  readonly key: string;
  /** PEM CA bundle (ca.crt), when present. */
  readonly ca: string | undefined;
  /** The parsed leaf certificate. */
  readonly certificate: X509Certificate;
  /** A secure context for the current key pair (cached until the next reload). */
  getSecureContext(): SecureContext;
  /**
   * Keeps `server` serving the current certificate: calls
   * `server.setSecureContext()` on every reload. Returns an unsubscribe.
   */
  attach(server: Pick<TlsServer, "setSecureContext">): () => void;
  /** Called after a reload that passed every check. Returns an unsubscribe. */
  onChange(listener: (material: TlsMaterial) => void): () => void;
}

/** A PEM CA bundle. Spread it into `https.request` options: `{ ...bundle }` gives `{ ca }`. */
export interface CaBundle {
  readonly ca: string;
  readonly certificates: readonly X509Certificate[];
}

/** A keystore. For PKCS#12, spread into TLS options: `{ ...ks }` gives `{ pfx, passphrase }`. */
export interface Keystore {
  readonly pfx: Buffer;
  readonly passphrase: string | undefined;
  readonly format: "pkcs12" | "jks";
}

/** A declared file input. Create one with configFile(), tlsFile() and the other helpers. */
export interface FileInput<TValue = unknown, TRequired extends boolean = boolean> {
  readonly "~docuconf": "file";
  readonly type: FileType;
  readonly options: FileCommonOptions & Record<string, unknown>;
  /** Phantom types for inference. */
  readonly "~types"?: { value: TValue; required: TRequired };
}

export type FileInputs = Record<string, FileInput<unknown, boolean>>;

/** The loaded value of each file input; optional inputs may be undefined. */
export type FileValues<T extends FileInputs> = {
  readonly [K in keyof T]: T[K] extends FileInput<infer V, infer R> ? (R extends true ? V : V | undefined) : never;
};

/** Builds a file input. SDKs use it for config files, whose value type depends on their schema type. */
export function makeFileInput<V, R extends boolean>(type: FileType, options: object): FileInput<V, R> {
  return Object.freeze({ "~docuconf": "file" as const, type, options: { ...options } as FileInput["options"] });
}

/** A TLS key pair directory (tls.crt, tls.key, optional ca.crt). */
export function tlsFile<const R extends boolean = false>(options: TlsFileOptions<R>): FileInput<TlsMaterial, R> {
  return makeFileInput("tls", { ...options, secret: true });
}

/** A PEM bundle of one or more CA certificates. */
export function caBundleFile<const R extends boolean = false>(options: CaBundleFileOptions<R>): FileInput<CaBundle, R> {
  return makeFileInput("caBundle", options);
}

/** A PKCS#12 (or JKS) keystore, opened at boot with the password in `passwordVar`. */
export function keystoreFile<const R extends boolean = false>(options: KeystoreFileOptions<R>): FileInput<Keystore, R> {
  return makeFileInput("keystore", { format: "pkcs12", ...options, secret: true });
}

/** A UTF-8 text file, such as a licence key. */
export function textFile<const R extends boolean = false>(options: TextFileOptions<R>): FileInput<string, R> {
  return makeFileInput("text", options);
}

/** Opaque bytes, such as a GeoIP database. Only the size is checked. */
export function binaryFile<const R extends boolean = false>(options: BinaryFileOptions<R>): FileInput<Buffer, R> {
  return makeFileInput("binary", options);
}

export function isFileInput(x: unknown): x is FileInput {
  return typeof x === "object" && x !== null && (x as { "~docuconf"?: unknown })["~docuconf"] === "file";
}

/**
 * How an SDK handles the schema of a config file: its JSON Schema for the
 * contract, and validation of the parsed content at boot.
 */
export interface SchemaAdapter {
  /** JSON Schema of the type the file binds to. Throws when it cannot be represented. */
  jsonSchema(schema: unknown): Record<string, unknown>;
  /** Checks parsed content and returns the bound value, or issues with a dotted path ("" for the root). */
  validate(schema: unknown, data: unknown): { value: unknown; issues?: undefined } | { issues: Array<{ path: string; message: string }> };
}
