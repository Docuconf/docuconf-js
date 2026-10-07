import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import "reflect-metadata";
import { IsString } from "class-validator";
import { afterAll, describe, expect, it } from "vitest";
import { canVet, vet } from "../../core/test/support/cue.ts";
import { exportModule } from "../src/export.ts";
import { Describe, Details, TextFile, declare } from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(join(here, "fixtures/.details-tmp-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("description and details (SPEC §14.7)", () => {
  it("takes the description from @Describe and details from the TSDoc comment and @Details", async () => {
    const { cue, declaration, warnings } = await exportModule(join(here, "fixtures/details-env.ts"));
    expect(warnings).toEqual([]);
    const port = declaration.vars.get("PORT")!.contract;
    expect(port["description"]).toBe("Port the HTTP server listens on");
    expect(port["details"]).toBe(
      "Behind the mesh, keep the default. See `HOST`.\n\n- `8080` in every environment\n- `0` is rejected\n\n```sh\nPORT=9090 npm start\n```",
    );
    expect(Object.keys(port).slice(0, 3)).toEqual(["type", "description", "details"]);
    expect(declaration.vars.get("HOST")!.contract["details"]).toBeUndefined();
    expect(declaration.vars.get("MODE")!.contract["details"]).toBe("Mode `a` is the default.");
    expect(declaration.vars.get("REGION")!.contract["details"]).toBe("Inherited from the base class.");
    expect(declaration.fileContracts.get("settings")!["details"]).toBe("Mounted from a ConfigMap.");
    if (canVet) {
      const r = vet(cue);
      expect(r.ok, r.output).toBe(true);
    }
  });

  it("fails without a description", () => {
    class NoDescription {
      @IsString() @Details("Has details but no description.")
      HOST: string = "x";
    }
    expect(() => declare(NoDescription)).toThrow(/HOST: needs a description of at least 5 characters/);
  });

  it("fails on blank or too-long @Details, on variables and files", () => {
    class Bad {
      @IsString() @Describe("Some input") @Details(" ")
      A: string = "x";

      @IsString() @Describe("Some input") @Details("日本".repeat(2001))
      B: string = "x";

      @TextFile({ path: "/etc/bad/x", description: "Some file" }) @Details("日本".repeat(2001))
      file?: string;
    }
    expect(() => declare(Bad)).toThrow(/A: @Details: details must not be blank/);
    expect(() => declare(Bad)).toThrow(/B: @Details: details are 4002 characters \(Unicode code points\); the most is 4000/);
    expect(() => declare(Bad)).toThrow(/file \(file input "file"\): details are 4002 characters/);
  });

  it("fails export when a doc comment gives more than 4000 characters", async () => {
    const file = join(tmp, "long-env.ts");
    writeFileSync(
      file,
      `import "reflect-metadata";
import { IsString } from "class-validator";
import { Describe, docuconfValidate } from "../../../src/index.ts";
export class LongEnv {
  /**
   * Some input.
   *
   * ${"日本".repeat(2001)}
   */
  @IsString() @Describe("Some input")
  A: string = "x";
}
export const validate = docuconfValidate(LongEnv, { name: "long" });
`,
    );
    await expect(exportModule(file)).rejects.toThrow(/A: doc comment: details are 4002 characters/);
  });
});
