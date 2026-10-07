import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { uncheckedBlocks } from "./support/readme.ts";

const here = dirname(fileURLToPath(import.meta.url));

describe("README", () => {
  it("has no code block that is not a compiled file", () => {
    const missing = uncheckedBlocks(join(here, "../README.md"), [join(here, "../readme")]);
    expect(missing.map((b) => `README.md:${b.line}\n${b.body}`)).toEqual([]);
  });

  it("the root README has none either", () => {
    expect(uncheckedBlocks(join(here, "../../../README.md"), []).map((b) => b.line)).toEqual([]);
  });
});
