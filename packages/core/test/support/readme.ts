import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Languages whose README blocks must come from a compiled file. */
const CODE = new Set(["ts", "tsx", "js", "mjs", "cjs"]);

export interface Block {
  lang: string;
  body: string;
  line: number;
}

/** Every fenced block in a Markdown file. */
export function readmeBlocks(markdown: string): Block[] {
  const out: Block[] = [];
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const open = /^```(\S*)\s*$/.exec(lines[i]!);
    if (!open) continue;
    const start = i;
    const body: string[] = [];
    for (i++; i < lines.length && !/^```\s*$/.test(lines[i]!); i++) body.push(lines[i]!);
    out.push({ lang: open[1]!, body: body.join("\n"), line: start + 1 });
  }
  return out;
}

function files(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === "dist") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (/\.(c|m)?[jt]sx?$/.test(p)) out.push(p);
  }
  return out;
}

/**
 * The README's code blocks that are not, verbatim, part of a source file
 * under `dirs`. Those files are compiled (and some run) in CI, so a block
 * found in one is checked too.
 */
export function uncheckedBlocks(readmePath: string, dirs: string[]): Block[] {
  const sources = dirs.flatMap(files).map((f) => readFileSync(f, "utf8"));
  return readmeBlocks(readFileSync(readmePath, "utf8")).filter((b) => CODE.has(b.lang) && !sources.some((s) => s.includes(b.body)));
}

/** The console blocks of a README: `$ command` and the output that follows. */
export function consoleBlocks(markdown: string): Array<{ command: string; output: string }> {
  const out: Array<{ command: string; output: string }> = [];
  for (const b of readmeBlocks(markdown)) {
    if (b.lang !== "console") continue;
    const [first, ...rest] = b.body.split("\n");
    if (first?.startsWith("$ ")) out.push({ command: first.slice(2), output: rest.join("\n") });
  }
  return out;
}
