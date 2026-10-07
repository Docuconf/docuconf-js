import {
  type ContractOptions,
  type Generator,
  buildContract as coreBuildContract,
  renderContract as coreRenderContract,
} from "@docuconf/core/pure";
import type { Declaration } from "./declaration.ts";
import { SDK_NAME, SDK_VERSION } from "./version.ts";

export type { ContractOptions };

const GENERATOR: Generator = { language: "typescript", sdk: SDK_NAME, version: SDK_VERSION };

function withName(decl: Declaration, opts: ContractOptions): ContractOptions {
  if (opts.name === undefined && decl.name === undefined) {
    throw new Error("docuconf: no service name; pass createEnv({ name }) or --name");
  }
  return opts;
}

/** The contract as plain data, in output order (SPEC §4, §11.2 item 3). */
export function buildContract(decl: Declaration, opts: ContractOptions = {}): Record<string, unknown> {
  return coreBuildContract(decl, withName(decl, opts), GENERATOR);
}

/** Writes the contract as a CUE file that unifies with contract.#Contract. */
export function renderContract(decl: Declaration, opts: ContractOptions = {}): string {
  return coreRenderContract(decl, withName(decl, opts), GENERATOR);
}
