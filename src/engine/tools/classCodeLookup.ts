import { InputError } from "../money.ts";
import type { ClassCode, ClassCodeData } from "../rules/classCodes.ts";
import type { ClassSystem, Jurisdiction } from "../rules/jurisdictions.ts";
import type { RuleBook } from "../rules/registry.ts";
import { asArray, asObject, asOfDate, classCode, optString, stateCode } from "../validate.ts";
import type { NormalizedInput, Tool } from "./types.ts";

interface Input extends NormalizedInput {
  query?: string;
  code?: string;
  states: string[];
}

interface Match {
  system: ClassSystem;
  code: string;
  title: string;
  /** Requested states that use this system (empty when no states were given). */
  states: string[];
}

interface StateComparison {
  state: string;
  stateName: string;
  bureau: string;
  classSystem: ClassSystem;
  found: boolean;
  title?: string;
  equivalent?: { code: string; title?: string; note: string };
  note?: string;
}

export interface ClassCodeOutput {
  mode: "search" | "compare";
  matches: Match[];
  comparison?: { code: string; byState: StateComparison[] };
  notes: string[];
}

const MAX_MATCHES = 20;

export const classCodeLookup: Tool<Input, ClassCodeOutput> = {
  name: "class_code_lookup",
  title: "Class code lookup and compare",
  description:
    "Search workers' comp class codes by number or plain words (\"plumber\", \"office\"), or compare one code across states. " +
    "Shows which bureau governs each state and whether the code means the same thing there.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Words or a partial code to search for, e.g. \"janitorial\" or \"88\"." },
      code: { type: "string", description: "A specific class code to compare across states, e.g. \"8810\"." },
      states: {
        type: "array",
        items: { type: "string", description: "Two-letter state code." },
        description: "States to compare or search within. Omit to search every loaded table.",
      },
      policyEffectiveDate: { type: "string", description: "Policy effective date, YYYY-MM-DD. Defaults to today." },
    },
    additionalProperties: false,
  },
  ruleSets: ["class-codes", "jurisdictions"],

  normalize(raw) {
    const o = asObject(raw);
    const query = optString(o.query, "query", 80)?.toLowerCase();
    const code = o.code === undefined || o.code === null || o.code === "" ? undefined : classCode(o.code, "code");
    if (!query && !code) throw new InputError("query", "enter a class code or a few words to search for");
    const states = o.states === undefined ? [] : asArray(o.states, "states", { max: 51 }).map((s, i) => stateCode(s, `states[${i}]`));
    return {
      policyEffectiveDate: asOfDate(o.policyEffectiveDate),
      ...(query ? { query } : {}),
      ...(code ? { code } : {}),
      states: [...new Set(states)].sort(),
    };
  },

  run(input, rules) {
    const codes = rules.get<ClassCodeData>("class-codes").data;
    const places = rules.get<Record<string, Jurisdiction>>("jurisdictions").data;
    const notes: string[] = [];

    for (const s of input.states) {
      if (!places[s]) throw new InputError("states", `${s} is not a recognized state`);
    }

    const systemsInScope: ClassSystem[] = input.states.length
      ? [...new Set(input.states.map((s) => places[s]!.classSystem))]
      : (Object.keys(codes.systems) as ClassSystem[]);
    const statesUsing = (system: ClassSystem) => input.states.filter((s) => places[s]!.classSystem === system);

    if (input.code) {
      const code = input.code;
      const byState: StateComparison[] = input.states.map((state) => compareInState(state, code, places[state]!, codes));
      const matches: Match[] = [];
      for (const system of systemsInScope) {
        const hit = codes.systems[system]?.find((c) => c.code === code);
        if (hit) matches.push({ system, code: hit.code, title: hit.title, states: statesUsing(system) });
      }
      if (!input.states.length) notes.push("Add states to see how this code compares where you operate.");
      if (!matches.length) notes.push(`Code ${code} is not in Penny's loaded tables yet.`);
      return { mode: "compare", matches, comparison: { code, byState }, notes };
    }

    const query = input.query ?? "";
    const scored: { score: number; match: Match }[] = [];
    for (const system of systemsInScope) {
      for (const entry of codes.systems[system] ?? []) {
        const score = scoreMatch(entry, query);
        if (score > 0) scored.push({ score, match: { system, code: entry.code, title: entry.title, states: statesUsing(system) } });
      }
    }
    scored.sort((a, b) => b.score - a.score || a.match.code.localeCompare(b.match.code) || a.match.system.localeCompare(b.match.system));
    const matches = scored.slice(0, MAX_MATCHES).map((s) => s.match);
    if (!matches.length) notes.push(`No loaded class codes match "${query}". Try a broader word.`);
    if (systemsInScope.includes("STATE_FUND")) {
      notes.push("Monopolistic state fund states use the fund's own classifications, which Penny has not loaded yet.");
    }
    return { mode: "search", matches, notes };
  },
};

function compareInState(state: string, code: string, place: Jurisdiction, data: ClassCodeData): StateComparison {
  const base = { state, stateName: place.name, bureau: place.bureau, classSystem: place.classSystem };
  const table = data.systems[place.classSystem];
  if (!table) {
    return { ...base, found: false, note: place.note ?? `${place.bureau} codes are not loaded in Penny yet.` };
  }
  const hit = table.find((c) => c.code === code);
  if (hit) return { ...base, found: true, title: hit.title, ...(place.note ? { note: place.note } : {}) };

  const walk = data.crosswalks.find((w) => Object.values(w.codes).includes(code) && w.codes[place.classSystem]);
  if (walk) {
    const eqCode = walk.codes[place.classSystem]!;
    const eqTitle = table.find((c) => c.code === eqCode)?.title;
    return { ...base, found: false, equivalent: { code: eqCode, ...(eqTitle ? { title: eqTitle } : {}), note: walk.note } };
  }
  return { ...base, found: false, note: `Code ${code} is not in ${place.bureau}'s loaded table.` };
}

function scoreMatch(entry: ClassCode, query: string): number {
  if (!query) return 0;
  if (entry.code === query.padStart(4, "0") && /^\d+$/.test(query)) return 100;
  if (/^\d+$/.test(query)) return entry.code.startsWith(query) ? 80 : 0;
  const words = query.split(/\s+/).filter(Boolean);
  const title = entry.title.toLowerCase();
  let score = 0;
  for (const word of words) {
    if (entry.keywords.some((k) => k === word)) score += 30;
    else if (entry.keywords.some((k) => k.includes(word))) score += 20;
    else if (title.includes(word)) score += 10;
    else return 0;
  }
  return score;
}
