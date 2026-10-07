import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { DocuconfDeclarationError, annotate, createEnv, getDeclaration } from "../src/index.ts";
import { exportModule } from "../src/export.ts";
import { canVet, vet } from "../../core/test/support/cue.ts";

const here = dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(join(here, "fixtures/.details-tmp-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("description and details (SPEC §14.7)", () => {
  it("takes the description from .describe() and details from the TSDoc comment, .meta() and annotate()", async () => {
    const { cue, declaration, warnings } = await exportModule(join(here, "fixtures/details-env.ts"));
    expect(warnings).toEqual([]);
    const port = declaration.vars.get("PORT")!.contract;
    expect(port["description"]).toBe("Port the HTTP server listens on");
    expect(port["details"]).toBe(
      "Behind the mesh, keep the default. See `HOST`.\n\n- `8080` in every environment\n- `0` is rejected\n\n```sh\nPORT=9090 npm start\n```",
    );
    expect(Object.keys(port).slice(0, 3)).toEqual(["type", "description", "details"]);
    // A comment that only repeats the description adds nothing.
    expect(declaration.vars.get("HOST")!.contract["details"]).toBeUndefined();
    expect(declaration.vars.get("REGION")!.contract["details"]).toBe("Set by the **platform**.");
    expect(declaration.vars.get("MODE")!.contract["details"]).toBe("Mode `a` is the default.");
    expect(declaration.fileContracts.get("settings")!["details"]).toBe("Mounted from a ConfigMap.");
    expect(cue).toContain('details:     "Behind the mesh, keep the default. See `HOST`.\\n\\n- `8080`');
    if (canVet) {
      const r = vet(cue);
      expect(r.ok, r.output).toBe(true);
    }
  });

  it("fails without a description", () => {
    expect(() => createEnv({ server: { PORT: z.string() }, runtimeEnv: {}, isServer: true } as never)).toThrow(/PORT: needs a description of at least 5 characters/);
    expect(() => createEnv({ server: { PORT: z.string().describe("   ") }, runtimeEnv: {}, isServer: true } as never)).toThrow(DocuconfDeclarationError);
  });

  it("fails on blank or too-long explicit details", () => {
    const long = "日本".repeat(2001);
    expect(() => createEnv({ server: { A: z.string().describe("Some input").meta({ details: " " }) }, runtimeEnv: {} } as never)).toThrow(/A: details must not be blank/);
    expect(() => createEnv({ server: { A: annotate(z.string().describe("Some input"), { details: long }) }, runtimeEnv: {} } as never)).toThrow(
      /A: details are 4002 characters \(Unicode code points\); the most is 4000/,
    );
    const ok = createEnv({ server: { A: z.string().default("x").describe("Some input").meta({ details: "日本".repeat(2000) }) }, runtimeEnv: {} } as never);
    expect(getDeclaration(ok).vars.get("A")!.contract["details"]).toHaveLength(4000);
  });

  it("fails export when a doc comment gives more than 4000 characters", async () => {
    const file = join(tmp, "long-env.ts");
    writeFileSync(
      file,
      `import { z } from "zod";
import { createEnv } from "../../../src/index.ts";
export const env = createEnv({
  name: "long",
  server: {
    /**
     * Some input.
     *
     * ${"日本".repeat(2001)}
     */
    A: z.string().default("x").describe("Some input"),
  },
  runtimeEnv: {},
});
`,
    );
    await expect(exportModule(file)).rejects.toThrow(/A: doc comment: details are 4002 characters/);
  });
});
