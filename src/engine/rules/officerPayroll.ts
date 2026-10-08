import type { RuleSet } from "./types.ts";

export interface OfficerLimits {
  /** Annual minimum payroll counted for an included officer, in dollars. */
  minAnnual: string;
  /** Annual maximum payroll counted for an included officer, in dollars. */
  maxAnnual: string;
  /** Payroll counted for an included sole proprietor or partner, in dollars per year. */
  ownerAnnual: string;
}

// SAMPLE figures only: round placeholders so the calculator can be built and
// demoed. Each state's real limits change yearly; load them from the bureau's
// filing before any result is shown as authoritative.
export const officerPayroll2026: RuleSet<Record<string, OfficerLimits>> = {
  id: "officer-payroll",
  version: "2026.1-sample",
  effectiveFrom: "2026-01-01",
  status: "sample",
  source: "Placeholder values. Replace with each bureau's current executive officer payroll limits.",
  data: {
    AZ: { minAnnual: "30000", maxAnnual: "150000", ownerAnnual: "50000" },
    CA: { minAnnual: "65000", maxAnnual: "260000", ownerAnnual: "65000" },
    NV: { minAnnual: "30000", maxAnnual: "150000", ownerAnnual: "50000" },
    TX: { minAnnual: "30000", maxAnnual: "150000", ownerAnnual: "50000" },
    UT: { minAnnual: "30000", maxAnnual: "150000", ownerAnnual: "50000" },
  },
};
