import { createHash } from "node:crypto";

/**
 * Deterministic JSON: object keys sorted at every level, no whitespace.
 * Two values that are equal as data always serialize to the same bytes,
 * which is what lets a run be fingerprinted and replayed.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function hashOf(value: unknown): string {
  return sha256(canonicalJson(value));
}
