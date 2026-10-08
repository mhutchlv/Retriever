import Anthropic from "@anthropic-ai/sdk";
import { isToolName, runTool, TOOLS, type RunRecord } from "../engine/engine.ts";
import { InputError } from "../engine/money.ts";
import type { ChatReply } from "./router.ts";

// The model reads and routes; the engine computes. Every figure Penny states
// comes from a tool result, which is logged with its rule and engine versions.

const MODEL = process.env.PENNY_MODEL ?? "claude-opus-5-5";
const MAX_TOOL_ROUNDS = 6;

const SYSTEM = `You are Penny, Propono's workers' compensation premium audit helper. Your promise is accuracy to the penny and showing your work.

How you work:
- Every number you state (premium, payroll, rates, limits, differences) must come from a tool result in this conversation. Never do arithmetic yourself and never estimate figures without a tool.
- When a tool needs facts the user has not given (payroll by class, rates from their policy, entity type), ask for exactly what is missing in one short message.
- Rates come from the user's own policy. You do not supply rates.
- If a tool result has dataStatus "sample" or warnings, tell the user plainly that the figures use sample data and need confirming.
- Explain results in plain language: what was counted, why, and what would change the outcome.

What you never do:
- Promise lower premiums or call yourself an arbiter. You give a neutral first review; the carrier and auditor make the final decision, and the business keeps every appeal right its state provides.
- Give legal advice or tell someone to withhold payment.
- Quote or paraphrase NCCI manual text beyond short class code titles.

Style: short, direct sentences. No hype. Use the user's words for their business.`;

function toolDefs(): Anthropic.Beta.BetaTool[] {
  return Object.values(TOOLS).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export function modelConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.PENNY_USE_MODEL === "1");
}

let client: Anthropic | undefined;

export async function modelChat(history: ChatTurn[], tenant: string): Promise<ChatReply> {
  client ??= new Anthropic();
  const messages: Anthropic.Beta.BetaMessageParam[] = history.map((t) => ({ role: t.role, content: t.content }));
  const runs: RunRecord[] = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium" },
      system: SYSTEM,
      tools: toolDefs(),
      messages,
    });

    if (response.stop_reason === "refusal") {
      return { reply: "I can't help with that one. I can look up class codes, estimate an audit bill, work out officer payroll, or build a document checklist.", runs, mode: "model" };
    }

    const text = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    const toolUses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");

    if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
      return { reply: text || "Done.", runs, mode: "model" };
    }

    messages.push({ role: "assistant", content: response.content });
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = toolUses.map((use) => {
      if (!isToolName(use.name)) {
        return { type: "tool_result", tool_use_id: use.id, is_error: true, content: `Unknown tool ${use.name}` };
      }
      try {
        const run = runTool(use.name, use.input, { tenant });
        runs.push(run);
        return {
          type: "tool_result",
          tool_use_id: use.id,
          content: JSON.stringify({ runId: run.runId, dataStatus: run.dataStatus, rules: run.rules, output: run.output }),
        };
      } catch (err) {
        if (err instanceof InputError) {
          return { type: "tool_result", tool_use_id: use.id, is_error: true, content: `Input problem: ${err.message}` };
        }
        throw err;
      }
    });
    messages.push({ role: "user", content: results });
  }

  return { reply: "That took more steps than expected. Could you narrow the question?", runs, mode: "model" };
}
