import "reflect-metadata";
import { IsEnum, IsInt, IsOptional, IsString, Matches, Max, ValidateNested } from "class-validator";
import { describe, expect, it } from "vitest";
import {
  ConfigFile,
  DocuconfDeclarationError,
  Describe,
  Duration,
  Examples,
  KeystoreFile,
  Secret,
  TextFile,
  TlsFile,
  docuconfValidate,
} from "../src/index.ts";
import { kebab } from "../src/declaration.ts";

function problems(cls: new () => object): readonly string[] {
  try {
    docuconfValidate(cls, { onWarning: () => {} });
  } catch (e) {
    if (e instanceof DocuconfDeclarationError) return e.problems;
    throw e;
  }
  throw new Error("expected a declaration error");
}

describe("declaration checks", () => {
  it("requires descriptions of at least 5 characters, valid names and a known type", () => {
    class Env {
      @IsString() @Describe("HTTP listen port")
      port!: string;

      @IsString() @Describe("host")
      HOST!: string;

      @Describe("Something untyped")
      MYSTERY!: unknown;
    }
    expect(problems(Env)).toEqual([
      "port: variable names must match ^[A-Z][A-Z0-9_]*$",
      'HOST: needs a description of at least 5 characters (@Describe("..."))',
      expect.stringMatching(/^MYSTERY: cannot tell its type; add @IsString\(\)/),
    ]);
  });

  it("rejects defaults and examples on secrets, and defaults that break their own constraints", () => {
    class Env {
      @Secret() @IsString() @Describe("Token for the upstream API")
      API_TOKEN: string = "dev-token";

      @Secret() @IsString() @Examples("tok_123") @Describe("Webhook signing key")
      WEBHOOK_KEY!: string;

      @IsInt() @Max(65535) @Describe("HTTP listen port")
      PORT: number = 70000;
    }
    expect(problems(Env)).toEqual([
      "API_TOKEN: a secret must not have a default",
      "WEBHOOK_KEY: a secret must not have examples",
      'PORT: default 70000 violates its own constraints: must not be greater than 65535 (got "70000")',
    ]);
  });

  it("rejects patterns outside RE2 and flags the contract cannot carry", () => {
    class Env {
      @IsString() @Matches(/^(?!admin)/) @Describe("No admin prefix")
      A!: string;

      @IsString() @Matches(/^abc$/i) @Describe("Case-insensitive")
      B!: string;
    }
    expect(problems(Env)).toEqual([
      "A: pattern uses negative lookahead (?!...), which RE2 does not support (SPEC §4.3)",
      'B: @Matches flags "i" cannot be expressed in the contract; use inline syntax',
    ]);
  });

  it("checks enums, durations and mixed-up decorators", () => {
    enum Level {
      Low = 1,
      High = 2,
    }
    class Env {
      @IsEnum(Level) @Describe("Numeric level")
      LEVEL!: Level;

      @Duration({ max: "forever" }) @IsString() @Describe("Request timeout")
      TIMEOUT!: number;
    }
    expect(problems(Env)).toEqual([
      "LEVEL: enum values must be strings",
      "TIMEOUT: a duration property holds the parsed value, not the string; remove @IsString()",
      'TIMEOUT: @Duration max "forever" is not a Go duration such as "30s"',
    ]);
  });

  it("checks file inputs: names, mounts, pathEnv and keystore passwords", () => {
    class Nested {
      @ValidateNested()
      inner!: object;
    }
    class Env {
      @IsOptional() @IsString() @Describe("Keystore password")
      KS_PASSWORD?: string;

      @IsOptional() @IsString() @Describe("Where the licence is")
      LICENSE_FILE?: string;

      @KeystoreFile({ path: "/etc/app/ks/ks.p12", description: "Partner keystore", passwordVar: "KS_PASSWORD" })
      keystore?: unknown;

      @TextFile({ path: "/etc/app/ks/license.key", description: "Licence key", pathEnv: "LICENSE_FILE" })
      license?: string;

      @TlsFile({ name: "Serving_TLS", path: "/etc", description: "Serving certificate" })
      tls?: unknown;

      @ConfigFile({ format: "json", path: "/etc/app/settings/s.json", description: "Settings", schema: Nested })
      settings?: unknown;
    }
    expect(problems(Env)).toEqual([
      'keystore (file input "keystore"): passwordVar KS_PASSWORD must be a secret variable (add @Secret())',
      'license (file input "license"): shares mount directory /etc/app/ks with keystore; each input needs its own directory',
      'license (file input "license"): pathEnv LICENSE_FILE must not also be a variable',
      'tls (file input "Serving_TLS"): input names must be DNS labels matching ^[a-z]([-a-z0-9]{0,40}[a-z0-9])?$',
      'tls (file input "Serving_TLS"): would be mounted at /etc, which hides a directory the image needs; use a subdirectory',
      'settings (file input "settings"): schema cannot be converted to JSON Schema (Nested.inner: @ValidateNested() needs @Type(() => TheClass) from class-transformer)',
    ]);
  });

  it("names file inputs after their property in kebab case", () => {
    expect(kebab("servingTls")).toBe("serving-tls");
    expect(kebab("upstreamCA")).toBe("upstream-ca");
    expect(kebab("geoip")).toBe("geoip");
  });
});
