import { auditChecklist2026 } from "./checklist.ts";
import { classCodes2026 } from "./classCodes.ts";
import { jurisdictions2026 } from "./jurisdictions.ts";
import { officerPayroll2026, officerPayroll2026v2 } from "./officerPayroll.ts";
import { payrollCaps2026, payrollCaps2026Oct } from "./payrollCaps.ts";
import type { RuleRef, RuleSet, RuleSetId } from "./types.ts";

// Every version ever shipped stays in this list. Results are reproduced by
// looking up the exact version they recorded, so old versions are never edited
// or removed; corrections ship as a new version.
// When two versions share an effective date, the one listed later wins.
const ALL: RuleSet<unknown>[] = [
  jurisdictions2026,
  classCodes2026,
  officerPayroll2026,
  officerPayroll2026v2,
  auditChecklist2026,
  payrollCaps2026,
  payrollCaps2026Oct,
];

function versionsOf(id: RuleSetId): RuleSet<unknown>[] {
  return ALL.filter((s) => s.id === id).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
}

/** The rule set in force for a policy effective on `asOfDate` (YYYY-MM-DD). */
export function ruleSetFor(id: RuleSetId, asOfDate: string): RuleSet<unknown> {
  const candidates = versionsOf(id);
  const inForce = candidates.filter((s) => s.effectiveFrom <= asOfDate);
  const chosen = inForce.at(-1) ?? candidates[0];
  if (!chosen) throw new Error(`no rule set registered for ${id}`);
  return chosen;
}

export function ruleSetVersion(id: RuleSetId, version: string): RuleSet<unknown> {
  const found = ALL.find((s) => s.id === id && s.version === version);
  if (!found) throw new Error(`rule set ${id}@${version} is not registered`);
  return found;
}

/** The resolved rule sets one run reads. */
export class RuleBook {
  private readonly sets: Map<RuleSetId, RuleSet<unknown>>;

  constructor(sets: RuleSet<unknown>[]) {
    this.sets = new Map(sets.map((s) => [s.id, s]));
  }

  static forDate(ids: RuleSetId[], asOfDate: string): RuleBook {
    return new RuleBook(ids.map((id) => ruleSetFor(id, asOfDate)));
  }

  static fromRefs(refs: RuleRef[]): RuleBook {
    return new RuleBook(refs.map((r) => ruleSetVersion(r.id, r.version)));
  }

  get<T>(id: RuleSetId): RuleSet<T> {
    const set = this.sets.get(id);
    if (!set) throw new Error(`rule set ${id} was not resolved for this run`);
    return set as RuleSet<T>;
  }

  refs(): RuleRef[] {
    return [...this.sets.values()]
      .map((s) => ({ id: s.id, version: s.version, status: s.status }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }
}
