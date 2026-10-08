import type { Case, Doc, Finding, Line, Officer, Sub } from "./model.ts";

// SAMPLE cases for the preview workspace. Every business, person and number here
// is invented. The preview never holds client data (docs/WORKSPACE.md, "Hosting").

const line = (id: string, payee: string, title: string, classCode: string, payroll: string, doc: string, page: number, extra: Partial<Line> = {}): Line => ({
  id,
  payee,
  title,
  classCode,
  payroll,
  overtimePremium: "0.00",
  overtimeExcluded: false,
  source: { doc, page },
  setBy: "penny",
  ...extra,
});

const doc = (id: string, name: string, type: string, period: string, pages: number): Doc => ({ id, name, type, period, pages });

export interface SeedEvent {
  action: string;
  summary: string;
  actor: string;
  at: string;
}

export interface SeedCase {
  data: Omit<Case, "timeline">;
  events: SeedEvent[];
}

export function sampleCases(username: string): SeedCase[] {
  const penny = "Penny";
  return [
    {
      data: {
        id: "DRL-2026",
        sample: true,
        insured: "Desert Ridge Landscaping LLC",
        entityType: "llc",
        policyNumber: "SMP-WC-1004821",
        carrier: "Sample Mutual Insurance Co.",
        state: "NV",
        policyEffectiveDate: "2025-10-01",
        policyExpirationDate: "2026-10-01",
        status: "In review",
        assignee: username,
        dueDate: "2026-10-30",
        auditType: "Field",
        contact: "Ray Duarte, managing member",
        operations:
          "Landscape installation and maintenance for homes and small commercial properties in the Las Vegas valley: mowing, trimming, planting, irrigation installation and repair, and seasonal cleanup. Crews of two to four work from three company trucks. Paver and wall work and tree trimming are subcontracted; employees don't work in trees. One employee visits client sites to measure and quote jobs. Office staff handle scheduling, billing and bookkeeping from a leased office in Henderson.",
        rates: {
          "0042": { rate: "6.21", title: "Landscape gardening & drivers" },
          "8742": { rate: "0.48", title: "Salespersons or collectors, outside" },
          "8810": { rate: "0.22", title: "Clerical office employees NOC" },
        },
        experienceMod: "0.94",
        expenseConstant: "200",
        depositPremium: "14850",
        estimatedPayroll: { "0042": "190000", "8810": "95000" },
        lines: [
          line("L1", "Marco Alvarez", "Crew lead", "0042", "58200.00", "D1", 2, { overtimePremium: "3100.00", overtimeExcluded: true }),
          line("L2", "Jenna Ortiz", "Landscaper", "0042", "33250.00", "D1", 3, { overtimePremium: "1800.00", overtimeExcluded: true }),
          line("L3", "Devon Price", "Landscaper", "0042", "31900.00", "D1", 4, {
            overtimePremium: "2200.00",
            flag: "The register lumps Q3 overtime into regular pay, so the overtime premium can't be left out yet. Time cards for July to September would separate it.",
          }),
          line("L4", "Luis Romero", "Irrigation technician", "0042", "34600.00", "D1", 5),
          line("L5", "Sam Whitaker", "Seasonal laborer", "0042", "14300.00", "D1", 6),
          line("L6", "Priya Nair", "Office manager", "8810", "35500.00", "D1", 7),
          line("L7", "Tom Becker", "Estimator and sales", "8810", "61500.00", "D1", 8, {
            flag: "His job description and mileage log show most days at client sites selling and measuring jobs. Outside sales (8742) may fit better than clerical (8810).",
            source: { doc: "D10", page: 1, note: "Payroll register p.8; job description p.1" },
          }),
          line("L8", "Ana Ruiz", "Bookkeeper, part time", "8810", "18750.00", "D1", 9),
        ],
        officers: [
          { id: "O1", name: "Ray Duarte", title: "Managing member", classCode: "0042", payroll: "92000.00", status: "included", source: { doc: "D1", page: 10 } },
          { id: "O2", name: "Kim Duarte", title: "Manager (unpaid)", classCode: "8810", payroll: "0.00", status: "included", source: { doc: "D7", page: 1, note: "Operating agreement lists her as a manager" } },
        ] satisfies Officer[],
        subs: [
          { id: "S1", name: "Rivera Hardscape", work: "Paver patios and walls", classCode: "0042", paid: "24800.00", coiExpires: "2026-03-31", treatment: "insured", source: { doc: "D8", page: 1 } },
          { id: "S2", name: "Clearwater Tree Service", work: "Tree trimming", classCode: "0042", paid: "9600.00", coiExpires: "2027-01-15", treatment: "insured", source: { doc: "D9", page: 1 } },
        ] satisfies Sub[],
        documents: [
          doc("D1", "Payroll register, Oct 2025 to Sep 2026", "Payroll register", "10/2025-9/2026", 12),
          doc("D2", "Form 941, Q4 2025", "Form 941", "Q4 2025", 3),
          doc("D3", "Form 941, Q1 2026", "Form 941", "Q1 2026", 3),
          doc("D4", "Form 941, Q2 2026", "Form 941", "Q2 2026", 3),
          doc("D5", "Form 941, Q3 2026", "Form 941", "Q3 2026", 3),
          doc("D6", "Nevada quarterly wage reports", "State wage report", "Q4 2025-Q3 2026", 4),
          doc("D7", "General ledger, cash disbursements", "Ledger", "10/2025-9/2026", 22),
          doc("D8", "Certificate of insurance: Rivera Hardscape", "Certificate", "4/1/2025-3/31/2026", 1),
          doc("D9", "Certificate of insurance: Clearwater Tree Service", "Certificate", "1/15/2026-1/15/2027", 1),
          doc("D10", "Job description: Tom Becker", "Job description", "Current", 1),
        ],
        findings: [
          {
            id: "F1",
            title: "Rivera Hardscape's certificate lapsed March 31",
            detail: "Penny found no renewed certificate for April to September. If none arrives, the carrier's rules may treat what was paid to Rivera as payroll in 0042.",
            status: "open",
            refs: ["S1", "D8", "D7"],
          },
          {
            id: "F2",
            title: "Q3 overtime isn't separated for Devon Price",
            detail: "Only the overtime premium portion can be left out, and only when records show it. Request his Q3 time cards.",
            status: "open",
            refs: ["L3", "D1"],
          },
          {
            id: "F3",
            title: "Tom Becker may be outside sales, not clerical",
            detail: "The job description and mileage log point to 8742. Confirm his duties with Ray Duarte before moving him.",
            status: "open",
            refs: ["L7", "D10"],
          },
          {
            id: "F4",
            title: "Q2 941 wages are higher than the register",
            detail: "The Q2 941 reports more wages than the payroll register shows for April to June. Ask for the reconciliation or any off-register pay.",
            status: "open",
            refs: ["D4", "D1"],
          },
        ] satisfies Finding[],
        notes: [],
      },
      events: [
        { action: "assigned", summary: `Case assigned to ${username}`, actor: "Sample Mutual", at: "2026-10-01T15:00:00Z" },
        { action: "status", summary: "Status set to Records requested", actor: username, at: "2026-10-01T15:20:00Z" },
        { action: "documents", summary: "10 documents received from the insured", actor: "Ray Duarte", at: "2026-10-05T18:42:00Z" },
        { action: "first_pass", summary: "Penny's first pass: 8 payroll lines, 2 officers, 2 subcontractors; 2 lines flagged, 4 findings", actor: penny, at: "2026-10-05T18:51:00Z" },
        { action: "status", summary: "Status set to In review", actor: username, at: "2026-10-06T16:05:00Z" },
      ],
    },
    {
      data: {
        id: "SRR-2026",
        sample: true,
        insured: "Summit Ridge Roofing Inc.",
        entityType: "corporation",
        policyNumber: "SMP-WC-1003377",
        carrier: "Sample Mutual Insurance Co.",
        state: "AZ",
        policyEffectiveDate: "2025-09-01",
        policyExpirationDate: "2026-09-01",
        status: "Records requested",
        assignee: username,
        dueDate: "2026-11-14",
        auditType: "Remote",
        contact: "Dana Kessler, office manager",
        operations: "",
        rates: {
          "5551": { rate: "9.85", title: "Roofing: all kinds & drivers" },
          "8810": { rate: "0.18", title: "Clerical office employees NOC" },
        },
        experienceMod: "1.08",
        expenseConstant: "160",
        depositPremium: "41200",
        estimatedPayroll: { "5551": "380000", "8810": "48000" },
        lines: [
          line("L1", "Roofing crew (estimate)", "From the application", "5551", "380000.00", "D1", 2, { setBy: "person" }),
          line("L2", "Office (estimate)", "From the application", "8810", "48000.00", "D1", 2, { setBy: "person" }),
        ],
        officers: [{ id: "O1", name: "Grant Kessler", title: "President", classCode: "5551", payroll: "120000.00", status: "included", source: { doc: "D1", page: 3 } }],
        subs: [],
        documents: [doc("D1", "Policy declarations and application", "Policy", "9/1/2025-9/1/2026", 6)],
        findings: [],
        notes: [],
      },
      events: [
        { action: "assigned", summary: `Case assigned to ${username}`, actor: "Sample Mutual", at: "2026-09-08T16:00:00Z" },
        { action: "status", summary: "Status set to Records requested", actor: username, at: "2026-09-09T17:30:00Z" },
      ],
    },
    {
      data: {
        id: "BJS-2026",
        sample: true,
        insured: "Basin Janitorial Services LLC",
        entityType: "llc",
        policyNumber: "SMP-WC-1002956",
        carrier: "Sample Mutual Insurance Co.",
        state: "NV",
        policyEffectiveDate: "2025-08-01",
        policyExpirationDate: "2026-08-01",
        status: "Draft ready",
        assignee: username,
        dueDate: "2026-10-20",
        auditType: "Remote",
        contact: "Luz Herrera, owner",
        operations:
          "Commercial janitorial service for office buildings and medical offices in Reno and Sparks, done at night by crews of two or three: trash removal, vacuuming, restroom cleaning and floor care. No window washing above ground level. A supervisor rotates between sites; one scheduler works in the office.",
        rates: {
          "9014": { rate: "3.94", title: "Janitorial services by contractors & drivers" },
          "8810": { rate: "0.22", title: "Clerical office employees NOC" },
        },
        experienceMod: "1.00",
        expenseConstant: "200",
        depositPremium: "6900",
        estimatedPayroll: { "9014": "150000", "8810": "30000" },
        lines: [
          line("L1", "Rosa Medina", "Cleaner", "9014", "31200.00", "D1", 1, { setBy: "person" }),
          line("L2", "Kevin Tran", "Cleaner", "9014", "29800.00", "D1", 1, { setBy: "person" }),
          line("L3", "Maya Collins", "Cleaner", "9014", "27400.00", "D1", 2, { setBy: "person" }),
          line("L4", "Victor Salas", "Crew supervisor", "9014", "35000.00", "D1", 2, { overtimePremium: "1900.00", overtimeExcluded: true, setBy: "person" }),
          line("L5", "Erin Walsh", "Scheduler", "8810", "32600.00", "D1", 3, { setBy: "person" }),
        ],
        officers: [{ id: "O1", name: "Luz Herrera", title: "Managing member", classCode: "9014", payroll: "48000.00", status: "included", source: { doc: "D1", page: 4 } }],
        subs: [],
        documents: [
          doc("D1", "Payroll register, Aug 2025 to Jul 2026", "Payroll register", "8/2025-7/2026", 5),
          doc("D2", "Form 941s, four quarters", "Form 941", "Q3 2025-Q2 2026", 12),
          doc("D3", "Nevada quarterly wage reports", "State wage report", "Q3 2025-Q2 2026", 4),
        ],
        findings: [{ id: "F1", title: "Register matches the 941s", detail: "Wages tie to the 941s for all four quarters.", status: "accepted", refs: ["D1", "D2"] }],
        notes: [],
      },
      events: [
        { action: "assigned", summary: `Case assigned to ${username}`, actor: "Sample Mutual", at: "2026-08-12T15:00:00Z" },
        { action: "documents", summary: "3 documents received from the insured", actor: "Luz Herrera", at: "2026-09-02T20:10:00Z" },
        { action: "status", summary: "Status set to Draft ready", actor: username, at: "2026-10-02T21:45:00Z" },
      ],
    },
    {
      data: {
        id: "HEC-2026",
        sample: true,
        insured: "Highline Electric Co.",
        entityType: "corporation",
        policyNumber: "SMP-WC-1002610",
        carrier: "Sample Mutual Insurance Co.",
        state: "NV",
        policyEffectiveDate: "2025-08-15",
        policyExpirationDate: "2026-08-15",
        status: "Waiting on insured",
        assignee: username,
        dueDate: "2026-10-24",
        auditType: "Field",
        contact: "Owen Pike, controller",
        operations:
          "Electrical contractor wiring new construction and tenant improvements in commercial buildings in Las Vegas. No work on buildings over three stories and no utility line work. Office staff handle estimating, billing and payroll.",
        rates: {
          "5190": { rate: "4.37", title: "Electrical wiring within buildings & drivers" },
          "8810": { rate: "0.22", title: "Clerical office employees NOC" },
        },
        experienceMod: "0.88",
        expenseConstant: "200",
        depositPremium: "13900",
        estimatedPayroll: { "5190": "260000", "8810": "40000" },
        lines: [
          line("L1", "Electricians (Q3-Q1)", "From the register", "5190", "196400.00", "D1", 1),
          line("L2", "Office (Q3-Q1)", "From the register", "8810", "29700.00", "D1", 2),
        ],
        officers: [{ id: "O1", name: "Nadia Pike", title: "President", classCode: "5190", payroll: "64000.00", status: "excluded", source: { doc: "D3", page: 1, note: "Officer rejection on file" } }],
        subs: [],
        documents: [
          doc("D1", "Payroll register, Aug 2025 to Apr 2026", "Payroll register", "8/2025-4/2026", 6),
          doc("D2", "Form 941s, Q3 2025 to Q1 2026", "Form 941", "Q3 2025-Q1 2026", 9),
          doc("D3", "Officer rejection of coverage: Nadia Pike", "Officer form", "Policy term", 1),
        ],
        findings: [
          {
            id: "F1",
            title: "Records stop in April",
            detail: "The register and 941s end with Q1 2026. Request May to August 2026 payroll and the Q2 941 before the audit can close.",
            status: "open",
            refs: ["D1", "D2"],
          },
        ],
        notes: [],
      },
      events: [
        { action: "assigned", summary: `Case assigned to ${username}`, actor: "Sample Mutual", at: "2026-08-20T15:00:00Z" },
        { action: "documents", summary: "3 documents received from the insured", actor: "Owen Pike", at: "2026-09-18T19:00:00Z" },
        { action: "status", summary: "Status set to Waiting on insured: May to August payroll missing", actor: username, at: "2026-09-19T16:30:00Z" },
      ],
    },
  ];
}
