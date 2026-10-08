import type { RuleSet } from "./types.ts";

export interface PayrollCap {
  /** Most payroll counted for any one employee per policy year, in dollars. */
  perEmployeeAnnual: string;
  note: string;
  citations: string[];
}

// Per-employee payroll caps. Nevada is the only NCCI state with one. The cap in
// force when the policy is issued applies for the whole term.
export const payrollCaps2026: RuleSet<Record<string, PayrollCap>> = {
  id: "payroll-caps",
  version: "2026.1",
  effectiveFrom: "2026-01-01",
  status: "verified",
  source: "NRS 616B.222 and NAC 616A.200, checked 2026-10-08.",
  data: {
    NV: {
      perEmployeeAnnual: "36000",
      note: "Nevada counts no more than $36,000 of any one employee's pay per policy year for policies issued before October 1, 2026.",
      citations: ["NRS 616B.222", "NAC 616A.200"],
    },
  },
};

export const payrollCaps2026Oct: RuleSet<Record<string, PayrollCap>> = {
  id: "payroll-caps",
  version: "2026.2",
  effectiveFrom: "2026-10-01",
  status: "verified",
  source: "NRS 616B.222 as amended by SB 317 (2025); NCCI circular FYI-DR-NV-2026-01, checked 2026-10-08.",
  data: {
    NV: {
      perEmployeeAnnual: "98433.60",
      note:
        "Nevada counts no more than $98,433.60 of any one employee's pay per policy year for policies issued on or after October 1, 2026 (12 times the $8,202.80 maximum average monthly wage). The Administrator resets it each January 1. Employees of the State and local governments stay at $36,000.",
      citations: ["NRS 616B.222 (SB 317, 2025)", "NCCI FYI-DR-NV-2026-01"],
    },
  },
};
