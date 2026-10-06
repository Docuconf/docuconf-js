/**
 * Go duration syntax (time.ParseDuration): a possibly signed sequence of
 * decimal numbers, each with an optional fraction and a unit suffix, such as
 * "300ms", "-1.5h" or "2h45m". Valid units are ns, us (or µs), ms, s, m, h.
 */

const UNIT_NS: Record<string, number> = {
  ns: 1,
  us: 1e3,
  "µs": 1e3,
  "μs": 1e3,
  ms: 1e6,
  s: 1e9,
  m: 60e9,
  h: 3600e9,
};

const PART = /^([0-9]*(?:\.[0-9]*)?)(ns|us|µs|μs|ms|s|m|h)/;

/** Parses a Go duration string. Returns milliseconds, or undefined if invalid. */
export function parseDuration(input: string): number | undefined {
  let s = input;
  let sign = 1;
  if (s.startsWith("-") || s.startsWith("+")) {
    if (s[0] === "-") sign = -1;
    s = s.slice(1);
  }
  if (s === "0") return 0;
  if (s === "") return undefined;
  let totalNs = 0;
  while (s.length > 0) {
    const m = PART.exec(s);
    if (!m) return undefined;
    const num = m[1] ?? "";
    const unit = m[2] ?? "";
    if (num === "" || num === "." || !/[0-9]/.test(num)) return undefined;
    totalNs += Number(num) * (UNIT_NS[unit] ?? NaN);
    s = s.slice(m[0].length);
  }
  if (!Number.isFinite(totalNs)) return undefined;
  return (sign * totalNs) / 1e6;
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

/** Normalises a Go duration to its contract form, or returns undefined if invalid. */
export function canonicalDuration(input: string): string | undefined {
  const ms = parseDuration(input);
  if (ms === undefined || ms < 0) return undefined;
  return formatDuration(ms);
}
