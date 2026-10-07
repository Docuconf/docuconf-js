// ESM only (subpath "@docuconf/core/cli"): the export CLIs of the SDKs.
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { renderMarkdown } from "./docs.ts";

/** What an SDK's export gives the CLI. */
export interface ExportedContract {
  /** contract.cue */
  cue: string;
  /** The contract as data (for docs). */
  data: Record<string, unknown>;
  warnings: string[];
}

export interface ExportCliOptions {
  name?: string;
  appVersion?: string;
  packageName?: string;
  tsconfig?: string;
  /** SDK-specific string options, by long name. */
  extra: Record<string, string | undefined>;
}

export interface CliSpec {
  /** The command name, such as `docuconf-t3`. */
  bin: string;
  /** One paragraph on which modules to pass. */
  about: string;
  /** SDK-specific string options: long name → help line. */
  extraOptions?: Record<string, string>;
  /** The default for `--name` in help: where the service name comes from. */
  nameSource: string;
  exportModule(file: string, opts: ExportCliOptions): Promise<ExportedContract>;
}

interface Io {
  out: { write(s: string): unknown };
  err: { write(s: string): unknown };
}

function usage(spec: CliSpec): string {
  const extra = Object.entries(spec.extraOptions ?? {})
    .map(([k, help]) => `  --${k.padEnd(14)}${help}\n`)
    .join("");
  return `Usage: ${spec.bin} export <module> [--out contract.cue] [--check contract.cue] [options]
       ${spec.bin} docs <module> [--out CONFIG.md] [options]

${spec.about}

export writes the contract as CUE; docs writes Markdown documentation of it.

  --out, -o       file to write (default: stdout)
  --check         export only: compare with this file instead of writing; exit 1
                  with a diff when it is out of date (for CI)
  --name, -n      service name, a DNS label (default: ${spec.nameSource})
  --app-version   metadata.appVersion, e.g. a git SHA
  --package       CUE package name (default: the service name)
  --tsconfig      the tsconfig.json whose "paths" aliases apply (default: the nearest)
${extra}`;
}

/** A short line diff: the first lines that differ, with line numbers. */
export function lineDiff(want: string, have: string, limit = 20): string {
  const a = want.split("\n");
  const b = have.split("\n");
  const out: string[] = [];
  for (let i = 0; i < Math.max(a.length, b.length) && out.length < limit; i++) {
    if (a[i] === b[i]) continue;
    if (b[i] !== undefined) out.push(`-${i + 1}: ${b[i]}`);
    if (a[i] !== undefined) out.push(`+${i + 1}: ${a[i]}`);
  }
  return out.join("\n");
}

/** Runs `<bin> export|docs ...`; returns the exit code. */
export async function runCli(spec: CliSpec, argv: string[], io: Io = { out: process.stdout, err: process.stderr }): Promise<number> {
  const help = usage(spec);
  const [command, ...rest] = argv;
  if (command === undefined || command === "-h" || command === "--help" || command === "help") {
    io.out.write(help);
    return command === undefined ? 2 : 0;
  }
  if (command !== "export" && command !== "docs") {
    io.err.write(`${spec.bin}: unknown command "${command}"\n\n${help}`);
    return 2;
  }
  const extraNames = Object.keys(spec.extraOptions ?? {});
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        out: { type: "string", short: "o" },
        check: { type: "string" },
        name: { type: "string", short: "n" },
        "app-version": { type: "string" },
        package: { type: "string" },
        tsconfig: { type: "string" },
        ...Object.fromEntries(extraNames.map((k) => [k, { type: "string" as const }])),
      },
    });
  } catch (e) {
    io.err.write(`${spec.bin}: ${(e as Error).message}\n\n${help}`);
    return 2;
  }
  const [file, ...more] = parsed.positionals;
  const v = parsed.values as Record<string, string | undefined>;
  if (file === undefined || more.length > 0 || (v["check"] !== undefined && (command !== "export" || v["out"] !== undefined))) {
    io.err.write(help);
    return 2;
  }
  let result: ExportedContract;
  try {
    result = await spec.exportModule(file, {
      ...(v["name"] !== undefined ? { name: v["name"] } : {}),
      ...(v["app-version"] !== undefined ? { appVersion: v["app-version"] } : {}),
      ...(v["package"] !== undefined ? { packageName: v["package"] } : {}),
      ...(v["tsconfig"] !== undefined ? { tsconfig: v["tsconfig"] } : {}),
      extra: Object.fromEntries(extraNames.map((k) => [k, v[k]])),
    });
  } catch (e) {
    io.err.write(e instanceof Error ? `${e.message}\n` : `${String(e)}\n`);
    return 1;
  }
  for (const w of result.warnings) io.err.write(`docuconf: warning: ${w}\n`);
  const text = command === "export" ? result.cue : renderMarkdown(result.data);
  if (v["check"] !== undefined) {
    let current: string | undefined;
    try {
      current = readFileSync(v["check"], "utf8");
    } catch {
      current = undefined;
    }
    if (current === text) {
      io.err.write(`docuconf: ${v["check"]} is up to date\n`);
      return 0;
    }
    io.err.write(
      current === undefined
        ? `docuconf: ${v["check"]} does not exist; run ${spec.bin} export ${file} --out ${v["check"]}\n`
        : `docuconf: ${v["check"]} is out of date; run ${spec.bin} export ${file} --out ${v["check"]}\n${lineDiff(text, current)}\n`,
    );
    return 1;
  }
  if (v["out"] !== undefined) {
    writeFileSync(v["out"], text);
    io.err.write(`docuconf: wrote ${v["out"]}\n`);
  } else io.out.write(text);
  return 0;
}
