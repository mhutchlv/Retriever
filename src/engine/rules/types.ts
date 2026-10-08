// A rule set is a versioned, dated table the engine reads. Results record the
// exact version they used, so any past result can be reproduced exactly.

/**
 * "verified": checked against the governing bureau's published source.
 * "sample": placeholder values for development and demos. Every result built
 * on sample data says so; never present it as authoritative.
 */
export type DataStatus = "verified" | "sample";

export type RuleSetId = "jurisdictions" | "class-codes" | "officer-payroll" | "audit-checklist";

export interface RuleSet<T> {
  id: RuleSetId;
  version: string;
  /** ISO date. The set applies to policies effective on or after this date. */
  effectiveFrom: string;
  status: DataStatus;
  source: string;
  data: T;
}

export interface RuleRef {
  id: RuleSetId;
  version: string;
  status: DataStatus;
}
