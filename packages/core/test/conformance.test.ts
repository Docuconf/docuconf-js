/**
 * The shared conformance suite (SPEC §12, docuconf-go conformance/README.md),
 * run through the contract-first mode. Every case is a test named by its id.
 *
 * cases.json comes from DOCUCONF_CONFORMANCE, else ../docuconf-go/conformance/cases.json
 * next to this repository. With DOCUCONF_REQUIRE_CONFORMANCE=1 a missing file fails.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { DocuconfValidationError, KeySet, formatSignedDuration, jsonText, loadContract, parseJsonExact } from "../src/index.ts";

/**
 * The capability tags this SDK supports: all of them. A case that requires
 * any other tag, including one added to the suite after this list was
 * written, is skipped, never run (SPEC §12). CI requires 0 skipped.
 */
const SUPPORTED = new Set<string>(["int64", "json-schema", "key-set", "deprecated", "strict-parsing", "files", "profiles", "overlays"]);

type FileContent = { text: string } | { base64: string };

interface Case {
  id: string;
  source: string;
  requires: string[];
  contract: {
    vars?: Record<string, { type: string; secret?: boolean; encoding?: string }>;
    files?: Record<string, { type: string; secret?: boolean }>;
  };
  env: Record<string, string>;
  files?: Record<string, FileContent>;
  expect?: Record<string, unknown>;
  errors?: Array<{ var: string; code: string }>;
}

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const fromEnv = process.env["DOCUCONF_CONFORMANCE"];
const casesPath = fromEnv ? resolve(fromEnv) : resolve(repoRoot, "../docuconf-go/conformance/cases.json");
const required = process.env["DOCUCONF_REQUIRE_CONFORMANCE"] === "1";
const found = existsSync(casesPath);

/** An input's typed value as the case's JSON writes it (conformance/README.md, step 3). */
function asJson(c: Case, name: string, value: unknown): unknown {
  if (value === undefined) return null;
  const file = c.contract.files?.[name];
  if (file) return file.type === "config" || file.type === "text" ? value : true;
  const type = c.contract.vars?.[name]?.type;
  if (type === "duration") return formatSignedDuration(value as number);
  if (value instanceof KeySet) return value.keys();
  return value;
}

/** Equal as JSON, numbers compared numerically; an int beyond 2^53 must be the exact bigint. */
function same(got: unknown, want: unknown): boolean {
  if (typeof want === "bigint") return typeof got === "bigint" && got === want;
  if (typeof got === "bigint") return false;
  if (typeof want === "number") return typeof got === "number" && got === want;
  if (Array.isArray(want)) return Array.isArray(got) && got.length === want.length && want.every((w, i) => same(got[i], w));
  if (typeof want === "object" && want !== null) {
    if (typeof got !== "object" || got === null || Array.isArray(got)) return false;
    const keys = Object.keys(want);
    return keys.length === Object.keys(got).length && keys.every((k) => same((got as Record<string, unknown>)[k], (want as Record<string, unknown>)[k]));
  }
  return got === want;
}

/** The raw env values of a case's secret variables, including indexed items. */
function secretValues(c: Case): string[] {
  const out: string[] = [];
  for (const [name, v] of Object.entries(c.contract.vars ?? {})) {
    if (v.secret !== true) continue;
    for (const [k, raw] of Object.entries(c.env)) {
      if ((k === name || k.startsWith(`${name}__`)) && raw !== "") out.push(raw);
    }
  }
  return out;
}

/** Writes each of the case's files under `root`, at its absolute path. */
function writeFiles(root: string, files: Record<string, FileContent>): void {
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "base64" in content ? Buffer.from(content.base64, "base64") : content.text);
  }
}

describe.runIf(found || required)("conformance suite", () => {
  it("finds cases.json", () => {
    expect(found, `cases.json not found at ${casesPath}; set DOCUCONF_CONFORMANCE`).toBe(true);
  });
  if (!found) return;

  const suite = parseJsonExact(readFileSync(casesPath, "utf8")) as { version: number; cases: Case[] };
  const unsupported = (c: Case) => c.requires.filter((t) => !SUPPORTED.has(t));
  const skipped = suite.cases.filter((c) => unsupported(c).length > 0);
  const dir = mkdtempSync(join(tmpdir(), "docuconf-conformance-"));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    const tags = [...new Set(skipped.flatMap(unsupported))].sort();
    console.log(`conformance: ${suite.cases.length - skipped.length} run, ${skipped.length} skipped${tags.length ? ` (requires ${tags.join(", ")})` : ""}`);
  });

  it("skips no case", () => {
    expect(skipped.map((c) => `${c.id} (requires ${unsupported(c).join(", ")})`)).toEqual([]);
  });

  it("reads version 1", () => {
    expect(suite.version).toBe(1);
  });

  suite.cases.forEach((c, i) => {
    it.skipIf(skipped.includes(c))(c.id, () => {
      // A new, empty file root for every case, files or not, so no case reads the machine's own files.
      const root = join(dir, `case-${i}`);
      mkdirSync(root);
      writeFiles(root, c.files ?? {});
      const log = join(dir, `termination-log-${i}`);
      const warnings: string[] = [];
      let values: Record<string, unknown> | undefined;
      let error: DocuconfValidationError | undefined;
      try {
        values = loadContract(c.contract, {
          env: { ...c.env, DOCUCONF_FILE_ROOT: root },
          terminationLog: log,
          onWarning: (m) => warnings.push(m),
        });
      } catch (e) {
        if (!(e instanceof DocuconfValidationError)) throw e;
        error = e;
      }

      if (c.expect) {
        expect(error?.message, `${c.source}: expected success`).toBeUndefined();
        for (const [name, want] of Object.entries(c.expect)) {
          const got = asJson(c, name, values![name]);
          expect(same(got, want), `${name}: got ${jsonText(got)}, want ${jsonText(want)}`).toBe(true);
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

      // Warnings (a deprecated input that is set) name the input, never a secret's value.
      for (const secret of secretValues(c)) {
        for (const w of warnings) expect(w.includes(secret), "a secret's value appears in a warning").toBe(false);
      }
    });
  });
});
