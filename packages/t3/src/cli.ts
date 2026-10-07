import { runCli } from "@docuconf/core/cli";
import { buildContract } from "./contract.ts";
import { exportModule } from "./export.ts";

/** `docuconf-t3 export|docs <module>`. Returns the exit code. */
export function main(argv: string[], io?: Parameters<typeof runCli>[2]): Promise<number> {
  return runCli(
    {
      bin: "docuconf-t3",
      about: `Loads <module> (.ts, .mts, .cts, .js, .mjs or .cjs) in export mode, where createEnv from
@docuconf/t3 skips validation, and reads the declaration of its createEnv call.`,
      nameSource: "createEnv's name option",
      async exportModule(file, opts) {
        const { extra: _extra, tsconfig, ...contractOpts } = opts;
        const r = await exportModule(file, { ...contractOpts, tsconfig });
        return { cue: r.cue, warnings: r.warnings, data: buildContract(r.declaration, contractOpts) };
      },
    },
    argv,
    io,
  );
}
