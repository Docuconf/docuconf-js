import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { exportModule } from "./export.ts";

const USAGE = `Usage: docuconf-nestjs export <module> [--out contract.cue] [--name service] [--app-version v] [--package pkg] [--export name]

Loads <module> (.ts, .js, .mjs or .cjs, such as src/config/env.validation.ts or its
compiled dist/config/env.validation.js) in export mode and writes the contract of
its docuconfValidate(...) call as CUE.

  --out, -o       file to write (default: stdout)
  --name, -n      service name, a DNS label (default: docuconfValidate's name option)
  --app-version   metadata.appVersion, e.g. a git SHA
  --package       CUE package name (default: the service name)
  --export        the exported validate function to use, when the module makes several
`;

export async function main(argv: string[], io = { out: process.stdout, err: process.stderr }): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "-h" || command === "--help" || command === "help") {
    io.out.write(USAGE);
    return command === undefined ? 2 : 0;
  }
  if (command !== "export") {
    io.err.write(`docuconf-nestjs: unknown command "${command}"\n\n${USAGE}`);
    return 2;
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        out: { type: "string", short: "o" },
        name: { type: "string", short: "n" },
        "app-version": { type: "string" },
        package: { type: "string" },
        export: { type: "string" },
      },
    });
  } catch (e) {
    io.err.write(`docuconf-nestjs: ${(e as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const [file, ...extra] = parsed.positionals;
  if (file === undefined || extra.length > 0) {
    io.err.write(USAGE);
    return 2;
  }
  const v = parsed.values;
  try {
    const { cue, warnings } = await exportModule(file, {
      ...(v.name !== undefined ? { name: v.name } : {}),
      ...(v["app-version"] !== undefined ? { appVersion: v["app-version"] } : {}),
      ...(v.package !== undefined ? { packageName: v.package } : {}),
      ...(v.export !== undefined ? { exportName: v.export } : {}),
    });
    for (const w of warnings) io.err.write(`docuconf: warning: ${w}\n`);
    if (v.out !== undefined) {
      writeFileSync(v.out, cue);
      io.err.write(`docuconf: wrote ${v.out}\n`);
    } else {
      io.out.write(cue);
    }
    return 0;
  } catch (e) {
    io.err.write(e instanceof Error ? `${e.message}\n` : `${String(e)}\n`);
    return 1;
  }
}
