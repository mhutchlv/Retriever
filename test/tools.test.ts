import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runTool } from "../src/engine/engine.ts";
import { InputError } from "../src/engine/money.ts";
import type { EstimatorOutput } from "../src/engine/tools/auditEstimator.ts";
import type { ClassCodeOutput } from "../src/engine/tools/classCodeLookup.ts";
import type { ChecklistOutput } from "../src/engine/tools/documentChecklist.ts";
import type { OfficerPayrollOutput } from "../src/engine/tools/officerPayroll.ts";

const tenant = "public";
const date = "2026-07-01";

describe("audit bill estimator", () => {
  const out = runTool(
    "audit_bill_estimator",
    {
      state: "NV",
      policyEffectiveDate: date,
      lines: [
        { classCode: "8810", payroll: "250000", rate: "0.25" },
        { classCode: "5183", payroll: "400000", rate: "4.12" },
      ],
      experienceMod: "0.92",
      scheduleRatingPct: "-10",
      expenseConstant: "250",
      depositPremium: "12000",
    },
    { tenant },
  ).output as EstimatorOutput;

  it("rates each class to the penny", () => {
    assert.deepEqual(out.lines.map((l) => l.premium.cents), [62500, 1648000]);
    assert.equal(out.manualPremium.cents, 1710500);
  });

  it("applies mod, schedule rating and charges in documented steps", () => {
    assert.equal(out.modifiedPremium.cents, 1573660);
    assert.deepEqual(
      out.steps.map((s) => [s.label, s.amount.cents]),
      [
        ["Manual premium", 1710500],
        ["Experience mod", 1573660],
        ["Schedule credit", -157366],
        ["Expense constant", 25000],
        ["Estimated audit premium", 1441294],
      ],
    );
    assert.equal(out.totalAuditPremium.display, "$14,412.94");
  });

  it("compares to the deposit premium", () => {
    assert.deepEqual(out.comparison, {
      depositPremium: { cents: 1200000, display: "$12,000.00" },
      difference: { cents: 241294, display: "$2,412.94" },
      result: "additional premium",
    });
  });

  it("shows what moves the bill, largest first", () => {
    assert.deepEqual(
      out.drivers.map((d) => [d.classCode, d.per10kPayroll.display]),
      [
        ["5183", "$341.14"],
        ["8810", "$20.70"],
      ],
    );
  });

  it("rejects bad input with the field named", () => {
    assert.throws(
      () => runTool("audit_bill_estimator", { state: "NV", lines: [{ classCode: "88", payroll: "1", rate: "1" }] }, { tenant }),
      (err: unknown) => err instanceof InputError && err.field === "lines[0].classCode",
    );
    assert.throws(() => runTool("audit_bill_estimator", { state: "NV", lines: [] }, { tenant }), InputError);
    assert.throws(() => runTool("audit_bill_estimator", { state: "ZZ", lines: [{ classCode: "8810", payroll: "1", rate: "1" }] }, { tenant }), InputError);
  });

  it("warns on a rate that looks like it is not per $100", () => {
    const warn = runTool(
      "audit_bill_estimator",
      { state: "NV", policyEffectiveDate: date, lines: [{ classCode: "8810", payroll: "1000", rate: "75" }] },
      { tenant },
    ).output as EstimatorOutput;
    assert.match(warn.warnings.join(" "), /unusually high/);
  });
});

describe("officer payroll", () => {
  const run = (input: Record<string, unknown>) =>
    runTool("officer_payroll", { state: "NV", policyEffectiveDate: date, ...input }, { tenant }).output as OfficerPayrollOutput;

  it("never applies sample limits as a state's figures", () => {
    const out = run({ state: "AZ", entityType: "corporation", people: [{ name: "Low", actualPayroll: "10000" }] });
    assert.equal(out.limits.source, "none on file");
    assert.equal(out.people[0]!.countedPayroll.cents, 1000000);
    assert.match(out.warnings.join(" "), /hasn't loaded verified/);
  });

  it("raises to the minimum, caps at the maximum, and zeroes exclusions", () => {
    const out = run({
      entityType: "corporation",
      limitsOverride: { minAnnual: "30000", maxAnnual: "150000", ownerAnnual: "50000" },

      people: [
        { name: "Low", actualPayroll: "10000" },
        { name: "High", actualPayroll: "400000" },
        { name: "Mid", actualPayroll: "90000" },
        { name: "Out", actualPayroll: "90000", status: "excluded" },
      ],
    });
    assert.deepEqual(
      out.people.map((p) => p.countedPayroll.cents),
      [3000000, 15000000, 9000000, 0],
    );
    assert.equal(out.totalCountedPayroll.display, "$270,000.00");
    assert.equal(out.limits.source, "entered by user");
  });

  it("prorates limits for a short term", () => {
    const out = run({ entityType: "corporation", policyTermDays: 73, limitsOverride: { minAnnual: "30000", maxAnnual: "150000", ownerAnnual: "50000" }, people: [{ name: "Low", actualPayroll: "100" }] });
    assert.equal(out.people[0]!.countedPayroll.display, "$6,000.00");
  });

  it("excludes owners unless they elected coverage, then uses the set amount", () => {
    const out = run({
      entityType: "partnership",
      limitsOverride: { minAnnual: "30000", maxAnnual: "150000", ownerAnnual: "50000" },
      people: [
        { name: "Not elected", actualPayroll: "80000" },
        { name: "Elected", actualPayroll: "5000", status: "included" },
      ],
    });
    assert.deepEqual(out.people.map((p) => p.countedPayroll.cents), [0, 5000000]);
  });

  it("uses limits the user enters over the table", () => {
    const out = run({
      entityType: "corporation",
      limitsOverride: { minAnnual: "50000", maxAnnual: "100000", ownerAnnual: "60000" },
      people: [{ name: "Low", actualPayroll: "10000" }],
    });
    assert.equal(out.limits.source, "entered by user");
    assert.equal(out.people[0]!.countedPayroll.cents, 5000000);
  });

  it("applies Nevada's verified officer limits with citations", () => {
    const out = run({
      entityType: "corporation",
      people: [
        { name: "Unpaid", actualPayroll: "0" },
        { name: "High", actualPayroll: "120000" },
        { name: "Mid", actualPayroll: "20000" },
      ],
    });
    assert.equal(out.limits.source, "state table");
    assert.deepEqual(out.people.map((p) => p.countedPayroll.cents), [600000, 3600000, 2000000]);
    assert.ok(out.stateRules?.citations.some((c) => c.startsWith("NRS 616B.624")));
  });

  it("counts a Nevada sole proprietor at the deemed wage they elected", () => {
    const base = { entityType: "sole_proprietor", people: [{ name: "Owner", actualPayroll: "80000", status: "included" }] };
    assert.equal(run(base).people[0]!.countedPayroll.display, "$3,600.00");
    assert.equal(run({ ...base, soleProprietorHigherWage: true }).people[0]!.countedPayroll.display, "$21,600.00");
  });

  it("shows actual pay for a Nevada partner, since no amount is verified", () => {
    const out = run({ entityType: "partnership", people: [{ name: "P", actualPayroll: "50000", status: "included" }] });
    assert.equal(out.people[0]!.countedPayroll.cents, 5000000);
    assert.match(out.warnings.join(" "), /verified NV amount for an included partner/);
  });

  it("says so when a state has no limits on file", () => {
    const out = run({ state: "OK", entityType: "corporation", people: [{ name: "A", actualPayroll: "12345.67" }] });
    assert.equal(out.limits.source, "none on file");
    assert.equal(out.people[0]!.countedPayroll.cents, 1234567);
  });
});

describe("Nevada payroll cap", () => {
  const estimate = (policyEffectiveDate: string) =>
    (runTool("audit_bill_estimator", { state: "NV", policyEffectiveDate, lines: [{ classCode: "8810", payroll: "100000", rate: "0.3" }] }, { tenant })
      .output as EstimatorOutput).warnings.join(" ");

  it("notes the per-employee cap in force for the policy date", () => {
    assert.match(estimate("2026-07-01"), /\$36,000 of any one employee/);
    assert.match(estimate("2026-10-01"), /\$98,433\.60/);
  });

  it("adds nothing for states without a cap", () => {
    const w = (runTool("audit_bill_estimator", { state: "AZ", policyEffectiveDate: date, lines: [{ classCode: "8810", payroll: "100000", rate: "0.3" }] }, { tenant })
      .output as EstimatorOutput).warnings;
    assert.ok(!w.some((x) => /per policy year/.test(x)));
  });
});

describe("class code lookup", () => {
  it("compares a code across states and points to the local equivalent", () => {
    const out = runTool("class_code_lookup", { code: "9014", states: ["NV", "CA", "PA", "OH"], policyEffectiveDate: date }, { tenant })
      .output as ClassCodeOutput;
    const byState = Object.fromEntries(out.comparison!.byState.map((s) => [s.state, s]));
    assert.equal(byState.NV!.found, true);
    assert.equal(byState.CA!.found, false);
    assert.equal(byState.CA!.equivalent?.code, "9008");
    assert.equal(byState.PA!.found, false);
    assert.match(byState.PA!.note ?? "", /own classification/);
    assert.equal(byState.OH!.classSystem, "STATE_FUND");
  });

  it("searches by plain words", () => {
    const out = runTool("class_code_lookup", { query: "plumber", policyEffectiveDate: date }, { tenant }).output as ClassCodeOutput;
    assert.deepEqual(
      out.matches.map((m) => `${m.system}:${m.code}`),
      ["NCCI:5183", "WCIRB:5183"],
    );
  });

  it("searches by code prefix within the states given", () => {
    const out = runTool("class_code_lookup", { query: "88", states: ["NV"], policyEffectiveDate: date }, { tenant }).output as ClassCodeOutput;
    assert.ok(out.matches.length >= 3);
    assert.ok(out.matches.every((m) => m.system === "NCCI" && m.code.startsWith("88") && m.states[0] === "NV"));
  });

  it("needs a code or a search term", () => {
    assert.throws(() => runTool("class_code_lookup", {}, { tenant }), InputError);
  });
});

describe("document checklist", () => {
  const ids = (input: Record<string, unknown>) =>
    (runTool("document_checklist", { policyEffectiveDate: date, ...input }, { tenant }).output as ChecklistOutput).groups.flatMap((g) =>
      g.items.map((i) => i.id),
    );

  it("always asks for the core payroll and tax records", () => {
    const list = ids({});
    for (const id of ["payroll-register", "form-941", "state-ui", "general-ledger", "job-duties"]) assert.ok(list.includes(id), id);
    assert.ok(!list.includes("sub-cois"));
  });

  it("adds subcontractor, construction and class-split items when they apply", () => {
    const list = ids({ usesSubcontractors: true, classCodes: ["5645", "8810"] });
    for (const id of ["sub-cois", "sub-payments", "form-1099", "construction-jobs", "class-split"]) assert.ok(list.includes(id), id);
  });

  it("asks owners for an election instead of officer exclusions", () => {
    const list = ids({ entityType: "sole_proprietor" });
    assert.ok(list.includes("owner-election"));
    assert.ok(!list.includes("officer-list"));
  });
});
