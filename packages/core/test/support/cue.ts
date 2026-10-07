import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

/** The CUE module from docuconf-go/spec/cue: DOCUCONF_SPEC_CUE, or a checkout beside this repo. */
export const specCue = process.env["DOCUCONF_SPEC_CUE"] ?? join(repoRoot, "../docuconf-go/spec/cue");

function findCue(): string | undefined {
  const candidates = [process.env["CUE"], join(homedir(), "go/bin/cue"), "cue"].filter((c): c is string => !!c);
  for (const c of candidates) {
    const r = spawnSync(c, ["version"], { encoding: "utf8" });
    if (r.status === 0) return c;
  }
  return undefined;
}

export const cue = findCue();
export const canVet = cue !== undefined && existsSync(join(specCue, "cue.mod")) && existsSync(join(specCue, "contract"));
/** CI sets DOCUCONF_REQUIRE_VET=1 so a missing cue binary or spec checkout fails instead of skipping. */
export const requireVet = process.env["DOCUCONF_REQUIRE_VET"] === "1";

/** Copies the meta-schema module to a temp dir and vets `contract` as package ./svc. */
export function vet(contract: string): { ok: boolean; output: string } {
  const dir = mkdtempSync(join(tmpdir(), "docuconf-vet-"));
  cpSync(join(specCue, "cue.mod"), join(dir, "cue.mod"), { recursive: true });
  cpSync(join(specCue, "contract"), join(dir, "contract"), { recursive: true });
  mkdirSync(join(dir, "svc"));
  writeFileSync(join(dir, "svc/contract.cue"), contract);
  const r = spawnSync(cue!, ["vet", "-c", "./svc"], { cwd: dir, encoding: "utf8" });
  return { ok: r.status === 0, output: `${r.stdout}${r.stderr}` };
}

/** Runs `cue fmt --check` on a file. */
export function fmtCheck(file: string): { ok: boolean; output: string } {
  const r = spawnSync(cue!, ["fmt", "--check", file], { encoding: "utf8" });
  return { ok: r.status === 0, output: `${r.stdout}${r.stderr}` };
}

/** Node flags for running workspace TypeScript sources in a child process. */
export const SOURCE_CONDITIONS = "--conditions=@docuconf/source";

/**
 * Replaces the value of metadata.generator.version in an exported contract. It is the SDK version, which every
 * release PR bumps, so comparisons with committed exports (golden files, example contracts) ignore it.
 */
export function withoutGeneratorVersion(contract: string): string {
  return contract.replace(/(generator:\s*\{[^{}]*?\bversion:\s*)"[^"]*"/g, '$1"<generator-version>"');
}
