import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canonicalJson } from "../src/engine/canonical.ts";
import { replayRun, runTool, TOOLS } from "../src/engine/engine.ts";
import { divRound, formatCents, InputError, toScaled } from "../src/engine/money.ts";
import { ruleSetFor } from "../src/engine/rules/registry.ts";
import type { ToolName } from "../src/engine/tools/types.ts";

const tenant = "public";

const SAMPLES: Record<ToolName, unknown> = {
  class_code_lookup: { code: "9014", states: ["NV", "CA"], policyEffectiveDate: "2026-07-01" },
  audit_bill_estimator: {
    state: "NV",
    policyEffectiveDate: "2026-07-01",
    lines: [
      { classCode: "8810", payroll: "250,000", rate: "0.25" },
      { classCode: "5183", payroll: 400000, rate: 4.12 },
    ],
    experienceMod: "0.92",
    scheduleRatingPct: "-10",
    expenseConstant: "250",
    depositPremium: "12000",
  },
  officer_payroll: {
    state: "NV",
    entityType: "corporation",
    policyEffectiveDate: "2026-07-01",
    people: [{ name: "A", actualPayroll: "10000" }],
  },
  document_checklist: { entityType: "llc", usesSubcontractors: true, classCodes: ["5183", "8810"], policyEffectiveDate: "2026-07-01" },
};

describe("money", () => {
  it("parses decimals exactly and rounds half up beyond the scale", () => {
    assert.equal(toScaled("2.37", 4, "rate"), 23700n);
    assert.equal(toScaled("$1,250.005", 2, "x"), 125001n);
    assert.equal(toScaled(0.1 + 0.2, 2, "x"), 30n);
    assert.equal(toScaled("-1.005", 2, "x"), -101n);
    assert.throws(() => toScaled("abc", 2, "x"), InputError);
  });

  it("divides with half-up rounding in both signs", () => {
    assert.equal(divRound(5n, 2n), 3n);
    assert.equal(divRound(-5n, 2n), -3n);
    assert.equal(divRound(4n, 3n), 1n);
  });

  it("formats cents", () => {
    assert.equal(formatCents(123456789n), "$1,234,567.89");
    assert.equal(formatCents(-5n), "-$0.05");
  });
});

describe("one engine, one answer", () => {
  for (const name of Object.keys(SAMPLES) as ToolName[]) {
    it(`${name}: same input gives the same fingerprint and output`, () => {
      const a = runTool(name, SAMPLES[name], { tenant });
      const b = runTool(name, SAMPLES[name], { tenant: "carrier:acme" });
      assert.equal(a.fingerprint, b.fingerprint);
      assert.equal(a.outputHash, b.outputHash);
      assert.notEqual(a.runId, b.runId);
    });

    it(`${name}: normalizing twice changes nothing`, () => {
      const tool = TOOLS[name];
      const once = tool.normalize(SAMPLES[name]);
      assert.equal(canonicalJson(tool.normalize(once)), canonicalJson(once));
    });

    it(`${name}: a run replays exactly`, () => {
      const run = runTool(name, SAMPLES[name], { tenant });
      const replay = replayRun(run);
      assert.equal(replay.reproduced, true, replay.reason ?? "");
    });
  }

  it("formatting differences in the input do not change the answer", () => {
    const a = runTool("audit_bill_estimator", SAMPLES.audit_bill_estimator, { tenant });
    const b = runTool(
      "audit_bill_estimator",
      {
        ...(SAMPLES.audit_bill_estimator as object),
        lines: [
          { classCode: "8810", payroll: 250000, rate: "0.2500" },
          { classCode: "5183", payroll: "$400,000.00", rate: "4.12" },
        ],
      },
      { tenant },
    );
    assert.equal(a.inputHash, b.inputHash);
    assert.equal(a.outputHash, b.outputHash);
  });

  it("a tampered receipt does not replay", () => {
    const run = runTool("audit_bill_estimator", SAMPLES.audit_bill_estimator, { tenant });
    const tampered = structuredClone(run);
    (tampered.input as unknown as { experienceMod: string }).experienceMod = "0.500";
    const replay = replayRun(tampered);
    assert.equal(replay.reproduced, false);
    assert.match(replay.reason ?? "", /input does not match/);
  });

  it("records the rule versions in force and flags sample data", () => {
    const run = runTool("class_code_lookup", SAMPLES.class_code_lookup, { tenant });
    assert.deepEqual(
      run.rules.map((r) => r.id),
      ["class-codes", "jurisdictions"],
    );
    assert.equal(run.dataStatus, "sample");
    const checklist = runTool("document_checklist", { policyEffectiveDate: "2026-07-01" }, { tenant });
    assert.equal(checklist.rules.find((r) => r.id === "audit-checklist")?.status, "verified");
  });

  it("picks the rule set by policy effective date", () => {
    assert.equal(ruleSetFor("class-codes", "2026-03-01").version, "2026.1-seed");
    // Before the first set, the earliest set applies rather than failing.
    assert.equal(ruleSetFor("class-codes", "2019-01-01").version, "2026.1-seed");
  });
});
