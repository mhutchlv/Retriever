import type { ChecklistFact, ChecklistItem } from "../rules/checklist.ts";
import type { Jurisdiction } from "../rules/jurisdictions.ts";
import type { RuleBook } from "../rules/registry.ts";
import { asArray, asObject, asOfDate, classCode, optBool, optEnum, stateCode } from "../validate.ts";
import type { NormalizedInput, Tool } from "./types.ts";

const ENTITY_TYPES = ["corporation", "llc", "partnership", "sole_proprietor"] as const;
const AUDIT_TYPES = ["physical", "phone_or_mail", "unknown"] as const;

interface Input extends NormalizedInput {
  state?: string;
  entityType: (typeof ENTITY_TYPES)[number];
  auditType: (typeof AUDIT_TYPES)[number];
  usesSubcontractors: boolean;
  hasOfficersOrOwners: boolean;
  hasOvertime: boolean;
  hasCasualLabor: boolean;
  multiState: boolean;
  classCodes: string[];
}

export interface ChecklistOutput {
  groups: { group: ChecklistItem["group"]; items: { id: string; label: string; why: string; priority: ChecklistItem["priority"] }[] }[];
  counts: { required: number; recommended: number };
  tips: string[];
}

const GROUP_ORDER: ChecklistItem["group"][] = ["Payroll", "Tax filings", "People", "Subcontractors", "Operations"];

/** Construction and erection codes sit in the 5000-6999 range in NCCI-based tables. */
const isConstruction = (code: string) => Number(code) >= 5000 && Number(code) <= 6999;

export const documentChecklist: Tool<Input, ChecklistOutput> = {
  name: "document_checklist",
  title: "Audit document checklist",
  description:
    "List the records a business should gather for its workers' comp premium audit, based on its entity type, class codes, " +
    "and whether it uses subcontractors, pays overtime, uses casual labor, or works in more than one state. Each item says why it matters.",
  inputSchema: {
    type: "object",
    properties: {
      state: { type: "string", description: "Two-letter state code of the main state." },
      policyEffectiveDate: { type: "string", description: "Policy effective date, YYYY-MM-DD." },
      entityType: { type: "string", enum: [...ENTITY_TYPES] },
      auditType: { type: "string", enum: [...AUDIT_TYPES], description: "How the audit is being done, if known." },
      usesSubcontractors: { type: "boolean" },
      hasOfficersOrOwners: { type: "boolean", description: "Whether officers, members, partners or owners work in the business." },
      hasOvertime: { type: "boolean" },
      hasCasualLabor: { type: "boolean", description: "Temporary, casual or staffing-agency labor." },
      multiState: { type: "boolean", description: "Employees worked in more than one state." },
      classCodes: { type: "array", items: { type: "string" }, description: "Class codes on the policy." },
    },
    additionalProperties: false,
  },
  ruleSets: ["audit-checklist", "jurisdictions"],

  normalize(raw) {
    const o = asObject(raw);
    const codes = o.classCodes === undefined ? [] : asArray(o.classCodes, "classCodes", { max: 30 }).map((c, i) => classCode(c, `classCodes[${i}]`));
    return {
      policyEffectiveDate: asOfDate(o.policyEffectiveDate),
      ...(o.state ? { state: stateCode(o.state) } : {}),
      entityType: optEnum(o.entityType, "entityType", ENTITY_TYPES, "corporation"),
      auditType: optEnum(o.auditType, "auditType", AUDIT_TYPES, "unknown"),
      usesSubcontractors: optBool(o.usesSubcontractors, "usesSubcontractors"),
      hasOfficersOrOwners: optBool(o.hasOfficersOrOwners, "hasOfficersOrOwners", true),
      hasOvertime: optBool(o.hasOvertime, "hasOvertime"),
      hasCasualLabor: optBool(o.hasCasualLabor, "hasCasualLabor"),
      multiState: optBool(o.multiState, "multiState"),
      classCodes: [...new Set(codes)].sort(),
    };
  },

  run(input, rules) {
    const items = rules.get<ChecklistItem[]>("audit-checklist").data;
    const owners = input.entityType === "partnership" || input.entityType === "sole_proprietor";
    const facts: Record<ChecklistFact, boolean> = {
      always: true,
      subcontractors: input.usesSubcontractors,
      officersOrOwners: input.hasOfficersOrOwners && !owners,
      soleProprietorOrPartnership: owners,
      overtime: input.hasOvertime,
      casualLabor: input.hasCasualLabor,
      multiState: input.multiState,
      multipleClasses: input.classCodes.length > 1,
      construction: input.classCodes.some(isConstruction),
    };

    const applicable = items.filter((i) => facts[i.when]);
    const groups = GROUP_ORDER.map((group) => ({
      group,
      items: applicable.filter((i) => i.group === group).map(({ id, label, why, priority }) => ({ id, label, why, priority })),
    })).filter((g) => g.items.length);

    const tips: string[] = [];
    if (input.auditType === "physical") tips.push("For an in-person audit, have the originals ready where the auditor will work.");
    if (input.auditType === "phone_or_mail") tips.push("For a phone or mail audit, send copies by the due date and keep a record of what you sent.");
    tips.push("Cover the full policy period, not the calendar year. Policy periods often span two tax years.");
    if (input.state) {
      const place = rules.get<Record<string, Jurisdiction>>("jurisdictions").data[input.state];
      if (place?.monopolistic) tips.push(`${place.name} coverage runs through ${place.bureau}; follow its reporting instructions.`);
    }

    return {
      groups,
      counts: {
        required: applicable.filter((i) => i.priority === "required").length,
        recommended: applicable.filter((i) => i.priority === "recommended").length,
      },
      tips,
    };
  },
};
