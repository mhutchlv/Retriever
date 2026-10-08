import { runTool, type RunRecord } from "../engine/engine.ts";
import { formatCents, formatScaled, money, toCents, type Money } from "../engine/money.ts";
import type { PayrollCap } from "../engine/rules/payrollCaps.ts";
import { ruleSetFor } from "../engine/rules/registry.ts";
import type { EstimatorOutput } from "../engine/tools/auditEstimator.ts";
import type { OfficerPayrollOutput } from "../engine/tools/officerPayroll.ts";

// One audit case: a policy period being audited. Dollar amounts are held as
// decimal strings ("52340.00") and only ever summed as bigint cents. Every total
// shown in the workspace comes from engine runs over this data.

export const AUDIT_STATUSES = [
  "Assigned",
  "Scheduled",
  "Records requested",
  "Records received",
  "In review",
  "Draft ready",
  "Director review",
  "Submitted to carrier",
  "Final",
  "Waiting on insured",
  "Returned for revision",
  "Non-compliant",
  "Cancelled",
] as const;
export type AuditStatus = (typeof AUDIT_STATUSES)[number];
/** The main path, shown as the stepper. The rest are side states. */
export const MAIN_PATH: AuditStatus[] = AUDIT_STATUSES.slice(0, 9) as AuditStatus[];

export type SetBy = "penny" | "person" | "penny-for-person";

export interface Source {
  doc: string;
  page?: number;
  note?: string;
}

export interface Line {
  id: string;
  payee: string;
  title: string;
  classCode: string;
  /** Gross pay in the policy period. */
  payroll: string;
  /** Overtime premium pay (the extra half or more) included in payroll. */
  overtimePremium: string;
  /** True when records separate the premium portion, so it is left out. */
  overtimeExcluded: boolean;
  source: Source;
  setBy: SetBy;
  /** A question Penny wants a person to look at. Cleared when someone decides. */
  flag?: string;
}

export interface Officer {
  id: string;
  name: string;
  title: string;
  classCode: string;
  payroll: string;
  status: "included" | "excluded";
  source: Source;
}

export interface Sub {
  id: string;
  name: string;
  work: string;
  classCode: string;
  paid: string;
  coiExpires?: string;
  treatment: "insured" | "uninsured";
  source: Source;
}

export interface Doc {
  id: string;
  name: string;
  type: string;
  period: string;
  pages: number;
}

export interface Finding {
  id: string;
  title: string;
  detail: string;
  status: "open" | "accepted" | "rejected";
  refs: string[];
}

export interface TimelineEvent {
  seq: number;
  at: string;
  actor: string;
  via: "workspace" | "penny";
  action: string;
  summary: string;
  target?: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  reason?: string;
  /** Estimated audit premium before and after, for changes that move money. */
  premium?: { before: string; after: string };
  runId?: string;
  undoes?: number;
  prevHash: string;
  hash: string;
}

export interface Case {
  id: string;
  sample: true;
  insured: string;
  dba?: string;
  entityType: "corporation" | "llc" | "partnership" | "sole_proprietor";
  policyNumber: string;
  carrier: string;
  state: string;
  policyEffectiveDate: string;
  policyExpirationDate: string;
  status: AuditStatus;
  assignee: string;
  dueDate: string;
  auditType: "Field" | "Remote" | "Mail";
  contact: string;
  /** Description of operations for the audit report: what the business does, where and how. */
  operations: string;
  /** Rates per $100 of payroll, from the policy's declarations. */
  rates: Record<string, { rate: string; title: string }>;
  experienceMod: string;
  expenseConstant: string;
  depositPremium: string;
  /** What the insured estimated at binding, by class, for the variance view. */
  estimatedPayroll: Record<string, string>;
  lines: Line[];
  officers: Officer[];
  subs: Sub[];
  documents: Doc[];
  findings: Finding[];
  notes: { at: string; author: string; text: string }[];
  timeline: TimelineEvent[];
}

export interface ClassTotal {
  classCode: string;
  title: string;
  employees: Money;
  officers: Money;
  uninsuredSubs: Money;
  payroll: Money;
  estimated?: Money;
}

export interface LineCount {
  counted: Money;
  overtimeLeftOut: Money;
  capped: boolean;
}

export interface CaseTotals {
  byClass: ClassTotal[];
  lines: Record<string, LineCount>;
  officers: OfficerPayrollOutput;
  estimate?: EstimatorOutput;
  problems: string[];
  cap?: { perEmployee: Money; note: string };
  runs: RunRecord[];
  openFlags: number;
  openFindings: number;
}

const ZERO = 0n;
const min = (a: bigint, b: bigint) => (a < b ? a : b);

/** Engine-backed totals for a case. Pure apart from the run ids and timestamps on its receipts. */
export function computeCase(c: Case, tenant: string): CaseTotals {
  const problems: string[] = [];
  const capSet = ruleSetFor("payroll-caps", c.policyEffectiveDate);
  const capRow = capSet.status === "verified" ? (capSet.data as Record<string, PayrollCap>)[c.state] : undefined;
  const cap = capRow ? toCents(capRow.perEmployeeAnnual, "cap") : undefined;

  const byClass = new Map<string, { employees: bigint; officers: bigint; subs: bigint }>();
  const bucket = (code: string) => {
    let b = byClass.get(code);
    if (!b) byClass.set(code, (b = { employees: ZERO, officers: ZERO, subs: ZERO }));
    return b;
  };

  const lines: Record<string, LineCount> = {};
  for (const l of c.lines) {
    const gross = toCents(l.payroll, "payroll");
    const ot = l.overtimeExcluded ? toCents(l.overtimePremium, "overtimePremium") : ZERO;
    let counted = gross - ot;
    const capped = cap !== undefined && counted > cap;
    if (capped) counted = cap;
    lines[l.id] = { counted: money(counted), overtimeLeftOut: money(ot), capped };
    bucket(l.classCode).employees += counted;
  }

  const officerRun = runTool(
    "officer_payroll",
    {
      state: c.state,
      policyEffectiveDate: c.policyEffectiveDate,
      entityType: c.entityType,
      people: c.officers.length
        ? c.officers.map((o) => ({ name: o.name, actualPayroll: o.payroll, status: o.status }))
        : [{ name: "(none)", actualPayroll: "0", status: "excluded" }],
    },
    { tenant },
  );
  const officers = officerRun.output as OfficerPayrollOutput;
  c.officers.forEach((o, i) => {
    bucket(o.classCode).officers += BigInt(officers.people[i]!.countedPayroll.cents);
  });

  for (const s of c.subs) if (s.treatment === "uninsured") bucket(s.classCode).subs += toCents(s.paid, "paid");

  const codes = [...byClass.keys()].sort();
  const rated = codes.filter((code) => {
    if (c.rates[code]) return true;
    problems.push(`Class ${code} has payroll but no rate on the policy. Add the class to the policy or move the payroll.`);
    return false;
  });

  const runs: RunRecord[] = [officerRun];
  let estimate: EstimatorOutput | undefined;
  if (rated.length) {
    const est = runTool(
      "audit_bill_estimator",
      {
        state: c.state,
        policyEffectiveDate: c.policyEffectiveDate,
        lines: rated.map((code) => {
          const b = byClass.get(code)!;
          return { classCode: code, description: c.rates[code]!.title, payroll: formatPlain(b.employees + b.officers + b.subs), rate: c.rates[code]!.rate };
        }),
        experienceMod: c.experienceMod,
        expenseConstant: c.expenseConstant,
        depositPremium: c.depositPremium,
      },
      { tenant },
    );
    runs.push(est);
    estimate = est.output as EstimatorOutput;
    // The workspace applies the per-employee cap itself (see `cap`), so the
    // estimator's "enter payroll already capped" reminder doesn't apply here.
    if (capRow) estimate = { ...estimate, warnings: estimate.warnings.filter((w) => !w.startsWith(capRow.note)) };
  }

  return {
    byClass: codes.map((code) => {
      const b = byClass.get(code)!;
      const est = c.estimatedPayroll[code];
      return {
        classCode: code,
        title: c.rates[code]?.title ?? "Not on the policy",
        employees: money(b.employees),
        officers: money(b.officers),
        uninsuredSubs: money(b.subs),
        payroll: money(b.employees + b.officers + b.subs),
        ...(est ? { estimated: money(toCents(est, "estimated")) } : {}),
      };
    }),
    lines,
    officers,
    ...(estimate ? { estimate } : {}),
    problems,
    ...(cap !== undefined && capRow ? { cap: { perEmployee: money(cap), note: capRow.note } } : {}),
    runs,
    openFlags: c.lines.filter((l) => l.flag).length,
    openFindings: c.findings.filter((f) => f.status === "open").length,
  };
}

/** Cents as a plain decimal string ("1234.50") for engine input. */
export function formatPlain(cents: bigint): string {
  return formatScaled(cents, 2);
}

export const dollars = (value: string) => formatCents(toCents(value, "amount"));
