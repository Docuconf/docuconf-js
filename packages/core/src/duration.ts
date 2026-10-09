/**
 * Go duration syntax (time.ParseDuration): a possibly signed sequence of
 * decimal numbers, each with an optional fraction and a unit suffix, such as
 * "300ms", "-1.5h" or "2h45m". Valid units are ns, us (or µs), ms, s, m, h.
 */

const UNIT_NS: Record<string, bigint> = {
  ns: 1n,
  us: 1_000n,
  "µs": 1_000n,
  "μs": 1_000n,
  ms: 1_000_000n,
  s: 1_000_000_000n,
  m: 60_000_000_000n,
  h: 3_600_000_000_000n,
};

const PART = /^([0-9]*)(?:\.([0-9]*))?(ns|us|µs|μs|ms|s|m|h)/;

/** Go's time.Duration range: -2^63 to 2^63 - 1 nanoseconds. */
const MAX_NS = 2n ** 63n - 1n;

/**
 * Parses a Go duration string, exactly as time.ParseDuration does (SPEC §5):
 * an optional sign, then `0` or numbers with units, such as "1m30s", "1.5h",
 * "-5s" or "+5s". Fractions are truncated to whole nanoseconds. Returns
 * milliseconds (negative for a negative duration), or undefined if invalid
 * or outside Go's range of -2^63 to 2^63 - 1 nanoseconds.
 */
export function parseDuration(input: string): number | undefined {
  let s = input;
  let negative = false;
  if (s.startsWith("-") || s.startsWith("+")) {
    negative = s[0] === "-";
    s = s.slice(1);
  }
  if (s === "0") return 0;
  if (s === "") return undefined;
  let total = 0n;
  while (s.length > 0) {
    const m = PART.exec(s);
    if (!m) return undefined;
    const whole = m[1] ?? "";
    const frac = m[2] ?? "";
    const unit = UNIT_NS[m[3]!]!;
    if (whole === "" && frac === "") return undefined;
    total += BigInt(whole || "0") * unit;
    if (frac !== "") total += (BigInt(frac) * unit) / 10n ** BigInt(frac.length);
    if (total > MAX_NS + 1n) return undefined;
    s = s.slice(m[0].length);
  }
  if (total > (negative ? MAX_NS + 1n : MAX_NS)) return undefined;
  const ns = negative ? -total : total;
  return Number(ns / 1_000_000n) + Number(ns % 1_000_000n) / 1e6;
}

/** The contract's #Duration form: integer components, no sign or fractions. */
export const CONTRACT_DURATION = /^([0-9]+(ns|us|ms|s|m|h))+$/;

/**
 * Formats milliseconds as a contract duration (e.g. 90000 -> "1m30s",
 * 1500 -> "1s500ms"). Negative values cannot be represented in a contract.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`cannot express ${ms}ms as a contract duration`);
  let ns = BigInt(Math.round(ms * 1e6));
  if (ns === 0n) return "0s";
  const units: Array<[string, bigint]> = [
    ["h", 3_600_000_000_000n],
    ["m", 60_000_000_000n],
    ["s", 1_000_000_000n],
    ["ms", 1_000_000n],
    ["us", 1_000n],
    ["ns", 1n],
  ];
  let out = "";
  for (const [unit, size] of units) {
    const q = ns / size;
    if (q > 0n) {
      out += `${q}${unit}`;
      ns -= q * size;
    }
  }
  return out;
}

/**
 * Formats milliseconds as a canonical duration with a sign: "-1m30s" for
 * -90000. For typed values (a Go duration may be negative); a contract's
 * own durations use formatDuration.
 */
export function formatSignedDuration(ms: number): string {
  return ms < 0 ? `-${formatDuration(-ms)}` : formatDuration(ms);
}

/** Normalises a Go duration to its contract form, or returns undefined if invalid. */
export function canonicalDuration(input: string): string | undefined {
  const ms = parseDuration(input);
  if (ms === undefined || ms < 0) return undefined;
  return formatDuration(ms);
}

/** How a duration is written in the environment (SPEC §5). */
export type DurationEncoding = "go" | "iso8601" | "seconds" | "timespan";

export const DURATION_ENCODINGS: readonly DurationEncoding[] = ["go", "iso8601", "seconds", "timespan"];

/** Milliseconds from whole and fractional decimal digits of a unit worth `unitMs`. */
function decimal(whole: string, frac: string | undefined, unitMs: number): number {
  return Number(whole) * unitMs + (frac ? Number(`0.${frac}`) * unitMs : 0);
}

const N = "([0-9]+)(?:[.,]([0-9]+))?";
const ISO8601 = new RegExp(`^P(?:${N}D)?(?:T(?:${N}H)?(?:${N}M)?(?:${N}S)?)?$`);

/**
 * An ISO 8601 duration (SPEC §5): `P[nD][T[nH][nM][nS]]`, such as `PT90S`,
 * `PT1,5S` or `P1DT2H3M4.5S`, where each `n` may have a fraction after `.`
 * or `,`. Upper case only. Days count as 24 hours; years, months and weeks
 * have no fixed length, so they are rejected, as is a sign. Returns
 * milliseconds, or undefined if invalid.
 */
export function parseIso8601Duration(input: string): number | undefined {
  const m = ISO8601.exec(input);
  if (!m) return undefined;
  const [, d, df, h, hf, min, mf, s, sf] = m;
  if (d === undefined && h === undefined && min === undefined && s === undefined) return undefined;
  // "P1DT" has a time designator with nothing after it.
  if (input.endsWith("T")) return undefined;
  return decimal(d ?? "0", df, 86_400_000) + decimal(h ?? "0", hf, 3_600_000) + decimal(min ?? "0", mf, 60_000) + decimal(s ?? "0", sf, 1000);
}

const SECONDS = /^([0-9]+)(?:\.([0-9]+))?$/;

/** A plain decimal number of seconds (`90`, `0.25`). Returns milliseconds, or undefined if invalid. */
export function parseSecondsDuration(input: string): number | undefined {
  const m = SECONDS.exec(input);
  return m ? decimal(m[1]!, m[2], 1000) : undefined;
}

const TIMESPAN = /^(?:([0-9]+)\.)?([0-9]{1,2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,7}))?$/;

/**
 * A .NET TimeSpan in its constant form, `[d.]hh:mm:ss[.fffffff]`
 * (`00:01:30`, `1.02:03:04.5`): `hh` one or two digits below 24, `mm` and
 * `ss` two digits below 60 (SPEC §5). Returns milliseconds, or undefined if
 * invalid.
 */
export function parseTimespan(input: string): number | undefined {
  const m = TIMESPAN.exec(input);
  if (!m) return undefined;
  const [, d, h, min, s, frac] = m;
  if (Number(h) > 23 || Number(min) > 59 || Number(s) > 59) return undefined;
  return decimal(d ?? "0", undefined, 86_400_000) + decimal(h!, undefined, 3_600_000) + decimal(min!, undefined, 60_000) + decimal(s!, frac, 1000);
}

/** Parses a duration in the given encoding. Returns milliseconds, or undefined if invalid. */
export function parseDurationAs(input: string, encoding: DurationEncoding): number | undefined {
  switch (encoding) {
    case "go":
      return parseDuration(input);
    case "iso8601":
      return parseIso8601Duration(input);
    case "seconds":
      return parseSecondsDuration(input);
    case "timespan":
      return parseTimespan(input);
  }
}

/** What a duration's encoding looks like, for messages. */
export const DURATION_EXAMPLE: Record<DurationEncoding, string> = {
  go: "a Go duration such as 30s or 1m30s",
  iso8601: "an ISO 8601 duration such as PT30S or PT1M30S",
  seconds: "a number of seconds such as 30 or 0.5",
  timespan: "a TimeSpan such as 00:00:30 or 1.02:03:04.5",
};
