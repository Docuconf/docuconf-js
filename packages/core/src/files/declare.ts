import { posix } from "node:path";
import { CONTRACT_DURATION, canonicalDuration } from "../duration.ts";
import { closeSchema } from "../jsonschema.ts";
import { cleanPattern, nonRe2Feature } from "../re2.ts";
import { ENV_NAME, validDescription } from "../vars.ts";
import type { FileInput, SchemaAdapter } from "./spec.ts";

export const INPUT_NAME = /^[a-z]([-a-z0-9]{0,40}[a-z0-9])?$/;
const ABS_PATH = /^\/[A-Za-z0-9._/-]+$/;

/** Mirrors #ReservedDirs in files.cue: never mount over these. */
export const RESERVED_DIRS = [
  "/", "/app", "/bin", "/boot", "/dev", "/etc", "/etc/pki", "/etc/ssl",
  "/etc/ssl/certs", "/home", "/lib", "/lib64", "/opt", "/proc", "/root",
  "/run", "/sbin", "/srv", "/sys", "/tmp", "/usr", "/usr/lib", "/usr/local",
  "/usr/share", "/var", "/var/lib", "/var/run",
];

function isAbsPath(p: string): boolean {
  return ABS_PATH.test(p) && !/(^|\/)\.\.?(\/|$)/.test(p) && !p.includes("//") && !p.endsWith("/");
}

function patternSource(p: string | RegExp): string {
  return typeof p === "string" ? p : cleanPattern(p.source);
}

/** How the SDK names things in declaration problems. */
export interface DescribeFilesOptions {
  /** Prefix of each problem. Default `files.<name>`. */
  label?: (name: string) => string;
  /** How to make a variable secret, for the passwordVar hint. Default "wrap it in secret()". */
  secretHint?: string;
  /** What the SDK calls a declared variable. Default "server variable". */
  varNoun?: string;
}

/**
 * Checks file declarations (SPEC §4.6, mount rules) and returns each
 * input's contract fields, in output order. `vars` are the declared
 * variables, for pathEnv and passwordVar checks.
 */
export function describeFiles(
  files: Record<string, FileInput>,
  vars: ReadonlyMap<string, { secret: boolean }>,
  problems: string[],
  adapter: SchemaAdapter,
  opts: DescribeFilesOptions = {},
): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  const mountDirs = new Map<string, string>();
  const pathEnvs = new Map<string, string>();

  for (const [name, input] of Object.entries(files)) {
    const o = input.options;
    const noun = opts.varNoun ?? "server variable";
    const label = opts.label ? opts.label(name) : `files.${name}`;
    const p = (msg: string) => problems.push(`${label}: ${msg}`);
    if (!INPUT_NAME.test(name)) p(`input names must be DNS labels matching ${INPUT_NAME.source}`);
    if (!validDescription(o.description)) p("needs a description of at least 5 characters");
    if (!isAbsPath(o.path)) p(`path "${o.path}" must be absolute and normalised`);
    else {
      const dir = input.type === "tls" ? o.path : posix.dirname(o.path);
      if (RESERVED_DIRS.includes(dir)) p(`would be mounted at ${dir}, which hides a directory the image needs; use a subdirectory`);
      const other = mountDirs.get(dir);
      if (other !== undefined) p(`shares mount directory ${dir} with ${other}; each input needs its own directory`);
      mountDirs.set(dir, name);
    }
    if (o.pathEnv !== undefined) {
      if (!ENV_NAME.test(o.pathEnv)) p(`pathEnv must match ${ENV_NAME.source}`);
      if (vars.has(o.pathEnv)) p(`pathEnv ${o.pathEnv} must not also be a ${noun}`);
      const other = pathEnvs.get(o.pathEnv);
      if (other !== undefined) p(`pathEnv ${o.pathEnv} is also used by ${other}`);
      pathEnvs.set(o.pathEnv, name);
    }
    if (o.maxSize !== undefined && (!Number.isInteger(o.maxSize) || o.maxSize <= 0)) p("maxSize must be a positive integer");
    if (o.reload !== undefined && o.reload !== "restart" && o.reload !== "watch") p('reload must be "restart" or "watch"');

    const c: Record<string, unknown> = { type: input.type };
    if (input.type === "config" || input.type === "keystore") c["format"] = o["format"];
    c["description"] = o.description;
    if (o.required === true) c["required"] = true;
    if (o.secret === true) c["secret"] = true;
    c["path"] = o.path;
    if (o.pathEnv !== undefined) c["pathEnv"] = o.pathEnv;
    if (o.reload === "watch") c["reload"] = "watch";
    if (o.maxSize !== undefined) c["maxSize"] = o.maxSize;
    if (o.group !== undefined) c["group"] = o.group;
    if (o.deprecated !== undefined) {
      if (o.deprecated.replacedBy !== undefined && !INPUT_NAME.test(o.deprecated.replacedBy)) p("deprecated.replacedBy must be an input name");
      c["deprecated"] = o.deprecated;
    }

    switch (input.type) {
      case "config": {
        if (o["format"] !== "json" && o["format"] !== "yaml") p('format must be "json" or "yaml"');
        try {
          c["schema"] = closeSchema(adapter.jsonSchema(o["schema"]));
        } catch (e) {
          p(`schema cannot be converted to JSON Schema${e instanceof Error && e.message ? ` (${e.message})` : ""}`);
        }
        break;
      }
      case "tls": {
        const dnsNames = o["dnsNames"] as string[] | undefined;
        if (dnsNames !== undefined) {
          if (dnsNames.length === 0) p("dnsNames must not be empty when given");
          c["dnsNames"] = dnsNames;
        }
        const algs = o["keyAlgorithms"] as string[] | undefined;
        if (algs !== undefined) {
          for (const a of algs) if (!["RSA", "ECDSA", "Ed25519"].includes(a)) p(`unknown key algorithm ${a}`);
          c["keyAlgorithms"] = algs;
        }
        const minRemaining = o["minRemaining"] as string | undefined;
        if (minRemaining !== undefined) {
          const canon = CONTRACT_DURATION.test(minRemaining) ? minRemaining : canonicalDuration(minRemaining);
          if (canon === undefined) p(`minRemaining "${minRemaining}" is not a Go duration`);
          else c["minRemaining"] = canon;
        }
        if (o["requireCA"] === true) c["requireCA"] = true;
        break;
      }
      case "caBundle": {
        const min = o["minCertificates"] as number | undefined;
        if (min !== undefined) {
          if (!Number.isInteger(min) || min < 1) p("minCertificates must be an integer >= 1");
          if (min !== 1) c["minCertificates"] = min;
        }
        break;
      }
      case "keystore": {
        if (o["format"] !== "pkcs12" && o["format"] !== "jks") p('format must be "pkcs12" or "jks"');
        const pv = o["passwordVar"] as string | undefined;
        if (pv !== undefined) {
          const v = vars.get(pv);
          if (!v) p(`passwordVar ${pv} must be a declared ${noun}`);
          else if (!v.secret) p(`passwordVar ${pv} must be a secret variable (${opts.secretHint ?? "wrap it in secret()"})`);
          c["passwordVar"] = pv;
        }
        break;
      }
      case "text": {
        const pattern = o["pattern"] as string | RegExp | undefined;
        if (pattern !== undefined) {
          if (pattern instanceof RegExp && pattern.flags.replace(/[gu]/g, "") !== "") {
            p(`pattern flags /${pattern.flags} cannot be expressed in the contract; use inline syntax`);
          }
          const src = patternSource(pattern);
          const bad = nonRe2Feature(src);
          if (bad) p(`pattern uses ${bad}, which RE2 does not support`);
          c["pattern"] = src;
        }
        if (o["minLength"] !== undefined) c["minLength"] = o["minLength"];
        if (o["maxLength"] !== undefined) c["maxLength"] = o["maxLength"];
        break;
      }
      case "binary":
        break;
    }
    out.set(name, c);
  }
  return out;
}
