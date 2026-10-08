import { divRound, formatScaled, InputError, money, toCents, type Money } from "../money.ts";
import type { OfficerLimits } from "../rules/officerPayroll.ts";
import type { RuleBook } from "../rules/registry.ts";
import { asArray, asObject, asOfDate, optEnum, reqString, stateCode } from "../validate.ts";
import type { NormalizedInput, Tool } from "./types.ts";

const ENTITY_TYPES = ["corporation", "llc", "partnership", "sole_proprietor"] as const;
type EntityType = (typeof ENTITY_TYPES)[number];
const STATUSES = ["included", "excluded"] as const;

interface Person {
  name: string;
  actualPayroll: string;
  status: (typeof STATUSES)[number];
}

interface Input extends NormalizedInput {
  state: string;
  entityType: EntityType;
  policyTermDays: number;
  people: Person[];
  limitsOverride?: OfficerLimits;
}

export interface OfficerPayrollOutput {
  people: { name: string; status: string; actualPayroll: Money; countedPayroll: Money; reason: string }[];
  totalCountedPayroll: Money;
  limits: { source: "state table" | "entered by user" | "none on file"; minimum?: Money; maximum?: Money; ownerAmount?: Money; proratedFor: string };
  warnings: string[];
}

const isOwnerEntity = (t: EntityType) => t === "partnership" || t === "sole_proprietor";

export const officerPayroll: Tool<Input, OfficerPayrollOutput> = {
  name: "officer_payroll",
  title: "Officer payroll calculator",
  description:
    "Work out how much officer or owner payroll counts on a workers' comp audit: excluded people count as zero, included officers are " +
    "raised to the state minimum or capped at the maximum (prorated for short policy terms), and included sole proprietors or partners " +
    "count at the state's set amount.",
  inputSchema: {
    type: "object",
    properties: {
      state: { type: "string", description: "Two-letter state code." },
      policyEffectiveDate: { type: "string", description: "Policy effective date, YYYY-MM-DD." },
      entityType: { type: "string", enum: [...ENTITY_TYPES] },
      policyTermDays: { type: "integer", description: "Length of the policy term in days. Defaults to 365." },
      people: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            actualPayroll: { type: "string", description: "Pay received during the policy period, in dollars." },
            status: { type: "string", enum: [...STATUSES], description: "Whether this person is included in coverage or excluded." },
          },
          required: ["name", "actualPayroll"],
          additionalProperties: false,
        },
      },
      limitsOverride: {
        type: "object",
        description: "The state's current limits, if the user has them from the bureau. Overrides Penny's table.",
        properties: { minAnnual: { type: "string" }, maxAnnual: { type: "string" }, ownerAnnual: { type: "string" } },
        required: ["minAnnual", "maxAnnual", "ownerAnnual"],
        additionalProperties: false,
      },
    },
    required: ["state", "entityType", "people"],
    additionalProperties: false,
  },
  ruleSets: ["officer-payroll"],

  normalize(raw) {
    const o = asObject(raw);
    const entityType = optEnum(o.entityType, "entityType", ENTITY_TYPES, "corporation");
    const defaultStatus = isOwnerEntity(entityType) ? "excluded" : "included";
    const term = o.policyTermDays ?? 365;
    if (typeof term !== "number" || !Number.isInteger(term) || term < 1 || term > 731) {
      throw new InputError("policyTermDays", "must be a whole number of days from 1 to 731");
    }
    let limitsOverride: OfficerLimits | undefined;
    if (o.limitsOverride !== undefined && o.limitsOverride !== null) {
      const l = asObject(o.limitsOverride, "limitsOverride");
      limitsOverride = {
        minAnnual: formatScaled(toCents(l.minAnnual, "limitsOverride.minAnnual"), 2),
        maxAnnual: formatScaled(toCents(l.maxAnnual, "limitsOverride.maxAnnual"), 2),
        ownerAnnual: formatScaled(toCents(l.ownerAnnual, "limitsOverride.ownerAnnual"), 2),
      };
      if (toCents(limitsOverride.minAnnual, "min") > toCents(limitsOverride.maxAnnual, "max")) {
        throw new InputError("limitsOverride", "minimum cannot be more than maximum");
      }
    }
    return {
      policyEffectiveDate: asOfDate(o.policyEffectiveDate),
      state: stateCode(o.state),
      entityType,
      policyTermDays: term,
      people: asArray(o.people, "people", { min: 1, max: 50 }).map((p, i) => {
        const person = asObject(p, `people[${i}]`);
        const pay = toCents(person.actualPayroll, `people[${i}].actualPayroll`);
        if (pay < 0n) throw new InputError(`people[${i}].actualPayroll`, "cannot be negative");
        return {
          name: reqString(person.name, `people[${i}].name`, 80),
          actualPayroll: formatScaled(pay, 2),
          status: optEnum(person.status, `people[${i}].status`, STATUSES, defaultStatus),
        };
      }),
      ...(limitsOverride ? { limitsOverride } : {}),
    };
  },

  run(input, rules) {
    const warnings: string[] = [];
    const table = rules.get<Record<string, OfficerLimits>>("officer-payroll");
    // Only verified limits are ever applied as a state's figures. Sample rows are
    // placeholders and would read as that state's real numbers, so they are not used.
    const fromTable = table.status === "verified" ? table.data[input.state] : undefined;
    const limits = input.limitsOverride ?? fromTable;
    const source = input.limitsOverride ? "entered by user" : fromTable ? "state table" : "none on file";
    if (source === "none on file") {
      warnings.push(
        `Penny hasn't loaded verified officer and owner payroll limits for ${input.state} yet, so no state minimum, maximum or owner amount is applied. Actual payroll is shown. Ask your carrier or the state's rating bureau for the current limits and enter them to apply them.`,
      );
    }
    if (input.entityType === "llc") {
      warnings.push("LLC members are treated like corporate officers here. Some states treat members like partners; check the state rule.");
    }

    const prorate = (annual: string) => divRound(toCents(annual, "limit") * BigInt(input.policyTermDays), 365n);
    const min = limits ? prorate(limits.minAnnual) : undefined;
    const max = limits ? prorate(limits.maxAnnual) : undefined;
    const owner = limits ? prorate(limits.ownerAnnual) : undefined;
    const owners = isOwnerEntity(input.entityType);

    const people = input.people.map((p) => {
      const actual = toCents(p.actualPayroll, "actualPayroll");
      let counted = actual;
      let reason = "Actual payroll counted.";
      if (p.status === "excluded") {
        counted = 0n;
        reason = owners
          ? "Owner has not elected coverage, so no payroll is counted."
          : "Excluded from coverage, so no payroll is counted. The exclusion must be on file for the policy period.";
      } else if (owners && owner !== undefined) {
        counted = owner;
        reason = "Included owners count at the state's set amount, regardless of what they drew.";
      } else if (min !== undefined && max !== undefined) {
        if (actual < min) {
          counted = min;
          reason = "Raised to the state minimum for an included officer.";
        } else if (actual > max) {
          counted = max;
          reason = "Capped at the state maximum for an included officer.";
        }
      }
      return { name: p.name, status: p.status, actualPayroll: money(actual), countedPayroll: money(counted), reason, counted };
    });

    return {
      people: people.map(({ counted: _counted, ...rest }) => rest),
      totalCountedPayroll: money(people.reduce((s, p) => s + p.counted, 0n)),
      limits: {
        source,
        ...(min !== undefined ? { minimum: money(min) } : {}),
        ...(max !== undefined ? { maximum: money(max) } : {}),
        ...(owner !== undefined ? { ownerAmount: money(owner) } : {}),
        proratedFor: `${input.policyTermDays}-day term`,
      },
      warnings,
    };
  },
};
