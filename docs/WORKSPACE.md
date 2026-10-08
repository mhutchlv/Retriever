# Penny workspace: signed-in product design

One workspace for everyone who touches a premium audit. It adapts to who is signed in, keeps every document and figure for a case in one place, and keeps Penny in view at all times. Penny answers audit questions, explains the app, and makes changes to the audit when asked. Every change is recorded.

This document is the design target for Phases 2 to 4 in `docs/BUILD-PLAN.md`. The engine rules in `CLAUDE.md` still hold: every figure comes from an engine run, money is bigint cents, rule versions are never edited.

## Who uses it

| Role | Plan | What they come to do |
| --- | --- | --- |
| Premium auditor (staff or contract) | Pro, Max, carrier seat | Work an assigned list of audits from records request to final report; check and correct Penny's first pass; produce the worksheet and report the carrier needs. |
| Audit director / audit manager | Carrier enterprise (Director dashboard) | See every audit and dispute across the team, assign work, review and approve, watch aging, quality and the share cleared without changes. |
| Insurance agency / bookkeeper | Partner seat | Prepare many clients for their audits, track each client's status, review final bills, start a dispute for a client. |
| Small business owner | Audit Ready, Audit Review | Get ready for one audit, upload records, understand the final bill line by line, accept it or dispute specific lines. |

A person can hold more than one role (an agency that is also a business owner, a director who also audits). The role is chosen per workspace, not per login.

## Layout: chat-forward, one screen

```
+--------------------------------------------------------------------------------+
| Penny   [Workspace: Acme Audits v]   Search cases, people, docs      ? (help)  |
+---------------+-------------------------------------------+--------------------+
| My work       |  Case: Townsend Maintenance  10/21/25-26   |  Penny             |
|  Due this wk 4|  Status: In review  [Next: Draft report]   |                    |
|  In review   7|  ---------------------------------------- |  "Why did you put  |
|  Waiting on  3|  Tabs: Overview | Worksheet | Documents   |   Ana Ruiz in 9014?"|
|   records     |        | Findings | Disputes | Timeline   |                    |
|  Disputes    2|        | Reports                          |  Because her pay   |
|               |                                           |  stub and job desc |
| Cases (list,  |  [the selected tab's content: tables,     |  (doc 3, p.2) say  |
|  filters,     |   document viewer with highlights,        |  ... [Show source] |
|  saved views) |   change history]                         |                    |
|               |                                           |  [Move to 9015]    |
| Reports       |                                           |  [Keep as is]      |
| Templates     |                                           |                    |
| Settings      |                                           |  Type a request... |
+---------------+-------------------------------------------+--------------------+
```

- **Penny panel is always open** on the right (bottom sheet on phones, where chat is the main view). It knows the current case, tab and selection, so "move these three to 5645" works on whatever rows are selected.
- **The center panel shows the work**, so every answer Penny gives can point at a line, a document page or a timeline entry, and the user sees the change happen.
- **The left rail is the work queue** and changes by role (see below).
- Sentence case labels; Propono brand; keyboard shortcuts for auditors who live in the worksheet.

## The case: what a single audit holds

| Object | What it is |
| --- | --- |
| Case | One policy period being audited: insured, policy, carrier, states, dates, assigned people, status, due dates. |
| Parties | Insured, carrier, agency, auditor, director, bookkeeper, with their access. |
| Documents | Every file (payroll registers, 941/940, state wage reports, ledgers, COIs, policy, prior audits, correspondence). Versioned, tagged by type and period, SSNs redacted on upload. |
| Extractions | Structured data read from documents, each value cited to document, page and region. Claude reads; the engine never trusts an uncited value. |
| Worksheet | Lines of exposure: employee or payee, state, class code, period, payroll or other base, inclusions and exclusions, officer limits, subcontractor treatment. Every total is an engine run. |
| Findings | Issues with a dollar effect: uninsured subs, overtime not separated, officer outside limits, class mismatch, missing records. Each finding cites evidence and the rule version used. |
| Disputes | A business or agency challenge to specific lines, with evidence, Penny's neutral first review, the auditor's decision, and the regenerated result. |
| Runs | Every engine run for the case, with fingerprint, rule versions and Verify. |
| Timeline | The full, append-only history of the case: every status change, edit, upload, message, approval and export. |
| Reports | Generated work product, each tied to the exact case version it was produced from. |

## Status tracking

One status model per case, shown as a stepper with the next action called out. Statuses are configurable per carrier, with these defaults.

**Audit (auditor, director):** Assigned → Scheduled → Records requested → Records received → In review → Draft ready → Director review (optional) → Submitted to carrier → Final. Side states: Waiting on insured, Returned for revision, Non-compliant (no records), Cancelled.

**Business side (owner, agency, bookkeeper):** Audit notice received → Gathering records (checklist) → Ready for auditor → Audit in progress → Bill received → Reviewing → Accepted, or Disputed → Under auditor review → Resolved.

**Disputes (per line):** Raised → Penny's first review → Waiting on evidence → With auditor → Approved, Denied or Partly approved → Bill regenerated.

Every status change is a timeline event with who, when and why. Due dates and aging drive the work queue and the director's dashboard.

## Reviewing and editing Penny's output

Penny does the first pass; a person owns the result.

- **Every line shows where it came from:** the source document and page, the rule version, and whether it was set by Penny's extraction, by a person, or by Penny at a person's request.
- **Confidence and review flags:** lines Penny is less sure of (low-quality scan, ambiguous job description, class decided on one document) are flagged for a look, and the case cannot move to Draft ready while required flags are open.
- **Edits are first-class:** change a class, split payroll, mark a payment as an uninsured sub, override a value. A person's override needs a short reason; the original value stays visible in the line's history.
- **Accept, change or reject** a whole extraction or finding in one step; bulk actions for selected rows.
- **Compare versions** of the worksheet (before and after an edit, or draft vs final) with a dollar-impact summary.

## Every change documented

The timeline is append-only and tamper-evident.

- Each event records actor (person, or Penny acting for a named person), time, the change as before and after, the reason, and links to the chat message, document page or engine run behind it.
- Events are hash-chained per case, so an edited history is detectable. The run fingerprints already in the engine carry through, so any figure in any report can be traced to the exact inputs and rule versions.
- Undo is a new event that reverses an earlier one; nothing is deleted. Deletion of documents for retention reasons leaves a tombstone event.
- The timeline exports with the case (PDF and CSV) for carrier files, disputes and SOC 2 evidence.

## Penny in the workspace

Penny is three things in one panel: the audit assistant, the operator of the workspace, and the user manual.

**Answers questions about the audit, with sources.**
"Why did you choose 5645 for these roofers?" Penny shows the evidence it used (pages, job descriptions, prior audit), the rule version, and the alternatives it considered with the dollar difference each would make. Figures always come from engine runs.

**Takes action on the audit.** Penny calls workspace actions, the same ones the buttons use, so nothing Penny does is outside the permission model or the timeline. Examples:
- "Move Ana Ruiz, Ben Ortiz and Carla Diaz to 9015." Moves the lines, reruns totals, shows the change and its premium effect.
- "Exclude the overtime premium for Q3." Applies the state rule version, or explains why the state doesn't allow it.
- "Treat Rivera Framing as uninsured for March to May; their certificate lapsed." Updates the sub line, cites the certificate.
- "Set this case to Waiting on insured and draft a records request for the 941s." Changes status, drafts the request for the user to send.
- "Make the report use the carrier's format and add a summary of class changes." Updates the report template for this case.
- "Export the worksheet to Excel with a tab per state."

**How changes are applied.** Penny shows a change card (what will change, the dollar effect, the source) and applies it on confirm, with one-click undo afterward. Small, non-financial actions (filters, views, drafts) apply directly. Actions that leave the workspace (send, submit to carrier, finalize, accept a bill) always need the user's explicit confirm. DECISION: Mark to confirm this split, or allow Penny to apply financial edits without a confirm step for Pro and Max users who opt in.

**Is the user manual.** "How do I add a second auditor?", "What does Director review do?", "Where are my exports?" Penny answers from an in-app help library kept in step with the UI (the same rule as `FACTS` for the homepage), and can open the right screen. It also answers general premium audit questions, citing rule versions, and says when something needs the carrier's or bureau's ruling.

**Penny's limits, enforced in code:** no arithmetic in the model; no figures not produced by the engine; actions only through the permission model; role scope respected (a business owner's Penny cannot see the auditor's private notes); neutral first review in disputes, never "arbiter"; no "automate/automation/automated" in auditor- or carrier-facing copy.

## How the workspace adapts by role

| | Auditor | Director | Agency / bookkeeper | Business owner |
| --- | --- | --- | --- | --- |
| Home | My queue: due this week, waiting on records, flags to clear, disputes assigned | Team board: by auditor and status, aging, overdue, disputes, returned for revision | Client board: every client's audit status and next date | My audit: status, checklist, what to do next |
| Worksheet | Full edit | View, comment, approve or return | View; edit before submission when the client authorizes | View final lines with plain-language explanations |
| Documents | All case documents | All | Their clients' uploads and the final audit | Their own uploads and the final audit |
| Findings | Create, accept, reject | Review quality | See items that affect the client | See items with dollar impact and what would fix them |
| Disputes | Decide per line | Monitor, reassign | Raise and track for clients | Raise per line with evidence |
| Reports | Audit report, worksheet, findings, records request letters | Team metrics, quality, cleared without changes, time to resolution | Client audit package, renewal summary | Audit Ready package, dispute letter |
| Penny's focus | Speed and accuracy of the audit | Where the team is stuck, quality patterns | Which clients need attention | What this means, what to send, whether to dispute |

## Work product and exports

- **Auditor:** audit report (carrier format or Penny default), payroll-by-class worksheet, findings summary, uninsured subcontractor schedule, records request letter, variance explanation vs the estimate.
- **Director:** team status and aging, quality review results, cleared without changes, disputes and outcomes, time to resolution.
- **Agency and business:** Audit Ready package (indexed records with a cover summary), final bill explanation, dispute letter with cited evidence.
- **Formats:** PDF, Excel (one tab per state or class on request, formulas left visible so the file can be checked), CSV, and later the carrier import formats.
- **Templates:** each report is a template with saved options (sections, columns, branding, carrier format). Penny edits templates on request; templates are versioned and every report records the template version and the case version it came from.
- Exports are generated by deterministic code from engine output, not written by the model.

## Documents

- Upload in the app, drag and drop, or forward to the case's intake email address.
- Stored per tenant in Azure Blob storage, encrypted, with retention and deletion controls; SSNs redacted on upload.
- Auto-tagged by type and period; duplicates detected; each document links to the lines and findings that cite it.
- A viewer with highlights shows exactly where each extracted value came from.

## Access and security

- Tenants: carrier, auditing firm, agency, business, solo auditor. Strict isolation; only rules and engine logic are shared.
- Roles and permissions per workspace; per-case sharing (a business sees its own case; its agency sees it if invited; the auditor and director see their carrier's cases).
- Magic-link sign-in first; SSO (Entra, Okta, SAML) for carrier tenants.
- Audit trail export and access reviews feed SOC 2 evidence.

## Build order

1. **Case, documents, worksheet, timeline (auditor, Phase 2).** The data model above in Postgres, status stepper, worksheet with edit history, document upload and viewer, engine-backed totals, Excel and PDF worksheet export.
2. **Penny actions (Phase 2).** Workspace action API shared by buttons and Penny; change cards with confirm and undo; "why" explanations with sources; in-app help library.
3. **Extraction and findings (Phase 2).** Document reading with citations; the engine tools in BUILD-PLAN Phase 2; review flags.
4. **Business and agency views (Phase 3).** Audit Ready checklist, client board, bill review, dispute raise.
5. **Director dashboard and disputes (Phase 4).** Team board, approvals, per-line dispute workflow, metrics.

## Decisions waiting on Mark

- Confirm-before-apply rule for Penny's financial edits (above).
- Default status lists: confirm the audit and business-side steps, or provide a carrier's real list.
- First carrier report format to match (an actual audit report from a carrier Statement works with).
- Whether a business owner may edit their own worksheet before the auditor sees it, or only upload and comment.
