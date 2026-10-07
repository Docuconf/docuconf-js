/** What a secret's value prints as. */
export const REDACTED = "[redacted]";

const INSPECT = Symbol.for("nodejs.util.inspect.custom");

/** A copy of `values` with every secret replaced by REDACTED. */
export function redactValues(values: Readonly<Record<string, unknown>>, secrets: ReadonlySet<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) out[k] = secrets.has(k) && v !== undefined ? REDACTED : v;
  return out;
}

/**
 * Makes `target` print with its secrets redacted in console.log and
 * util.inspect (`nodejs.util.inspect.custom`) and in JSON.stringify
 * (`toJSON`). Both are non-enumerable, so they never show up as values.
 * `view` returns the object as it should print.
 */
export function redactOnPrint(target: object, view: () => Record<string, unknown>): void {
  Object.defineProperty(target, INSPECT, {
    value: (_depth: number, options: object, inspect?: (v: unknown, o: object) => string) =>
      inspect ? inspect(view(), options) : view(),
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(target, "toJSON", { value: () => view(), enumerable: false, configurable: true });
}

export { INSPECT };
