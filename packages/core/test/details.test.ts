import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DocuconfDeclarationError,
  MAX_DETAILS,
  applyDocComments,
  describeFiles,
  detailsFromDocComment,
  detailsProblem,
  jsDocText,
  jsDocToMarkdown,
  loadContract,
  parseContract,
  setDetails,
  textFile,
  type SchemaAdapter,
} from "../src/index.ts";
import { callArgumentDocs, classPropertyDocs } from "../src/loader.ts";

const adapter: SchemaAdapter = { jsonSchema: () => ({}), validate: (_s, d) => ({ value: d }) };

describe("details limits (SPEC §4.2)", () => {
  it("accepts up to 4000 code points, counting multi-byte characters once", () => {
    expect(MAX_DETAILS).toBe(4000);
    expect(detailsProblem("日本".repeat(2000))).toBeUndefined();
    expect(detailsProblem("日本".repeat(2000) + "語")).toMatch(/4001 characters .*most is 4000/);
  });

  it("rejects blank details", () => {
    expect(detailsProblem("")).toMatch(/blank/);
    expect(detailsProblem(" \n\t ")).toMatch(/blank/);
  });

  it("puts details right after description", () => {
    const c: Record<string, unknown> = { type: "int", description: "Worker count", required: true, min: 1 };
    setDetails(c, "More.");
    expect(Object.keys(c)).toEqual(["type", "description", "details", "required", "min"]);
  });
});

describe("TSDoc/JSDoc to CommonMark (SPEC §14.7)", () => {
  const comment = `/**
   * Number of background workers.
   *
   * Each worker holds one connection to {@link DATABASE_URL}, and
   * {@link https://example.com/pool | the pool guide} says why.
   *
   * - Raise it when the queue backs up.
   * - Lower it when the database is busy.
   *
   * \`\`\`sh
   * WORKERS=8   # {@link kept} as written in code
   * \`\`\`
   *
   * @param ignored - not a function, dropped
   * @default 4
   * @remarks
   * Use {@code 0} to pause.
   * @example
   * WORKERS=4
   * @deprecated use POOL instead
   */`;

  it("strips the comment syntax", () => {
    expect(jsDocText("/** One line. */")).toBe("One line.");
    expect(jsDocText(comment).split("\n")[0]).toBe("Number of background workers.");
  });

  it("keeps paragraphs, lists and code; converts inline tags; drops block tags", () => {
    expect(jsDocToMarkdown(jsDocText(comment))).toBe(
      [
        "Number of background workers.",
        "",
        "Each worker holds one connection to `DATABASE_URL`, and",
        "[the pool guide](https://example.com/pool) says why.",
        "",
        "- Raise it when the queue backs up.",
        "- Lower it when the database is busy.",
        "",
        "```sh",
        "WORKERS=8   # {@link kept} as written in code",
        "```",
        "",
        "Use `0` to pause.",
        "",
        "```ts",
        "WORKERS=4",
        "```",
      ].join("\n"),
    );
  });

  it("drops a first paragraph that repeats the description", () => {
    const text = jsDocText(comment);
    expect(detailsFromDocComment(text, "Number of background workers")).toMatch(/^Each worker holds/);
    // A different summary is part of the details.
    expect(detailsFromDocComment(text, "Workers")).toMatch(/^Number of background workers\.\n\nEach worker/);
    expect(detailsFromDocComment("Number of background workers.", "Number of background workers")).toBeUndefined();
    expect(detailsFromDocComment("@internal", "Anything")).toBeUndefined();
  });

  it("fails an input whose doc comment gives more than 4000 characters", () => {
    const problems: string[] = [];
    const c: Record<string, unknown> = { type: "string", description: "A long one" };
    applyDocComments([["LONG", c, `A long one.\n\n${"日本".repeat(2001)}`]], problems);
    expect(problems).toEqual(["LONG: doc comment: details are 4002 characters (Unicode code points); the most is 4000"]);
    expect(c["details"]).toBeUndefined();
  });

  it("lets explicit details win over the doc comment", () => {
    const c: Record<string, unknown> = { type: "string", description: "Short", details: "Explicit." };
    applyDocComments([["X", c, "Short.\n\nFrom the comment."]], []);
    expect(c["details"]).toBe("Explicit.");
  });
});

describe("reading doc comments from source", () => {
  const dir = mkdtempSync(join(tmpdir(), "docuconf-docs-"));

  it("reads createEnv's server and files properties, through a const and a spread", () => {
    const file = join(dir, "env.ts");
    writeFileSync(
      file,
      `const shared = {
  /** Shared one.\n\n   * Shared details. */
  SHARED: z.string(),
};
const server = {
  ...shared,
  /**
   * Port.
   *
   * Details of the port.
   */
  PORT: z.coerce.number(),
  // not a doc comment
  HOST: z.string(),
} satisfies Record<string, unknown>;
export const env = createEnv({
  server,
  files: {
    /** Settings.\n\n     * Settings details. */
    settings: textFile({ path: "/etc/x/s", description: "Settings" }),
  },
});
`,
    );
    const docs = callArgumentDocs(file, "createEnv", ["server", "files"]);
    expect(docs.get("server")!.get("PORT")).toBe("Port.\n\nDetails of the port.");
    expect(docs.get("server")!.get("SHARED")).toBe("Shared one.\n\nShared details.");
    expect(docs.get("server")!.has("HOST")).toBe(false);
    expect(docs.get("files")!.get("settings")).toBe("Settings.\n\nSettings details.");
  });

  it("reads class properties, above their decorators", () => {
    const file = join(dir, "config.ts");
    writeFileSync(
      file,
      `export class Env {
  /**
   * Port.
   *
   * Details.
   */
  @IsInt() @Describe("Port")
  PORT: number = 8080;

  @IsString() @Describe("Host")
  HOST!: string;
}
`,
    );
    const docs = classPropertyDocs(file, "Env");
    expect([...docs]).toEqual([["PORT", "Port.\n\nDetails."]]);
    expect(classPropertyDocs(file, "Other").size).toBe(0);
  });
});

describe("file inputs take details", () => {
  it("exports details after description, and rejects blank or long ones", () => {
    const problems: string[] = [];
    const out = describeFiles(
      {
        settings: textFile({ path: "/etc/app/settings", description: "App settings", details: "Mounted from a ConfigMap." }),
        blank: textFile({ path: "/etc/blank/x", description: "Blank details", details: "  " }),
        long: textFile({ path: "/etc/long/x", description: "Long details", details: "日本".repeat(2001) }),
      },
      new Map(),
      problems,
      adapter,
    );
    expect(Object.keys(out.get("settings")!).slice(0, 3)).toEqual(["type", "description", "details"]);
    expect(out.get("settings")!["details"]).toBe("Mounted from a ConfigMap.");
    expect(problems).toEqual([
      "files.blank: details must not be blank",
      "files.long: details are 4002 characters (Unicode code points); the most is 4000",
    ]);
  });
});

describe("contract-first mode with details", () => {
  const contract = (details: unknown) => ({
    apiVersion: "docuconf.dev/v1alpha1",
    kind: "ConfigContract",
    metadata: { name: "orders" },
    vars: { PORT: { type: "int", description: "HTTP listen port", details, default: 8080 } },
    files: { settings: { type: "text", description: "App settings", details: "Docs **only**.", path: "/etc/app/settings" } },
  });

  it("loads a contract with details and ignores them at runtime", () => {
    expect(loadContract(JSON.stringify(contract("# Why\n\nBehind the mesh, keep the default.")), { env: { PORT: "9090" }, terminationLog: false })).toEqual({ PORT: 9090 });
  });

  it("rejects details the meta-schema rejects", () => {
    expect(() => parseContract(contract(" "))).toThrow(DocuconfDeclarationError);
    expect(() => parseContract(contract("日本".repeat(2001)))).toThrow(/PORT: details are 4002 characters/);
  });
});
