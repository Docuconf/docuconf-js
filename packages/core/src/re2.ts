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

/**
 * Compiles an RE2 pattern from a contract (SPEC §4.3) to a RegExp that
 * matches the same strings, for patterns written in the syntax RE2 and
 * JavaScript share. Handles a leading flag group such as `(?i)`, `\A` and
 * `\z`, and `\pL`-style classes. Returns a problem for what JavaScript
 * cannot match the RE2 way.
 */
export function re2RegExp(pattern: string): RegExp | { problem: string } {
  let p = pattern;
  let flags = "";
  const lead = /^\(\?([imsU]+)\)/.exec(p);
  if (lead) {
    if (lead[1]!.includes("U")) return { problem: "the U (ungreedy) flag has no JavaScript equivalent" };
    flags = [...new Set(lead[1]!)].join("");
    p = p.slice(lead[0].length);
  }
  const bad = nonRe2Feature(p);
  if (bad) return { problem: `${bad} is not RE2` };
  // Outside character classes: \A and \z are the input's ends (without the
  // m flag, JavaScript's ^ and $ are too), and \pL is \p{L}.
  let out = "";
  let inClass = false;
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === "\\") {
      const next = p[i + 1] ?? "";
      if (!inClass && next === "A" && !flags.includes("m")) out += "^";
      else if (!inClass && next === "z" && !flags.includes("m")) out += "$";
      else if ((next === "p" || next === "P") && /[A-Z]/.test(p[i + 2] ?? "")) {
        out += `\\${next}{${p[i + 2]}}`;
        i++;
      } else out += c + next;
      i++;
      continue;
    }
    if (inClass && c === "]") inClass = false;
    else if (!inClass && c === "[") {
      inClass = true;
      out += c;
      if (p[i + 1] === "^") out += p[++i];
      if (p[i + 1] === "]") out += `\\${p[++i]}`;
      continue;
    }
    out += c;
  }
  // RE2 matches code points, as the u flag does; some patterns RE2 accepts
  // (such as escaped punctuation that needs no escape) only compile without it.
  for (const f of [`${flags}u`, flags]) {
    try {
      return new RegExp(out, f);
    } catch {
      // try the next
    }
  }
  return { problem: "pattern does not compile as a JavaScript regular expression" };
}
