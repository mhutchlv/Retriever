// Exact decimal math for audit figures. Every dollar amount is held as integer
// cents (bigint) and every rate as a scaled integer, so results never depend on
// floating-point behavior. Rounding is half-up at each documented step.

export class InputError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = "InputError";
    this.field = field;
  }
}

const DECIMAL = /^-?\d+(\.\d+)?$/;

/**
 * Parse a decimal (string or number) into an integer scaled by 10^scale.
 * "2.37" at scale 4 -> 23700n. Digits beyond `scale` are rounded half-up.
 */
export function toScaled(value: unknown, scale: number, field: string): bigint {
  let text: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new InputError(field, "must be a finite number");
    text = String(value);
    if (/e/i.test(text)) text = value.toFixed(scale + 2);
  } else if (typeof value === "string") {
    text = value.trim().replace(/[$,\s]/g, "");
  } else {
    throw new InputError(field, "must be a number");
  }
  if (!DECIMAL.test(text)) throw new InputError(field, `"${String(value)}" is not a number`);

  const negative = text.startsWith("-");
  const [whole = "0", frac = ""] = (negative ? text.slice(1) : text).split(".");
  const kept = frac.slice(0, scale).padEnd(scale, "0");
  let scaled = BigInt(whole) * 10n ** BigInt(scale) + BigInt(kept || "0");
  const next = frac.charAt(scale);
  if (next !== "" && Number(next) >= 5) scaled += 1n;
  return negative ? -scaled : scaled;
}

export function toCents(value: unknown, field: string): bigint {
  return toScaled(value, 2, field);
}

/** Integer division rounded half away from zero. */
export function divRound(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error("division by zero");
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const q = (n * 2n + d) / (d * 2n);
  return negative ? -q : q;
}

/** Cents as a JSON-safe number. Throws if the amount is beyond safe range. */
export function centsToNumber(cents: bigint): number {
  if (cents > BigInt(Number.MAX_SAFE_INTEGER) || cents < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("amount out of range");
  }
  return Number(cents);
}

export function formatCents(cents: bigint): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const dollars = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const rest = (abs % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}$${dollars}.${rest}`;
}

/** Render a scaled integer back to a fixed-point string: (23700n, 4) -> "2.3700". */
export function formatScaled(value: bigint, scale: number): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(scale);
  const whole = (abs / base).toString();
  const frac = (abs % base).toString().padStart(scale, "0");
  return `${negative ? "-" : ""}${whole}${scale > 0 ? "." + frac : ""}`;
}

/** A money figure in API output: exact cents plus a display string. */
export interface Money {
  cents: number;
  display: string;
}

export function money(cents: bigint): Money {
  return { cents: centsToNumber(cents), display: formatCents(cents) };
}
