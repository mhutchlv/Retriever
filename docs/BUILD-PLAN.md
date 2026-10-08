# Penny by Propono: build plan

## Where things stand
Phase 1 (Foundation) is built and deploying to Azure Container Apps (rg-penny) as a **team preview**. It runs in Statement Insurance's Azure subscription only for the preview and must never hold client data there. Joey will move Penny into Propono's own infrastructure (subscription, registry, network, SOC 2 controls) before any client data is loaded; everything in Phases 2 to 5 that stores customer data assumes that move is done.
- Deterministic audit engine: bigint-cent math, versioned rule tables picked by policy date, fingerprinted runs that replay exactly (Verify button), run log that keeps only hashes for free tools.
- Four free tools: class code lookup/compare, audit bill estimator, officer payroll, document checklist. Class codes and officer limits are SAMPLE data, labeled on every result.
- Homepage in the preview-site design; chat runs the tools, acts as salesperson (pricing, plans, security, sign-up), plays three engine-backed demos, and collects early-access sign-ups with consent (/api/leads).
- Claude chat mode exists but is off (no ANTHROPIC_API_KEY); keyword mode is live.
Read README.md, docs/ARCHITECTURE.md, docs/DEPLOY-AZURE.md and CLAUDE.md before changing anything. CLAUDE.md rules are not optional: pure tools, bigint money, never edit a shipped rule version, label sample data, every figure from the engine, no contact details through the model, no "automate/automation/automated" in auditor or carrier copy, accuracy not lower premiums, "neutral first review" never "arbiter".

## Next sprint (do in this order)
1. Privacy policy and terms pages, linked from the sign-up form and footer. We collect emails on a public page; this comes first. Terms must cover, per the GTM plan's risk table: results are a second look with no guarantee; no promise of lower premium; Pro and Max are individual licenses (company-wide use needs Team or enterprise); data-handling terms for contract auditors bound by carrier confidentiality, with carriers able to allow or block use; NCCI content excluded. Tech E&O to be placed through Statement Insurance before paid plans. Draft them; DECISION: Mark approves wording.
2. Lead alerts: create a Teams incoming webhook or Power Automate HTTP flow and set PENNY_LEAD_WEBHOOK through deploy.sh. Test with one sign-up.
3. CI: GitHub Actions running npm run check on every PR. Then a deploy workflow on merge to main using Azure OIDC federated credentials (no stored secrets) that runs deploy/azure/deploy.sh.
4. Monitoring: Log Analytics workspace on penny-env, an availability test on /api/health, alert to Mark on failure.
5. Postgres: Azure Database for PostgreSQL Flexible Server, private endpoint (same pattern as ST360). Implement RunLog and LeadSink on Postgres behind the existing interfaces, migrate the JSONL files, move the rate limiter to Postgres, then raise maxReplicas above 1.
6. Real reference data, each as a NEW rule set version with status "verified" and a source per row:
   - Officer payroll limits for NV, CA, AZ, UT, TX from current bureau filings, then all states.
   - WCIRB California class codes (public), then NYCIRB, PCRB and DCRB tables.
   - NCCI: the $250 Atlas license is internal use only. Showing NCCI data in a public product needs a separate commercial license. DECISION: Mark to price it with NCCI. Until then keep NCCI to short titles.
7. Turn on Claude chat: ANTHROPIC_API_KEY as a Container App secret. First add a per-IP daily message cap, a global daily spend cap with fallback to keyword mode, and a 50-question eval (pricing accuracy, no invented features, no "automation", tools used for every figure, sign-up offered when asked). Disclose chat logging on the page (California two-party consent). DECISION: Mark approves spend cap.
8. Custom domain with managed certificate. DECISION: which domain (suggest penny.propono.ai).

## Free tools, round 2
Pure engine tools on public or user-entered data, no model cost. Each follows the CLAUDE.md rules: pure `run()`, bigint money, versioned rule tables, sample data labeled until verified against the source, no NCCI manual text. Research (Oct 2026): auditors gather mainly through NSIPA (nsipa.org: chapters, annual seminar, webinars, vendor and audit-software directories) and the APA designation; no active public Reddit, LinkedIn or Facebook group was found. Free auditor-facing calculators barely exist (ClassCheck, the Massachusetts bureau's tools, carrier PDF guides).

Build first (no overlap with Pro):
1. GL gross sales adjuster: nets sales tax, freight, returns, finance charges and intercompany sales out of gross receipts. Rules in our own words, no ISO manual text.
2. Policy-period prorator: fiscal-year, quarterly or calendar payroll converted to the policy term.
3. Mileage and per diem reasonableness check: reimbursements vs the IRS mileage rate and GSA per diem, versioned by effective date.
4. Cancellation earned premium: pro-rata and short-rate, short-rate table user-editable.
5. Estimate-to-final variance worksheet: explains why the final audit differs from the deposit, line by line.

Then:
6. Remuneration include/exclude lookup: 40 to 60 pay items (tips, per diem, severance, sick pay, 401(k), Section 125) by state, in our own words.
7. Officer and owner payroll limits by state and effective date (same work as sprint item 6, verified data).

Signed-in free tools (already decided in the Penny Product and GTM Plan, Oct 6: free with a login, cents per run because Claude reads the documents):
8. Subcontractor certificate checker: reads a COI, checks WC coverage and dates against when the sub was paid, totals the uninsured portion.
9. 941 reconciliation check: quarterly 941s (plus 940 and state wage reports) vs the payroll summary, flags gaps.

Overlap with Pro (DECISION: Mark chooses the fence; recommended: free single calculation, Pro adds the case workspace, saved history and exports):
10. Overtime exclusion calculator with state exceptions.
11. Multi-state payroll allocator.

Skip for now: experience mod explainer and premium discount tables (NCCI licensed values), field route planner (paid routing API).

Verify before loading (research found these, none confirmed against the source yet): PA executive officer limits $5,400 max and $1,347 min per week; NV annual payroll cap $98,433.60 from 10/1/2026; IRS mileage 72.5 cents from 1/1/2026 and 76 cents from 7/1/2026; PA, DE and NV not allowing the overtime premium exclusion. Each becomes a new rule version with a source per row only after checking the bureau or IRS publication.

Marketing: list Penny in NSIPA's vendor and audit-software directories; offer an NSIPA webinar once round 2 ships.

## The signed-in workspace
Design target for Phases 2 to 4: `docs/WORKSPACE.md`. One chat-forward workspace that adapts to auditors, audit directors, agencies, bookkeepers and business owners: case status tracking, review and edit of Penny's first pass, an append-only hash-chained timeline of every change, documents with cited extractions, reports and Excel exports from versioned templates, and Penny in an always-open panel that answers audit questions, explains the app as its user manual, and takes actions on the case through the same permission-checked actions as the buttons. DECISIONS listed at the end of that document.

## Phase 2: Auditors (PennyPro and PennyMax)
Goal: paying PennyPro users and real model cost per user measured.
- Accounts: email magic-link sign-in (no passwords). Each user is a tenant with full retention under the data terms. Convert early-access leads into invites.
- Pricing (Mark, 2026-10-08): Free account $0; PennyPro $199/month; PennyMax $399/month; Enterprise, contact us for options. Monthly, never per audit: users may not use the features the same way when their whole company isn't on the platform. PennyPro and PennyMax users add teammates by buying additional seats (seat price to set).
- Billing: Stripe subscriptions plus a seat quantity. Each plan gets a monthly usage allowance measured in model tokens, set from our real model costs (the chat budget's per-call cost logging is the starting point). DECISION: Mark to set the allowance per plan and the seat price once cost per user is measured.
- Audit workspace: a case holds documents, extracted data, worksheet, and every engine run.
- Document intake: upload plus a unique email intake address per user. Claude reads PDFs (payroll registers, 941s, COIs, policies) into structured data with page citations; the engine does all math.
- New engine tools, each deterministic, versioned and tested:
  - 941 reconciliation (quarterly wages vs register)
  - COI checker (WC in force for the work dates, named insured match)
  - payroll-by-class worksheet builder
  - overtime premium exclusion (state rules versioned)
  - multi-state payroll split
- Worksheet exports (PDF, Excel), with custom output templates.
- Fences that protect enterprise pricing: individual-license terms; no director console, SSO, integrations or dispute portal in Pro. Data-handling terms for contract auditors; carriers can allow or block.
- SSN redaction on upload; retention and deletion controls.

## Phase 3: Businesses through agencies
Goal: agencies renewing and clients finishing audits faster.
- Audit Ready (in PennyPro and PennyMax): business account, guided intake reusing the chat flows, checklist tracking with uploads, flags with dollar impact (subs without COIs, overtime, officer exclusion vs the policy), packaged indexed file with a cover summary.
- Partner accounts: agency dashboard for many client audits, co-branding, client invites, client-pays option; agencies use PennyPro or PennyMax with added seats, white-label and API are Enterprise.
- Statement Insurance is the pilot partner. ST360 already stores WC class codes and officer elections per client, so build "Send to Penny" from ST360 via a partner API key. Then roll out to NIIA agencies.
- Audit Review (paid): flat fee first. DECISION: legal review of consultant licensing and success fees before launch.

## Phase 4: Carrier dispute module (enterprise)
Goal: first carrier live; measure the share of disputes closed without an auditor.
- Carrier tenants with SSO (SAML/Entra/Okta), audit-trail export, strict data isolation.
- Import a carrier's audits (CSV/JSON first; Guidewire, Duck Creek and Insurity later via core systems, never via anyone's employer internals).
- Insured portal: line-by-line explanations with rule citations, evidence upload, what-if recalculation, escalate unresolved lines, state appeal-rights disclosure.
- Auditor view: disputed lines only, evidence, Penny's assessment, approve or deny per line; approval regenerates the audit and bill and exports back.
- Director metrics: closed without auditor, time to resolution, approval rate.
- Only auditor-confirmed outcomes enter the correction dataset (feeds the NSF research controller).
- Before the first pilot: penetration test, SOC 2 controls applied to Penny (access reviews, change management via PR and CI, Postgres backups and restore tests).

## Phase 5: Standalone Audit Review and integrations
After legal sign-off: standalone Audit Review (consider a separate brand), white-label and API (keys, rate limits, per-review billing, revenue share), payroll provider integrations ("Send to Penny" from Gusto, ADP, Paychex).

## Source documents
- Penny: Product and Go-to-Market Plan (Oct 6, 2026): positioning, audiences, lineup, pricing, unit economics, guardrails, risks, roadmap, metrics. This build plan implements it.
- Propono Systems Claude Context (Box, Propono folder): venture-level facts and decisions.

## Metrics to instrument (from the GTM plan)
Free tools: monthly users, sign-ups from tools, cost per tool run. Auditor plans: free-to-paid conversion, audits per user per month, gross margin per plan. Business and partner: partners active, audits per partner, client completion time. Dispute module: share closed without an auditor, time to resolution, auditor approval rate. Consistency: share of reruns that reproduce the same result (target 100%). Funnel: carriers asking for Penny because their auditors or insureds use it.

## Decisions waiting on Mark
- Penny's move to Propono infrastructure: owned by Joey, required before client data (decided Oct 8, 2026). The Statement-subscription deploy is a team preview only; until the move, the security page's SOC 2 claim does not describe the preview host.
- Domain; NCCI commercial license; legal review; spend cap for Claude chat; privacy and terms wording.
- "Automation" wording on insurers.html and research.html (settle with Cliff).
- Joey to verify every security-page claim against the SOC 2 report, and pull real cost per audit once Phase 2 is live.
- "Penny" trademark search before a real launch.

## How to work
One branch and PR per item, npm run check green before every push, small commits. Update src/chat/knowledge.ts FACTS whenever plans, prices or availability change, and keep it in step with the site pages and src/chat/sales.ts. Report back to Mark after each sprint item with what shipped and what's blocked.
