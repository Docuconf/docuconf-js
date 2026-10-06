/**
 * The shared conformance suite (SPEC §12, docuconf-go conformance/README.md),
 * run through the contract-first mode. Every case is a test named by its id.
 *
 * cases.json comes from DOCUCONF_CONFORMANCE, else ../docuconf-go/conformance/cases.json
 * next to this repository. With DOCUCONF_REQUIRE_CONFORMANCE=1 a missing file fails.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { DocuconfValidationError, formatDuration, loadContract } from "../src/index.ts";

/** Capability tags this SDK lacks (README, "Conformance"). */
const UNSUPPORTED = new Set([
  // A JavaScript number holds integers exactly only up to 2^53 - 1.
  "int64",
  // @docuconf/core has no JSON Schema validator; loadContract takes one as validateJson.
  "json-schema",
]);

interface Case {
  id: string;
  source: string;
  requires: string[];
  contract: { vars: Record<string, { type: string; secret?: boolean; encoding?: string }> };
  env: Record<string, string>;
  expect?: Record<string, unknown>;
  errors?: Array<{ var: string; code: string }>;
}

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const fromEnv = process.env["DOCUCONF_CONFORMANCE"];
const casesPath = fromEnv ? resolve(fromEnv) : resolve(repoRoot, "../docuconf-go/conformance/cases.json");
const required = process.env["DOCUCONF_REQUIRE_CONFORMANCE"] === "1";
const found = existsSync(casesPath);

/** JSON.parse that keeps integers beyond 2^53 exact, as BigInt. */
function parseExact(text: string): unknown {
  return JSON.parse(text, (_key, value: unknown, context?: { source?: string }) => {
    if (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value) && context?.source && /^-?[0-9]+$/.test(context.source)) {
      return BigInt(context.source);
    }
    return value;
  });
}

/** A typed value as the case's JSON writes it. */
function asJson(type: string, value: unknown): unknown {
  if (value === undefined) return null;
  if (type === "duration") return formatDuration(value as number);
  return value;
}

function sameValue(type: string, got: unknown, want: unknown): boolean {
  if (typeof want === "bigint") return typeof got === "number" && Number.isSafeInteger(got) && BigInt(got) === want;
  if (type === "float" && typeof got === "number" && typeof want === "number") return got === want;
  return JSON.stringify(got) === JSON.stringify(want);
}

/** The raw env values of a case's secret variables, including indexed list items. */
function secretValues(c: Case): string[] {
  const out: string[] = [];
  for (const [name, v] of Object.entries(c.contract.vars)) {
    if (v.secret !== true) continue;
    for (const [k, raw] of Object.entries(c.env)) {
      if ((k === name || k.startsWith(`${name}__`)) && raw !== "") out.push(raw);
    }
  }
  return out;
}

describe.runIf(found || required)("conformance suite", () => {
  it("finds cases.json", () => {
    expect(found, `cases.json not found at ${casesPath}; set DOCUCONF_CONFORMANCE`).toBe(true);
  });
  if (!found) return;

  const suite = parseExact(readFileSync(casesPath, "utf8")) as { version: number; cases: Case[] };
  const skipped = suite.cases.filter((c) => c.requires.some((t) => UNSUPPORTED.has(t)));
  const dir = mkdtempSync(join(tmpdir(), "docuconf-conformance-"));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    const tags = [...new Set(skipped.flatMap((c) => c.requires.filter((t) => UNSUPPORTED.has(t))))].sort();
    console.log(`conformance: ${suite.cases.length - skipped.length} run, ${skipped.length} skipped (requires ${tags.join(", ")})`);
  });

  it("reads version 1", () => {
    expect(suite.version).toBe(1);
  });

  suite.cases.forEach((c, i) => {
    it.skipIf(skipped.includes(c))(c.id, () => {
      const log = join(dir, `termination-log-${i}`);
      let values: Record<string, unknown> | undefined;
      let error: DocuconfValidationError | undefined;
      try {
        values = loadContract(c.contract, { env: c.env, terminationLog: log });
      } catch (e) {
        if (!(e instanceof DocuconfValidationError)) throw e;
        error = e;
      }

      if (c.expect) {
        expect(error?.message, `${c.source}: expected success`).toBeUndefined();
        for (const [name, want] of Object.entries(c.expect)) {
          const type = c.contract.vars[name]!.type;
          const got = asJson(type, values![name]);
          expect(sameValue(type, got, want), `${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v))}`).toBe(true);
        }
      }

      if (c.errors) {
        expect(error, `${c.source}: expected errors`).toBeDefined();
        const pairs = (xs: Array<[string, string]>) => xs.map(([v, code]) => `${v} ${code}`).sort();
        expect(pairs(error!.violations.map((v) => [v.input, v.code]))).toEqual(pairs(c.errors.map((e) => [e.var, e.code])));
        const output = [error!.message, ...error!.violations.map((v) => v.message), existsSync(log) ? readFileSync(log, "utf8") : ""];
        for (const secret of secretValues(c)) {
          for (const text of output) expect(text.includes(secret), "a secret's value appears in the error output").toBe(false);
        }
      }
    });
  });
});
