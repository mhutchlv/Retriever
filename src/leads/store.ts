import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { InputError } from "../engine/money.ts";
import { asObject, optEnum, optString, reqString } from "../engine/validate.ts";

// Early-access sign-ups from the homepage chat. Kept apart from the run log:
// these are contact details people chose to give, stored under their consent.

export const ROLES = ["business", "auditor", "agency_or_partner", "insurer", "other"] as const;
export const INTERESTS = ["free_account", "pro", "max", "team", "enterprise", "audit_ready", "audit_review", "partner", "insurer_demo", "other"] as const;

export interface Lead {
  leadId: string;
  name: string;
  email: string;
  role: (typeof ROLES)[number];
  interest: (typeof INTERESTS)[number];
  company?: string;
  notes?: string;
  source: "homepage_chat";
  createdAt: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function normalizeLead(raw: unknown): Omit<Lead, "leadId" | "createdAt" | "source"> {
  const o = asObject(raw);
  const email = reqString(o.email, "email", 200).toLowerCase();
  if (!EMAIL.test(email)) throw new InputError("email", "doesn't look like an email address");
  if (o.consent !== true) throw new InputError("consent", "we need your OK to contact you");
  const company = optString(o.company, "company", 120);
  const notes = optString(o.notes, "notes", 1000);
  return {
    name: reqString(o.name, "name", 120),
    email,
    role: optEnum(o.role, "role", ROLES, "other"),
    interest: optEnum(o.interest, "interest", INTERESTS, "other"),
    ...(company ? { company } : {}),
    ...(notes ? { notes } : {}),
  };
}

export interface LeadSink {
  add(raw: unknown): Lead;
}

export class MemoryLeadSink implements LeadSink {
  readonly leads: Lead[] = [];

  add(raw: unknown): Lead {
    const lead: Lead = { leadId: randomUUID(), ...normalizeLead(raw), source: "homepage_chat", createdAt: new Date().toISOString() };
    this.leads.push(lead);
    this.notify(lead);
    return lead;
  }

  protected notify(_lead: Lead): void {}
}

/**
 * JSON Lines file, plus an optional webhook (a Teams or Power Automate HTTP
 * trigger, a CRM intake URL) so the team hears about each sign-up right away.
 */
export class FileLeadSink extends MemoryLeadSink {
  private readonly path: string;
  private readonly webhook: string | undefined;

  constructor(path: string, webhook?: string) {
    super();
    this.path = path;
    this.webhook = webhook || undefined;
    mkdirSync(dirname(path), { recursive: true });
  }

  protected override notify(lead: Lead): void {
    appendFileSync(this.path, JSON.stringify(lead) + "\n");
    if (!this.webhook) return;
    fetch(this.webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: `New Penny early-access sign-up: ${lead.name} (${lead.role}) wants ${lead.interest}.`,
        lead,
      }),
    }).catch((err) => console.error("lead webhook failed", err));
  }
}
