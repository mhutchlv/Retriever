import type { RuleSet } from "./types.ts";

export type ClassSystem = "NCCI" | "WCIRB" | "NYCIRB" | "PCRB" | "DCRB" | "STATE_FUND";

export interface Jurisdiction {
  name: string;
  /** Rating bureau or fund that governs classification in the state. */
  bureau: string;
  /** Which class code table the state's codes come from. */
  classSystem: ClassSystem;
  /** True where workers' comp is written only by a state fund. */
  monopolistic: boolean;
  note?: string;
}

const ncci = (name: string): Jurisdiction => ({ name, bureau: "NCCI", classSystem: "NCCI", monopolistic: false });
const independent = (name: string, bureau: string, classSystem: ClassSystem, note?: string): Jurisdiction => ({
  name,
  bureau,
  classSystem,
  monopolistic: false,
  ...(note ? { note } : {}),
});
const stateFund = (name: string, bureau: string): Jurisdiction => ({
  name,
  bureau,
  classSystem: "STATE_FUND",
  monopolistic: true,
  note: "Monopolistic state fund. Coverage and classification come from the state fund, not private carriers.",
});
const ncciBased = "Uses NCCI-based codes with state-specific exceptions.";

export const jurisdictions2026: RuleSet<Record<string, Jurisdiction>> = {
  id: "jurisdictions",
  version: "2026.1",
  effectiveFrom: "2026-01-01",
  status: "sample",
  source: "Bureau jurisdiction map compiled from public bureau websites; confirm before launch.",
  data: {
    AL: ncci("Alabama"),
    AK: ncci("Alaska"),
    AZ: ncci("Arizona"),
    AR: ncci("Arkansas"),
    CA: independent("California", "WCIRB California", "WCIRB", "California uses its own classification system."),
    CO: ncci("Colorado"),
    CT: ncci("Connecticut"),
    DE: independent("Delaware", "DCRB", "DCRB", "Delaware uses its own classification system."),
    DC: ncci("District of Columbia"),
    FL: ncci("Florida"),
    GA: ncci("Georgia"),
    HI: ncci("Hawaii"),
    ID: ncci("Idaho"),
    IL: ncci("Illinois"),
    IN: independent("Indiana", "ICRB", "NCCI", ncciBased),
    IA: ncci("Iowa"),
    KS: ncci("Kansas"),
    KY: ncci("Kentucky"),
    LA: ncci("Louisiana"),
    ME: ncci("Maine"),
    MD: ncci("Maryland"),
    MA: independent("Massachusetts", "WCRIBMA", "NCCI", ncciBased),
    MI: independent("Michigan", "CAOM", "NCCI", ncciBased),
    MN: independent("Minnesota", "MWCIA", "NCCI", ncciBased),
    MS: ncci("Mississippi"),
    MO: ncci("Missouri"),
    MT: ncci("Montana"),
    NE: ncci("Nebraska"),
    NV: ncci("Nevada"),
    NH: ncci("New Hampshire"),
    NJ: independent("New Jersey", "NJCRIB", "NCCI", ncciBased),
    NM: ncci("New Mexico"),
    NY: independent("New York", "NYCIRB", "NYCIRB", "New York uses its own classification system."),
    NC: independent("North Carolina", "NCRB", "NCCI", ncciBased),
    ND: stateFund("North Dakota", "WSI (North Dakota)"),
    OH: stateFund("Ohio", "Ohio BWC"),
    OK: ncci("Oklahoma"),
    OR: ncci("Oregon"),
    PA: independent("Pennsylvania", "PCRB", "PCRB", "Pennsylvania uses its own classification system."),
    RI: ncci("Rhode Island"),
    SC: ncci("South Carolina"),
    SD: ncci("South Dakota"),
    TN: ncci("Tennessee"),
    TX: ncci("Texas"),
    UT: ncci("Utah"),
    VT: ncci("Vermont"),
    VA: ncci("Virginia"),
    WA: stateFund("Washington", "Washington L&I"),
    WV: ncci("West Virginia"),
    WI: independent("Wisconsin", "WCRB", "NCCI", ncciBased),
    WY: stateFund("Wyoming", "Wyoming Workers' Compensation Division"),
  },
};
