/**
 * SPEC §4.3: patterns are RE2, the dialect every SDK can match exactly.
 * Returns a description of the first non-RE2 feature in `pattern`, or
 * undefined if none was found. This is a syntactic check for the features
 * JavaScript has and RE2 lacks: lookaround, backreferences and atomic groups.
 */
export function nonRe2Feature(pattern: string): string | undefined {
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") {
      const next = pattern[i + 1] ?? "";
      if (!inClass && /[1-9]/.test(next)) return `backreference \\${next}`;
      if (!inClass && next === "k" && pattern[i + 2] === "<") return "named backreference \\k<...>";
      i++;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") {
      inClass = true;
      // A ']' right after '[' or '[^' is a literal.
      if (pattern[i + 1] === "^") i++;
      if (pattern[i + 1] === "]") i++;
      continue;
    }
    if (c === "(" && pattern[i + 1] === "?") {
      const rest = pattern.slice(i + 2, i + 4);
      if (rest.startsWith("=")) return "lookahead (?=...)";
      if (rest.startsWith("!")) return "negative lookahead (?!...)";
      if (rest === "<=") return "lookbehind (?<=...)";
      if (rest === "<!") return "negative lookbehind (?<!...)";
      if (rest.startsWith(">")) return "atomic group (?>...)";
    }
  }
  return undefined;
}

/**
 * JavaScript's RegExp#source escapes "/" as "\/". RE2 accepts that, but the
 * plain form is what other SDKs emit, so contracts stay comparable.
 */
export function cleanPattern(source: string): string {
  return source.replace(/(?<!\\)((?:\\\\)*)\\\//g, "$1/");
}
