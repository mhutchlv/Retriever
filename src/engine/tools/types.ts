import type { RuleBook } from "../rules/registry.ts";
import type { RuleSetId } from "../rules/types.ts";

export type ToolName = "class_code_lookup" | "audit_bill_estimator" | "officer_payroll" | "document_checklist";

/** JSON Schema for a tool's input, shared by the HTTP API and the chat model. */
export type JsonSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};

export interface NormalizedInput {
  /** Policy effective date (YYYY-MM-DD); picks the rule versions in force. Same key as the raw input so normalizing is idempotent. */
  policyEffectiveDate: string;
}

export interface Tool<I extends NormalizedInput = NormalizedInput, O = unknown> {
  name: ToolName;
  title: string;
  /** What the tool does, written for both people and the chat model. */
  description: string;
  inputSchema: JsonSchema;
  ruleSets: RuleSetId[];
  /** Validate and apply defaults. Throws InputError on bad input. */
  normalize(raw: unknown): I;
  /** Pure function of normalized input and rules: no clock, no randomness, no I/O. */
  run(input: I, rules: RuleBook): O;
}
