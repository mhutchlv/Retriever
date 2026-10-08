import { InputError } from "./money.ts";

// Small input validators. Tools normalize raw input with these before running,
// and the normalized input is what gets hashed, so defaults are recorded too.

export type Raw = Record<string, unknown>;

export function asObject(value: unknown, field = "input"): Raw {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new InputError(field, "must be an object");
  }
  return value as Raw;
}

export function asArray(value: unknown, field: string, { min = 0, max = 200 } = {}): unknown[] {
  if (!Array.isArray(value)) throw new InputError(field, "must be a list");
  if (value.length < min) throw new InputError(field, `needs at least ${min} item${min === 1 ? "" : "s"}`);
  if (value.length > max) throw new InputError(field, `allows at most ${max} items`);
  return value;
}

export function optString(value: unknown, field: string, maxLength = 200): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new InputError(field, "must be text");
  const trimmed = value.trim();
  if (trimmed.length > maxLength) throw new InputError(field, `must be ${maxLength} characters or fewer`);
  return trimmed || undefined;
}

export function reqString(value: unknown, field: string, maxLength = 200): string {
  const s = optString(value, field, maxLength);
  if (s === undefined) throw new InputError(field, "is required");
  return s;
}

export function optBool(value: unknown, field: string, fallback = false): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new InputError(field, "must be true or false");
  return value;
}

export function optEnum<T extends string>(value: unknown, field: string, allowed: readonly T[], fallback: T): T {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new InputError(field, `must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** A YYYY-MM-DD date; defaults to today (recorded in the normalized input). */
export function asOfDate(value: unknown, field = "policyEffectiveDate"): string {
  if (value === undefined || value === null || value === "") return today();
  if (typeof value !== "string" || !ISO_DATE.test(value) || Number.isNaN(Date.parse(value))) {
    throw new InputError(field, "must be a date like 2026-07-01");
  }
  return value;
}

export function stateCode(value: unknown, field = "state"): string {
  const s = reqString(value, field, 2).toUpperCase();
  if (!/^[A-Z]{2}$/.test(s)) throw new InputError(field, "must be a two-letter state code");
  return s;
}

export function classCode(value: unknown, field: string): string {
  const s = reqString(value, field, 6).replace(/\s/g, "");
  if (!/^\d{3,4}$/.test(s)) throw new InputError(field, "must be a 3 or 4 digit class code");
  return s.padStart(4, "0");
}
