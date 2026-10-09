/**
 * The `keySet` type (SPEC §4.3, §6.1): a set of secret keys that are all
 * valid at once, so one can be rotated without an outage. For the side
 * that verifies: webhook signatures, inbound API keys, JWT HMAC
 * verification, cookie-signing fallbacks.
 */
import { REDACTED } from "./redact.ts";
import type { ErrorCode } from "./violations.ts";

/** A problem with a key set: its code and a message that never quotes a key. */
interface Problem {
  code: ErrorCode;
  message: string;
}

/** Length in characters (code points), as SPEC §4.3 counts. */
function charLength(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

const INSPECT = Symbol.for("nodejs.util.inspect.custom");
const encoder = new TextEncoder();

/** Whether two byte strings are equal, in time that depends only on their lengths. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) diff |= (a[i] ?? 0) ^ b[i]!;
  return diff === 0;
}

/**
 * A set of secret keys, in the order the platform gave them. It is always
 * secret: it prints as `[redacted]` in `String()`, template literals,
 * `JSON.stringify`, `console.log` and `util.inspect`; read the keys with
 * `keys()`.
 *
 * ```ts
 * const ok = env.WEBHOOK_KEYS?.verify((key) => {
 *   const want = createHmac("sha256", key).update(body).digest();
 *   return want.length === signature.length && timingSafeEqual(want, signature);
 * });
 * ```
 */
export class KeySet {
  readonly #keys: readonly string[];

  constructor(keys: Iterable<string>) {
    this.#keys = Object.freeze([...keys]);
  }

  /** The number of keys. */
  get size(): number {
    return this.#keys.length;
  }

  /** The keys, in the order the platform gave them (a copy). */
  keys(): string[] {
    return [...this.#keys];
  }

  /**
   * Whether `candidate` is one of the keys, such as an API key a caller
   * presents. It compares `candidate` with every key in constant time, so
   * the time taken does not say which key matched, or how much of one; it
   * depends only on the number of keys and on the lengths involved.
   */
  contains(candidate: string): boolean {
    const want = encoder.encode(candidate);
    let found = false;
    for (const key of this.#keys) found = sameBytes(encoder.encode(key), want) || found;
    return found;
  }

  /**
   * Calls `check` with each key and reports whether any call returned
   * true. For checks that need the key itself, such as an HMAC. Every key
   * is tried, even after one matches, so the time taken does not say which
   * key matched; `check` should compare in constant time itself
   * (`crypto.timingSafeEqual`).
   */
  verify(check: (key: string) => boolean): boolean {
    let ok = false;
    for (const key of this.#keys) ok = check(key) || ok;
    return ok;
  }

  /** `[redacted]`. */
  toString(): string {
    return REDACTED;
  }

  /** `[redacted]`, so `JSON.stringify` never writes a key. */
  toJSON(): string {
    return REDACTED;
  }

  /** `KeySet [redacted]` in `console.log` and `util.inspect`. */
  [INSPECT](): string {
    return `KeySet ${REDACTED}`;
  }

  get [Symbol.toStringTag](): string {
    return "KeySet";
  }
}

/** A key set's bounds (SPEC §4.3): the number of keys and each key's length in characters. */
export interface KeySetBounds {
  /** Default 1. */
  minKeys?: number | undefined;
  /** Default 2. */
  maxKeys?: number | undefined;
  keyMinLength?: number | undefined;
  keyMaxLength?: number | undefined;
}

/** The meta-schema defaults of minKeys and maxKeys. */
export const KEYSET_DEFAULTS = { minKeys: 1, maxKeys: 2 } as const;

/**
 * Every problem with a key set's keys: an empty key (a stray separator) or
 * one outside its length bounds is `out_of_range`; too few or too many keys
 * is `too_few_items` or `too_many_items`. Messages give positions and
 * lengths, never a key.
 */
export function keySetProblems(keys: readonly string[], bounds: KeySetBounds): Problem[] {
  const out: Problem[] = [];
  for (const [i, key] of keys.entries()) {
    const n = charLength(key);
    if (n === 0) out.push({ code: "out_of_range", message: `key ${i + 1} is empty` });
    else if (bounds.keyMinLength !== undefined && n < bounds.keyMinLength) {
      out.push({ code: "out_of_range", message: `key ${i + 1} is ${n} characters, below keyMinLength ${bounds.keyMinLength}` });
    } else if (bounds.keyMaxLength !== undefined && n > bounds.keyMaxLength) {
      out.push({ code: "out_of_range", message: `key ${i + 1} is ${n} characters, above keyMaxLength ${bounds.keyMaxLength}` });
    }
  }
  const min = bounds.minKeys ?? KEYSET_DEFAULTS.minKeys;
  const max = bounds.maxKeys ?? KEYSET_DEFAULTS.maxKeys;
  if (keys.length < min) out.push({ code: "too_few_items", message: `has ${keys.length} keys, fewer than minKeys ${min}` });
  else if (keys.length > max) out.push({ code: "too_many_items", message: `has ${keys.length} keys, more than maxKeys ${max}` });
  return out;
}

/** Declaration problems with a key set's bounds: minKeys at least 1, maxKeys at least minKeys, key lengths at least 1. */
export function keySetDeclProblems(bounds: KeySetBounds): string[] {
  const out: string[] = [];
  const int = (k: keyof KeySetBounds, least: number) => {
    const v = bounds[k];
    if (v !== undefined && !(Number.isInteger(v) && v >= least)) out.push(`${k} must be an integer of at least ${least}`);
  };
  int("minKeys", 1);
  int("maxKeys", 1);
  int("keyMinLength", 1);
  int("keyMaxLength", 1);
  const min = bounds.minKeys ?? KEYSET_DEFAULTS.minKeys;
  const max = bounds.maxKeys ?? KEYSET_DEFAULTS.maxKeys;
  if (max < min) out.push(`maxKeys ${max} is below minKeys ${min}`);
  if (bounds.keyMinLength !== undefined && bounds.keyMaxLength !== undefined && bounds.keyMaxLength < bounds.keyMinLength) {
    out.push(`keyMaxLength ${bounds.keyMaxLength} is below keyMinLength ${bounds.keyMinLength}`);
  }
  return out;
}

/** A key set's contract fields, in output order, with minKeys and maxKeys written out. */
export function keySetContract(bounds: KeySetBounds, encoding: string, separator: string | undefined): Record<string, unknown> {
  const c: Record<string, unknown> = { encoding };
  if (encoding === "csv") c["separator"] = separator ?? ",";
  c["minKeys"] = bounds.minKeys ?? KEYSET_DEFAULTS.minKeys;
  c["maxKeys"] = bounds.maxKeys ?? KEYSET_DEFAULTS.maxKeys;
  if (bounds.keyMinLength !== undefined) c["keyMinLength"] = bounds.keyMinLength;
  if (bounds.keyMaxLength !== undefined) c["keyMaxLength"] = bounds.keyMaxLength;
  return c;
}
