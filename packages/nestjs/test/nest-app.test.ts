import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "reflect-metadata";
import { Inject, Injectable, Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { IsEnum, IsInt, IsOptional, Max, Min } from "class-validator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileRoot } from "../../core/test/support/certs.ts";
import { z } from "zod";
import { createEnv, duration, secret, url } from "../../t3/src/index.ts";
import { Describe, DocuconfValidationError, Duration, List, Secret, TextFile, UrlSchemes, docuconfValidate } from "../src/index.ts";

enum NodeEnv {
  Development = "development",
  Production = "production",
}

// The class from the NestJS configuration docs, plus docuconf's decorators.
class EnvironmentVariables {
  @IsEnum(NodeEnv) @Describe("Environment the app runs in")
  NODE_ENV: NodeEnv = NodeEnv.Production;

  @IsInt() @Min(0) @Max(65535) @Describe("Port the app listens on")
  PORT: number = 3000;

  @Secret() @UrlSchemes("postgres") @Describe("Primary Postgres connection string")
  DATABASE_URL!: string;

  @Duration({ default: "30s" }) @Describe("Upstream request timeout")
  REQUEST_TIMEOUT!: number;

  @IsOptional() @List() @Describe("CORS origins allowed to call the API")
  ALLOWED_ORIGINS?: string[];

  @TextFile({ path: "/etc/app/license/license.key", description: "Licence key", required: true })
  license!: string;
}

@Injectable()
class AppService {
  constructor(@Inject(ConfigService) private readonly config: ConfigService<EnvironmentVariables, true>) {}

  describe() {
    return {
      port: this.config.get("PORT", { infer: true }),
      env: this.config.get("NODE_ENV", { infer: true }),
      timeout: this.config.get("REQUEST_TIMEOUT", { infer: true }),
      origins: this.config.get("ALLOWED_ORIGINS", { infer: true }),
      license: this.config.get("license", { infer: true }),
      url: this.config.get("DATABASE_URL", { infer: true }),
    };
  }
}

const VARS = ["NODE_ENV", "PORT", "DATABASE_URL", "REQUEST_TIMEOUT", "ALLOWED_ORIGINS", "DOCUCONF_FILE_ROOT"];
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
  for (const k of VARS) delete process.env[k];
  const fr = fileRoot();
  fr.write("/etc/app/license/license.key", "LICENSE-1");
  process.env["DOCUCONF_FILE_ROOT"] = fr.root;
});

// ConfigModule copies validated values to process.env; put it back.
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function compile(terminationLog: string | false = false) {
  const validate = docuconfValidate(EnvironmentVariables, { name: "nest-app", terminationLog, watch: false });
  @Module({ imports: [ConfigModule.forRoot({ ignoreEnvFile: true, validate })], providers: [AppService] })
  class AppModule {}
  return Test.createTestingModule({ imports: [AppModule] }).compile();
}

describe("ConfigModule.forRoot({ validate: docuconfValidate(...) })", () => {
  it("boots and serves typed values, durations, lists and files through ConfigService", async () => {
    process.env["DATABASE_URL"] = "postgres://u:p@db/app";
    process.env["PORT"] = "8080";
    process.env["ALLOWED_ORIGINS"] = "https://a.example,https://b.example";
    const app = await compile();
    expect(app.get(AppService).describe()).toEqual({
      port: 8080,
      env: "production",
      timeout: 30_000,
      origins: ["https://a.example", "https://b.example"],
      license: "LICENSE-1",
      url: "postgres://u:p@db/app",
    });
    // Defaults reach process.env as Nest does it, in their wire form; durations and files do not.
    expect(process.env["NODE_ENV"]).toBe("production");
    expect(process.env["REQUEST_TIMEOUT"]).toBeUndefined();
    expect(process.env["license"]).toBeUndefined();
    await app.close();
  });

  it("fails the boot with every violation, secrets redacted, and writes the termination log", async () => {
    process.env["DATABASE_URL"] = "vault:secret/data/app#db";
    process.env["PORT"] = "70000";
    process.env["NODE_ENV"] = "staging";
    process.env["REQUEST_TIMEOUT"] = "soon";
    process.env["DOCUCONF_FILE_ROOT"] = mkdtempSync(join(tmpdir(), "docuconf-empty-"));
    const log = join(mkdtempSync(join(tmpdir(), "docuconf-nest-app-")), "termination-log");
    const err = await compile(log).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DocuconfValidationError);
    expect((err as DocuconfValidationError).violations.map((v) => `${v.input} ${v.code}`)).toEqual([
      "NODE_ENV not_in_enum",
      "PORT out_of_range",
      "DATABASE_URL invalid_type",
      "REQUEST_TIMEOUT invalid_type",
      "license file_missing",
    ]);
    const logged = readFileSync(log, "utf8");
    expect(logged).toContain("DATABASE_URL [invalid_type]: holds an unresolved vault: reference");
    expect(logged).not.toContain("secret/data/app");
    expect((err as Error).message).not.toContain("secret/data/app");
  });
});

describe("apps that declare their environment with Zod", () => {
  it("use @docuconf/t3's createEnv as the validate function", async () => {
    process.env["DATABASE_URL"] = "postgres://u:p@db/app";
    const server = {
      PORT: z.coerce.number().int().min(1).max(65535).default(3000).describe("Port the app listens on"),
      DATABASE_URL: secret(url({ schemes: ["postgres"] })).describe("Primary Postgres connection string"),
      REQUEST_TIMEOUT: duration({ default: "30s" }).describe("Upstream request timeout"),
    };
    const validate = (config: Record<string, string | undefined>) => createEnv({ name: "zod-app", server, runtimeEnv: config, terminationLog: false });
    @Module({ imports: [ConfigModule.forRoot({ ignoreEnvFile: true, validate })] })
    class ZodModule {}
    const app = await Test.createTestingModule({ imports: [ZodModule] }).compile();
    const config = app.get(ConfigService);
    expect(config.get("PORT")).toBe(3000);
    expect(config.get("REQUEST_TIMEOUT")).toBe(30_000);
    await app.close();
  });
});
