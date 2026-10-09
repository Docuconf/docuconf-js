// The entry bundlers pick for browsers and edge runtimes (the "browser",
// "edge-light" and "worker" export conditions), so a "use client" component
// can import the same env.ts as the server. It has no Node built-ins:
// createEnv is T3's, with docuconf's options removed. Boot validation, file
// inputs and export are server features; the Node entry has them.
import { createEnv as t3CreateEnv } from "@t3-oss/env-core";
import type * as Node from "./index.ts";

export { annotate, duration, int64, json, keySet, list, secret, url } from "./helpers.ts";
export type { DurationOptions, Int64Options, JsonOptions, KeySetOptions, ListOptions, UrlOptions } from "./helpers.ts";
export type { Annotations } from "./meta.ts";
export {
  binaryFile,
  caBundleFile,
  configFile,
  keystoreFile,
  textFile,
  tlsFile,
  type CaBundle,
  type FileInput,
  type FileInputs,
  type FileValues,
  type Keystore,
  type KeyAlgorithm,
  type TlsMaterial,
} from "./files/spec.ts";
export type { CheckEnvOptions, CheckEnvResult, DocuconfEnv, DocuconfOptions } from "./env.ts";
export type { ContractOptions } from "./contract.ts";
export type { Declaration } from "./declaration.ts";
export {
  DocuconfDeclarationError,
  DocuconfValidationError,
  ERROR_CODES,
  KeySet,
  formatDuration,
  parseDuration,
  type ErrorCode,
  type Violation,
} from "@docuconf/core/pure";

const DOCUCONF_KEYS = ["name", "appVersion", "files", "fileRoot", "terminationLog", "onWarning", "watch", "exitOnError"];

function serverOnly(what: string): never {
  throw new Error(`docuconf: ${what} is server-only; this is @docuconf/t3's browser build`);
}

const noFiles = new Proxy(
  {},
  {
    get(_t, prop) {
      if (typeof prop !== "string") return undefined;
      return serverOnly(`env.files.${prop}`);
    },
  },
);

/** T3 Env's createEnv: client and shared variables are validated by T3, as without docuconf. */
export const createEnv: typeof Node.createEnv = ((opts: Record<string, unknown>) => {
  const t3opts: Record<string, unknown> = { ...opts };
  for (const k of DOCUCONF_KEYS) delete t3opts[k];
  const env = t3CreateEnv(t3opts as never) as object;
  return new Proxy(env, {
    get(target, prop) {
      if (prop === "files") return noFiles;
      return Reflect.get(target, prop);
    },
  });
}) as never;

export const checkEnv: typeof Node.checkEnv = () => serverOnly("checkEnv");
export const getDeclaration: typeof Node.getDeclaration = () => serverOnly("getDeclaration");
export const toContract: typeof Node.toContract = () => serverOnly("toContract");
export const onFileChange: typeof Node.onFileChange = () => serverOnly("onFileChange");
export const reloadFile: typeof Node.reloadFile = () => serverOnly("reloadFile");
export const closeWatchers: typeof Node.closeWatchers = () => serverOnly("closeWatchers");
export const buildContract: typeof Node.buildContract = () => serverOnly("buildContract");
export const renderContract: typeof Node.renderContract = () => serverOnly("renderContract");
