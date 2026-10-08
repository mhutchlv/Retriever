import type { ClassSystem } from "./jurisdictions.ts";
import type { RuleSet } from "./types.ts";

// Short code titles only. Full manual text (scopes, notes) stays out of Penny
// until the NCCI data license is signed; bureau tables replace this seed set.

export interface ClassCode {
  code: string;
  title: string;
  /** Plain-language keywords that help search ("office", "plumber"). */
  keywords: string[];
}

export interface Crosswalk {
  /** Codes that describe substantially the same work in different systems. */
  codes: Partial<Record<ClassSystem, string>>;
  note: string;
}

export interface ClassCodeData {
  systems: Partial<Record<ClassSystem, ClassCode[]>>;
  crosswalks: Crosswalk[];
}

const c = (code: string, title: string, keywords: string[]): ClassCode => ({ code, title, keywords });

export const classCodes2026: RuleSet<ClassCodeData> = {
  id: "class-codes",
  version: "2026.1-seed",
  effectiveFrom: "2026-01-01",
  status: "sample",
  source: "Seed list of common codes for development. Replace with public bureau tables (WCIRB, NYCIRB, PCRB) and licensed NCCI data.",
  data: {
    systems: {
      NCCI: [
        c("0042", "Landscape gardening & drivers", ["landscaping", "lawn", "gardener", "yard"]),
        c("3632", "Machine shop NOC", ["machinist", "fabrication", "cnc"]),
        c("5183", "Plumbing NOC & drivers", ["plumber", "plumbing", "pipes"]),
        c("5190", "Electrical wiring within buildings & drivers", ["electrician", "electrical", "wiring"]),
        c("5221", "Concrete or cement work: floors, driveways, yards or sidewalks & drivers", ["concrete", "cement", "flatwork", "driveway"]),
        c("5403", "Carpentry NOC", ["carpenter", "carpentry", "framing"]),
        c("5437", "Carpentry: installation of cabinet work or interior trim", ["cabinets", "trim", "finish carpentry"]),
        c("5474", "Painting NOC & shop operations, drivers", ["painter", "painting"]),
        c("5551", "Roofing: all kinds & drivers", ["roofer", "roofing", "roof"]),
        c("5606", "Contractor: executive supervisor or construction superintendent", ["superintendent", "supervisor", "construction manager"]),
        c("5645", "Carpentry: construction of residential dwellings not exceeding three stories", ["residential carpentry", "home builder", "framing"]),
        c("6217", "Excavation & drivers", ["excavation", "grading", "earthwork"]),
        c("7228", "Trucking: local hauling only, all employees & drivers", ["trucking", "hauling", "local delivery"]),
        c("7380", "Drivers, chauffeurs, messengers and their helpers NOC, commercial", ["driver", "delivery", "courier"]),
        c("8017", "Store: retail NOC", ["retail", "store", "shop"]),
        c("8380", "Automobile service or repair center & drivers", ["auto repair", "mechanic", "garage"]),
        c("8601", "Architect or engineer, consulting", ["architect", "engineer", "consulting"]),
        c("8742", "Salespersons or collectors, outside", ["outside sales", "sales", "salesperson"]),
        c("8810", "Clerical office employees NOC", ["clerical", "office", "admin", "bookkeeper"]),
        c("8820", "Attorney: all employees & clerical, messengers, drivers", ["attorney", "law firm", "lawyer"]),
        c("8832", "Physician & clerical", ["physician", "doctor", "medical office"]),
        c("8835", "Nursing: home health, public and traveling, all employees & drivers", ["home health", "nursing", "caregiver"]),
        c("9014", "Janitorial services by contractors & drivers", ["janitorial", "cleaning", "custodian"]),
        c("9015", "Building or property management, all other employees", ["property management", "maintenance", "building"]),
        c("9079", "Restaurant NOC", ["restaurant", "cook", "server", "kitchen"]),
        c("9083", "Restaurant: fast food", ["fast food", "quick service"]),
      ],
      WCIRB: [
        c("0042", "Landscape gardening", ["landscaping", "lawn", "gardener"]),
        c("5183", "Plumbing", ["plumber", "plumbing"]),
        c("5190", "Electrical wiring", ["electrician", "electrical"]),
        c("8017", "Stores: retail", ["retail", "store"]),
        c("8742", "Salespersons: outside", ["outside sales", "sales"]),
        c("8810", "Clerical office employees", ["clerical", "office", "admin"]),
        c("9008", "Janitorial services by contractors", ["janitorial", "cleaning"]),
        c("9079", "Restaurants", ["restaurant", "cook", "server"]),
      ],
    },
    crosswalks: [
      { codes: { NCCI: "9014", WCIRB: "9008" }, note: "Janitorial contractors use a different code in California." },
    ],
  },
};
