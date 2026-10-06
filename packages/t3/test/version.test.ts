import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SDK_NAME, SDK_VERSION } from "../src/version.ts";

describe("version", () => {
  it("matches package.json, so exported contracts name the published version", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      name: string;
      version: string;
      dependencies: Record<string, string>;
    };
    const core = JSON.parse(readFileSync(new URL("../../core/package.json", import.meta.url), "utf8")) as { version: string };
    expect(SDK_NAME).toBe(pkg.name);
    expect(SDK_VERSION).toBe(pkg.version);
    // The release workflow publishes @docuconf/core first; the SDK must accept that version.
    expect(pkg.dependencies["@docuconf/core"]).toBe(`^${core.version}`);
  });
});
