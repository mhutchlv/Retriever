import { runTool, type RunRecord } from "../engine/engine.ts";
import type { Jurisdiction } from "../engine/rules/jurisdictions.ts";
import { jurisdictions2026 } from "../engine/rules/jurisdictions.ts";
import type { ToolName } from "../engine/tools/types.ts";

// Keyword router used when no model is configured. It runs a tool directly when
// the message carries enough to do so (a class code, a search term), and
// otherwise opens the right tool's form. Same engine either way.

export interface ChatReply {
  reply: string;
  runs: RunRecord[];
  /** A tool form the UI should open, optionally prefilled. */
  openTool?: { tool: ToolName; prefill?: Record<string, unknown> };
  mode: "rules" | "model";
}

const STATES: Record<string, Jurisdiction> = jurisdictions2026.data;
const NAME_TO_CODE = new Map(Object.entries(STATES).map(([code, j]) => [j.name.toLowerCase(), code]));

export function detectStates(text: string): string[] {
  const found = new Set<string>();
  for (const token of text.match(/\b[A-Z]{2}\b/g) ?? []) {
    if (STATES[token]) found.add(token);
  }
  const lower = text.toLowerCase();
  for (const [name, code] of NAME_TO_CODE) {
    if (new RegExp(`\\b${name}\\b`).test(lower)) found.add(code);
  }
  return [...found].sort();
}

const STOP = new Set(["what", "whats", "is", "the", "a", "an", "for", "class", "code", "codes", "of", "my", "i", "need", "find", "look", "up", "lookup", "search", "which", "in", "me", "show", "and", "to", "do", "use", "should", "workers", "comp", "compare"]);

export function routeMessage(message: string, tenant: string): ChatReply {
  const text = message.trim();
  const lower = text.toLowerCase();
  const states = detectStates(text);
  const code = text.match(/\b(\d{4})\b/)?.[1];

  if (code && !/\$|payroll|premium|rate|bill|estimat|owe|record|document|officer|owner/.test(lower)) {
    const run = runTool("class_code_lookup", { code, states }, { tenant });
    return {
      reply: states.length
        ? `Here is class ${code} compared across ${states.join(", ")}.`
        : `Here is class ${code}. Add states (for example "8810 in NV and CA") to compare them.`,
      runs: [run],
      mode: "rules",
    };
  }

  if (/officer|owner|partner|sole prop|llc member/.test(lower)) {
    return {
      reply: "Officer and owner payroll counts differently on an audit. Enter each person and Penny will show what counts and why.",
      runs: [],
      openTool: { tool: "officer_payroll", prefill: states[0] ? { state: states[0] } : {} },
      mode: "rules",
    };
  }

  if (/dispute|disagree|wrong|mistake|error|too high|unfair|appeal/.test(lower)) {
    return {
      reply:
        "Penny can give your audit a neutral first review. Start by re-running the math: enter the payroll and rates from your audit " +
        "and Penny will show each step. If something does not match, you will see exactly which line. You keep every appeal right your state provides.",
      runs: [],
      openTool: { tool: "audit_bill_estimator", prefill: states[0] ? { state: states[0] } : {} },
      mode: "rules",
    };
  }

  if (/estimat|bill|premium|owe|additional|return premium|refund|how much/.test(lower)) {
    return {
      reply: "Enter payroll and rates by class from your policy, and Penny will estimate the audit result step by step.",
      runs: [],
      openTool: { tool: "audit_bill_estimator", prefill: states[0] ? { state: states[0] } : {} },
      mode: "rules",
    };
  }

  if (/document|checklist|gather|records|prepare|ready|bring|send the auditor/.test(lower)) {
    return {
      reply: "Answer a few questions and Penny will list the records to gather, with why each one matters.",
      runs: [],
      openTool: { tool: "document_checklist", prefill: states[0] ? { state: states[0] } : {} },
      mode: "rules",
    };
  }

  const words = lower
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w) && !(w.length === 2 && STATES[w.toUpperCase()]) && !NAME_TO_CODE.has(w));
  if (/class|code|classif|what code/.test(lower) && words.length) {
    const query = words.join(" ");
    const run = runTool("class_code_lookup", { query, states }, { tenant });
    return { reply: `Class codes matching "${query}":`, runs: [run], mode: "rules" };
  }

  return {
    reply:
      "I can look up and compare class codes, estimate an audit bill, work out officer payroll, or build your document checklist. " +
      "Try \"class code for janitorial in CA\", \"8810 in NV and CA\", or \"what records do I need for my audit?\"",
    runs: [],
    mode: "rules",
  };
}
