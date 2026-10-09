import { type FSWatcher, readFileSync, statSync, watch } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { createSecureContext } from "node:tls";
import { parse as parseToml } from "smol-toml";
import { parseDocument } from "yaml";
import { re2RegExp } from "../re2.ts";
import { parseJsonExact } from "../vars.ts";
import { type ErrorCode, type Violation, formatViolations } from "../violations.ts";
import type { FileInput, Keystore, KeyAlgorithm, SchemaAdapter } from "./spec.ts";
import { type Report, TlsMaterialHolder, checkCaBundle, checkTls } from "./tls.ts";

export interface LoadContext {
  /** Raw runtime environment (for pathEnv). */
  env: Record<string, unknown>;
  /** Validated server values (for keystore passwordVar). */
  values: Record<string, unknown>;
  /** DOCUCONF_FILE_ROOT: prefix for absolute paths, for local development and tests. */
  root: string | undefined;
  /** Validates config files against their schema. */
  adapter: SchemaAdapter;
}

/** The file root from DOCUCONF_FILE_ROOT, unless an option overrides it. */
export function fileRootFrom(option: string | undefined): string | undefined {
  return option ?? (process.env["DOCUCONF_FILE_ROOT"] || undefined);
}

/** Where to read an input: its pathEnv when set, else its path, under the file root. */
export function resolvePath(input: FileInput, ctx: LoadContext): string {
  const fromEnv = input.options.pathEnv ? ctx.env[input.options.pathEnv] : undefined;
  const p = typeof fromEnv === "string" && fromEnv !== "" ? fromEnv : input.options.path;
  return ctx.root && isAbsolute(p) ? join(ctx.root, p) : p;
}

type ReadResult = Buffer | "absent" | "failed";

function readChecked(file: string, label: string, maxSize: number | undefined, report: Report): ReadResult {
  let size: number;
  try {
    const st = statSync(file);
    if (st.isDirectory()) {
      report("file_malformed", `${label} is a directory, expected a file`);
      return "failed";
    }
    size = st.size;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return "absent";
    report("file_unreadable", `${label} cannot be accessed (${code ?? "error"})`);
    return "failed";
  }
  if (maxSize !== undefined && size > maxSize) {
    report("file_too_large", `${label} is ${size} bytes, more than maxSize ${maxSize}`);
    return "failed";
  }
  try {
    return readFileSync(file);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    report(
      "file_unreadable",
      `${label} exists but cannot be read (${code ?? "error"}); a secret volume with mode 0400 needs the pod's securityContext.fsGroup when the container runs as non-root`,
    );
    return "failed";
  }
}

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** A structured file's format (SPEC §4.6 `config`, §4.7 overlays). */
export type StructuredFormat = "json" | "yaml" | "toml";

/**
 * Parses a structured file's text (a BOM already removed). Returns the data,
 * or a message saying why it does not parse; with `quiet` (a secret file)
 * the message never quotes the content. With `exact`, JSON integers beyond
 * 2^53 are read as bigints, as TOML's always are.
 */
export function parseStructured(format: StructuredFormat, text: string, quiet = false, exact = false): { data: unknown } | { problem: string } {
  if (format === "yaml") {
    const doc = parseDocument(text, { prettyErrors: false });
    if (doc.errors.length > 0) {
      const e = doc.errors[0]!;
      return { problem: quiet ? "not valid YAML" : `not valid YAML: ${e.code} at line ${e.linePos?.[0]?.line ?? "?"}` };
    }
    return { data: doc.toJS() };
  }
  if (format === "toml") {
    try {
      return { data: parseToml(text, { integersAsBigInt: "asNeeded" }) };
    } catch (e) {
      // smol-toml's messages quote the line, so never for secrets.
      return { problem: quiet ? "not valid TOML" : `not valid TOML: ${(e as Error).message.split("\n")[0]}` };
    }
  }
  try {
    return { data: exact ? parseJsonExact(text) : JSON.parse(text) };
  } catch (e) {
    // JSON.parse messages quote the content, so never for secrets.
    return { problem: quiet ? "not valid JSON" : `not valid JSON: ${(e as Error).message}` };
  }
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** The loaded value of one file input, or undefined (optional and absent). */
export interface Loaded {
  value: unknown;
  violations: Violation[];
}

/** Reads and checks one file input (SPEC §11.2 item 7). */
export function loadFile(name: string, input: FileInput, ctx: LoadContext, now = Date.now()): Loaded {
  const violations: Violation[] = [];
  const o = input.options;
  const report: Report = (code: ErrorCode, message: string) => violations.push({ input: name, kind: "file", code, message });
  const path = resolvePath(input, ctx);
  const required = o.required === true;
  // Outside a cluster the platform's mounts do not exist; say how to point at local copies.
  const hint = ctx.root === undefined && isAbsolute(path) ? " (for local development, set DOCUCONF_FILE_ROOT)" : "";
  const missing = (what: string): Loaded => {
    if (required) report("file_missing", `${what} not found${hint}`);
    return { value: undefined, violations };
  };

  if (input.type === "tls") {
    let isDir = false;
    try {
      isDir = statSync(path).isDirectory();
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return missing(`directory ${path}`);
      report("file_unreadable", `directory ${path} cannot be accessed (${code ?? "error"})`);
      return { value: undefined, violations };
    }
    if (!isDir) {
      report("file_malformed", `${path} must be a directory holding tls.crt and tls.key`);
      return { value: undefined, violations };
    }
    const cert = readChecked(join(path, "tls.crt"), `${path}/tls.crt`, o.maxSize, report);
    const key = readChecked(join(path, "tls.key"), `${path}/tls.key`, o.maxSize, report);
    const ca = readChecked(join(path, "ca.crt"), `${path}/ca.crt`, o.maxSize, report);
    if (cert === "absent") report("file_missing", `${path}/tls.crt not found${hint}`);
    if (key === "absent") report("file_missing", `${path}/tls.key not found${hint}`);
    if (!(cert instanceof Buffer) || !(key instanceof Buffer) || ca === "failed") return { value: undefined, violations };
    const parts = checkTls(
      { cert: cert.toString("utf8"), key: key.toString("utf8"), ca: ca instanceof Buffer ? ca.toString("utf8") : undefined },
      {
        dnsNames: o["dnsNames"] as string[] | undefined,
        keyAlgorithms: o["keyAlgorithms"] as KeyAlgorithm[] | undefined,
        minRemaining: o["minRemaining"] as string | undefined,
        requireCA: o["requireCA"] === true,
      },
      report,
      now,
    );
    return { value: parts, violations };
  }

  const data = readChecked(path, path, o.maxSize, report);
  if (data === "absent") return missing(path);
  if (data === "failed") return { value: undefined, violations };

  switch (input.type) {
    case "binary":
      return { value: data, violations };
    case "text": {
      let text: string;
      try {
        text = utf8.decode(data);
      } catch {
        report("file_malformed", `${path} is not UTF-8 text`);
        return { value: undefined, violations };
      }
      const pattern = o["pattern"] as string | RegExp | undefined;
      // A contract pattern is RE2 (SPEC §4.3), compiled as every other pattern is.
      const compiled = typeof pattern === "string" ? re2RegExp(pattern) : pattern;
      const re = compiled instanceof RegExp ? compiled : undefined;
      // Contract patterns match anywhere in the value, like RegExp.test.
      if (re && !re.test(text)) report("pattern_mismatch", `content does not match ${String(re.source)}`);
      const runes = [...text].length;
      const minLength = o["minLength"] as number | undefined;
      const maxLength = o["maxLength"] as number | undefined;
      if (minLength !== undefined && runes < minLength) report("out_of_range", `content is ${runes} characters, fewer than ${minLength}`);
      if (maxLength !== undefined && runes > maxLength) report("out_of_range", `content is ${runes} characters, more than ${maxLength}`);
      return { value: violations.length ? undefined : text, violations };
    }
    case "caBundle": {
      const bundle = checkCaBundle(data.toString("utf8"), (o["minCertificates"] as number | undefined) ?? 1, report);
      return { value: bundle, violations };
    }
    case "keystore": {
      const format = (o["format"] as "pkcs12" | "jks" | undefined) ?? "pkcs12";
      const passwordVar = o["passwordVar"] as string | undefined;
      const pw = passwordVar ? ctx.values[passwordVar] : undefined;
      // An unset password variable is an empty password (SPEC §11.2 item 7).
      const passphrase = typeof pw === "string" ? pw : passwordVar !== undefined ? "" : undefined;
      if (format === "jks") {
        // Node has no JKS parser: check the magic number only.
        const magic = data.length >= 4 ? data.readUInt32BE(0) : 0;
        if (magic !== 0xfeedfeed && magic !== 0xcececece) {
          report("keystore_unreadable", "not a JKS or JCEKS keystore");
          return { value: undefined, violations };
        }
      } else {
        try {
          // OpenSSL, through Node's TLS layer, opens PKCS#12 natively.
          createSecureContext({ pfx: data, ...(passphrase !== undefined ? { passphrase } : {}) });
        } catch (e) {
          const msg = (e as Error).message;
          const wrongPw = /mac verify|password|decrypt/i.test(msg);
          report(
            "keystore_unreadable",
            wrongPw
              ? `cannot open the PKCS#12 keystore with the password from ${passwordVar ?? "(no passwordVar)"}`
              : `cannot open the PKCS#12 keystore (${msg})`,
          );
          return { value: undefined, violations };
        }
      }
      const ks: Keystore = Object.freeze({ pfx: data, passphrase, format });
      return { value: ks, violations };
    }
    case "config": {
      const text = stripBom(data.toString("utf8"));
      const p = parseStructured((o["format"] as StructuredFormat | undefined) ?? "json", text, o.secret === true);
      if ("problem" in p) {
        report("file_malformed", p.problem);
        return { value: undefined, violations };
      }
      const r = ctx.adapter.validate(o["schema"], p.data);
      if (r.issues !== undefined) {
        for (const issue of r.issues) report("schema_mismatch", `${issue.path || "(root)"}: ${issue.message}`);
        return { value: undefined, violations };
      }
      return { value: r.value, violations };
    }
  }
  return { value: undefined, violations };
}

/** Holds the current value of each file input and re-reads `reload: watch` inputs. */
export class FileState {
  private readonly values = new Map<string, unknown>();
  private readonly tls = new Map<string, TlsMaterialHolder>();
  private readonly listeners = new Map<string, Set<(v: unknown) => void>>();
  private readonly watchers: FSWatcher[] = [];
  readonly proxy: Record<string, unknown>;
  private readonly inputs: Record<string, FileInput>;
  private readonly ctx: LoadContext;

  constructor(inputs: Record<string, FileInput>, ctx: LoadContext) {
    this.inputs = inputs;
    this.ctx = ctx;
    const proxy: Record<string, unknown> = {};
    for (const name of Object.keys(inputs)) {
      Object.defineProperty(proxy, name, { enumerable: true, get: () => this.get(name) });
    }
    this.proxy = Object.freeze(proxy);
  }

  get(name: string): unknown {
    const holder = this.tls.get(name);
    return holder ? holder.material : this.values.get(name);
  }

  /** Stores a freshly loaded value. TLS keeps one stable material object. */
  set(name: string, value: unknown): void {
    const input = this.inputs[name]!;
    if (input.type === "tls" && value !== undefined) {
      const holder = this.tls.get(name);
      if (holder) holder.update(value as ConstructorParameters<typeof TlsMaterialHolder>[0]);
      else this.tls.set(name, new TlsMaterialHolder(value as ConstructorParameters<typeof TlsMaterialHolder>[0]));
    } else {
      this.values.set(name, value);
    }
  }

  onChange(name: string, listener: (v: unknown) => void): () => void {
    let set = this.listeners.get(name);
    if (!set) this.listeners.set(name, (set = new Set()));
    set.add(listener);
    return () => set.delete(listener);
  }

  /**
   * Watches the mount directory of every `reload: watch` input. Kubernetes
   * swaps a `..data` symlink to update projected files, so the directory is
   * watched, not the file. A reload that fails its checks is logged and the
   * previous value kept.
   */
  watch(debounceMs = 100): void {
    for (const [name, input] of Object.entries(this.inputs)) {
      if (input.options.reload !== "watch") continue;
      const path = resolvePath(input, this.ctx);
      const dir = input.type === "tls" ? path : dirname(path);
      let timer: NodeJS.Timeout | undefined;
      try {
        const w = watch(dir, { persistent: false }, () => {
          clearTimeout(timer);
          timer = setTimeout(() => this.reload(name), debounceMs);
          timer.unref();
        });
        w.on("error", () => w.close());
        this.watchers.push(w);
      } catch {
        // Directory absent (optional input): nothing to watch.
      }
    }
  }

  /** Loads every input, as at boot. Returns the violations; values are stored either way. */
  loadAll(): Violation[] {
    const violations: Violation[] = [];
    for (const [name, input] of Object.entries(this.inputs)) {
      const r = loadFile(name, input, this.ctx);
      violations.push(...r.violations);
      this.set(name, r.value);
    }
    return violations;
  }

  reload(name: string): boolean {
    const r = loadFile(name, this.inputs[name]!, this.ctx);
    if (r.violations.length > 0) {
      console.error(`docuconf: keeping the previous ${name} after a failed reload\n${formatViolations(r.violations)}`);
      return false;
    }
    if (r.value === undefined) return false;
    this.set(name, r.value);
    for (const l of this.listeners.get(name) ?? []) {
      try {
        l(this.get(name));
      } catch (e) {
        console.error(`docuconf: ${name} reload listener failed:`, e);
      }
    }
    return true;
  }

  close(): void {
    for (const w of this.watchers.splice(0)) w.close();
  }
}
