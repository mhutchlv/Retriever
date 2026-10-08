import { randomUUID } from "node:crypto";
import { hashOf } from "./canonical.ts";
import { RuleBook } from "./rules/registry.ts";
import type { DataStatus, RuleRef } from "./rules/types.ts";
import { auditEstimator } from "./tools/auditEstimator.ts";
import { classCodeLookup } from "./tools/classCodeLookup.ts";
import { documentChecklist } from "./tools/documentChecklist.ts";
import { officerPayroll } from "./tools/officerPayroll.ts";
import type { NormalizedInput, Tool, ToolName } from "./tools/types.ts";
import { ENGINE_VERSION } from "./version.ts";

// One engine, one answer: a run is a pure function of (tool, normalized input,
// rule versions, engine version). Those four are fingerprinted, so the same
// fingerprint must always produce the same output hash, for any audience.

export const TOOLS: Record<ToolName, Tool<NormalizedInput, unknown>> = {
  class_code_lookup: classCodeLookup as unknown as Tool<NormalizedInput, unknown>,
  audit_bill_estimator: auditEstimator as unknown as Tool<NormalizedInput, unknown>,
  officer_payroll: officerPayroll as unknown as Tool<NormalizedInput, unknown>,
  document_checklist: documentChecklist as unknown as Tool<NormalizedInput, unknown>,
};

export function isToolName(name: string): name is ToolName {
  return Object.hasOwn(TOOLS, name);
}

export interface RunRecord {
  runId: string;
  tool: ToolName;
  /** Whose data this is. Records never cross tenants; only logic is shared. */
  tenant: string;
  engineVersion: string;
  rules: RuleRef[];
  /** "sample" when any rule set behind the result is not yet verified. */
  dataStatus: DataStatus;
  inputHash: string;
  outputHash: string;
  fingerprint: string;
  createdAt: string;
  input: NormalizedInput;
  output: unknown;
}

function fingerprintOf(tool: ToolName, engineVersion: string, rules: RuleRef[], inputHash: string): string {
  return hashOf({ tool, engineVersion, rules: rules.map((r) => `${r.id}@${r.version}`), inputHash });
}

export function runTool(name: ToolName, rawInput: unknown, opts: { tenant: string }): RunRecord {
  const tool = TOOLS[name];
  const input = tool.normalize(rawInput);
  const book = RuleBook.forDate(tool.ruleSets, input.policyEffectiveDate);
  const output = tool.run(input, book);
  const rules = book.refs();
  const inputHash = hashOf(input);
  return {
    runId: randomUUID(),
    tool: name,
    tenant: opts.tenant,
    engineVersion: ENGINE_VERSION,
    rules,
    dataStatus: rules.some((r) => r.status === "sample") ? "sample" : "verified",
    inputHash,
    outputHash: hashOf(output),
    fingerprint: fingerprintOf(name, ENGINE_VERSION, rules, inputHash),
    createdAt: new Date().toISOString(),
    input,
    output,
  };
}

export interface ReplayResult {
  runId: string;
  reproduced: boolean;
  engineVersion: { recorded: string; current: string };
  outputHash: { recorded: string; replayed: string };
  reason?: string;
}

/** Re-run a recorded run with the exact rule versions it used and compare outputs. */
export function replayRun(record: RunRecord): ReplayResult {
  const base = { runId: record.runId, engineVersion: { recorded: record.engineVersion, current: ENGINE_VERSION } };
  if (!isToolName(record.tool)) {
    return { ...base, reproduced: false, outputHash: { recorded: record.outputHash, replayed: "" }, reason: "unknown tool" };
  }
  const tool = TOOLS[record.tool];
  const input = tool.normalize(record.input);
  if (hashOf(input) !== record.inputHash) {
    return { ...base, reproduced: false, outputHash: { recorded: record.outputHash, replayed: "" }, reason: "input does not match its recorded hash" };
  }
  const output = tool.run(input, RuleBook.fromRefs(record.rules));
  const replayed = hashOf(output);
  const reproduced = replayed === record.outputHash;
  return {
    ...base,
    reproduced,
    outputHash: { recorded: record.outputHash, replayed },
    ...(reproduced
      ? {}
      : {
          reason:
            record.engineVersion === ENGINE_VERSION
              ? "output differs under the same engine version: this is a determinism bug"
              : "engine version changed since this run",
        }),
  };
}
