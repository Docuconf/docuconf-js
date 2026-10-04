import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SDK_NAME, SDK_VERSION } from "../src/version.ts";

describe("version", () => {
  it("matches package.json, so exported contracts name the published version", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { name: string; version: string };
    expect(SDK_NAME).toBe(pkg.name);
    expect(SDK_VERSION).toBe(pkg.version);
  });
});
