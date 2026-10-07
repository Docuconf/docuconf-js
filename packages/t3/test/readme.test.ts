import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { consoleBlocks, uncheckedBlocks } from "../../core/test/support/readme.ts";
import { SOURCE_CONDITIONS } from "../../core/test/support/cue.ts";

// These tests start real processes; leave room for a loaded CI machine.
vi.setConfig({ testTimeout: 90_000 });

const here = dirname(fileURLToPath(import.meta.url));
const readme = join(here, "../README.md");

describe("README", () => {
  it("has no code block that is not a compiled file", () => {
    const missing = uncheckedBlocks(readme, [join(here, "../readme"), join(here, "../../../examples/next-t3/src")]);
    expect(missing.map((b) => `README.md:${b.line}\n${b.body}`)).toEqual([]);
  });

  it("shows the error output the quickstart really prints", () => {
    const block = consoleBlocks(readFileSync(readme, "utf8")).find((b) => b.command === "PORT=0 node src/server.ts");
    expect(block).toBeDefined();
    const r = spawnSync(process.execPath, [SOURCE_CONDITIONS, "src/server.ts"], {
      cwd: join(here, "../readme"),
      encoding: "utf8",
      env: { PATH: process.env["PATH"] ?? "", PORT: "0", DOCUCONF_TERMINATION_LOG: "/dev/null" },
    });
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toBe(`${block!.output}\n`);
  });
});
