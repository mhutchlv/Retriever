import { divRound, formatScaled, InputError, money, toCents, toScaled, type Money } from "../money.ts";
import type { Jurisdiction } from "../rules/jurisdictions.ts";
import type { PayrollCap } from "../rules/payrollCaps.ts";
import type { RuleBook } from "../rules/registry.ts";
import { asArray, asObject, asOfDate, classCode, optString, reqString, stateCode } from "../validate.ts";
import type { NormalizedInput, Tool } from "./types.ts";

// Rates are per $100 of payroll, 4 decimals. Experience mod 3 decimals.
// Schedule rating is a percent with 2 decimals (negative = credit).
const RATE_SCALE = 4;
const MOD_SCALE = 3;
const PCT_SCALE = 2;

interface Line {
  classCode: string;
  description?: string;
  payroll: string;
  rate: string;
}

interface Input extends NormalizedInput {
  state: string;
  lines: Line[];
  experienceMod: string;
  scheduleRatingPct: string;
  expenseConstant: string;
  otherCharges: { label: string; amount: string }[];
  depositPremium?: string;
}

export interface EstimatorOutput {
  lines: { classCode: string; description?: string; payroll: Money; rate: string; premium: Money }[];
  steps: { label: string; detail: string; amount: Money }[];
  manualPremium: Money;
  modifiedPremium: Money;
  totalAuditPremium: Money;
  comparison?: { depositPremium: Money; difference: Money; result: "additional premium" | "return premium" | "no change" };
  /** What changes the bill: premium effect of each extra $10,000 of payroll per class. */
  drivers: { classCode: string; per10kPayroll: Money }[];
  warnings: string[];
}

export const auditEstimator: Tool<Input, EstimatorOutput> = {
  name: "audit_bill_estimator",
  title: "Audit bill estimator",
  description:
    "Estimate a workers' comp audit result from payroll by class code, the policy's rates per $100 of payroll, the experience mod, " +
    "schedule rating and fixed charges. Compares to the deposit premium to show likely additional or return premium. " +
    "Rates come from the insured's own policy; Penny does not supply rates.",
  inputSchema: {
    type: "object",
    properties: {
      state: { type: "string", description: "Two-letter state code." },
      policyEffectiveDate: { type: "string", description: "Policy effective date, YYYY-MM-DD." },
      lines: {
        type: "array",
        description: "One line per class code on the policy.",
        items: {
          type: "object",
          properties: {
            classCode: { type: "string" },
            description: { type: "string" },
            payroll: { type: "string", description: "Actual payroll for the policy period in dollars, e.g. \"182500\"." },
            rate: { type: "string", description: "Rate per $100 of payroll from the policy, e.g. \"2.37\"." },
          },
          required: ["classCode", "payroll", "rate"],
          additionalProperties: false,
        },
      },
      experienceMod: { type: "string", description: "Experience modification factor, e.g. \"0.92\". Defaults to 1.00." },
      scheduleRatingPct: { type: "string", description: "Schedule rating percent; negative is a credit, e.g. \"-10\". Defaults to 0." },
      expenseConstant: { type: "string", description: "Expense constant in dollars. Defaults to 0." },
      otherCharges: {
        type: "array",
        description: "Other flat charges such as terrorism or state assessments, in dollars.",
        items: {
          type: "object",
          properties: { label: { type: "string" }, amount: { type: "string" } },
          required: ["label", "amount"],
          additionalProperties: false,
        },
      },
      depositPremium: { type: "string", description: "Estimated (deposit) premium already billed, in dollars." },
    },
    required: ["state", "lines"],
    additionalProperties: false,
  },
  ruleSets: ["jurisdictions", "payroll-caps"],

  normalize(raw) {
    const o = asObject(raw);
    const lines = asArray(o.lines, "lines", { min: 1, max: 50 }).map((l, i): Line => {
      const line = asObject(l, `lines[${i}]`);
      const payroll = toCents(line.payroll, `lines[${i}].payroll`);
      const rate = toScaled(line.rate, RATE_SCALE, `lines[${i}].rate`);
      if (payroll < 0n) throw new InputError(`lines[${i}].payroll`, "cannot be negative");
      if (rate < 0n) throw new InputError(`lines[${i}].rate`, "cannot be negative");
      const description = optString(line.description, `lines[${i}].description`, 120);
      return {
        classCode: classCode(line.classCode, `lines[${i}].classCode`),
        ...(description ? { description } : {}),
        payroll: formatScaled(payroll, 2),
        rate: formatScaled(rate, RATE_SCALE),
      };
    });
    const mod = toScaled(o.experienceMod ?? "1", MOD_SCALE, "experienceMod");
    if (mod <= 0n) throw new InputError("experienceMod", "must be greater than zero");
    const sched = toScaled(o.scheduleRatingPct ?? "0", PCT_SCALE, "scheduleRatingPct");
    if (sched < -9900n || sched > 9900n) throw new InputError("scheduleRatingPct", "must be between -99 and 99");
    const expense = toCents(o.expenseConstant ?? "0", "expenseConstant");
    const others = o.otherCharges === undefined ? [] : asArray(o.otherCharges, "otherCharges", { max: 20 });
    const deposit = o.depositPremium === undefined || o.depositPremium === "" ? undefined : toCents(o.depositPremium, "depositPremium");
    return {
      policyEffectiveDate: asOfDate(o.policyEffectiveDate),
      state: stateCode(o.state),
      lines,
      experienceMod: formatScaled(mod, MOD_SCALE),
      scheduleRatingPct: formatScaled(sched, PCT_SCALE),
      expenseConstant: formatScaled(expense, 2),
      otherCharges: others.map((c, i) => {
        const charge = asObject(c, `otherCharges[${i}]`);
        return {
          label: reqString(charge.label, `otherCharges[${i}].label`, 60),
          amount: formatScaled(toCents(charge.amount, `otherCharges[${i}].amount`), 2),
        };
      }),
      ...(deposit !== undefined ? { depositPremium: formatScaled(deposit, 2) } : {}),
    };
  },

  run(input, rules) {
    const place = rules.get<Record<string, Jurisdiction>>("jurisdictions").data[input.state];
    if (!place) throw new InputError("state", `${input.state} is not a recognized state`);
    const warnings: string[] = [];
    if (place.monopolistic) warnings.push(`${place.name} is a monopolistic state fund state; its audits follow the fund's own rules.`);
    const caps = rules.get<Record<string, PayrollCap>>("payroll-caps");
    const cap = caps.status === "verified" ? caps.data[input.state] : undefined;
    if (cap) warnings.push(`${cap.note} Enter each class's payroll with every employee already capped. (${cap.citations.join("; ")})`);

    const mod = toScaled(input.experienceMod, MOD_SCALE, "experienceMod");
    const sched = toScaled(input.scheduleRatingPct, PCT_SCALE, "scheduleRatingPct");
    const rateBase = 100n * 10n ** BigInt(RATE_SCALE);

    const lines = input.lines.map((l) => {
      const payroll = toCents(l.payroll, "payroll");
      const rate = toScaled(l.rate, RATE_SCALE, "rate");
      if (rate > 50n * 10n ** BigInt(RATE_SCALE)) {
        warnings.push(`Class ${l.classCode}: a rate of ${l.rate} is unusually high. Check that it is per $100 of payroll.`);
      }
      const premium = divRound(payroll * rate, rateBase);
      return { line: l, payroll, rate, premium };
    });

    const seen = new Set<string>();
    for (const { line } of lines) {
      if (seen.has(line.classCode)) warnings.push(`Class ${line.classCode} appears more than once; each line is rated separately.`);
      seen.add(line.classCode);
    }
    if (mod < 500n || mod > 2000n) warnings.push(`An experience mod of ${input.experienceMod} is outside the usual range. Check the mod worksheet.`);

    const manual = lines.reduce((sum, l) => sum + l.premium, 0n);
    const modified = divRound(manual * mod, 10n ** BigInt(MOD_SCALE));
    const schedAdj = divRound(modified * sched, 100n * 10n ** BigInt(PCT_SCALE));
    const expense = toCents(input.expenseConstant, "expenseConstant");
    const others = input.otherCharges.map((c) => ({ label: c.label, amount: toCents(c.amount, "amount") }));
    const total = modified + schedAdj + expense + others.reduce((s, c) => s + c.amount, 0n);

    const steps: EstimatorOutput["steps"] = [
      { label: "Manual premium", detail: "Sum of each class's payroll ÷ 100 × rate", amount: money(manual) },
      { label: "Experience mod", detail: `Manual premium × ${input.experienceMod}`, amount: money(modified) },
    ];
    if (sched !== 0n) {
      steps.push({
        label: sched < 0n ? "Schedule credit" : "Schedule debit",
        detail: `Modified premium × ${input.scheduleRatingPct}%`,
        amount: money(schedAdj),
      });
    }
    if (expense !== 0n) steps.push({ label: "Expense constant", detail: "Flat charge", amount: money(expense) });
    for (const c of others) steps.push({ label: c.label, detail: "Flat charge", amount: money(c.amount) });
    steps.push({ label: "Estimated audit premium", detail: "Total of the steps above", amount: money(total) });

    // Effect of $10,000 more payroll in each class, after mod and schedule rating.
    const tenK = 1_000_000n;
    const drivers = lines
      .map(({ line, rate }) => {
        const n = tenK * rate * mod * (100n * 10n ** BigInt(PCT_SCALE) + sched);
        const d = rateBase * 10n ** BigInt(MOD_SCALE) * 100n * 10n ** BigInt(PCT_SCALE);
        return { classCode: line.classCode, cents: divRound(n, d) };
      })
      .sort((a, b) => (b.cents > a.cents ? 1 : b.cents < a.cents ? -1 : a.classCode.localeCompare(b.classCode)))
      .map((d) => ({ classCode: d.classCode, per10kPayroll: money(d.cents) }));

    const output: EstimatorOutput = {
      lines: lines.map(({ line, payroll, premium }) => ({
        classCode: line.classCode,
        ...(line.description ? { description: line.description } : {}),
        payroll: money(payroll),
        rate: line.rate,
        premium: money(premium),
      })),
      steps,
      manualPremium: money(manual),
      modifiedPremium: money(modified),
      totalAuditPremium: money(total),
      drivers,
      warnings,
    };

    if (input.depositPremium !== undefined) {
      const deposit = toCents(input.depositPremium, "depositPremium");
      const diff = total - deposit;
      output.comparison = {
        depositPremium: money(deposit),
        difference: money(diff < 0n ? -diff : diff),
        result: diff > 0n ? "additional premium" : diff < 0n ? "return premium" : "no change",
      };
    }
    return output;
  },
};
