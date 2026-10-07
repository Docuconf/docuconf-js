import { runCli } from "@docuconf/core/cli";
import { buildContract } from "./contract.ts";
import { exportModule } from "./export.ts";

/** `docuconf-nestjs export|docs <module>`. Returns the exit code. */
export function main(argv: string[], io?: Parameters<typeof runCli>[2]): Promise<number> {
  return runCli(
    {
      bin: "docuconf-nestjs",
      about: `Loads <module> (.ts, .js, .mjs or .cjs, such as src/config/env.validation.ts or its
compiled dist/config/env.validation.js) in export mode and reads the declaration of its
docuconfValidate(...) call.`,
      nameSource: "docuconfValidate's name option",
      extraOptions: { export: "the exported validate function to use, when the module makes several" },
      async exportModule(file, opts) {
        const { extra, tsconfig, ...contractOpts } = opts;
        const r = await exportModule(file, { ...contractOpts, tsconfig, ...(extra["export"] !== undefined ? { exportName: extra["export"] } : {}) });
        return { cue: r.cue, warnings: r.warnings, data: buildContract(r.declaration, contractOpts) };
      },
    },
    argv,
    io,
  );
}
