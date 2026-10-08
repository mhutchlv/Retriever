import { InputError, toScaled, formatScaled } from "../engine/money.ts";
import { asArray, asObject, classCode, optString, reqString, stateCode } from "../engine/validate.ts";
import type { Case, Doc } from "./model.ts";

// A case the auditor opens by hand: the insured's contact details, the policy,
// the class codes and rates from the declarations, and any documents they
// already have. Like insured uploads, documents are recorded by name and size
// only; the preview never receives the files.

const ENTITY = ["corporation", "llc", "partnership", "sole_proprietor"] as const;
const AUDIT = ["Field", "Remote", "Mail"] as const;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const date = (v: unknown, field: string) => {
  if (typeof v !== "string" || !DATE.test(v) || Number.isNaN(Date.parse(v))) throw new InputError(field, "must be a date");
  return v;
};

export interface NewCaseInput {
  insured: string;
  entityType: Case["entityType"];
  state: string;
  policyNumber: string;
  carrier: string;
  policyEffectiveDate: string;
  policyExpirationDate: string;
  auditType: Case["auditType"];
  dueDate: string;
  contactName: string;
  contactEmail?: string;
  contactPhone?: string;
  rates: Record<string, { rate: string; title: string }>;
  files: { name: string; size: number; type: string }[];
}

export function parseNewCase(raw: unknown): NewCaseInput {
  const o = asObject(raw, "case");
  const from = date(o.policyEffectiveDate, "policyEffectiveDate");
  const to = date(o.policyExpirationDate, "policyExpirationDate");
  if (to <= from) throw new InputError("policyExpirationDate", "must be after the effective date");
  const email = optString(o.contactEmail, "contactEmail", 120);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new InputError("contactEmail", "doesn't look like an email address");
  const phone = optString(o.contactPhone, "contactPhone", 30);
  if (phone && !/^[0-9()+.\-\s]{7,30}$/.test(phone)) throw new InputError("contactPhone", "doesn't look like a phone number");
  const rates: NewCaseInput["rates"] = {};
  for (const [i, r] of (o.classes === undefined ? [] : asArray(o.classes, "classes", { max: 20 })).entries()) {
    const x = asObject(r, `classes[${i}]`);
    const code = classCode(x.code, `classes[${i}].code`);
    const rate = toScaled(x.rate, 4, `classes[${i}].rate`);
    if (rate <= 0n) throw new InputError(`classes[${i}].rate`, "must be more than zero");
    rates[code] = { rate: formatScaled(rate, 4).replace(/0{1,2}$/, ""), title: optString(x.title, `classes[${i}].title`, 120) ?? `Class ${code}` };
  }
  const files = (o.files === undefined ? [] : asArray(o.files, "files", { max: 20 })).map((f, i) => {
    const x = asObject(f, `files[${i}]`);
    const name = typeof x.name === "string" ? x.name.replace(/[\u0000-\u001f]/g, "").trim().slice(0, 150) : "";
    const size = typeof x.size === "number" && Number.isInteger(x.size) && x.size >= 0 && x.size <= 50 * 1024 * 1024 ? x.size : -1;
    if (!name) throw new InputError(`files[${i}].name`, "is required");
    if (size < 0) throw new InputError(`files[${i}].size`, "must be 50 MB or less");
    return { name, size, type: typeof x.type === "string" ? x.type.slice(0, 100) : "" };
  });
  return {
    insured: reqString(o.insured, "insured", 120),
    entityType: ENTITY.find((e) => e === o.entityType) ?? "corporation",
    state: stateCode(o.state),
    policyNumber: reqString(o.policyNumber, "policyNumber", 40),
    carrier: reqString(o.carrier, "carrier", 120),
    policyEffectiveDate: from,
    policyExpirationDate: to,
    auditType: AUDIT.find((a) => a === o.auditType) ?? "Remote",
    dueDate: date(o.dueDate, "dueDate"),
    contactName: reqString(o.contactName, "contactName", 80),
    ...(email ? { contactEmail: email } : {}),
    ...(phone ? { contactPhone: phone } : {}),
    rates,
    files,
  };
}

/** A short, readable case id: the insured's initials and the policy year. */
export function caseIdFor(insured: string, effective: string, taken: Set<string>): string {
  const initials = insured.replace(/[^A-Za-z0-9\s]/g, " ").split(/\s+/).filter(Boolean).filter((w) => !/^(inc|llc|co|corp|the|and)$/i.test(w)).map((w) => w[0]!.toUpperCase()).join("").slice(0, 4) || "CASE";
  const base = `${initials}-${effective.slice(0, 4)}`;
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

export function buildCase(input: NewCaseInput, id: string, assignee: string, uploader: string): Omit<Case, "timeline"> {
  const at = new Date().toISOString();
  const documents: Doc[] = input.files.map((f, i) => ({
    id: `D${i + 1}`,
    name: f.name,
    type: "Added at setup",
    period: "",
    uploadedBy: uploader,
    uploadedAt: at,
    size: f.size,
    fileType: f.type,
  }));
  return {
    id,
    sample: true,
    insured: input.insured,
    entityType: input.entityType,
    policyNumber: input.policyNumber,
    carrier: input.carrier,
    state: input.state,
    policyEffectiveDate: input.policyEffectiveDate,
    policyExpirationDate: input.policyExpirationDate,
    status: "Assigned",
    assignee,
    dueDate: input.dueDate,
    auditType: input.auditType,
    contact: input.contactName,
    ...(input.contactEmail ? { contactEmail: input.contactEmail } : {}),
    ...(input.contactPhone ? { contactPhone: input.contactPhone } : {}),
    operations: "",
    rates: input.rates,
    experienceMod: "1.00",
    expenseConstant: "0",
    depositPremium: "0",
    estimatedPayroll: {},
    lines: [],
    officers: [],
    subs: [],
    documents,
    findings: [],
    notes: [],
  };
}
