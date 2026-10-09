/**
 * A small CUE writer for plain data (SPEC §4: contracts are data, with no
 * expressions beyond the meta-schema). Output follows `cue fmt`: tabs,
 * values of consecutive single-line fields aligned, lists of scalars inline.
 */

const IDENT = /^[A-Za-z][A-Za-z0-9_]*$/;
const KEYWORDS = new Set(["package", "import", "for", "in", "if", "let", "true", "false", "null", "_", "__"]);

export function cueLabel(key: string): string {
  return IDENT.test(key) && !KEYWORDS.has(key) ? key : JSON.stringify(key);
}

function isScalar(v: unknown): boolean {
  return v === null || typeof v !== "object";
}

function scalar(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new TypeError(`cannot write ${v} in CUE`);
    return Object.is(v, -0) ? "0" : JSON.stringify(v);
  }
  if (typeof v === "boolean" || v === null) return String(v);
  // An exact integer beyond 2^53, such as an int64 bound.
  if (typeof v === "bigint") return v.toString();
  throw new TypeError(`cannot write ${typeof v} in CUE`);
}

export function cueValue(v: unknown, indent: string): string {
  if (isScalar(v)) return scalar(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    if (v.every(isScalar)) return `[${v.map(scalar).join(", ")}]`;
    const inner = indent + "\t";
    return `[\n${v.map((x) => `${inner}${cueValue(x, inner)},`).join("\n")}\n${indent}]`;
  }
  const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
  if (entries.length === 0) return "{}";
  return `{\n${cueFields(entries, indent + "\t")}\n${indent}}`;
}

/**
 * Writes struct fields. Runs of fields with scalar values are aligned; a
 * list or struct value ends the run, as `cue fmt` does.
 */
export function cueFields(entries: Array<[string, unknown]>, indent: string): string {
  const lines: string[] = [];
  let run: Array<[string, string]> = [];
  const flush = () => {
    const width = Math.max(...run.map(([l]) => l.length));
    for (const [l, val] of run) lines.push(`${indent}${l}:${" ".repeat(width - l.length + 1)}${val}`);
    run = [];
  };
  for (const [k, v] of entries) {
    if (v === undefined) continue;
    const label = cueLabel(k);
    if (isScalar(v)) {
      run.push([label, scalar(v)]);
      continue;
    }
    if (run.length > 0) flush();
    lines.push(`${indent}${label}: ${cueValue(v, indent)}`);
  }
  if (run.length > 0) flush();
  return lines.join("\n");
}
