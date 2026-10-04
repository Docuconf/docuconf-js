import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createEnv, secret, toContract } from "../src/index.ts";
import { main } from "../src/cli.ts";
import { exportModule } from "../src/export.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures/sample-env.ts");
const golden = join(here, "golden/sample-env.cue");

/** The CUE module from docuconf-go/spec/cue, if checked out beside this repo. */
const specCue = process.env["DOCUCONF_SPEC_CUE"] ?? join(here, "../../docuconf-go/spec/cue");

function findCue(): string | undefined {
  const candidates = [process.env["CUE"], join(homedir(), "go/bin/cue"), "cue"].filter((c): c is string => !!c);
  for (const c of candidates) {
    const r = spawnSync(c, ["version"], { encoding: "utf8" });
    if (r.status === 0) return c;
  }
  return undefined;
}
const cue = findCue();
const canVet = cue !== undefined && existsSync(join(specCue, "cue.mod")) && existsSync(join(specCue, "contract"));

/** Copies the meta-schema module to a temp dir and vets `contract` as package ./svc. */
function vet(contract: string): { ok: boolean; output: string } {
  const dir = mkdtempSync(join(tmpdir(), "docuconf-vet-"));
  cpSync(join(specCue, "cue.mod"), join(dir, "cue.mod"), { recursive: true });
  cpSync(join(specCue, "contract"), join(dir, "contract"), { recursive: true });
  mkdirSync(join(dir, "svc"));
  writeFileSync(join(dir, "svc/contract.cue"), contract);
  const r = spawnSync(cue!, ["vet", "-c", "./svc"], { cwd: dir, encoding: "utf8" });
  return { ok: r.status === 0, output: `${r.stdout}${r.stderr}` };
}

describe("export", () => {
  // CI sets DOCUCONF_REQUIRE_VET=1 so a missing cue binary or spec checkout fails instead of skipping.
  it.runIf(process.env["DOCUCONF_REQUIRE_VET"] === "1")("has cue and the meta-schema available", () => {
    expect(cue, "cue binary").toBeDefined();
    expect(existsSync(join(specCue, "contract")), `meta-schema at ${specCue}`).toBe(true);
  });

  it("matches the golden file", async () => {
    const { cue: out, warnings } = await exportModule(fixture);
    expect(warnings).toEqual([]);
    if (process.env["UPDATE_GOLDEN"] === "1") {
      mkdirSync(dirname(golden), { recursive: true });
      writeFileSync(golden, out);
    }
    expect(out).toBe(readFileSync(golden, "utf8"));
  });

  it("is deterministic", async () => {
    const a = await exportModule(fixture);
    const b = await exportModule(fixture);
    expect(a.cue).toBe(b.cue);
  });

  it.skipIf(!canVet)("passes cue vet against the meta-schema", async () => {
    const { cue: out } = await exportModule(fixture);
    const r = vet(out);
    expect(r.output).toBe("");
    expect(r.ok).toBe(true);
  });

  it.skipIf(!canVet)("exports the example app to a valid, up-to-date contract", async () => {
    const example = join(here, "../examples/basic");
    const { cue: out } = await exportModule(join(example, "env.ts"));
    expect(out).toBe(readFileSync(join(example, "contract.cue"), "utf8"));
    expect(vet(out).output).toBe("");
  });

  it.skipIf(!canVet)("is already cue fmt formatted", () => {
    const r = spawnSync(cue!, ["fmt", "--check", golden], { encoding: "utf8" });
    expect(`${r.stdout}${r.stderr}`).toBe("");
    expect(r.status).toBe(0);
  });

  it.skipIf(!canVet)("cue vet catches a contract the meta-schema rejects", () => {
    const bad = readFileSync(golden, "utf8").replace('"Fraction of requests traced"', '"abc"');
    expect(vet(bad).ok).toBe(false);
  });

  it("leaves client (build-time) and shared variables out", () => {
    const env = createEnv({
      name: "web",
      clientPrefix: "PUBLIC_",
      server: { API_KEY: secret(z.string()).describe("Upstream API key") },
      client: { PUBLIC_ANALYTICS_ID: z.string().describe("Analytics site id") },
      shared: { NODE_ENV: z.enum(["development", "production"]).describe("Node environment") },
      runtimeEnv: { API_KEY: "k", PUBLIC_ANALYTICS_ID: "a", NODE_ENV: "production" },
    });
    const out = toContract(env);
    expect(out).toContain("API_KEY");
    expect(out).not.toContain("PUBLIC_ANALYTICS_ID");
    expect(out).not.toContain("NODE_ENV");
  });

  it("takes name, appVersion and package from options", () => {
    const env = createEnv({
      server: { PORT: z.coerce.number().int().default(8080).describe("HTTP listen port") },
      runtimeEnv: {},
    });
    expect(() => toContract(env)).toThrow(/no service name/);
    const out = toContract(env, { name: "billing-api", appVersion: "1.4.0", packageName: "billing" });
    expect(out).toContain("package billing\n");
    expect(out).toContain('appVersion: "1.4.0"');
    expect(() => toContract(env, { name: "Billing" })).toThrow(/DNS label/);
  });

  it("writes the contract from the CLI", async () => {
    const dir = mkdtempSync(join(tmpdir(), "docuconf-cli-"));
    const outFile = join(dir, "contract.cue");
    const err: string[] = [];
    const io = { out: { write: () => true }, err: { write: (s: string) => (err.push(s), true) } } as never;
    const code = await main(["export", fixture, "--out", outFile, "--name", "renamed", "--app-version", "abc123"], io);
    expect(err.join("")).toContain("wrote");
    expect(code).toBe(0);
    const out = readFileSync(outFile, "utf8");
    expect(out).toContain('name:       "renamed"');
    expect(out).toContain("package renamed\n");
    expect(await main(["export"], io)).toBe(2);
    expect(await main(["nope"], io)).toBe(2);
  });

  it("runs as a real process with Node's type stripping", () => {
    const bin = join(here, "../src/bin.ts");
    const out = execFileSync(process.execPath, ["--no-warnings", bin, "export", fixture], { encoding: "utf8" });
    expect(out).toBe(readFileSync(golden, "utf8"));
  });

  it("falls back to jiti for extensionless TypeScript imports", () => {
    const bin = join(here, "../src/bin.ts");
    const out = execFileSync(process.execPath, ["--no-warnings", bin, "export", join(here, "fixtures/jiti-env.ts")], {
      encoding: "utf8",
    });
    expect(out).toContain("JITI_LOADED");
  });
});
