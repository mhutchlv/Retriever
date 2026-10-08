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

/** A state's officer and owner rules, checked against the statute or bureau filing cited. */
export interface StateOwnerRules {
  /** Payroll counted for an included officer (or LLC manager) per policy year, in dollars. */
  officerMinAnnual: string;
  officerMaxAnnual: string;
  /** Payroll counted for a sole proprietor who elected coverage, per policy year. */
  soleProprietorAnnual?: string;
  /** Higher amount a sole proprietor can elect by paying extra premium, per policy year. */
  soleProprietorHigherAnnual?: string;
  /** Payroll counted for a partner who elected coverage. Left out when not verified. */
  partnerAnnual?: string;
  /** True when the state treats LLC managers like corporate officers. */
  llcManagersAsOfficers?: boolean;
  /** Short facts to pass on with every result for this state. */
  notes: string[];
  citations: string[];
}

// Verified rows only. A state is added here once each figure is checked against
// its statute or bureau filing, with the citation kept beside it.
export const officerPayroll2026v2: RuleSet<Record<string, StateOwnerRules>> = {
  id: "officer-payroll",
  version: "2026.2",
  effectiveFrom: "2026-01-01",
  status: "verified",
  source: "Nevada statutes, checked 2026-10-08 at leg.state.nv.us.",
  data: {
    NV: {
      officerMinAnnual: "6000",
      officerMaxAnnual: "36000",
      soleProprietorAnnual: "3600",
      soleProprietorHigherAnnual: "21600",
      llcManagersAsOfficers: true,
      notes: [
        "Nevada counts a paid officer or LLC manager at no less than $6,000 and no more than $36,000 per policy year; an unpaid one is counted at $6,000.",
        "Officers and managers are covered unless they reject coverage in writing to the insurer (an unpaid one also notifies the company).",
        "A sole proprietor is covered only by electing it in writing with the Administrator and the carrier, and is counted at $300 a month, or $1,800 a month if they elected the higher amount and paid the extra premium at least 90 days before an injury.",
        "Penny hasn't verified a Nevada set amount for partners or for LLC members who aren't managers.",
      ],
      citations: ["NRS 616B.624 (officers and LLC managers)", "NRS 616B.659 (sole proprietors)"],
    },
  },
};

// The same Nevada rows for policies effective in 2025. NRS 616B.624 and 616B.659
// set these amounts long before 2025 and were unchanged by SB 317.
export const officerPayroll2025: RuleSet<Record<string, StateOwnerRules>> = {
  ...officerPayroll2026v2,
  version: "2025.1",
  effectiveFrom: "2025-01-01",
};
