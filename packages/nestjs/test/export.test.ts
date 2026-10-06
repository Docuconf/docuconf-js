import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import "reflect-metadata";
import { IsEmail, IsOptional } from "class-validator";
import { describe, expect, it } from "vitest";
import { SOURCE_CONDITIONS, canVet, cue, fmtCheck, requireVet, specCue, vet } from "../../core/test/support/cue.ts";
import { main } from "../src/cli.ts";
import { exportModule } from "../src/export.ts";
import { Describe, buildContract, declare, docuconfValidate, toContract } from "../src/index.ts";
import { EnvironmentVariables, validate } from "./fixtures/sample-env.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures/sample-env.ts");
const golden = join(here, "golden/sample-env.cue");
const example = join(here, "../../../examples/nestjs");
const bin = join(here, "../src/bin.ts");

describe("export", () => {
  it.runIf(requireVet)("has cue and the meta-schema available", () => {
    expect(cue, "cue binary").toBeDefined();
    expect(existsSync(join(specCue, "contract")), `meta-schema at ${specCue}`).toBe(true);
  });

  it("matches the golden file", () => {
    const out = toContract(validate);
    if (process.env["UPDATE_GOLDEN"] === "1") {
      mkdirSync(dirname(golden), { recursive: true });
      writeFileSync(golden, out);
    }
    expect(out).toBe(readFileSync(golden, "utf8"));
    expect(validate.declaration.warnings).toEqual([]);
  });

  it("names the generator and keeps vars and files sorted", () => {
    const data = buildContract(validate) as { metadata: { generator: unknown }; vars: object; files: object };
    expect(data.metadata.generator).toEqual({ language: "typescript", sdk: "@docuconf/nestjs", version: "0.1.0" });
    expect(Object.keys(data.vars)).toEqual([...Object.keys(data.vars)].sort());
    expect(Object.keys(data.files)).toEqual(["geoip", "license", "partner-keystore", "routes", "serving-tls", "upstream-ca"]);
  });

  it("exports from the class too, and is deterministic", () => {
    expect(toContract(EnvironmentVariables, { name: "sample-gateway" })).toBe(readFileSync(golden, "utf8"));
    expect(toContract(declare(EnvironmentVariables), { name: "sample-gateway" })).toBe(toContract(validate));
    expect(() => toContract(EnvironmentVariables)).toThrow(/no service name/);
  });

  it.skipIf(!canVet)("passes cue vet -c against the meta-schema", () => {
    const r = vet(toContract(validate));
    expect(r.output).toBe("");
    expect(r.ok).toBe(true);
  });

  it.skipIf(!canVet)("is already cue fmt formatted", () => {
    const r = fmtCheck(golden);
    expect(r.output).toBe("");
    expect(r.ok).toBe(true);
  });

  it.skipIf(!canVet)("cue vet catches a contract the meta-schema rejects", () => {
    const bad = readFileSync(golden, "utf8").replace('"Fraction of requests traced"', '"abc"');
    expect(vet(bad).ok).toBe(false);
  });

  it.skipIf(!canVet)("exports the example app to a valid, up-to-date contract", async () => {
    const { cue: out } = await exportModule(join(example, "src/config/env.validation.ts"));
    if (process.env["UPDATE_GOLDEN"] === "1") writeFileSync(join(example, "contract.cue"), out);
    expect(out).toBe(readFileSync(join(example, "contract.cue"), "utf8"));
    expect(vet(out).output).toBe("");
  });

  it("finds the validate function in a module, also one that calls ConfigModule.forRoot", async () => {
    const { cue: out, warnings } = await exportModule(fixture);
    expect(out).toBe(readFileSync(golden, "utf8"));
    expect(warnings).toEqual([]);
    const app = await exportModule(join(here, "fixtures/app.module.ts"), { name: "inline-app" });
    expect(app.cue).toContain('name: "inline-app"');
    expect(app.cue).toContain("APP_PORT: {");
  });

  it("asks which export to use when a module makes several", async () => {
    await expect(exportModule(join(here, "fixtures/two-envs.ts"))).rejects.toThrow(/2 times; pick one with --export/);
    const { cue: out } = await exportModule(join(here, "fixtures/two-envs.ts"), { exportName: "workerValidate", name: "worker" });
    expect(out).toContain("QUEUE_URL");
    expect(out).not.toContain("HTTP_PORT");
  });

  it("writes the contract from the CLI", async () => {
    const dir = mkdtempSync(join(tmpdir(), "docuconf-nest-cli-"));
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

  it("runs as a real process, compiling decorators with TypeScript", () => {
    const out = execFileSync(process.execPath, ["--no-warnings", SOURCE_CONDITIONS, bin, "export", fixture], { encoding: "utf8" });
    expect(out).toBe(readFileSync(golden, "utf8"));
  });

  it("warns about constraints the contract cannot express", () => {
    class Env {
      @IsOptional() @IsEmail() @Describe("Where alerts are sent")
      ALERT_EMAIL?: string;
    }
    const v = docuconfValidate(Env, { name: "w" });
    expect(v.declaration.warnings).toEqual(["ALERT_EMAIL: @IsEmail() is checked at boot, but the contract cannot express it"]);
    expect(toContract(v)).toContain('type:        "string"');
  });
});
