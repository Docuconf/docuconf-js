// What a first-time user meets: boot failure output, secrets in logs and
// errors, testing a declaration, Next.js, the browser build, and export in
// a TypeScript project.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { DocuconfValidationError, checkEnv, createEnv, duration, list, secret, tlsFile, toContract, url } from "../src/index.ts";
import * as browser from "../src/browser.ts";
import { main } from "../src/cli.ts";
import { registerEnv } from "../src/next.ts";
import { SOURCE_CONDITIONS } from "../../core/test/support/cue.ts";

// These tests start real processes; leave room for a loaded CI machine.
vi.setConfig({ testTimeout: 90_000 });

const here = dirname(fileURLToPath(import.meta.url));
const SECRET = "hunter2-do-not-print";

const server = {
  DATABASE_URL: secret(url({ schemes: ["postgres"] })).describe("Primary Postgres connection string"),
  API_KEY: secret(z.string().min(20).regex(/^sk_/)).describe("Key for the payments API"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080).describe("HTTP listen port"),
};
const good = { DATABASE_URL: `postgres://app:${SECRET}@db/app`, API_KEY: `sk_${SECRET}` };
const quiet = { terminationLog: false as const, onWarning: () => {} };

function failure(fn: () => unknown): DocuconfValidationError {
  try {
    fn();
  } catch (e) {
    if (e instanceof DocuconfValidationError) return e;
    throw e;
  }
  throw new Error("expected a DocuconfValidationError");
}

/** Runs a module in a child process, as an app would run. */
function run(file: string, env: Record<string, string>, args: string[] = []) {
  return spawnSync(process.execPath, [SOURCE_CONDITIONS, file, ...args], {
    encoding: "utf8",
    env: { PATH: process.env["PATH"] ?? "", DOCUCONF_TERMINATION_LOG: "/dev/null", ...env },
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("secrets never print by accident", () => {
  it("redacts secrets when the env object is logged or serialised", () => {
    const env = createEnv({ server, runtimeEnv: good, ...quiet });
    for (const printed of [inspect(env), JSON.stringify(env), inspect({ nested: env }, { depth: 5 })]) {
      expect(printed).not.toContain(SECRET);
      expect(printed).toContain("[redacted]");
      expect(printed).toContain("8080");
    }
    // Reading the value still gives it.
    expect(env.DATABASE_URL).toBe(good.DATABASE_URL);
    expect(Object.keys(env)).toContain("PORT");
  });

  it("keeps secrets out of messages, even from user-written validators", () => {
    const leaky = secret(
      z.string().superRefine((v, ctx) => {
        if (!v.startsWith("ok")) ctx.addIssue({ code: "custom", message: `bad token "${v}"` });
      }),
    ).describe("Token checked by app code");
    const e = failure(() => createEnv({ server: { ...server, TOKEN: leaky }, runtimeEnv: { ...good, TOKEN: SECRET, API_KEY: "sk_short" }, ...quiet }));
    expect(e.message).not.toContain(SECRET);
    expect(e.message).not.toContain("sk_short");
    expect(inspect(e)).not.toContain(SECRET);
  });

  it("says which rule a secret broke", () => {
    const e = failure(() =>
      createEnv({ server, runtimeEnv: { DATABASE_URL: `mysql://app:${SECRET}@db/app`, API_KEY: "pk_live" }, ...quiet }),
    );
    expect(e.violations.map((v) => `${v.input} [${v.code}]: ${v.message}`)).toEqual([
      "DATABASE_URL [invalid_scheme]: scheme must be one of postgres (value hidden: secret)",
      "API_KEY [out_of_range]: must be at least 20 characters long (value hidden: secret)",
      "API_KEY [pattern_mismatch]: must match ^sk_ (value hidden: secret)",
    ]);
  });
});

describe("boot failure", () => {
  const boot = join(here, "fixtures/boot-env.ts");

  it("exitOnError prints one line per problem and exits 1, with no stack trace", () => {
    const r = run(boot, { BOOT_EXIT: "1", PORT: "0" });
    expect(r.status).toBe(1);
    expect(r.stderr).toBe(
      "docuconf: 2 configuration problems:\n" +
        "  - DATABASE_URL [missing_required]: required, but not set\n" +
        '  - PORT [out_of_range]: Too small: expected number to be >=1 (got "0")\n',
    );
  });

  it("exitOnError also turns a broken declaration into a clean exit", () => {
    const r = run(boot, { BOOT_EXIT: "1", BOOT_BAD: "1" });
    expect(r.status).toBe(1);
    expect(r.stderr).toBe('docuconf: invalid declaration:\n  - BAD: needs a description of at least 5 characters (.describe("...") or .meta({ description }))\n');
  });

  it("an uncaught DocuconfValidationError prints as its list, without frames or an object dump", () => {
    const r = run(boot, { PORT: "0" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("docuconf: 2 configuration problems:\n  - DATABASE_URL [missing_required]");
    expect(r.stderr).not.toMatch(/\n\s+at /);
    expect(r.stderr).not.toContain("violations:");
  });

  it("warns about a likely typo, naming both variables and never the value", () => {
    const warnings: string[] = [];
    createEnv({ server, runtimeEnv: { ...good, PORTT: "9090", DATABSE_URL: SECRET }, terminationLog: false, onWarning: (w) => warnings.push(w) });
    expect(warnings).toEqual([
      "DATABSE_URL is set but not declared; did you mean DATABASE_URL?",
      "PORTT is set but not declared; did you mean PORT?",
    ]);
  });
});

describe("testing a declaration", () => {
  it("checkEnv validates an explicit map without process.env, throwing or the termination log", () => {
    vi.stubEnv("PORT", "1234");
    const env = createEnv({ server, runtimeEnv: good, ...quiet });
    const r = checkEnv(env, { PORT: "0" });
    expect(r.violations.map((v) => `${v.input} ${v.code}`)).toEqual(["DATABASE_URL missing_required", "API_KEY missing_required", "PORT out_of_range"]);
    expect(checkEnv(env, { ...good, PORT: "9090" }).values.PORT).toBe(9090);
    expect(checkEnv(env, { ...good }).violations).toEqual([]);
  });

  it("checkEnv reads file inputs under an explicit file root", () => {
    const env = createEnv({
      server: {},
      files: { tls: tlsFile({ path: "/etc/app/tls", required: true, description: "Serving certificate" }) },
      skipValidation: true,
      runtimeEnv: {},
    });
    const root = mkdtempSync(join(tmpdir(), "docuconf-root-"));
    const r = checkEnv(env, {}, { fileRoot: root });
    expect(r.violations.map((v) => v.code)).toEqual(["file_missing"]);
    expect(r.violations[0]!.message).toBe(`directory ${join(root, "/etc/app/tls")} not found`);
    // Without a root, the message says how to point at local copies.
    expect(checkEnv(env, {}).violations[0]!.message).toContain("set DOCUCONF_FILE_ROOT");
  });
});

describe("Next.js", () => {
  it("createEnv skips validation during next build", () => {
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    const env = createEnv({ server, runtimeEnv: {}, ...quiet });
    expect(env.PORT).toBeUndefined();
  });

  it("registerEnv validates when the server starts, and rethrows under a test runner", async () => {
    await expect(registerEnv(async () => createEnv({ server, runtimeEnv: {}, ...quiet }))()).rejects.toThrow(DocuconfValidationError);
    await expect(registerEnv(async () => createEnv({ server, runtimeEnv: good, ...quiet }))()).resolves.toBeUndefined();
    vi.stubEnv("NEXT_RUNTIME", "edge");
    await expect(registerEnv(async () => createEnv({ server, runtimeEnv: {}, ...quiet }))()).resolves.toBeUndefined();
  });

  it("registerEnv exits 1 with the list of problems outside a test runner", () => {
    const dir = mkdtempSync(join(here, "fixtures/.tmp-next-"));
    const script = join(dir, "instrumentation.ts");
    writeFileSync(
      script,
      `import { registerEnv } from ${JSON.stringify(resolve(here, "../src/next.ts"))};\n` +
        `await registerEnv(() => import(${JSON.stringify(join(here, "fixtures/boot-env.ts"))}))();\n` +
        `console.log("still running");\n`,
    );
    const r = run(script, { NEXT_RUNTIME: "nodejs", PORT: "70000" });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(
      "docuconf: 2 configuration problems:\n" +
        "  - DATABASE_URL [missing_required]: required, but not set\n" +
        '  - PORT [out_of_range]: Too big: expected number to be <=65535 (got "70000")\n',
    );
  });
});

describe("the browser build", () => {
  /** Every module the browser entry loads at run time, following relative imports and @docuconf/core/pure. */
  function runtimeImports(entry: string): Map<string, string[]> {
    const out = new Map<string, string[]>();
    const queue = [entry];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (out.has(file)) continue;
      const src = readFileSync(file, "utf8");
      const specs = [...src.matchAll(/^(?:import|export)\s+(?!type\s)[^;]*?from\s+"([^"]+)"/gms)].map((m) => m[1]!);
      out.set(file, specs);
      for (const s of specs) {
        if (s.startsWith(".")) queue.push(resolve(dirname(file), s));
        else if (s === "@docuconf/core/pure") queue.push(resolve(here, "../../core/src/pure.ts"));
      }
    }
    return out;
  }

  it("loads no Node built-in and none of @docuconf/core's Node entry", () => {
    const graph = runtimeImports(resolve(here, "../src/browser.ts"));
    expect(graph.size).toBeGreaterThan(5);
    for (const [file, specs] of graph) {
      for (const s of specs) {
        expect(s.startsWith("node:") || ["@docuconf/core", "@docuconf/core/loader", "yaml", "jiti"].includes(s), `${file} imports ${s}`).toBe(false);
      }
    }
  });

  it("is what bundlers pick for browsers and edge runtimes", () => {
    const pkg = JSON.parse(readFileSync(resolve(here, "../package.json"), "utf8")) as { exports: Record<string, Record<string, string>> };
    for (const condition of ["browser", "edge-light", "worker"]) expect(pkg.exports["."]![condition]).toBe("./dist/browser.js");
    expect(pkg.exports["./next"]!["default"]).toBe("./dist/next.js");
  });

  it("exports every runtime name the Node entry does", async () => {
    const node = await import("../src/index.ts");
    expect(Object.keys(browser).sort()).toEqual(Object.keys(node).sort());
  });

  it("validates client variables as T3 does, and keeps server features server-side", () => {
    const env = browser.createEnv({
      name: "web",
      clientPrefix: "NEXT_PUBLIC_",
      server,
      client: { NEXT_PUBLIC_API_BASE: z.url().describe("Public API base URL") },
      runtimeEnv: { NEXT_PUBLIC_API_BASE: "https://api.example.com" },
      isServer: false,
      files: { tls: tlsFile({ path: "/etc/x", description: "Serving certificate" }) },
      exitOnError: true,
    });
    expect(env.NEXT_PUBLIC_API_BASE).toBe("https://api.example.com");
    expect(() => env.DATABASE_URL).toThrow(/server-side environment variable on the client/);
    expect(() => env.files.tls).toThrow(/server-only/);
  });
});

describe("declaration hints", () => {
  const problems = (s: Record<string, unknown>) => {
    try {
      createEnv({ name: "x", server: s as never, runtimeEnv: {}, ...quiet, skipValidation: true });
    } catch (e) {
      return (e as { problems: string[] }).problems;
    }
    return [];
  };

  it("say what to write instead", () => {
    expect(problems({ PORT: z.number().int().describe("HTTP listen port") })).toEqual([
      "PORT: z.number() receives strings from the environment and always fails; use z.coerce.number().int()",
    ]);
    expect(problems({ MODE: z.union([z.literal("a"), z.literal("b")]).describe("Operating mode") })[0]).toContain('use z.enum(["a", "b"])');
    expect(problems({ NAME: z.string().nullable().describe("Display name") })[0]).toContain("use .optional()");
    expect(problems({ START: z.coerce.date().describe("Start date") })[0]).toContain("dates are not a contract type");
    expect(problems({ T: (duration() as z.ZodType).default("30s" as never).describe("Request timeout") })[0]).toBe(
      'T: default "30s" does not fit type duration: Zod\'s .default() takes the parsed value (milliseconds). Use duration({ default: "30s" }), or .default(30_000)',
    );
  });

  it("explain a validator without Standard JSON Schema", () => {
    const opaque = { "~standard": { version: 1, vendor: "valibot", validate: (v: unknown) => ({ value: v }) } };
    expect(problems({ P: opaque })[0]).toContain("for Valibot, wrap the schema in toStandardJsonSchema() from @valibot/to-json-schema");
  });

  it("export exclusive float bounds exactly", () => {
    const env = createEnv({ name: "x", server: { RATIO: z.coerce.number().positive().lt(1).describe("Sampling ratio") }, runtimeEnv: { RATIO: "0.5" }, ...quiet });
    const out = toContract(env);
    expect(out).toContain("min:         5e-324");
    expect(out).toContain("max:         0.9999999999999999");
  });
});

describe("lists", () => {
  const listEnv = (raw: string) =>
    createEnv({
      server: {
        ORIGINS: list(z.string()).describe("CORS origins"),
        PORTS: list(z.coerce.number().int().min(1)).optional().describe("Worker ports"),
      },
      runtimeEnv: { ORIGINS: raw, PORTS: "8080, 0, x" },
      ...quiet,
    });

  it("drop whitespace around separators and report each bad item, quoting the item", () => {
    const e = failure(() => listEnv("https://a.com, https://b.com"));
    expect(e.violations.map((v) => `${v.input} [${v.code}]: ${v.message}`)).toEqual(['PORTS [invalid_type]: item 3: expected a base-10 integer (got "x")']);
    const ok = createEnv({ server: { ORIGINS: list(z.string()).describe("CORS origins") }, runtimeEnv: { ORIGINS: "https://a.com, https://b.com" }, ...quiet });
    expect(ok.ORIGINS).toEqual(["https://a.com", "https://b.com"]);
  });
});

describe("export in a TypeScript project", () => {
  // As a user runs it: a real process, where Node's loader (and docuconf's
  // resolve hooks) load the module, not Vitest's.
  const app = join(here, "fixtures/alias-app");
  const cli = (...args: string[]) => run(resolve(here, "../src/bin.ts"), {}, args);

  it("applies tsconfig paths aliases", () => {
    const r = cli("export", join(app, "src/env.ts"));
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain("LOG_LEVEL: {");
  });

  it("says when an alias does not resolve, and how to fix it", () => {
    const r = cli("export", join(app, "src/missing.ts"));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(
      /^docuconf: cannot load .*missing\.ts: Cannot find module '@\/lib\/nothing'\n {2}hint: tsconfig "paths" in .*tsconfig\.json map it to .*src\/lib\/nothing, which does not exist\n$/,
    );
    expect(cli("export", join(app, "src/nomatch.ts")).stderr).toMatch(
      /Cannot find module '~\/lib\/nothing'\n {2}hint: no tsconfig "paths" entry in .*tsconfig\.json matches it; import it with a relative path or pass --tsconfig/,
    );
  });

  it("explains a module that uses env at import time", () => {
    const r = cli("export", join(app, "src/server.ts"));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/env\.files\.tls is not loaded during export.*export the module that calls createEnv/s);
  });

  it("prints no MODULE_TYPELESS_PACKAGE_JSON warning for a package without a type", () => {
    const r = cli("export", join(here, "fixtures/typeless/env.ts"));
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("PORT: {");
  });

  it("--check passes for an up-to-date contract and fails with a diff otherwise", () => {
    const file = join(mkdtempSync(join(tmpdir(), "docuconf-check-")), "contract.cue");
    const env = join(app, "src/env.ts");
    let r = cli("export", env, "--check", file);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("does not exist");
    expect(cli("export", env, "--out", file).status).toBe(0);
    r = cli("export", env, "--check", file);
    expect([r.status, r.stderr]).toEqual([0, `docuconf: ${file} is up to date\n`]);
    writeFileSync(file, readFileSync(file, "utf8").replace("Minimum log level", "Old text"));
    r = cli("export", env, "--check", file);
    expect(r.status).toBe(1);
    expect(r.stderr, r.stderr).toMatch(/out of date.*\n-\d+: .*Old text.*\n\+\d+: .*Minimum log level/s);
  });

  it("docs writes Markdown documentation of the contract", async () => {
    const out: string[] = [];
    const io = { out: { write: (s: string) => (out.push(s), true) }, err: { write: () => true } };
    expect(await main(["docs", join(here, "fixtures/boot-env.ts")], io)).toBe(0);
    const md = out.join("");
    expect(md).toContain("# boot configuration");
    expect(md).toContain("| `DATABASE_URL` | url | yes | yes | Primary Postgres connection string | scheme postgres |");
    expect(md).toContain("| `PORT` | int | no | no | HTTP listen port | 1 to 65535; default `8080` |");
  });
});

// Keep stray temporary fixture directories out of the repository.
afterEach(() => {
  const fixtures = join(here, "fixtures");
  for (const entry of readdirSync(fixtures)) if (entry.startsWith(".tmp-")) rmSync(join(fixtures, entry), { recursive: true, force: true });
});
