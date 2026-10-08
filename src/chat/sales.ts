import type { Lead } from "../leads/store.ts";

// The homepage chat is also Penny's salesperson. These are the demos it can run
// and the canned answers it gives when no model is configured. The facts here
// must match FACTS in knowledge.ts.

export const DEMOS = {
  audit_review: {
    title: "Audit Review: check an audit line by line",
    pitch: "Walk through a sample roofing contractor's audit: Penny explains each line, takes in two missing certificates, and recalculates the bill. The same flow powers the insured dispute portal for insurers.",
  },
  audit_ready: {
    title: "Audit Ready: get the file complete before the auditor asks",
    pitch: "See how Penny builds a sample business's document list, tracks what's in, and packages the file for the auditor.",
  },
  auditor_pro: {
    title: "PennyPro: a drafted audit worksheet for auditors",
    pitch: "Forward a sample audit's documents and see the drafted worksheet: payroll split by class, every figure tied to its source and rule.",
  },
} as const;

export type DemoId = keyof typeof DEMOS;

export function isDemoId(id: string): id is DemoId {
  return Object.hasOwn(DEMOS, id);
}

export interface SalesReply {
  reply: string;
  demo?: DemoId;
  /** Start the in-chat sign-up, with what the visitor seems interested in. */
  signup?: { interest: Lead["interest"] };
  /** Follow-up prompts to offer as chips. */
  suggestions?: string[];
}

const PRICING =
  "Here's how Penny is priced:\n\n" +
  "Free account: $0. All the free tools, saved to your own account.\n" +
  "PennyPro: $199 a month. The full audit workspace for one person, including Audit Ready and Audit Review.\n" +
  "PennyMax: $399 a month. Everything in PennyPro with a much larger monthly usage allowance.\n" +
  "Enterprise: for insurers and audit firms. Contact us for options.\n\n" +
  "Plans are monthly, not per audit. PennyPro and PennyMax users add teammates by buying extra seats. Paid plans are in early access: I can add you to the list.";

function interestFrom(lower: string): Lead["interest"] {
  if (/\b(penny ?)?max\b/.test(lower)) return "max";
  if (/\b(penny ?)?pro\b/.test(lower)) return "pro";
  if (/\bteam|\bseats?\b/.test(lower)) return "team";
  if (/ready/.test(lower)) return "audit_ready";
  if (/review|dispute/.test(lower)) return "audit_review";
  if (/partner|agency|bookkeep|accountant|white.?label|api/.test(lower)) return "partner";
  if (/enterprise/.test(lower)) return "enterprise";
  if (/insurer|carrier/.test(lower)) return "insurer_demo";
  if (/free/.test(lower)) return "free_account";
  return "other";
}

/** Sales questions the rules router answers before it looks for an audit tool. */
export function salesIntent(lower: string): SalesReply | null {
  if (/sign ?(me |us )?up|signup|register|create (an |my )?account|get started|early access|join (the )?(list|waitlist)|start (a |my )?(free|pro|max|trial)|free trial|subscribe/.test(lower)) {
    return {
      reply: "Happy to get you set up. Accounts and paid plans are in early access, so I'll take a few details and the Propono team will follow up personally. No payment needed.",
      signup: { interest: interestFrom(lower) },
    };
  }

  if (/book (an |a )?(insurer |live )?(demo|walkthrough)|request (the )?soc ?2|soc ?2 report|become a partner|talk to (a |an )?(person|human|someone|sales|rep)|speak (to|with)|contact (you|sales|the team|propono)|call me|email me|reach (you|the team)/.test(lower)) {
    return {
      reply: "I'll pass you to the team. Leave a few details and someone from Propono will reach out.",
      signup: { interest: interestFrom(lower) },
    };
  }

  if (/\bdemo\b|show me (how|what)|walk me through|see (it|penny) in action|how does (it|penny) work/.test(lower)) {
    if (/review|dispute|portal|check (an|my) audit/.test(lower)) return { reply: DEMOS.audit_review.pitch, demo: "audit_review" };
    if (/ready|prepare|checklist|before/.test(lower)) return { reply: DEMOS.audit_ready.pitch, demo: "audit_ready" };
    if (/auditor|worksheet|\bpro\b|\bmax\b/.test(lower)) return { reply: DEMOS.auditor_pro.pitch, demo: "auditor_pro" };
    if (/insurer|carrier|enterprise|director/.test(lower)) {
      return {
        reply:
          "For insurers, the interactive demos (collection, pre-build, the dispute portal and the director view) are on the For insurers page: insurers.html. The Audit Review demo here is the insured's side of the dispute portal. Want a live walkthrough with the team?",
        suggestions: ["Watch the Audit Review demo", "Book an insurer demo"],
      };
    }
    return {
      reply: "Which would you like to see?\n\n" + Object.values(DEMOS).map((d) => `${d.title}. ${d.pitch}`).join("\n\n"),
      suggestions: ["Watch the Audit Review demo", "Watch the Audit Ready demo", "Watch the PennyPro demo"],
    };
  }

  if (/pric|\bplans?\b|subscription|per seat|\bseats?\b|enterprise|\b(penny ?)?pro\b|\b(penny ?)?max\b|how much (is|does|do) (penny|it|pro|max|a plan|plans|the)|is (it|penny) free|cost of penny|penny cost/.test(lower)) {
    return { reply: PRICING, suggestions: ["Sign up for early access", "Watch a demo"] };
  }

  if (/insurer|carrier|underwriter|audit firm|enterprise|premium audit department|tpa\b/.test(lower)) {
    return {
      reply:
        "For insurers and audit firms, Penny is part of the full Propono audit system: document collection, audit pre-build, an insured dispute portal, voice and text outreach, a director console and system integrations. Fewer disputes reach your auditors, and the ones that do arrive organized. Your auditors make every final decision.\n\nSee the For insurers page (insurers.html) for interactive demos, or I can set up a walkthrough with the team.",
      suggestions: ["Watch the Audit Review demo", "Book an insurer demo"],
    };
  }

  if (/agency|agencies|\bagent\b|\bbroker|bookkeep|accountant|\bcpa\b|payroll (provider|company)|partner (program|plans?|seats?)|white.?label|\bapi\b|resell/.test(lower)) {
    return {
      reply:
        "Partners run Penny for many clients: insurance agencies, bookkeepers, accountants and payroll providers. Offer Audit Ready and Audit Review under your name, manage every client from one dashboard, or connect payroll data so audits start complete. Use PennyPro or PennyMax and add seats for your team; white-label and API are Enterprise, by conversation.",
      suggestions: ["Become a partner", "Watch the Audit Ready demo"],
    };
  }

  if (/secur|soc ?2|privacy|private|encrypt|confidential|safe|my data|store (my|the) data|keep (my|what)/.test(lower)) {
    return {
      reply:
        "Penny runs on Propono's SOC 2 Type II certified platform. Data is encrypted in transit and at rest, and each insurer's data is walled off. The free tools don't keep what you type: Penny stores only a fingerprint of each result, and you can save a receipt to verify it later. The full details are on the Data security page (security.html), what this preview collects is in the privacy policy (privacy.html), and the SOC 2 report is available under NDA through the team.",
      suggestions: ["Request the SOC 2 report", "Try a free tool"],
    };
  }

  if (/research|nsf|sbir|science|academic|provabl/.test(lower)) {
    return {
      reply:
        "Propono's research proposal to the U.S. National Science Foundation's SBIR program asks how an AI system proves which audit decisions it can take on with a dollar-based error guarantee, so review gets lighter only where the evidence earns it. The Research page (research.html) has the plan.",
    };
  }

  if (/audit review|dispute|disagree|wrong|mistake|error|too high|unfair|appeal|overcharg/.test(lower)) {
    return {
      reply:
        "Audit Review gives your audit a neutral first review: Penny checks each line against your payroll and the rules, explains every decision, flags likely errors and drafts a dispute letter. It's part of PennyPro and PennyMax, in early access. You can re-run the math now with the free estimator, or watch the demo. You keep every appeal right your state provides.",
      suggestions: ["Watch the Audit Review demo", "Estimate my audit bill", "Sign up for Audit Review"],
    };
  }

  if (/what (is|does) penny|who (are|is) (you|penny)|about penny|what can (you|penny) do|tell me about/.test(lower)) {
    return {
      reply:
        "I'm Penny, Propono's workers' comp audit helper. I show my work: every answer cites the rule and the math behind it, and the same inputs always give the same result. Right now you can use four free tools (class codes, audit bill estimates, officer payroll, document checklists) with no login. Auditors, businesses, partners and insurers each have plans in early access.",
      suggestions: ["Plans and pricing", "Watch a demo", "Look up a class code"],
    };
  }

  return null;
}
