import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { consoleBlocks, uncheckedBlocks } from "../../core/test/support/readme.ts";
import { SOURCE_CONDITIONS } from "../../core/test/support/cue.ts";

const here = dirname(fileURLToPath(import.meta.url));
const readme = join(here, "../README.md");

/** Starts readme/src/main.ts as `npm run start` would, compiled the way nest build compiles it. */
function start(env: Record<string, string>) {
  const script = `
    import { importForExport } from ${JSON.stringify(pathToFileURL(join(here, "../src/ts-loader.ts")).href)};
    await importForExport(${JSON.stringify(join(here, "../readme/src/main.ts"))});
  `;
  return spawnSync(process.execPath, [SOURCE_CONDITIONS, "--input-type=module", "-e", script], {
    encoding: "utf8",
    env: { PATH: process.env["PATH"] ?? "", DOCUCONF_TERMINATION_LOG: "/dev/null", ...env },
  });
}

describe("README", () => {
  it("has no code block that is not a compiled file", () => {
    const missing = uncheckedBlocks(readme, [join(here, "../readme")]);
    expect(missing.map((b) => `README.md:${b.line}\n${b.body}`)).toEqual([]);
  });

  it("shows what the app really prints, with valid and invalid configuration", () => {
    const blocks = consoleBlocks(readFileSync(readme, "utf8")).filter((b) => b.command.endsWith("npm run start"));
    expect(blocks).toHaveLength(2);
    for (const b of blocks) {
      const env = Object.fromEntries(
        b.command
          .replace(/ npm run start$/, "")
          .split(" ")
          .map((kv) => kv.split("=") as [string, string]),
      );
      const r = start(env);
      expect(r.stdout + r.stderr, b.command).toBe(`${b.output}\n`);
      expect(r.status).toBe(b.output.startsWith("docuconf:") ? 1 : 0);
    }
  }, 120_000);
});
