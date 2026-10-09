/**
 * The shared export check (SPEC §11.2 item 3, §12): the fixture in
 * docuconf-go's conformance/export/fixture.yaml, declared with @docuconf/t3
 * in fixtures/conformance-fixture.ts, must export to a contract equal, as
 * data, to conformance/export/golden.cue:
 *
 *   docuconf conformance export --golden golden.cue exported.cue
 *
 * golden.cue comes from DOCUCONF_EXPORT_GOLDEN, else beside DOCUCONF_CONFORMANCE
 * (conformance/export/golden.cue), else ../docuconf-go next to this repository.
 * The CLI is DOCUCONF_CLI, else `docuconf` on PATH. With
 * DOCUCONF_REQUIRE_CONFORMANCE=1, a missing golden file or CLI fails.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { exportModule } from "../src/export.ts";
import { canVet, vet } from "../../core/test/support/cue.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const cases = process.env["DOCUCONF_CONFORMANCE"] ?? join(repoRoot, "../docuconf-go/conformance/cases.json");
const golden = resolve(process.env["DOCUCONF_EXPORT_GOLDEN"] ?? join(dirname(cases), "export/golden.cue"));
const cli = process.env["DOCUCONF_CLI"] || "docuconf";
// Only whether it runs at all: a missing binary is ENOENT.
const hasCli = spawnSync(cli, ["--help"], { encoding: "utf8" }).error === undefined;
const required = process.env["DOCUCONF_REQUIRE_CONFORMANCE"] === "1";
const ready = existsSync(golden) && hasCli;

describe.runIf(ready || required)("the shared export fixture", () => {
  const dir = mkdtempSync(join(tmpdir(), "docuconf-export-fixture-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("finds golden.cue and the docuconf CLI", () => {
    expect(existsSync(golden), `golden.cue not found at ${golden}; set DOCUCONF_EXPORT_GOLDEN or DOCUCONF_CONFORMANCE`).toBe(true);
    expect(hasCli, `the docuconf CLI (${cli}) does not run; set DOCUCONF_CLI`).toBe(true);
  });

  it.runIf(ready)("exports to the golden contract, compared as data", async () => {
    const { cue, warnings } = await exportModule(join(here, "fixtures/conformance-fixture.ts"));
    expect(warnings).toEqual([]);
    const exported = join(dir, "exported.cue");
    writeFileSync(exported, cue);
    const r = spawnSync(cli, ["conformance", "export", "--golden", golden, exported], { encoding: "utf8" });
    expect(`${r.stdout}${r.stderr}`.trim(), "docuconf conformance export").not.toMatch(/difference|not in the golden|error/i);
    expect(r.status).toBe(0);
    if (canVet) expect(vet(cue).output).toBe("");
  });
});
