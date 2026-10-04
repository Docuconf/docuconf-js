import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { exportModule } from "./export.ts";
import { DocuconfDeclarationError } from "./violations.ts";

const USAGE = `Usage: docuconf export <module> [--out contract.cue] [--name service] [--app-version v] [--package pkg]

Loads <module> (.ts, .mts, .cts, .js, .mjs or .cjs) in export mode, where createEnv from
@docuconf/t3 skips validation, and writes its contract as CUE.

  --out, -o       file to write (default: stdout)
  --name, -n      service name, a DNS label (default: createEnv's name option)
  --app-version   metadata.appVersion, e.g. a git SHA
  --package       CUE package name (default: the service name)
`;

export async function main(argv: string[], io = { out: process.stdout, err: process.stderr }): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "-h" || command === "--help" || command === "help") {
    io.out.write(USAGE);
    return command === undefined ? 2 : 0;
  }
  if (command !== "export") {
    io.err.write(`docuconf: unknown command "${command}"\n\n${USAGE}`);
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
      },
    });
  } catch (e) {
    io.err.write(`docuconf: ${(e as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const [file, ...extra] = parsed.positionals;
  if (file === undefined || extra.length > 0) {
    io.err.write(USAGE);
    return 2;
  }
  try {
    const { cue, warnings } = await exportModule(file, {
      ...(parsed.values.name !== undefined ? { name: parsed.values.name } : {}),
      ...(parsed.values["app-version"] !== undefined ? { appVersion: parsed.values["app-version"] } : {}),
      ...(parsed.values.package !== undefined ? { packageName: parsed.values.package } : {}),
    });
    for (const w of warnings) io.err.write(`docuconf: warning: ${w}\n`);
    if (parsed.values.out !== undefined) {
      writeFileSync(parsed.values.out, cue);
      io.err.write(`docuconf: wrote ${parsed.values.out}\n`);
    } else {
      io.out.write(cue);
    }
    return 0;
  } catch (e) {
    io.err.write(e instanceof DocuconfDeclarationError || e instanceof Error ? `${e.message}\n` : `${String(e)}\n`);
    return 1;
  }
}
