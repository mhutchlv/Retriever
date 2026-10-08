#!/usr/bin/env bash
# Deploy Penny to Azure Container Apps, the same way Statement360's API runs.
# Run from the repo root on a machine where `az login` is done (Mark's laptop).
#
#   ACR_NAME=<registry> ./deploy/azure/deploy.sh            # deploy
#   DRY_RUN=1 ACR_NAME=<registry> ./deploy/azure/deploy.sh  # print the plan only
#
# Optional settings (environment variables):
#   RESOURCE_GROUP     default rg-penny         Penny's own resource group
#   LOCATION           default: the registry's region
#   APP_NAME           default penny-web
#   ENV_NAME           default penny-env        Container Apps environment (consumption)
#   STORAGE_ACCOUNT    default pennydata<hash>  holds the run log and sign-ups
#   TAG                default <git sha>-<time>
#   ALLOWED_IPS        comma-separated CIDRs; when set, only these can reach the site
#   ANTHROPIC_API_KEY  turns on model chat; stored as a Container App secret
#   PENNY_LEAD_WEBHOOK URL that gets each new sign-up (Teams / Power Automate); stored as a secret
set -euo pipefail

: "${ACR_NAME:?Set ACR_NAME to the Azure Container Registry name (no .azurecr.io)}"
RESOURCE_GROUP="${RESOURCE_GROUP:-rg-penny}"
APP_NAME="${APP_NAME:-penny-web}"
ENV_NAME="${ENV_NAME:-penny-env}"
IDENTITY_NAME="${IDENTITY_NAME:-id-penny-web}"
SHARE_NAME="penny-data"
ENV_STORAGE_NAME="pennydata"
DRY_RUN="${DRY_RUN:-0}"

run() {
  if [[ "$DRY_RUN" == "1" ]]; then echo "+ $*"; else "$@"; fi
}

# Values read from Azure. In a dry run, placeholders stand in.
query() {
  if [[ "$DRY_RUN" == "1" ]]; then echo "<$1>"; else shift; "$@"; fi
}

[[ -f Dockerfile && -f package.json ]] || { echo "Run this from the repository root." >&2; exit 1; }
if [[ "$DRY_RUN" != "1" ]]; then
  command -v az >/dev/null || { echo "The Azure CLI (az) is required." >&2; exit 1; }
  az account show >/dev/null || { echo "Run az login first." >&2; exit 1; }
  az extension add --name containerapp --upgrade --only-show-errors >/dev/null
fi

ACR_ID="$(query acr-id az acr show -n "$ACR_NAME" --query id -o tsv)"
ACR_SERVER="$(query acr-server az acr show -n "$ACR_NAME" --query loginServer -o tsv)"
LOCATION="${LOCATION:-$(query location az acr show -n "$ACR_NAME" --query location -o tsv)}"
SUB_HASH="$(query sub-hash bash -c "az account show --query id -o tsv | sha256sum | cut -c1-8")"
STORAGE_ACCOUNT="${STORAGE_ACCOUNT:-pennydata${SUB_HASH}}"
TAG="${TAG:-$(git rev-parse --short HEAD 2>/dev/null || echo local)-$(date -u +%Y%m%d%H%M)}"
IMAGE="${ACR_SERVER}/penny:${TAG}"

echo "Deploying ${IMAGE} to ${APP_NAME} in ${RESOURCE_GROUP} (${LOCATION})"

# 1. Resource group, owned by Penny alone.
run az group create -n "$RESOURCE_GROUP" -l "$LOCATION" --tags app=penny owner=propono -o none

# 2. Build the image in the registry (no local Docker needed).
run az acr build -r "$ACR_NAME" -t "penny:${TAG}" --platform linux/amd64 .

# 3. File share for the run log and sign-ups (append-only JSON Lines).
run az storage account create -n "$STORAGE_ACCOUNT" -g "$RESOURCE_GROUP" -l "$LOCATION" \
  --sku Standard_LRS --kind StorageV2 --min-tls-version TLS1_2 --allow-blob-public-access false -o none
run az storage share-rm create --storage-account "$STORAGE_ACCOUNT" -g "$RESOURCE_GROUP" -n "$SHARE_NAME" --quota 5 -o none
STORAGE_KEY="$(query storage-key az storage account keys list -n "$STORAGE_ACCOUNT" -g "$RESOURCE_GROUP" --query '[0].value' -o tsv)"

# 4. Container Apps environment (consumption plan: costs nothing while idle) with the share attached.
if [[ "$DRY_RUN" == "1" ]] || ! az containerapp env show -n "$ENV_NAME" -g "$RESOURCE_GROUP" >/dev/null 2>&1; then
  run az containerapp env create -n "$ENV_NAME" -g "$RESOURCE_GROUP" -l "$LOCATION" -o none
fi
run az containerapp env storage set -n "$ENV_NAME" -g "$RESOURCE_GROUP" --storage-name "$ENV_STORAGE_NAME" \
  --azure-file-account-name "$STORAGE_ACCOUNT" --azure-file-account-key "$STORAGE_KEY" \
  --azure-file-share-name "$SHARE_NAME" --access-mode ReadWrite -o none
ENV_ID="$(query env-id az containerapp env show -n "$ENV_NAME" -g "$RESOURCE_GROUP" --query id -o tsv)"

# 5. Identity that pulls the image, so no registry password is stored.
run az identity create -n "$IDENTITY_NAME" -g "$RESOURCE_GROUP" -l "$LOCATION" -o none
IDENTITY_ID="$(query identity-id az identity show -n "$IDENTITY_NAME" -g "$RESOURCE_GROUP" --query id -o tsv)"
IDENTITY_PRINCIPAL="$(query identity-principal az identity show -n "$IDENTITY_NAME" -g "$RESOURCE_GROUP" --query principalId -o tsv)"
if [[ "$DRY_RUN" == "1" ]] || [[ -z "$(az role assignment list --assignee "$IDENTITY_PRINCIPAL" --scope "$ACR_ID" --role AcrPull --query '[0].id' -o tsv)" ]]; then
  run az role assignment create --assignee-object-id "$IDENTITY_PRINCIPAL" --assignee-principal-type ServicePrincipal \
    --role AcrPull --scope "$ACR_ID" -o none
  [[ "$DRY_RUN" == "1" ]] || sleep 30 # role assignments take a moment to apply
fi

# 6. The app itself, from a generated spec (secrets live only in this temp file, removed on exit).
umask 077
SPEC="$(mktemp -t penny-app-XXXXXX.yaml)"
trap 'rm -f "$SPEC"' EXIT

{
  cat <<YAML
location: ${LOCATION}
identity:
  type: UserAssigned
  userAssignedIdentities:
    ${IDENTITY_ID}: {}
properties:
  managedEnvironmentId: ${ENV_ID}
  configuration:
    activeRevisionsMode: Single
    ingress:
      external: true
      targetPort: 8080
      transport: auto
      allowInsecure: false
YAML
  if [[ -n "${ALLOWED_IPS:-}" ]]; then
    echo "      ipSecurityRestrictions:"
    i=0
    IFS=',' read -ra RANGES <<<"$ALLOWED_IPS"
    for range in "${RANGES[@]}"; do
      i=$((i + 1))
      echo "        - name: allow-${i}"
      echo "          action: Allow"
      echo "          ipAddressRange: ${range// /}"
    done
  fi
  cat <<YAML
    registries:
      - server: ${ACR_SERVER}
        identity: ${IDENTITY_ID}
YAML
  if [[ -n "${ANTHROPIC_API_KEY:-}" || -n "${PENNY_LEAD_WEBHOOK:-}" ]]; then
    echo "    secrets:"
    [[ -n "${ANTHROPIC_API_KEY:-}" ]] && printf '      - name: anthropic-api-key\n        value: "%s"\n' "$ANTHROPIC_API_KEY"
    [[ -n "${PENNY_LEAD_WEBHOOK:-}" ]] && printf '      - name: lead-webhook\n        value: "%s"\n' "$PENNY_LEAD_WEBHOOK"
  fi
  cat <<YAML
  template:
    containers:
      - name: penny
        image: ${IMAGE}
        resources:
          cpu: 0.5
          memory: 1Gi
        env:
          - name: PENNY_RUNLOG
            value: /data/runs.jsonl
          - name: PENNY_LEADS
            value: /data/leads.jsonl
          - name: PENNY_TRUST_PROXY
            value: "1"
YAML
  [[ -n "${ANTHROPIC_API_KEY:-}" ]] && printf '          - name: ANTHROPIC_API_KEY\n            secretRef: anthropic-api-key\n'
  [[ -n "${PENNY_LEAD_WEBHOOK:-}" ]] && printf '          - name: PENNY_LEAD_WEBHOOK\n            secretRef: lead-webhook\n'
  cat <<YAML
        volumeMounts:
          - volumeName: data
            mountPath: /data
        probes:
          - type: Liveness
            httpGet:
              path: /api/health
              port: 8080
            periodSeconds: 30
          - type: Readiness
            httpGet:
              path: /api/health
              port: 8080
            periodSeconds: 10
    scale:
      # One replica: the run log is a single file. Move it to a database before scaling out.
      minReplicas: 0
      maxReplicas: 1
    volumes:
      - name: data
        storageType: AzureFile
        storageName: ${ENV_STORAGE_NAME}
        mountOptions: "uid=1000,gid=1000,dir_mode=0750,file_mode=0640"
YAML
} >"$SPEC"

if [[ "$DRY_RUN" == "1" ]]; then
  echo "--- app spec (secret values redacted) ---"
  awk '/name: (anthropic-api-key|lead-webhook)$/ { print; getline; sub(/value: .*/, "value: \"<redacted>\""); } { print }' "$SPEC"
  exit 0
fi

if az containerapp show -n "$APP_NAME" -g "$RESOURCE_GROUP" >/dev/null 2>&1; then
  az containerapp update -n "$APP_NAME" -g "$RESOURCE_GROUP" --yaml "$SPEC" -o none
else
  az containerapp create -n "$APP_NAME" -g "$RESOURCE_GROUP" --yaml "$SPEC" -o none
fi

FQDN="$(az containerapp show -n "$APP_NAME" -g "$RESOURCE_GROUP" --query properties.configuration.ingress.fqdn -o tsv)"
echo "Penny is live at https://${FQDN}"
curl -fsS "https://${FQDN}/api/health" && echo
