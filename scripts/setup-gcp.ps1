# =============================================================================
# One-shot Google Cloud + Firebase provisioning for AI Video Studio (PowerShell)
#
#   ./scripts/setup-gcp.ps1 -ProjectId my-video-studio [-Region europe-west1] [-SecretsOnly]
#
# Works in PowerShell 7+ on macOS (brew install --cask powershell), Windows, or
# Linux. Same behaviour as setup-gcp.sh — the gcloud/firebase CLIs are
# shell-agnostic, so pick whichever shell you prefer.
#
# Prereqs (one-time, interactive):
#   gcloud auth login
#   npx firebase login
# =============================================================================
param(
  [Parameter(Mandatory = $true)][string]$ProjectId,
  [string]$Region = 'europe-west1',
  [string]$FirestoreLocation = 'eur3',
  [switch]$SecretsOnly
)
$ErrorActionPreference = 'Stop'
$RepoDir = Split-Path -Parent $PSScriptRoot
$SecretNames = @('HIGGSFIELD_API_KEY', 'HIGGSFIELD_API_SECRET', 'ANTHROPIC_API_KEY', 'ELEVENLABS_API_KEY', 'FAL_KEY', 'ARK_API_KEY')

function Say($m)  { Write-Host "`n> $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "  OK: $m" -ForegroundColor Green }
function Warn2($m){ Write-Host "  WARN: $m" -ForegroundColor Yellow }

function Invoke-Firebase { param([string[]]$FbArgs) & npx --prefix $RepoDir firebase @FbArgs }

# --- auth checks -------------------------------------------------------------
$account = (& gcloud auth list --filter=status:ACTIVE --format='value(account)') | Select-Object -First 1
if (-not $account) { throw 'Not logged in to gcloud. Run: gcloud auth login' }
Ok "gcloud account: $account"
$fbLogin = Invoke-Firebase @('login:list') 2>$null | Out-String
if ($fbLogin -notmatch '@') { throw 'Not logged in to Firebase CLI. Run: npx firebase login' }
Ok 'firebase CLI logged in'
$Token = (& gcloud auth print-access-token).Trim()

function Setup-Secrets {
  Say 'Secrets -> Google Cloud Secret Manager'
  & gcloud services enable secretmanager.googleapis.com --project $ProjectId | Out-Null
  $projectNumber = (& gcloud projects describe $ProjectId --format='value(projectNumber)').Trim()
  $runtimeSa = "$projectNumber-compute@developer.gserviceaccount.com"
  Write-Host "  Runtime service account: $runtimeSa"
  foreach ($name in $SecretNames) {
    & gcloud secrets describe $name --project $ProjectId 2>$null | Out-Null
    $exists = ($LASTEXITCODE -eq 0)
    $hint = if ($exists) { '(already exists - Enter to keep, or type a new value)' } else { '(not set)' }
    $secure = Read-Host "  $name $hint - value (hidden, Enter to skip)" -AsSecureString
    $value = [System.Net.NetworkCredential]::new('', $secure).Password
    if ($value) {
      if (-not $exists) { & gcloud secrets create $name --project $ProjectId --replication-policy automatic | Out-Null }
      $tmp = New-TemporaryFile
      try {
        [IO.File]::WriteAllText($tmp.FullName, $value)
        & gcloud secrets versions add $name --project $ProjectId --data-file $tmp.FullName | Out-Null
      } finally { Remove-Item $tmp -Force }
      Ok "$name version added"
    } elseif (-not $exists) {
      # Create with a blank placeholder so `firebase deploy` never prompts;
      # the app treats blank values as "not configured" (mock mode).
      & gcloud secrets create $name --project $ProjectId --replication-policy automatic | Out-Null
      $tmp = New-TemporaryFile
      try {
        [IO.File]::WriteAllText($tmp.FullName, ' ')
        & gcloud secrets versions add $name --project $ProjectId --data-file $tmp.FullName | Out-Null
      } finally { Remove-Item $tmp -Force }
      Warn2 "$name left blank - that provider runs in MOCK mode until you set a real value"
    }
    & gcloud secrets add-iam-policy-binding $name --project $ProjectId `
      --member "serviceAccount:$runtimeSa" --role roles/secretmanager.secretAccessor 2>$null | Out-Null
  }
  Ok "Secret Manager configured: https://console.cloud.google.com/security/secret-manager?project=$ProjectId"
}

if ($SecretsOnly) { Setup-Secrets; exit 0 }

# --- 1. project --------------------------------------------------------------
Say 'Project'
& gcloud projects describe $ProjectId 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
  & gcloud projects create $ProjectId --name 'AI Video Studio'
  Ok 'Project created'
} else { Ok "Project $ProjectId exists" }
& gcloud config set project $ProjectId | Out-Null

# --- 2. billing --------------------------------------------------------------
Say 'Billing'
$billingEnabled = (& gcloud billing projects describe $ProjectId --format='value(billingEnabled)' 2>$null | Out-String).Trim()
if ($billingEnabled -match 'True') { Ok 'Billing already linked' }
else {
  $accounts = @(& gcloud billing accounts list --filter=open=true --format='value(name)' 2>$null | Where-Object { $_ })
  if ($accounts.Count -eq 0) { throw 'No open billing account. Create one at https://console.cloud.google.com/billing then re-run.' }
  $billing = if ($accounts.Count -eq 1) { $accounts[0] } else {
    & gcloud billing accounts list --filter=open=true
    Read-Host 'Enter billing account id (XXXXXX-XXXXXX-XXXXXX)'
  }
  & gcloud billing projects link $ProjectId --billing-account ($billing -replace 'billingAccounts/', '') | Out-Null
  Ok 'Billing linked'
}

# --- 3. APIs -----------------------------------------------------------------
Say 'Enabling APIs'
& gcloud services enable firebase.googleapis.com firestore.googleapis.com firebasestorage.googleapis.com `
  storage.googleapis.com identitytoolkit.googleapis.com cloudfunctions.googleapis.com cloudbuild.googleapis.com `
  artifactregistry.googleapis.com run.googleapis.com eventarc.googleapis.com secretmanager.googleapis.com `
  cloudbilling.googleapis.com --project $ProjectId
Ok 'APIs enabled'

# --- 4. add Firebase ---------------------------------------------------------
Say 'Firebase'
$fbProjects = Invoke-Firebase @('projects:list') 2>$null | Out-String
if ($fbProjects -match [regex]::Escape($ProjectId)) { Ok 'Firebase already added' }
else {
  Invoke-Firebase @('projects:addfirebase', $ProjectId)
  if ($LASTEXITCODE -eq 0) { Ok 'Firebase added' }
  else { Warn2 'Could not add Firebase via CLI - add the existing GCP project once at https://console.firebase.google.com then re-run.' }
}

# --- 5. Firestore ------------------------------------------------------------
Say "Firestore database ($FirestoreLocation)"
& gcloud firestore databases describe --database='(default)' --project $ProjectId 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
  & gcloud firestore databases create --location $FirestoreLocation --project $ProjectId | Out-Null
  Ok 'Firestore database created'
} else { Ok 'Firestore database exists' }

# --- 6. default Storage bucket ----------------------------------------------
Say 'Firebase Storage default bucket'
$headers = @{ Authorization = "Bearer $Token" }
try {
  Invoke-RestMethod -Uri "https://firebasestorage.googleapis.com/v1beta/projects/$ProjectId/defaultBucket" -Headers $headers | Out-Null
  Ok 'Default bucket exists'
} catch {
  try {
    Invoke-RestMethod -Method Post -Uri "https://firebasestorage.googleapis.com/v1beta/projects/$ProjectId/defaultBucket" `
      -Headers $headers -ContentType 'application/json' -Body '{}' | Out-Null
    Ok 'Default bucket created'
  } catch {
    Warn2 "Could not create the default bucket via API. Enable Storage once at https://console.firebase.google.com/project/$ProjectId/storage then re-run."
  }
}

# --- 7. Anonymous auth -------------------------------------------------------
Say 'Anonymous authentication'
try {
  Invoke-RestMethod -Method Patch `
    -Uri "https://identitytoolkit.googleapis.com/admin/v2/projects/$ProjectId/config?updateMask=signIn.anonymous.enabled" `
    -Headers $headers -ContentType 'application/json' -Body '{"signIn":{"anonymous":{"enabled":true}}}' | Out-Null
  Ok 'Anonymous sign-in enabled'
} catch {
  Warn2 "Could not enable Anonymous auth via API. Enable it once at https://console.firebase.google.com/project/$ProjectId/authentication/providers then re-run."
}

# --- 8. web app + local config ----------------------------------------------
Say 'Web app registration'
$appsOut = Invoke-Firebase @('apps:list', 'WEB', '--project', $ProjectId) 2>$null | Out-String
$appId = [regex]::Match($appsOut, '1:\d+:web:[a-f0-9]+').Value
if (-not $appId) {
  Invoke-Firebase @('apps:create', 'WEB', 'AI Video Studio', '--project', $ProjectId) | Out-Null
  $appsOut = Invoke-Firebase @('apps:list', 'WEB', '--project', $ProjectId) 2>$null | Out-String
  $appId = [regex]::Match($appsOut, '1:\d+:web:[a-f0-9]+').Value
}
if (-not $appId) { throw 'Could not find/register the web app' }
Ok "Web app: $appId"

Say 'Writing web/.env.local and .firebaserc'
$sdkJson = Invoke-Firebase @('apps:sdkconfig', 'WEB', $appId, '--project', $ProjectId, '--json') | Out-String
$parsed = $sdkJson | ConvertFrom-Json
$c = if ($parsed.result.sdkConfig) { $parsed.result.sdkConfig } elseif ($parsed.result) { $parsed.result } else { $parsed }
$bucket = if ($c.storageBucket) { $c.storageBucket } else { "$($c.projectId).firebasestorage.app" }
@(
  "VITE_FIREBASE_API_KEY=$($c.apiKey)"
  "VITE_FIREBASE_AUTH_DOMAIN=$($c.authDomain)"
  "VITE_FIREBASE_PROJECT_ID=$($c.projectId)"
  "VITE_FIREBASE_STORAGE_BUCKET=$bucket"
  "VITE_FIREBASE_MESSAGING_SENDER_ID=$($c.messagingSenderId)"
  "VITE_FIREBASE_APP_ID=$($c.appId)"
  'VITE_USE_EMULATORS=false'
  "VITE_FUNCTIONS_REGION=$Region"
) | Set-Content "$RepoDir/web/.env.local"
@{ projects = @{ default = $ProjectId } } | ConvertTo-Json | Set-Content "$RepoDir/.firebaserc"
Ok 'Local config written'

# --- 9. secrets --------------------------------------------------------------
Setup-Secrets

# --- 10. deploy --------------------------------------------------------------
Say 'Build & deploy'
Push-Location "$RepoDir/functions"; npm install; npm run build; Pop-Location
Push-Location "$RepoDir/web";       npm install; npm run build; Pop-Location
Push-Location $RepoDir; Invoke-Firebase @('deploy', '--project', $ProjectId); Pop-Location

Say 'Done'
Write-Host "App:            https://$ProjectId.web.app"
Write-Host "Console:        https://console.firebase.google.com/project/$ProjectId"
Write-Host "Secret Manager: https://console.cloud.google.com/security/secret-manager?project=$ProjectId"
Write-Host "Secrets only:   ./scripts/setup-gcp.ps1 -ProjectId $ProjectId -SecretsOnly"
