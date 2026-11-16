/**
 * Contract-first mode's conditional requirements (SPEC §4.2.1), roles
 * (SPEC §4.9) and included fragments (SPEC §4.8).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DocuconfDeclarationError, RequiredIf, checkContract, parseContract } from "../src/index.ts";

const head = { apiVersion: "docuconf.dev/v1alpha1", kind: "ConfigContract", metadata: { name: "t" } };
const codes = (r: ReturnType<typeof checkContract>) => r.violations.map((v) => [v.input, v.code]);
const root = mkdtempSync(join(tmpdir(), "docuconf-conditional-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** The problems parseContract reports, or [] when it reads the contract. */
function problems(contract: object): readonly string[] {
  try {
    parseContract({ ...head, ...contract });
    return [];
  } catch (e) {
    if (!(e instanceof DocuconfDeclarationError)) throw e;
    return e.problems;
  }
}

describe("requiredIf", () => {
  const contract = {
    ...head,
    vars: {
      TLS_ENABLED: { type: "bool", description: "Serve over TLS", default: false },
      TLS_CLIENT_CA_SUBJECT: { type: "string", description: "Subject of the client CA", requiredIf: { TLS_ENABLED: true } },
      LOG_FORMAT: { type: "enum", description: "Log line format", values: ["text", "json"], default: "text", configKey: "log.format" },
      LOG_SCHEMA_URL: { type: "url", description: "Schema of JSON log lines", requiredIf: { LOG_FORMAT: "json" } },
      WORKERS: { type: "int", description: "Worker processes", default: 1 },
      COORDINATOR_URL: { type: "url", description: "Coordinator of several workers", requiredIf: { WORKERS: 2 } },
      APP_ENV: { type: "string", description: "Profile selector", default: "development" },
    },
    files: {
      allowlist: {
        type: "text",
        description: "Client names allowed over TLS",
        path: "/etc/relay/allowlist/allow.txt",
        requiredIf: { TLS_ENABLED: true },
      },
    },
    profiles: { selector: "APP_ENV", default: "development", defaults: { production: { TLS_ENABLED: true } } },
    overlays: { app: { format: "json", path: "/etc/app/config.json", keySeparator: ".", reload: "restart" } },
  };
  const check = (env: Record<string, string>) => checkContract(contract, env, { fileRoot: root });

  it("leaves conditional inputs optional while their conditions do not hold", () => {
    const r = check({});
    expect(r.violations).toEqual([]);
    expect(r.values["TLS_CLIENT_CA_SUBJECT"]).toBeUndefined();
    expect(r.files["allowlist"]).toBeUndefined();
  });

  it("writes the condition into missing_required, the value as JSON", () => {
    const r = check({ TLS_ENABLED: "true", LOG_FORMAT: "json", WORKERS: "2" });
    expect(r.violations.filter((v) => v.kind === "var")).toEqual([
      { input: "TLS_CLIENT_CA_SUBJECT", kind: "var", code: "missing_required", message: "is required when TLS_ENABLED is true" },
      { input: "LOG_SCHEMA_URL", kind: "var", code: "missing_required", message: 'is required when LOG_FORMAT is "json"' },
      { input: "COORDINATOR_URL", kind: "var", code: "missing_required", message: "is required when WORKERS is 2" },
    ]);
  });

  it("appends the condition to file_missing", () => {
    const missing = check({ TLS_ENABLED: "true", TLS_CLIENT_CA_SUBJECT: "CN=CA" }).violations;
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({ input: "allowlist", code: "file_missing" });
    expect(missing[0]!.message).toMatch(/allow\.txt not found, and is required when TLS_ENABLED is true$/);
  });

  it("loads the conditional inputs when they are set", () => {
    mkdirSync(join(root, "etc/relay/allowlist"), { recursive: true });
    writeFileSync(join(root, "etc/relay/allowlist/allow.txt"), "billing\n");
    try {
      const r = check({ TLS_ENABLED: "TRUE", TLS_CLIENT_CA_SUBJECT: "CN=CA" });
      expect(r.violations).toEqual([]);
      expect(r.files["allowlist"]).toBe("billing\n");
    } finally {
      rmSync(join(root, "etc/relay"), { recursive: true });
    }
  });

  it("compares the loaded value: a profile default, an overlay, the environment over both", () => {
    expect(codes(check({ APP_ENV: "production", TLS_CLIENT_CA_SUBJECT: "CN=CA" }))).toEqual([["allowlist", "file_missing"]]);
    expect(codes(check({ APP_ENV: "production", TLS_ENABLED: "false" }))).toEqual([]);
    mkdirSync(join(root, "etc/app"), { recursive: true });
    writeFileSync(join(root, "etc/app/config.json"), JSON.stringify({ log: { format: "json" } }));
    try {
      expect(codes(check({}))).toEqual([["LOG_SCHEMA_URL", "missing_required"]]);
      expect(codes(check({ LOG_FORMAT: "text" }))).toEqual([]);
    } finally {
      rmSync(join(root, "etc/app"), { recursive: true });
    }
  });

  it("requires nothing on a condition variable with its own violation", () => {
    expect(codes(check({ TLS_ENABLED: "yes" }))).toEqual([["TLS_ENABLED", "invalid_type"]]);
    expect(codes(check({ WORKERS: "two" }))).toEqual([["WORKERS", "invalid_type"]]);
  });

  it("reports an empty value as unset", () => {
    expect(codes(check({ LOG_FORMAT: "json", LOG_SCHEMA_URL: "" }))).toEqual([["LOG_SCHEMA_URL", "missing_required"]]);
  });

  it("compares integers exactly, beyond 2^53 too", () => {
    const c = new RequiredIf("N", 9007199254740993n);
    expect(c.holdsFor(9007199254740993n)).toBe(true);
    expect(c.holdsFor(9007199254740992)).toBe(false);
    expect(new RequiredIf("N", 2).holdsFor(2n)).toBe(true);
    expect(new RequiredIf("N", 2).holdsFor("2")).toBe(false);
    expect(new RequiredIf("B", true).holdsFor("true")).toBe(false);
    expect(String(new RequiredIf("N", 9007199254740993n))).toBe("N is 9007199254740993");
    const decl = parseContract(`{
      "apiVersion": "docuconf.dev/v1alpha1", "kind": "ConfigContract",
      "vars": {
        "N": { "type": "int", "description": "A big number" },
        "M": { "type": "string", "description": "Needed for one value", "requiredIf": { "N": 9007199254740993 } }
      }
    }`);
    expect(decl.vars.get("M")!.requiredIf!.value).toBe(9007199254740993n);
    expect(codes(checkContract(decl, { N: "9007199254740993" }))).toEqual([["M", "missing_required"]]);
    expect(codes(checkContract(decl, { N: "9007199254740992" }))).toEqual([]);
  });
});

describe("requiredIf in the reader", () => {
  const on = {
    FLAG: { type: "bool", description: "A switch" },
    MODE: { type: "enum", description: "The mode", values: ["a", "b"] },
    PORT: { type: "int", description: "A port", min: 1, max: 65535 },
    NAME: { type: "string", description: "A name", pattern: "^[a-z]+$" },
    TOKEN: { type: "string", description: "A secret token", secret: true },
    RATIO: { type: "float", description: "A ratio" },
    TIMEOUT: { type: "duration", description: "A timeout" },
  };
  const withVar = (x: object) => problems({ vars: { ...on, X: { type: "string", description: "The input", ...x } } });

  it("accepts a condition on each plain type", () => {
    expect(withVar({ requiredIf: { FLAG: true } })).toEqual([]);
    expect(withVar({ requiredIf: { MODE: "b" } })).toEqual([]);
    expect(withVar({ requiredIf: { PORT: 443 } })).toEqual([]);
    expect(withVar({ requiredIf: { NAME: "abc" } })).toEqual([]);
  });

  it("refuses a malformed condition", () => {
    expect(withVar({ requiredIf: {} })).toEqual(["X: requiredIf must name one variable and its value: {VAR: value}"]);
    expect(withVar({ requiredIf: { FLAG: true, MODE: "a" } })).toEqual(["X: requiredIf must name one variable and its value: {VAR: value}"]);
    expect(withVar({ requiredIf: [] })).toEqual(["X: requiredIf must name one variable and its value: {VAR: value}"]);
    for (const value of [1.5, null, ["a"], { a: 1 }]) {
      expect(withVar({ requiredIf: { MODE: value } })).toEqual(["X: requiredIf must name one variable and a string, integer or boolean value"]);
    }
    expect(withVar({ requiredIf: { "not-env": "a" } })).toEqual(["X: requiredIf must name one variable and a string, integer or boolean value"]);
  });

  it("refuses a condition on itself, an undeclared, secret or non-plain variable", () => {
    expect(withVar({ requiredIf: { X: "a" } })).toEqual(["X: requiredIf must name another declared variable, not X"]);
    expect(withVar({ requiredIf: { NOPE: "a" } })).toEqual(["X: requiredIf must name another declared variable, not NOPE"]);
    for (const name of ["TOKEN", "RATIO", "TIMEOUT"]) {
      expect(withVar({ requiredIf: { [name]: "a" } })).toEqual([`X: requiredIf names ${name}, which is not a plain string, int, bool or enum variable`]);
    }
  });

  it("refuses a value the condition variable cannot have", () => {
    expect(withVar({ requiredIf: { FLAG: "true" } })).toEqual(["X: requiredIf: FLAG is \"true\" is not a value FLAG can have"]);
    expect(withVar({ requiredIf: { PORT: "443" } })).toEqual(['X: requiredIf: PORT is "443" is not a value PORT can have']);
    expect(withVar({ requiredIf: { MODE: true } })).toEqual(["X: requiredIf: MODE is true is not a value MODE can have"]);
    expect(withVar({ requiredIf: { MODE: "c" } })[0]).toMatch(/^X: requiredIf: MODE is "c" is not a value MODE can have: must be one of a, b/);
    expect(withVar({ requiredIf: { PORT: 70000 } })[0]).toMatch(/^X: requiredIf: PORT is 70000 is not a value PORT can have: must be at most 65535/);
    expect(withVar({ requiredIf: { NAME: "ABC" } })[0]).toMatch(/^X: requiredIf: NAME is "ABC" is not a value NAME can have: must match/);
  });

  it("refuses a conditional input that is required, has a default or is deprecated", () => {
    expect(withVar({ requiredIf: { FLAG: true }, required: true })).toEqual(["X: an input with requiredIf must not be required"]);
    expect(withVar({ requiredIf: { FLAG: true }, default: "x" })).toEqual(["X: an input with requiredIf must not have a default"]);
    expect(withVar({ requiredIf: { FLAG: true }, deprecated: { message: "Going away soon" } })).toEqual([
      "X: an input with requiredIf must not be deprecated: the platform could not stop setting it",
    ]);
  });

  it("checks a file input's condition too", () => {
    const file = (x: object) => problems({ vars: on, files: { ca: { type: "caBundle", description: "Trusted CAs", path: "/etc/ca/ca.crt", ...x } } });
    expect(file({ requiredIf: { FLAG: true } })).toEqual([]);
    expect(file({ requiredIf: { FLAG: true }, required: true })).toEqual(["files.ca: an input with requiredIf must not be required"]);
    expect(file({ requiredIf: { TOKEN: "a" } })).toEqual(["files.ca: requiredIf names TOKEN, which is not a plain string, int, bool or enum variable"]);
    expect(file({ requiredIf: { FLAG: 1 } })).toEqual(["files.ca: requiredIf: FLAG is 1 is not a value FLAG can have"]);
  });
});

describe("roles", () => {
  const role = { type: "enum", description: "The role this workload runs", required: true, values: ["web", "worker"] };
  const contract = {
    ...head,
    roles: ["web", "worker"],
    vars: {
      DOCUCONF_ROLE: role,
      ALLOWED_ORIGINS: { type: "list", items: "string", description: "Origins the web server accepts", required: true, roles: ["web"] },
      QUEUES: { type: "list", items: "string", description: "Queues the worker reads", required: true, roles: ["worker"] },
      DATABASE_URL: { type: "string", description: "Database connection", required: true },
      TLS_ENABLED: { type: "bool", description: "Serve over TLS", default: true },
      TLS_CLIENT_CA_SUBJECT: { type: "string", description: "Subject of the client CA", roles: ["web"], requiredIf: { TLS_ENABLED: true } },
    },
    files: {
      robots: { type: "text", description: "The robots.txt the web server serves", path: "/etc/shop/robots/robots.txt", required: true, roles: ["web"] },
    },
  };
  const check = (env: Record<string, string>) => checkContract(contract, env, { fileRoot: root });

  it("requires only the inputs the role uses", () => {
    expect(codes(check({ DOCUCONF_ROLE: "worker", DATABASE_URL: "db" }))).toEqual([["QUEUES", "missing_required"]]);
    expect(codes(check({ DOCUCONF_ROLE: "web", DATABASE_URL: "db" }))).toEqual([
      ["ALLOWED_ORIGINS", "missing_required"],
      ["TLS_CLIENT_CA_SUBJECT", "missing_required"],
      ["robots", "file_missing"],
    ]);
    const worker = check({ DOCUCONF_ROLE: "worker", DATABASE_URL: "db", QUEUES: "default,mail" });
    expect(worker.violations).toEqual([]);
    expect(worker.values["QUEUES"]).toEqual(["default", "mail"]);
  });

  it("makes every role-specific input optional without a valid role, so the role is the one problem", () => {
    expect(codes(check({ DATABASE_URL: "db" }))).toEqual([["DOCUCONF_ROLE", "missing_required"]]);
    expect(codes(check({ DOCUCONF_ROLE: "cron", DATABASE_URL: "db" }))).toEqual([["DOCUCONF_ROLE", "not_in_enum"]]);
    // An input every role uses stays required.
    expect(codes(check({ DOCUCONF_ROLE: "worker", QUEUES: "a" }))).toEqual([["DATABASE_URL", "missing_required"]]);
  });

  it("reads the roles and the includes", () => {
    const decl = parseContract({ ...contract, includes: ["node@1", "otel@1"] });
    expect(decl.roles).toEqual(["web", "worker"]);
    expect(decl.includes).toEqual(["node@1", "otel@1"]);
    expect(decl.vars.get("ALLOWED_ORIGINS")!.roles).toEqual(["web"]);
    expect(decl.fileRules["robots"]!.roles).toEqual(["web"]);
    expect(parseContract({ ...head, vars: {} })).toMatchObject({ roles: undefined, includes: [] });
  });

  it("refuses malformed roles", () => {
    const vars = (values: string[]) => ({ DOCUCONF_ROLE: { ...role, values } });
    expect(problems({ roles: [], vars: {} })).toEqual(["roles: roles must be a list of at least one role name"]);
    expect(problems({ roles: "web", vars: {} })).toEqual(["roles: roles must be a list of at least one role name"]);
    expect(problems({ roles: ["Web"], vars: vars(["Web"]) })).toEqual(['roles: role "Web" must be a DNS label']);
    expect(problems({ roles: ["web", "web"], vars: vars(["web", "web"]) })).toEqual(["roles: role web is listed twice"]);
    expect(problems({ ...contract, vars: { ...contract.vars, DATABASE_URL: { ...contract.vars.DATABASE_URL, roles: [] } } })).toEqual([
      "DATABASE_URL: roles must be a list of at least one role name",
    ]);
  });

  it("refuses input roles outside the contract's", () => {
    expect(problems({ ...contract, vars: { ...contract.vars, DATABASE_URL: { ...contract.vars.DATABASE_URL, roles: ["cron"] } } })).toEqual([
      "DATABASE_URL: role cron is not one of the contract's roles, web, worker",
    ]);
    expect(problems({ vars: { A: { type: "string", description: "Only the web", roles: ["web"] } } })).toEqual([
      "A: has roles, but the contract declares none",
    ]);
    expect(problems({ vars: {}, files: { f: { type: "text", description: "A text file", path: "/etc/f/f.txt", roles: ["web"] } } })).toEqual([
      "files.f: has roles, but the contract declares none",
    ]);
  });

  it("requires DOCUCONF_ROLE as a required enum of exactly the roles, used by every role", () => {
    const want = ["DOCUCONF_ROLE: a contract with roles declares it as a required enum whose values are the roles, web, worker, used by every role"];
    const withRole = (r: object | undefined) => problems({ roles: ["web", "worker"], vars: r === undefined ? {} : { DOCUCONF_ROLE: r } });
    expect(withRole(role)).toEqual([]);
    expect(withRole(undefined)).toEqual(want);
    expect(withRole({ ...role, required: false })).toEqual(want);
    expect(withRole({ ...role, values: ["worker", "web"] })).toEqual(want);
    expect(withRole({ ...role, values: ["web"] })).toEqual(want);
    expect(withRole({ ...role, roles: ["web"] })).toEqual(want);
    expect(withRole({ type: "string", description: "The role this workload runs", required: true })).toEqual(want);
  });
});

describe("includes", () => {
  it("refuses a malformed list", () => {
    expect(problems({ vars: {}, includes: "otel@1" })).toEqual(["includes must be a list of fragment names, such as otel@1"]);
    expect(problems({ vars: {}, includes: ["otel"] })).toEqual(['includes: "otel" is not a fragment name, name@major']);
    expect(problems({ vars: {}, includes: ["otel@0"] })).toEqual(['includes: "otel@0" is not a fragment name, name@major']);
    expect(problems({ vars: {}, includes: ["otel@1", "otel@1"] })).toEqual(["includes: otel@1 is listed twice"]);
  });
});
