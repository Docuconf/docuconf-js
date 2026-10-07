/**
 * An input's `details` (SPEC §4.2, §14.7): CommonMark for generated docs
 * only, never read at runtime. TypeScript has no runtime doc comments, so
 * the SDKs take details from an explicit option, and their export CLIs also
 * read the property's TSDoc/JSDoc comment (doc-comments.ts). This module is
 * the part with no Node built-ins: the limits, and JSDoc to CommonMark.
 */

/** The most characters (Unicode code points) details may have (SPEC §4.2). */
export const MAX_DETAILS = 4000;

/** Why `details` is not valid for the contract, or undefined when it is. */
export function detailsProblem(details: unknown): string | undefined {
  if (typeof details !== "string") return "details must be a string";
  if (details.trim() === "") return "details must not be blank";
  const n = [...details].length;
  if (n > MAX_DETAILS) return `details are ${n} characters (Unicode code points); the most is ${MAX_DETAILS}`;
  return undefined;
}

/**
 * Sets `details` in a contract object, right after `description` (the field
 * order of SPEC §4 and the Go reference), keeping every other field in place.
 */
export function setDetails(contract: Record<string, unknown>, details: string): void {
  const entries = Object.entries(contract).filter(([k]) => k !== "details");
  const at = entries.findIndex(([k]) => k === "description");
  entries.splice(at < 0 ? entries.length : at + 1, 0, ["details", details]);
  for (const k of Object.keys(contract)) delete contract[k];
  for (const [k, v] of entries) contract[k] = v;
}

const FENCE = /^\s*(```|~~~)/;
const BLOCK_TAG = /^@([A-Za-z]+)\b\s?(.*)$/;

/** `{@link X}`, `{@link X | text}`, `{@linkcode X}`, `{@code x}` and other inline tags, as CommonMark. */
function inlineTags(line: string): string {
  return line.replace(/\{@(\w+)\s*([^}]*)\}/g, (_, tag: string, body: string) => {
    if (tag === "inheritDoc") return "";
    const text = body.trim();
    if (text === "") return "";
    if (tag === "link" || tag === "linkcode" || tag === "linkplain") {
      const bar = text.search(/\s*\|\s*|\s+/);
      const target = bar < 0 ? text : text.slice(0, bar);
      const label = bar < 0 ? "" : text.slice(bar).replace(/^\s*\|?\s*/, "");
      if (/^https?:\/\//.test(target)) return label ? `[${label}](${target})` : `<${target}>`;
      return code(target);
    }
    return code(text);
  });
}

function code(s: string): string {
  const longest = Math.max(0, ...(s.match(/`+/g) ?? []).map((m) => m.length));
  const fence = "`".repeat(longest + 1);
  return longest > 0 ? `${fence} ${s} ${fence}` : `${fence}${s}${fence}`;
}

/** The text of a `/** ... *\/` comment: delimiters and each line's leading `*` removed. */
export function jsDocText(comment: string): string {
  const body = comment.replace(/^\/\*\*?/, "").replace(/\*\/$/, "");
  const lines = body.split(/\r?\n/).map((l, i) => (i === 0 ? l.trimStart() : l.replace(/^\s*\* ?/, "")));
  while (lines.length > 0 && lines[0]!.trim() === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  return lines.map((l) => l.replace(/\s+$/, "")).join("\n");
}

/**
 * A TSDoc/JSDoc comment as CommonMark. TSDoc's summary and `@remarks`
 * are kept as written; `@example` blocks become fenced code (unless already
 * fenced); other block tags (`@param`, `@default`, `@see`, `@deprecated`,
 * modifiers such as `@internal`) are dropped, since the contract has fields
 * of its own for defaults and deprecation. Inline `{@link X}` and
 * `{@code x}` become code spans, or a link for a URL.
 */
export function jsDocToMarkdown(text: string): string {
  const out: string[] = [];
  let tag: string | undefined;
  let example: string[] = [];
  let inFence = false;
  const flushExample = () => {
    if (tag !== "example") return;
    while (example.length > 0 && example[0]!.trim() === "") example.shift();
    while (example.length > 0 && example[example.length - 1]!.trim() === "") example.pop();
    if (example.length > 0) {
      if (out.length > 0) out.push("");
      if (example.some((l) => FENCE.test(l))) out.push(...example);
      else out.push("```ts", ...example, "```");
    }
    example = [];
  };
  for (const line of text.split("\n")) {
    if (!inFence) {
      const m = BLOCK_TAG.exec(line.trim());
      if (m) {
        flushExample();
        tag = m[1]!;
        const rest = m[2] ?? "";
        if (tag === "remarks") {
          if (out.length > 0 && out[out.length - 1] !== "") out.push("");
          if (rest.trim() !== "") out.push(inlineTags(rest));
        } else if (tag === "example" && rest.trim() !== "") example.push(rest);
        continue;
      }
    }
    if (FENCE.test(line)) inFence = !inFence;
    if (tag === "example") example.push(line);
    else if (tag === undefined || tag === "remarks") out.push(inFence || FENCE.test(line) ? line : inlineTags(line));
  }
  flushExample();
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Collapses whitespace and drops a final period, to compare a summary with a description. */
function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim().replace(/\.$/, "");
}

/**
 * The details a doc comment gives an input whose description is
 * `description` (from `.describe()` or `@Describe`): the comment as
 * CommonMark, without its first paragraph when that paragraph is the
 * description again, the usual TSDoc summary. Undefined when nothing is left.
 */
export function detailsFromDocComment(text: string, description: string | undefined): string | undefined {
  const md = jsDocToMarkdown(text);
  if (md === "") return undefined;
  const [first, ...rest] = md.split(/\n[ \t]*\n/);
  if (description !== undefined && !FENCE.test(first!) && normalize(first!) === normalize(description)) {
    const remaining = rest.join("\n\n").trim();
    return remaining === "" ? undefined : remaining;
  }
  return md;
}

/** Frames that are never the declaring file: dependencies, and decorator helpers that vitest/Vite inline. */
const HELPERS = /[\\/]node_modules[\\/]|@(oxc-project|babel|swc)\+(runtime|helpers)|[\\/]tslib(\.es6)?\.m?js$/;

/**
 * The source file of the first stack frame outside the SDK: the module that
 * called the SDK function that calls this, such as the file with the
 * createEnv() call or the class a decorator is on. The SDK's own frames are
 * the first two (this function and its caller) and any others in their
 * directories; Node internals, node_modules and bundlers' decorator helpers
 * (tslib, Babel, oxc and SWC runtimes) are skipped too. Used only to
 * find doc comments at export time.
 */
export function callerFile(): string | undefined {
  const stack = new Error().stack ?? "";
  const files: string[] = [];
  for (const line of stack.split("\n").slice(1)) {
    const m = /\(?((?:file:\/\/)?\/[^():]+|[A-Za-z]:\\[^():]+):\d+:\d+\)?\s*$/.exec(line);
    if (!m) continue;
    let f = m[1]!;
    // A module URL may carry a query, such as the export loader's ?docuconf-export=N.
    f = f.replace(/[?#][^/\\]*$/, "");
    if (f.startsWith("file://")) f = decodeURIComponent(f.slice("file://".length));
    files.push(f);
  }
  if (files.length < 2) return undefined;
  const dir = (f: string) => f.slice(0, Math.max(f.lastIndexOf("/"), f.lastIndexOf("\\")));
  const own = new Set([dir(files[0]!), dir(files[1]!)]);
  return files.find((f) => !own.has(dir(f)) && !HELPERS.test(f));
}

/**
 * Adds the details of each input's doc comment to its contract, unless the
 * input has explicit details, which win. `inputs` are [label, contract, doc
 * comment text]; a problem is appended for details that are too long.
 */
export function applyDocComments(inputs: Iterable<[label: string, contract: Record<string, unknown>, doc: string | undefined]>, problems: string[]): void {
  for (const [label, contract, doc] of inputs) {
    if (doc === undefined || contract["details"] !== undefined) continue;
    const details = detailsFromDocComment(doc, contract["description"] as string | undefined);
    if (details === undefined) continue;
    const bad = detailsProblem(details);
    if (bad !== undefined) problems.push(`${label}: doc comment: ${bad}`);
    else setDetails(contract, details);
  }
}
