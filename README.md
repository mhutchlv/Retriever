# Penny by Propono

Penny is Propono's chat-first workers' compensation premium audit helper: accurate to the penny, and every answer shows its work. It puts the same audit engine carriers use in front of individual auditors, the small businesses being audited, and the partners who serve them.

This repository is **Phase 1 (Foundation)** from the Penny product plan: the free no-login tools, the chat-first homepage (in the preview site's design), and the "one engine, one answer" core (versioned rules, deterministic runs, and a run log that can prove any result).

The homepage chat does two jobs:
- **Free audit tools:** guided conversations for class codes, audit bill estimates, officer payroll and document checklists, all computed by the engine, each with a receipt you can verify.
- **Salesperson:** answers questions about the product, plans, pricing and security from `src/chat/knowledge.ts` and the site pages; plays engine-backed feature demos (Audit Review, Audit Ready, Penny Pro); and signs visitors up for early access with a consent form.

## Run it

Requires Node 22.18 or later (TypeScript runs directly, with no build step).

```bash
npm install
npm start            # http://localhost:3000
npm run check        # typecheck + tests
```

Chat uses a keyword router by default. To have Claude handle the conversation, set `ANTHROPIC_API_KEY`; the model routes questions to the same tools, and every figure it states still comes from the engine.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `ANTHROPIC_API_KEY` | unset | Enables model chat |
| `PENNY_MODEL` | `claude-opus-5-5` | Model for chat |
| `PENNY_RUNLOG` | `data/runs.jsonl` | Run log location |
| `PENNY_LEADS` | `data/leads.jsonl` | Early-access sign-ups |
| `PENNY_LEAD_WEBHOOK` | unset | URL that receives each sign-up (Teams, Power Automate, CRM) |
| `PENNY_TRUST_PROXY` | unset | `1` behind Azure ingress, so rate limits see real client addresses |

## What's in Phase 1

| Tool | What it does | Data status |
| --- | --- | --- |
| Class code lookup and compare | Search codes by plain words; compare one code across states, with the governing bureau and local equivalents | **Sample** seed list; replace with bureau tables |
| Audit bill estimator | Payroll × rate by class, experience mod, schedule rating and charges, compared with the deposit premium; shows what moves the bill | Pure math; rates come from the user's policy |
| Officer payroll calculator | Exclusions, state minimums and maximums (prorated), owner amounts | **Sample** limits; user can enter real ones |
| Audit document checklist | Records to gather by entity type, classes and operations, with why each matters | Verified (Propono practice) |

Results built on sample data carry a visible "Sample data" badge and a warning. Do not launch publicly until those tables are replaced with verified bureau data.

## API

| Method | Path | |
| --- | --- | --- |
| `GET` | `/api/health` | Engine version and chat mode |
| `GET` | `/api/tools` | Tool list with JSON input schemas |
| `POST` | `/api/tools/:name` | Run a tool; returns the full receipt |
| `POST` | `/api/chat` | `{ messages: [{ role, content }] }` → reply, receipts, and any demo, sign-up or suggestions to show |
| `POST` | `/api/leads` | `{ name, email, role, interest, company?, consent: true }` → early-access sign-up |
| `POST` | `/api/replay` | `{ receipt }` → re-runs it and confirms the same answer |
| `GET` | `/api/runs/:id` | The stored record (hashes only for public runs) |

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how determinism, rule versioning and retention work, and [docs/DEPLOY-AZURE.md](docs/DEPLOY-AZURE.md) to deploy.

## Site pages

`public/` is the preview site (home, For insurers, Research, Data security) with the homepage chat wired to the engine. Before going public: replace `[CONTACT EMAIL]`, have Joey verify every security-page claim against the SOC 2 report, and settle the "automation" wording on the insurer and research pages.
