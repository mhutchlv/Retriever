# Penny by Propono: build plan

## Where things stand
Phase 1 (Foundation) is built and deploying to Azure Container Apps (rg-penny):
- Deterministic audit engine: bigint-cent math, versioned rule tables picked by policy date, fingerprinted runs that replay exactly (Verify button), run log that keeps only hashes for free tools.
- Four free tools: class code lookup/compare, audit bill estimator, officer payroll, document checklist. Class codes and officer limits are SAMPLE data, labeled on every result.
- Homepage in the preview-site design; chat runs the tools, acts as salesperson (pricing, plans, security, sign-up), plays three engine-backed demos, and collects early-access sign-ups with consent (/api/leads).
- Claude chat mode exists but is off (no ANTHROPIC_API_KEY); keyword mode is live.
Read README.md, docs/ARCHITECTURE.md, docs/DEPLOY-AZURE.md and CLAUDE.md before changing anything. CLAUDE.md rules are not optional: pure tools, bigint money, never edit a shipped rule version, label sample data, every figure from the engine, no contact details through the model, no "automate/automation/automated" in auditor or carrier copy, accuracy not lower premiums, "neutral first review" never "arbiter".

## Next sprint (do in this order)
1. Privacy policy and terms pages, linked from the sign-up form and footer. We collect emails on a public page; this comes first. Draft them; DECISION: Mark approves wording.
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

## Phase 2: Auditors (Pro and Max)
Goal: paying Pro users and real cost per audit measured.
- Accounts: email magic-link sign-in (no passwords). Each user is a tenant with full retention under the data terms. Convert early-access leads into invites.
- Billing: Stripe subscriptions with metered audits (Pro $99 incl. 30 then $4; Max $399 incl. 150 then $3). An "audit" is a case object; meter on finalized cases. Free plan: 3 audits a month.
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
- Audit Ready (from $49): business account, guided intake reusing the chat flows, checklist tracking with uploads, flags with dollar impact (subs without COIs, overtime, officer exclusion vs the policy), packaged indexed file with a cover summary.
- Partner accounts: agency dashboard for many client audits, co-branding, client invites, client-pays option, partner seats from $49.
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

## Decisions waiting on Mark
- Move Penny to a Propono-owned Azure subscription and registry (it's in Statement's for now; the security page's SOC 2 claim assumes Propono's platform).
- Domain; NCCI commercial license; legal review; spend cap for Claude chat; privacy and terms wording.
- "Automation" wording on insurers.html and research.html (settle with Cliff).
- Joey to verify every security-page claim against the SOC 2 report, and pull real cost per audit once Phase 2 is live.
- "Penny" trademark search before a real launch.

## How to work
One branch and PR per item, npm run check green before every push, small commits. Update src/chat/knowledge.ts FACTS whenever plans, prices or availability change, and keep it in step with the site pages and src/chat/sales.ts. Report back to Mark after each sprint item with what shipped and what's blocked.
