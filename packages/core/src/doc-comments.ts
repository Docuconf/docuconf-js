// ESM only (re-exported by "@docuconf/core/loader"): used by the export CLIs.
/**
 * Reads the TSDoc/JSDoc comments of declared properties from source, for
 * `details` (SPEC §14.7). Comments do not survive to runtime, so the export
 * CLI parses the declaring file with the project's own TypeScript, as
 * `tsc` would see it. Without TypeScript installed, only explicit details
 * are exported, and `docCommentsUnavailable` says why.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type * as TS from "typescript";
import { jsDocText } from "./doc-text.ts";

type Ts = typeof TS;

function loadTypeScript(file: string): Ts | undefined {
  for (const base of [file, import.meta.url]) {
    try {
      return createRequire(base)("typescript") as Ts;
    } catch {
      // try the next
    }
  }
  return undefined;
}

function parse(file: string): { ts: Ts; sf: TS.SourceFile } | undefined {
  const ts = loadTypeScript(file);
  if (!ts) return undefined;
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  return { ts, sf: ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true) };
}

/** Why doc comments in `file` cannot be read, or undefined when they can (or there are none). */
export function docCommentsUnavailable(file: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  if (!text.includes("/**")) return undefined;
  return loadTypeScript(file)
    ? undefined
    : `${file} has doc comments, but TypeScript is not installed, so they are not exported as details; install typescript, or use the explicit details option`;
}

/** The last `/** ... *\/` comment before `node` (and before its decorators), as text. */
function leadingDoc(ts: Ts, sf: TS.SourceFile, node: TS.Node): string | undefined {
  const ranges = ts.getLeadingCommentRanges(sf.text, node.getFullStart()) ?? [];
  for (let i = ranges.length - 1; i >= 0; i--) {
    const r = ranges[i]!;
    const c = sf.text.slice(r.pos, r.end);
    if (c.startsWith("/**") && c !== "/**/") return jsDocText(c);
  }
  return undefined;
}

function propertyName(ts: Ts, name: TS.PropertyName | undefined): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name) || ts.isPrivateIdentifier(name)) return name.text;
  return undefined;
}

/** An expression without `as`, `satisfies`, parentheses and `!`. */
function unwrap(ts: Ts, e: TS.Expression): TS.Expression {
  while (ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isTypeAssertionExpression(e)) {
    e = e.expression;
  }
  return e;
}

/** An object literal, or the object literal a same-file `const` holds. */
function objectLiteral(ts: Ts, sf: TS.SourceFile, e: TS.Expression | undefined): TS.ObjectLiteralExpression | undefined {
  if (!e) return undefined;
  e = unwrap(ts, e);
  if (ts.isObjectLiteralExpression(e)) return e;
  if (!ts.isIdentifier(e)) return undefined;
  let found: TS.ObjectLiteralExpression | undefined;
  const visit = (n: TS.Node): void => {
    if (found) return;
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === e.text && n.initializer) {
      const init = unwrap(ts, n.initializer);
      if (ts.isObjectLiteralExpression(init)) found = init;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

function docsOf(ts: Ts, sf: TS.SourceFile, obj: TS.ObjectLiteralExpression, out: Map<string, string>): void {
  for (const p of obj.properties) {
    if (ts.isSpreadAssignment(p)) {
      const inner = objectLiteral(ts, sf, p.expression);
      if (inner) docsOf(ts, sf, inner, out);
      continue;
    }
    const name = ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p) ? propertyName(ts, p.name) : undefined;
    if (name === undefined) continue;
    const doc = leadingDoc(ts, sf, p);
    if (doc !== undefined) out.set(name, doc);
  }
}

/**
 * The doc comments of the properties of the object literals passed as
 * `keys` (such as `server` and `files`) in the first argument of calls to
 * `callee` (such as `createEnv`), by key and property name. An object held
 * in a same-file `const`, and spreads of such objects, are followed.
 */
export function callArgumentDocs(file: string, callee: string, keys: readonly string[]): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>(keys.map((k) => [k, new Map()]));
  const parsed = parse(file);
  if (!parsed) return out;
  const { ts, sf } = parsed;
  const visit = (n: TS.Node): void => {
    if (ts.isCallExpression(n)) {
      const fn = unwrap(ts, n.expression);
      const name = ts.isIdentifier(fn) ? fn.text : ts.isPropertyAccessExpression(fn) ? fn.name.text : undefined;
      const arg = name === callee ? objectLiteral(ts, sf, n.arguments[0]) : undefined;
      if (arg) {
        for (const p of arg.properties) {
          const key = ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p) ? propertyName(ts, p.name) : undefined;
          if (key === undefined || !out.has(key)) continue;
          const value = ts.isPropertyAssignment(p) ? p.initializer : (p as TS.ShorthandPropertyAssignment).name;
          const obj = objectLiteral(ts, sf, value);
          if (obj) docsOf(ts, sf, obj, out.get(key)!);
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** The doc comments of the properties of class `className` in `file`, by property name. */
export function classPropertyDocs(file: string, className: string): Map<string, string> {
  const out = new Map<string, string>();
  const parsed = parse(file);
  if (!parsed) return out;
  const { ts, sf } = parsed;
  const visit = (n: TS.Node): void => {
    if ((ts.isClassDeclaration(n) || ts.isClassExpression(n)) && n.name?.text === className) {
      for (const m of n.members) {
        if (!ts.isPropertyDeclaration(m)) continue;
        const name = propertyName(ts, m.name);
        const doc = name === undefined ? undefined : leadingDoc(ts, sf, m);
        if (name !== undefined && doc !== undefined) out.set(name, doc);
      }
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
