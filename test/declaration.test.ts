import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  DocuconfDeclarationError,
  configFile,
  createEnv,
  duration,
  formatDuration,
  getDeclaration,
  keystoreFile,
  list,
  parseDuration,
  secret,
  textFile,
} from "../src/index.ts";

function problems(fn: () => unknown): readonly string[] {
  try {
    fn();
  } catch (e) {
    if (e instanceof DocuconfDeclarationError) return e.problems;
    throw e;
  }
  throw new Error("expected a declaration error");
}

const quiet = { runtimeEnv: {}, skipValidation: true, onWarning: () => {} } as const;

describe("declaration checks", () => {
  it("requires descriptions of at least 5 characters and valid names", () => {
    const p = problems(() =>
      createEnv({ ...quiet, server: { port: z.string().describe("HTTP listen port"), HOST: z.string().describe("host") } }),
    );
    expect(p).toEqual([
      "port: variable names must match ^[A-Z][A-Z0-9_]*$",
      'HOST: needs a description of at least 5 characters (.describe("...") or .meta({ description }))',
    ]);
  });

  it("rejects z.coerce.boolean(), which parses \"false\" as true", () => {
    const p = problems(() => createEnv({ ...quiet, server: { DEBUG: z.coerce.boolean().describe("Verbose logging") } }));
    expect(p[0]).toMatch(/parses "false" as true .*z\.stringbool\(\)/);
  });

  it("rejects patterns outside RE2", () => {
    const p = problems(() =>
      createEnv({
        ...quiet,
        server: {
          A: z.string().regex(/^(?!admin)/).describe("No admin prefix"),
          B: z.string().regex(/(a)\1/).describe("Repeated letter"),
        },
        files: { lic: textFile({ path: "/etc/lic/key", description: "Licence key", pattern: /(?<=x)y/ }) },
      }),
    );
    expect(p).toEqual([
      "A: pattern uses negative lookahead (?!...), which RE2 does not support (SPEC §4.3)",
      "B: pattern uses backreference \\1, which RE2 does not support (SPEC §4.3)",
      "files.lic: pattern uses lookbehind (?<=...), which RE2 does not support",
    ]);
  });

  it("rejects defaults on secrets and defaults that break their own constraints", () => {
    const p = problems(() =>
      createEnv({
        ...quiet,
        server: {
          TOKEN: secret(z.string().default("dev-token")).describe("API token"),
          PORT: z.coerce.number().int().max(100).default(8080).describe("HTTP listen port"),
        },
      }),
    );
    expect(p[0]).toBe("TOKEN: a secret must not have a default");
    expect(p[1]).toMatch(/^PORT: default 8080 violates its own constraints/);
  });

  it("checks file inputs: names, paths, mount directories, pathEnv and passwordVar", () => {
    const schema = z.object({ a: z.string() });
    const p = problems(() =>
      createEnv({
        ...quiet,
        server: {
          ROUTES_FILE: z.string().describe("Routes file path"),
          KS_PASSWORD: z.string().describe("Keystore password"),
        },
        files: {
          Routes: configFile({ format: "json", path: "/etc/app/routes.json", description: "Route table", schema, pathEnv: "ROUTES_FILE" }),
          other: configFile({ format: "json", path: "/etc/app/other.json", description: "Other table", schema }),
          ssl: configFile({ format: "json", path: "/etc/ssl/certs/x.json", description: "Hides trust store", schema }),
          rel: configFile({ format: "json", path: "etc/../x.json", description: "Relative path", schema }),
          ks: keystoreFile({ path: "/etc/ks/k.p12", description: "Partner keystore", passwordVar: "KS_PASSWORD" }),
        },
      }),
    );
    expect(p).toEqual([
      "files.Routes: input names must be DNS labels matching ^[a-z]([-a-z0-9]{0,40}[a-z0-9])?$",
      "files.Routes: pathEnv ROUTES_FILE must not also be a server variable",
      "files.other: shares mount directory /etc/app with Routes; each input needs its own directory",
      "files.ssl: would be mounted at /etc/ssl/certs, which hides a directory the image needs; use a subdirectory",
      'files.rel: path "etc/../x.json" must be absolute and normalised',
      "files.ks: passwordVar KS_PASSWORD must be a secret variable (wrap it in secret())",
    ]);
  });

  it("warns about names that look like feature flags (SPEC §10)", () => {
    const warnings: string[] = [];
    const env = createEnv({
      server: { ENABLE_NEW_CHECKOUT: z.stringbool().default(false).describe("New checkout flow") },
      runtimeEnv: {},
      onWarning: (w) => warnings.push(w),
    });
    expect(env.ENABLE_NEW_CHECKOUT).toBe(false);
    expect(warnings[0]).toMatch(/^ENABLE_NEW_CHECKOUT: looks like a feature flag/);
    expect(getDeclaration(env).warnings).toEqual(warnings);
  });

  it("warns when z.url({ protocol }) restricts schemes the contract cannot carry", () => {
    const warnings: string[] = [];
    createEnv({
      ...quiet,
      onWarning: (w) => warnings.push(w),
      server: {
        A: z.url({ protocol: /^postgres$/ }).describe("Database URL"),
        B: z.url().optional().describe("Plain URL, any scheme"),
      },
    });
    expect(warnings).toEqual(["A: z.url({ protocol }) cannot be exported; use url({ schemes }) from @docuconf/t3"]);
  });

  it("caps int bounds at Number.MAX_SAFE_INTEGER", () => {
    const env = createEnv({ ...quiet, name: "x", server: { N: z.coerce.number().int().describe("Some integer") } });
    expect(getDeclaration(env).vars.get("N")!.contract).toMatchObject({ min: -Number.MAX_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER });
  });

  it("validates helper options eagerly", () => {
    expect(() => duration({ min: "soon" })).toThrow(/not a Go duration/);
    expect(() => list(z.object({}))).toThrow(/strings or integers/);
  });
});

describe("Go durations", () => {
  it("parses Go syntax to milliseconds", () => {
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("1m30s")).toBe(90_000);
    expect(parseDuration("1.5h")).toBe(5_400_000);
    expect(parseDuration("250ms")).toBe(250);
    expect(parseDuration("500us")).toBe(0.5);
    expect(parseDuration("0")).toBe(0);
    expect(parseDuration("-2m")).toBe(-120_000);
    for (const bad of ["", "30", "1d", "s", "1m 30s", ".s"]) expect(parseDuration(bad)).toBeUndefined();
  });

  it("formats milliseconds in contract syntax", () => {
    expect(formatDuration(90_000)).toBe("1m30s");
    expect(formatDuration(1500)).toBe("1s500ms");
    expect(formatDuration(2_592_000_000)).toBe("720h");
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(0.0015)).toBe("1us500ns");
  });
});
