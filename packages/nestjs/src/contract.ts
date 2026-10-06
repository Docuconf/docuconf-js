import { type ContractOptions, type Generator, buildContract as coreBuildContract, renderContract as coreRenderContract } from "@docuconf/core";
import type { Class } from "./classes.ts";
import { type NestDeclaration, declare } from "./declaration.ts";
import { declarationOf } from "./validate.ts";
import { SDK_NAME, SDK_VERSION } from "./version.ts";

export type { ContractOptions };

const GENERATOR: Generator = { language: "typescript", sdk: SDK_NAME, version: SDK_VERSION };

/** A validate function from docuconfValidate, an environment class, or a declaration. */
export type ContractSourceInput = NestDeclaration | ((...args: never[]) => unknown) | Class;

function resolve(source: ContractSourceInput): NestDeclaration {
  if (typeof source === "object") return source;
  return declarationOf(source) ?? declare(source as Class);
}

/** The contract as plain data, in output order (SPEC §4, §11.2 item 3). */
export function buildContract(source: ContractSourceInput, opts: ContractOptions = {}): Record<string, unknown> {
  return coreBuildContract(resolve(source), opts, GENERATOR);
}

/**
 * The contract as CUE, what `docuconf-nestjs export` writes. Pass the
 * validate function from docuconfValidate, or the environment class with
 * a `name` option.
 */
export function toContract(source: ContractSourceInput, opts: ContractOptions = {}): string {
  return coreRenderContract(resolve(source), opts, GENERATOR);
}
