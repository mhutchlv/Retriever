import Anthropic from "@anthropic-ai/sdk";
import { isToolName, runTool, TOOLS, type RunRecord } from "../engine/engine.ts";
import { InputError } from "../engine/money.ts";
import { FACTS, siteText } from "./knowledge.ts";
import type { ChatReply } from "./router.ts";
import { DEMOS, isDemoId } from "./sales.ts";
import { INTERESTS } from "../leads/store.ts";

// The model reads and routes; the engine computes. Every figure Penny states
// comes from a tool result, which is logged with its rule and engine versions.

const MODEL = process.env.PENNY_MODEL ?? "claude-opus-5-5";
const MAX_TOOL_ROUNDS = 6;

const SYSTEM = `You are Penny, the chat on Penny by Propono's homepage. You do two jobs:
1. Run the free workers' comp audit tools for visitors (class codes, audit bill estimates, officer payroll, document checklists).
2. Be Penny's salesperson: answer questions about the product, plans, pricing, security and sign-up, run feature demos, and get interested visitors signed up for early access.

How you work:
- Every audit figure you state (premium, payroll, rates, limits, differences) must come from a tool result in this conversation. Never do arithmetic yourself.
- When a tool needs facts the visitor has not given (state, payroll by class, rates from their policy, entity type), ask for exactly what is missing in one short message.
- Rates come from the visitor's own policy. You do not supply rates.
- If a tool result has dataStatus "sample" or warnings, say plainly that the figures use sample data and need confirming.
- Product, pricing and policy answers come only from the Penny facts and site pages below. If something isn't there, say the team can answer and offer start_signup.
- Offer a demo when it would help someone see a feature, and call start_demo to play it in the chat. Offer start_signup when someone wants to sign up, start a plan, talk to the team, book an insurer walkthrough or request the SOC 2 report. Never ask for an email or phone number in chat; the sign-up form collects it with consent.
- Sell by being useful: understand who they are (business, auditor, agency or partner, insurer) and point them to the plan that fits. Don't push, don't pad.

Style: short, direct sentences. Plain text, no markdown headings or tables. No hype.`;

const UI_TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "start_demo",
    description:
      "Play an interactive feature demo in the chat, using sample data and the live audit engine. Demos: " +
      Object.entries(DEMOS).map(([id, d]) => `${id} (${d.title}: ${d.pitch})`).join(" "),
    input_schema: {
      type: "object",
      properties: { demo: { type: "string", enum: Object.keys(DEMOS) } },
      required: ["demo"],
      additionalProperties: false,
    },
  },
  {
    name: "start_signup",
    description:
      "Show the early-access sign-up form in the chat. Use when the visitor wants to sign up, start a plan, talk to the team, book an insurer walkthrough, or request the SOC 2 report.",
    input_schema: {
      type: "object",
      properties: { interest: { type: "string", enum: [...INTERESTS] } },
      required: ["interest"],
      additionalProperties: false,
    },
  },
];

function toolDefs(): Anthropic.Beta.BetaTool[] {
  const engine: Anthropic.Beta.BetaTool[] = Object.values(TOOLS).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
  return [...engine, ...UI_TOOLS];
}

// Stable prefix (instructions, facts, site pages) cached across visitors.
function systemBlocks(): Anthropic.Beta.BetaTextBlockParam[] {
  return [
    { type: "text", text: SYSTEM },
    { type: "text", text: `${FACTS}\n\n# Site pages\n\n${siteText()}`, cache_control: { type: "ephemeral" } },
  ];
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
  const ui: Pick<ChatReply, "demo" | "signup"> = {};

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium" },
      system: systemBlocks(),
      tools: toolDefs(),
      messages,
    });

    if (response.stop_reason === "refusal") {
      return { reply: "I can't help with that one. I can run the free audit tools, walk you through plans and pricing, or show a demo.", runs, mode: "model" };
    }

    const text = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    const toolUses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");

    if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
      return { reply: text || "Done.", runs, ...ui, mode: "model" };
    }

    messages.push({ role: "assistant", content: response.content });
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = toolUses.map((use) => {
      const args = (use.input ?? {}) as Record<string, unknown>;
      if (use.name === "start_demo") {
        if (typeof args.demo !== "string" || !isDemoId(args.demo)) {
          return { type: "tool_result", tool_use_id: use.id, is_error: true, content: "Unknown demo." };
        }
        ui.demo = args.demo;
        return { type: "tool_result", tool_use_id: use.id, content: "The demo is now playing in the chat below your message. Introduce it in one or two sentences." };
      }
      if (use.name === "start_signup") {
        const interest = INTERESTS.find((i) => i === args.interest) ?? "other";
        ui.signup = { interest };
        return { type: "tool_result", tool_use_id: use.id, content: "The sign-up form is now showing in the chat. Tell the visitor in one sentence what happens next: the team follows up personally." };
      }
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
