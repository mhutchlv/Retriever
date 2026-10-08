# Deploying Penny to Azure

Penny runs the same way Statement360's API does: a container image built in Azure Container Registry, served by Azure Container Apps. It goes in its **own resource group** (`rg-penny`) so its billing, access and SOC 2 scope stay separate from Statement Insurance's systems.

## What gets created

| Resource | Name (default) | Why |
| --- | --- | --- |
| Resource group | `rg-penny` | Everything Penny owns, nothing else |
| Container image | `<registry>/penny:<sha>-<time>` | Built in the registry with `az acr build` (no local Docker) |
| Container Apps environment | `penny-env` | Consumption plan: no charge while idle |
| Container App | `penny-web` | HTTPS ingress, scales 0 to 1 replica |
| Storage account + file share | `pennydata<hash>` / `penny-data` | Run log (`runs.jsonl`) and sign-ups (`leads.jsonl`), mounted at `/data` |
| Managed identity | `id-penny-web` | Pulls the image (AcrPull); no registry password stored |

Secrets (`ANTHROPIC_API_KEY`, `PENNY_LEAD_WEBHOOK`) are stored as Container App secrets.

## Deploy

From the repo root, on a machine with `az login` done:

```bash
# Preview every command and the generated app spec, changing nothing:
DRY_RUN=1 ACR_NAME=<registry> ./deploy/azure/deploy.sh

# Deploy (re-run the same command to ship an update):
ACR_NAME=<registry> \
ANTHROPIC_API_KEY=<key> \
PENNY_LEAD_WEBHOOK=<teams or power automate url> \
ALLOWED_IPS="<office ip>/32" \
./deploy/azure/deploy.sh
```

- `ACR_NAME`: reuse ST360's registry (`cad945086da7acr`) or create one for Propono (see the decision below).
- `ALLOWED_IPS`: leave it set while the reference tables are sample data, so only the team can reach the site. Remove it to go public.
- Without `ANTHROPIC_API_KEY` the chat uses its built-in keyword answers; tools, demos and sign-up all still work.
- With `ANTHROPIC_API_KEY` the chat uses Claude Sonnet 5.5 at low effort, gated to premium audit and Penny topics. Spend is capped per UTC day: `PENNY_CHAT_DAILY_USD` for the whole site (default $10), `PENNY_CHAT_VISITOR_USD` per visitor (default $0.50) and `PENNY_CHAT_VISITOR_MESSAGES` per visitor (default 40), plus 20 messages a minute per visitor and 4 model calls in flight. Past any limit, chat drops to the built-in answers until the next day. Counters persist in `/data/chat-budget.json` (hashed visitor keys, no IPs). Also set a monthly spend limit on the Anthropic workspace as a backstop.
- Preview key: instead of copying a key, set `ANTHROPIC_KEY_VAULT_SECRET=https://kv-st360-dev.vault.azure.net/secrets/anthropic-api-key`. The app reads ST360's Anthropic key from Key Vault with its managed identity (`id-penny-web` has Key Vault Secrets User on that one secret only), so nobody handles the value and rotations flow through. Move to Propono's own key and vault with the move to Propono infrastructure.
- `PENNY_LEAD_WEBHOOK` posts each sign-up as JSON, the same pattern as ST360's Teams e-sign notifications. Sign-ups are also written to `leads.jsonl` on the share.

- Workspace sign-in (preview): create each account's entry with `printf '%s' '<password>' | node scripts/hash-password.ts <username> "<display name>" auditor >> users.json` (the password goes in on stdin, only a salted scrypt hash comes out), then deploy with `PENNY_USERS_FILE=users.json`. The list is stored as a Container App secret, never in git. Without it `/login.html` refuses everyone. Sessions last 8 hours in memory (a restart signs everyone out); 8 failed attempts lock an account for 15 minutes. The sample cases live in `/data/workspace.json`. Magic links and SSO replace this before any client data.

The script prints the live URL and checks `/api/health` at the end.

## Custom domain

After the first deploy:

```bash
az containerapp hostname add -n penny-web -g rg-penny --hostname penny.<domain>
# Add the CNAME and TXT (asuid) records it asks for at the DNS host, then:
az containerapp hostname bind -n penny-web -g rg-penny --hostname penny.<domain> --environment penny-env --validation-method CNAME
```

## Decision before the first deploy: which subscription

Propono is a separate company from Statement Insurance. Putting Penny in Statement Insurance's Azure subscription would put Propono's product, data and SOC 2 scope in another company's account. Recommended: a **Propono-owned subscription** (it can sit in the same Azure tenant under its own billing), with its own registry. The script works either way; only `ACR_NAME` and the active `az account` change.

## Limits of this setup

- One replica, because the run log is a single file. Before scaling out, move the run log and sign-ups to Postgres behind the same interfaces (`RunLog`, `LeadSink`).
- The rate limiter is in memory, which is fine for one replica.
- No Log Analytics workspace is attached, so check logs with `az containerapp logs show -n penny-web -g rg-penny`.
