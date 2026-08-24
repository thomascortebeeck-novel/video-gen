#!/usr/bin/env bash
# =============================================================================
# One-shot Google Cloud + Firebase provisioning for AI Video Studio.
#
#   ./scripts/setup-gcp.sh <project-id> [--region europe-west1] [--secrets-only]
#
# Prereqs (one-time, interactive — do these first):
#   gcloud auth login
#   npx firebase login
#
# What it does (idempotent — safe to re-run):
#   1.  Creates the GCP project (or reuses it) and links billing
#   2.  Enables all required APIs (incl. Secret Manager)
#   3.  Adds Firebase to the project
#   4.  Creates the Firestore database (eur3) and the default Storage bucket
#   5.  Enables Anonymous authentication
#   6.  Registers the web app and writes web/.env.local + .firebaserc
#   7.  Creates/updates API-key secrets in **Google Cloud Secret Manager**
#       (you type values in a hidden prompt; grant runtime access via IAM)
#   8.  Builds and deploys functions + hosting + rules
# =============================================================================
set -euo pipefail

PROJECT_ID="${1:-}"
REGION="europe-west1"
FIRESTORE_LOCATION="eur3"
SECRETS_ONLY=false
for arg in "${@:2}"; do
  case "$arg" in
    --region) ;; # value handled below
    --secrets-only) SECRETS_ONLY=true ;;
    europe-*|us-*|asia-*) REGION="$arg" ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
SECRET_NAMES=(HIGGSFIELD_API_KEY HIGGSFIELD_API_SECRET ANTHROPIC_API_KEY ELEVENLABS_API_KEY FAL_KEY ARK_API_KEY)

say()  { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
ok()   { printf '\033[0;32m✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[0;33m⚠ %s\033[0m\n' "$*"; }
die()  { printf '\033[0;31m✗ %s\033[0m\n' "$*"; exit 1; }

[ -n "$PROJECT_ID" ] || die "Usage: ./scripts/setup-gcp.sh <project-id> [--region <region>] [--secrets-only]"
command -v gcloud >/dev/null || die "gcloud not found. Install: brew install --cask gcloud-cli"
FIREBASE="npx --prefix $REPO_DIR firebase"

# --- auth checks -------------------------------------------------------------
ACTIVE_ACCOUNT=$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null || true)
[ -n "$ACTIVE_ACCOUNT" ] || die "Not logged in to gcloud. Run:  gcloud auth login"
ok "gcloud account: $ACTIVE_ACCOUNT"
# Only the full setup needs firebase-tools (registering the web app, adding
# Firebase to the project). --secrets-only talks to Secret Manager through
# gcloud alone, so don't make it wait on a CLI login it never uses — the org's
# session policy expires that login within hours anyway.
if [ "$SECRETS_ONLY" = false ]; then
  $FIREBASE login:list 2>/dev/null | grep -q "@" || die "Not logged in to Firebase CLI. Run:  npx firebase login"
  ok "firebase CLI logged in"
fi

TOKEN=$(gcloud auth print-access-token)

secrets_setup() {
  say "Secrets → Google Cloud Secret Manager"
  gcloud services enable secretmanager.googleapis.com --project "$PROJECT_ID" >/dev/null
  PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
  RUNTIME_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
  echo "Runtime service account: $RUNTIME_SA"
  for NAME in "${SECRET_NAMES[@]}"; do
    if ! gcloud secrets describe "$NAME" --project "$PROJECT_ID" >/dev/null 2>&1; then
      HAS_VALUE=false
    else
      HAS_VALUE=true
    fi
    printf '\n%s %s\n' "$NAME" "$([ $HAS_VALUE = true ] && echo '(already exists — enter to keep, or type a new value)' || echo '(not set)')"
    printf 'Value (hidden, Enter to skip): '
    read -rs VALUE; echo
    if [ -n "$VALUE" ]; then
      if [ $HAS_VALUE = false ]; then
        gcloud secrets create "$NAME" --project "$PROJECT_ID" --replication-policy automatic >/dev/null
      fi
      printf '%s' "$VALUE" | gcloud secrets versions add "$NAME" --project "$PROJECT_ID" --data-file=- >/dev/null
      ok "$NAME version added"
    elif [ $HAS_VALUE = false ]; then
      # Create with a blank placeholder so `firebase deploy` never prompts;
      # the app treats blank values as "not configured" (mock mode).
      gcloud secrets create "$NAME" --project "$PROJECT_ID" --replication-policy automatic >/dev/null
      printf ' ' | gcloud secrets versions add "$NAME" --project "$PROJECT_ID" --data-file=- >/dev/null
      warn "$NAME left blank — that provider runs in MOCK mode until you set a real value"
    fi
    gcloud secrets add-iam-policy-binding "$NAME" --project "$PROJECT_ID" \
      --member "serviceAccount:$RUNTIME_SA" --role roles/secretmanager.secretAccessor >/dev/null 2>&1 || true
  done
  ok "Secret Manager configured (view: https://console.cloud.google.com/security/secret-manager?project=$PROJECT_ID)"
}

if [ "$SECRETS_ONLY" = true ]; then
  secrets_setup
  exit 0
fi

# --- 1. project --------------------------------------------------------------
say "Project"
if gcloud projects describe "$PROJECT_ID" >/dev/null 2>&1; then
  ok "Project $PROJECT_ID exists"
else
  gcloud projects create "$PROJECT_ID" --name "AI Video Studio" || die "Project creation failed (id taken? pick another)"
  ok "Project created"
fi
gcloud config set project "$PROJECT_ID" >/dev/null

# --- 2. billing --------------------------------------------------------------
say "Billing (required for Cloud Functions + outbound API calls)"
if gcloud billing projects describe "$PROJECT_ID" --format='value(billingEnabled)' 2>/dev/null | grep -qi true; then
  ok "Billing already linked"
else
  BILLING_LIST=$(gcloud billing accounts list --filter=open=true --format='value(name)' 2>/dev/null || true)
  BILLING_COUNT=$(printf '%s\n' "$BILLING_LIST" | grep -c . || true)
  if [ "$BILLING_COUNT" -eq 0 ]; then
    die "No open billing account found. Create one at https://console.cloud.google.com/billing then re-run."
  elif [ "$BILLING_COUNT" -eq 1 ]; then
    BILLING="$BILLING_LIST"
  else
    echo "Open billing accounts:"; gcloud billing accounts list --filter=open=true
    printf 'Enter billing account id (billingAccounts/XXXXXX-...): '
    read -r BILLING
  fi
  gcloud billing projects link "$PROJECT_ID" --billing-account "${BILLING#billingAccounts/}" >/dev/null
  ok "Billing linked"
fi

# --- 3. APIs -----------------------------------------------------------------
say "Enabling APIs"
gcloud services enable \
  firebase.googleapis.com \
  firestore.googleapis.com \
  firebasestorage.googleapis.com \
  storage.googleapis.com \
  identitytoolkit.googleapis.com \
  cloudfunctions.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  run.googleapis.com \
  eventarc.googleapis.com \
  secretmanager.googleapis.com \
  cloudbilling.googleapis.com \
  --project "$PROJECT_ID"
ok "APIs enabled"

# --- 4. add Firebase ---------------------------------------------------------
say "Firebase"
if $FIREBASE projects:list 2>/dev/null | grep -q "$PROJECT_ID"; then
  ok "Firebase already added"
else
  $FIREBASE projects:addfirebase "$PROJECT_ID" && ok "Firebase added" || warn "Could not add Firebase via CLI — do it once at https://console.firebase.google.com (Add project → existing GCP project), then re-run."
fi

# --- 5. Firestore ------------------------------------------------------------
say "Firestore database ($FIRESTORE_LOCATION)"
if gcloud firestore databases describe --database='(default)' --project "$PROJECT_ID" >/dev/null 2>&1; then
  ok "Firestore database exists"
else
  gcloud firestore databases create --location="$FIRESTORE_LOCATION" --project "$PROJECT_ID" >/dev/null
  ok "Firestore database created"
fi

# --- 6. default Storage bucket ----------------------------------------------
say "Firebase Storage default bucket"
BUCKET_CHECK=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" \
  "https://firebasestorage.googleapis.com/v1beta/projects/$PROJECT_ID/defaultBucket")
if [ "$BUCKET_CHECK" = "200" ]; then
  ok "Default bucket exists"
else
  CREATE_CODE=$(curl -s -o /tmp/bucket_resp.json -w '%{http_code}' -X POST \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    "https://firebasestorage.googleapis.com/v1beta/projects/$PROJECT_ID/defaultBucket" -d '{}')
  if [ "$CREATE_CODE" = "200" ]; then
    ok "Default bucket created"
  else
    warn "Could not create the default bucket via API (HTTP $CREATE_CODE)."
    warn "Enable Storage once in the console: https://console.firebase.google.com/project/$PROJECT_ID/storage — then re-run."
  fi
fi

# --- 7. Anonymous auth -------------------------------------------------------
say "Anonymous authentication"
AUTH_CODE=$(curl -s -o /tmp/auth_resp.json -w '%{http_code}' -X PATCH \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  "https://identitytoolkit.googleapis.com/admin/v2/projects/$PROJECT_ID/config?updateMask=signIn.anonymous.enabled" \
  -d '{"signIn":{"anonymous":{"enabled":true}}}')
if [ "$AUTH_CODE" = "200" ]; then
  ok "Anonymous sign-in enabled"
else
  warn "Could not enable Anonymous auth via API (HTTP $AUTH_CODE). Enable it once at:"
  warn "https://console.firebase.google.com/project/$PROJECT_ID/authentication/providers — then re-run."
fi

# --- 8. web app + local config ----------------------------------------------
say "Web app registration"
APP_ID=$($FIREBASE apps:list WEB --project "$PROJECT_ID" 2>/dev/null | grep -oE '1:[0-9]+:web:[a-f0-9]+' | head -1 || true)
if [ -z "$APP_ID" ]; then
  $FIREBASE apps:create WEB "AI Video Studio" --project "$PROJECT_ID" >/dev/null
  APP_ID=$($FIREBASE apps:list WEB --project "$PROJECT_ID" 2>/dev/null | grep -oE '1:[0-9]+:web:[a-f0-9]+' | head -1 || true)
fi
[ -n "$APP_ID" ] || die "Could not find/register the web app"
ok "Web app: $APP_ID"

say "Writing web/.env.local and .firebaserc"
SDK_JSON=$($FIREBASE apps:sdkconfig WEB "$APP_ID" --project "$PROJECT_ID" --json)
node - "$SDK_JSON" "$REPO_DIR" "$REGION" <<'EOF'
const [json, repo, region] = process.argv.slice(1);
const fs = require('fs');
const parsed = JSON.parse(json);
const c = parsed.result?.sdkConfig ?? parsed.result ?? parsed;
if (!c.projectId) { console.error('Unexpected sdkconfig output'); process.exit(1); }
const env = [
  `VITE_FIREBASE_API_KEY=${c.apiKey}`,
  `VITE_FIREBASE_AUTH_DOMAIN=${c.authDomain}`,
  `VITE_FIREBASE_PROJECT_ID=${c.projectId}`,
  `VITE_FIREBASE_STORAGE_BUCKET=${c.storageBucket ?? c.projectId + '.firebasestorage.app'}`,
  `VITE_FIREBASE_MESSAGING_SENDER_ID=${c.messagingSenderId ?? ''}`,
  `VITE_FIREBASE_APP_ID=${c.appId}`,
  `VITE_USE_EMULATORS=false`,
  `VITE_FUNCTIONS_REGION=${region}`,
  '',
].join('\n');
fs.writeFileSync(`${repo}/web/.env.local`, env);
fs.writeFileSync(`${repo}/.firebaserc`, JSON.stringify({ projects: { default: c.projectId } }, null, 2) + '\n');
console.log('written web/.env.local + .firebaserc');
EOF
ok "Local config written"

# --- 9. secrets --------------------------------------------------------------
secrets_setup

# --- 10. deploy --------------------------------------------------------------
say "Build & deploy"
(cd "$REPO_DIR/functions" && npm install && npm run build)
(cd "$REPO_DIR/web" && npm install && npm run build)
(cd "$REPO_DIR" && $FIREBASE deploy --project "$PROJECT_ID")

say "Done"
echo "App:            https://$PROJECT_ID.web.app"
echo "Console:        https://console.firebase.google.com/project/$PROJECT_ID"
echo "Secret Manager: https://console.cloud.google.com/security/secret-manager?project=$PROJECT_ID"
echo "Re-run secrets only:  ./scripts/setup-gcp.sh $PROJECT_ID --secrets-only"
