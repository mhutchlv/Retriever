import type { RuleSet } from "./types.ts";

/** Facts about the business that decide which documents apply. */
export type ChecklistFact =
  | "always"
  | "subcontractors"
  | "officersOrOwners"
  | "soleProprietorOrPartnership"
  | "overtime"
  | "casualLabor"
  | "multiState"
  | "multipleClasses"
  | "construction";

export interface ChecklistItem {
  id: string;
  group: "Payroll" | "Tax filings" | "People" | "Subcontractors" | "Operations";
  label: string;
  why: string;
  when: ChecklistFact;
  priority: "required" | "recommended";
}

const item = (
  id: string,
  group: ChecklistItem["group"],
  when: ChecklistFact,
  priority: ChecklistItem["priority"],
  label: string,
  why: string,
): ChecklistItem => ({ id, group, label, why, when, priority });

export const auditChecklist2026: RuleSet<ChecklistItem[]> = {
  id: "audit-checklist",
  version: "2026.1",
  effectiveFrom: "2026-01-01",
  status: "verified",
  source: "Propono audit practice: standard records requested in a workers' comp premium audit.",
  data: [
    item("payroll-register", "Payroll", "always", "required",
      "Payroll register or journal for the full policy period, by employee",
      "The audit starts from gross wages paid during the policy period."),
    item("form-941", "Tax filings", "always", "required",
      "Federal Form 941 for every quarter the policy period touches",
      "The auditor reconciles payroll records to the wages you reported to the IRS."),
    item("state-ui", "Tax filings", "always", "required",
      "State unemployment (quarterly wage) reports",
      "A second reconciliation point, and it shows payroll by state."),
    item("w2-w3", "Tax filings", "always", "recommended",
      "W-2s and W-3 for the calendar years the policy period touches",
      "Helps resolve differences between the register and the 941s."),
    item("general-ledger", "Payroll", "always", "required",
      "General ledger or cash disbursements journal",
      "Shows payments outside payroll, such as contract and casual labor."),
    item("job-duties", "Operations", "always", "required",
      "Description of your operations and each employee's job duties",
      "Class codes follow the work people actually do, not their titles."),
    item("class-split", "Operations", "multipleClasses", "required",
      "Time records showing how employees split hours between class codes",
      "Without records, payroll can be assigned to the highest-rated class."),
    item("construction-jobs", "Operations", "construction", "recommended",
      "Job list with dates, locations and the type of work on each job",
      "Supports the construction class assigned to each job's payroll."),
    item("overtime", "Payroll", "overtime", "required",
      "Overtime records by employee, showing the premium portion of overtime pay",
      "Many states exclude the premium portion of overtime, but only when it is shown separately."),
    item("officer-list", "People", "officersOrOwners", "required",
      "List of officers or owners with titles, ownership share, duties and pay",
      "Officer payroll is counted within state minimums and maximums."),
    item("exclusion-forms", "People", "officersOrOwners", "required",
      "Copies of any officer or owner exclusion or inclusion forms on file",
      "An exclusion only applies if it was properly filed for the policy period."),
    item("owner-election", "People", "soleProprietorOrPartnership", "required",
      "Any election to cover the sole proprietor or partners",
      "Owners are usually excluded unless they elected coverage; if included, a set payroll amount applies."),
    item("form-1099", "Subcontractors", "subcontractors", "required",
      "Form 1099s issued to contractors",
      "Identifies everyone you paid outside payroll."),
    item("sub-payments", "Subcontractors", "subcontractors", "required",
      "Amounts paid to each subcontractor, with labor and materials split where invoices show it",
      "Payments to uninsured subcontractors are commonly added to your audited payroll."),
    item("sub-cois", "Subcontractors", "subcontractors", "required",
      "Certificates of insurance for every subcontractor, showing workers' comp in force for the dates they worked",
      "A valid certificate is usually what keeps a subcontractor's payments off your audit."),
    item("casual-labor", "Payroll", "casualLabor", "required",
      "Records of casual or temporary labor, and staffing agency invoices",
      "Casual labor paid outside payroll can be added to audited payroll."),
    item("multi-state", "Payroll", "multiState", "required",
      "Payroll split by state, with where each employee worked",
      "Each state's payroll is rated under that state's rules and rates."),
  ],
};
