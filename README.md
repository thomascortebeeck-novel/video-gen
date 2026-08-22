# AI Video Studio

Turn a few photos and a one-paragraph idea into a multi-scene AI film.

Upload images of people and/or products → the system writes locked **character/product sheets**, generates **angle reference images** (master-first so the design can't drift), builds a full **director's briefing** in Dan Kieft's Seedance 2.5 advanced prompt format (`[GOAL] [REFERENCE MATERIAL] [CONTINUITY] [STAGES] [VISUAL STYLE] [CAMERA AND PERFORMANCE] [AUDIO] [EXCLUSIONS] [MAINTAIN CONSISTENCY]`) — you review and edit everything — then generates each scene on **Higgsfield** and stitches the clips into one film.

**Stack:** Firebase (Hosting, Auth, Firestore, Storage, Cloud Functions v2 / Node 22) · React + Vite + Tailwind · Claude (`claude-opus-5`) as the director · Higgsfield platform API for image/video generation · ElevenLabs for per-character voices (v2 feature, scaffolded).

---

## How it works

```
photos + story form
      │
      ▼
1. analyzeSubjects   Claude vision writes the character/product sheet:
      │              identity block, physique (with numbers), wardrobe,
      │              purpose line, materials, negations — locked wording
      │              that is reused VERBATIM in every later prompt.
      ▼
2. planBriefing      Claude (as director/cinematographer/editor) produces:
      │              style bible · audio plan · voice casting · environments ·
      │              scene-by-scene advanced-template fields · stitching plan
      ▼
3. asset pass        Angle images per subject (master first, then each angle
      │              referencing the master), environment refs per location,
      │              optional ElevenLabs voice sample per character.
      ▼
4. YOU review        Every field is editable; prompts reassemble live.
      │              Accept the briefing to unlock production.
      ▼
5. generateScene     Per scene: resolve references → assemble the prompt →
      │              Higgsfield job → poll → store MP4. Stitching modes:
      │              • hard_cut      new setup
      │              • frame_bridge  last frame of prev = first frame of next
      │              • extend_prev   Seedance 2.5 video extension
      ▼
6. assembleFinal     ffmpeg concat: trims duplicated boundary frames on
                     bridged joins, loudness-normalises audio, one encode.
```

### Angle sets (what gets generated per subject)

- **Characters** — *fast set (default)*: 8 images = 4 full-body (front★ master, ¾, side, back) + 4 close-ups (front, ¾, side, back of head). *Full set*: 12 (8 full-body at 45° increments + 4 close-ups). *Minimal*: 4. Community/expert consensus is 3–5 refs per subject **per video generation**; the set exists so the director can pick the right views per scene (close-ups for dialogue, back views when the camera follows, etc.).
- **Products** — auto by type: footwear 6 (side★, ¾, top, underside, front, back) · garment 4–5 · handheld prop 4 · furniture 5–6 · vehicle 6–8. Master = flattest orthographic view (a designer's first drawing), because the ¾ hero shot foreshortens and everything generated from it inherits the distortion.

---

## ⚠ Where Seedance 2.5 is actually available via API (verified 2026-08-22)

Higgsfield's consumer app/CLI/MCP has Seedance 2.5, but their **API-key REST platform still ships Seedance v1 only** (2.5 REST "pre-launch"). Four other platforms serve real Seedance 2.5 REST APIs today — full comparison for our use case (≈8 image refs/scene, native audio + lip-sync, voice via audio ref, start-frame stitching, extend, EU billing):

| | **BytePlus ModelArk** (official ByteDance) | **fal.ai** | Replicate | WaveSpeed |
|---|---|---|---|---|
| 720p price | **≈$0.23/s** | ≈$0.47/s (2× official) | ≈$0.23/s | $0.36/s |
| 1080p | ✓ (~$0.41/s promo) | ✓ (~$1.10/s) | ✗ (720p max) | ✓ ($0.90/s) |
| 30 image + 10 audio + 10 video refs | ✓ | ✓ | ✓ | ✓ |
| First+last frame | ✓ (roles) | ✓ (i2v `end_image_url`) | ✓ | ✓ |
| Extend | ✓ forward **and backward**, multi-round | ✓ via video ref + continuation prompt | ✓ (pricier flat rate) | ✓ dedicated `/video-extend` |
| `return_last_frame` (stitching helper) | **✓** | ✗ | ✗ | ✗ |
| Setup friction | $30 min top-up, SG entity, card/PayPal | none (Stripe) | none | none |

(Resellers with 2.5 — kie.ai, Segmind, PiAPI, MuAPI — exist but are second-tier: sync-only, gated, or unofficial reverse-engineered access.)

**Both top options are implemented as engines.** The abstraction (`functions/src/config.ts`) picks the best available:

| Engine | Provider | Status |
|---|---|---|
| `seedance25` | Higgsfield 2.5 | Adapter ready — set `SEEDANCE25_PATH` when their REST ships; verify `buildSeedance25Body()` |
| `seedance25_ark` | **BytePlus ModelArk** — `dreamina-seedance-2-5-260628`, official + cheapest, 1080p, native fwd/back extension | **Works today** — set the `ARK_API_KEY` secret ([console](https://console.byteplus.com), needs ≥$30 balance to unlock 2.5) |
| `seedance25_fal` | **fal.ai** — same features, best DX, zero signup friction | **Works today** — set the `FAL_KEY` secret ([keys](https://fal.ai/dashboard/keys)) |
| `seedance1` | Higgsfield v1 keyframe pipeline (nano-banana start frame → i2v), 12s cap, silent | Works today |
| `mock` | Local ffmpeg placeholders — full pipeline testable free | Automatic |

`VIDEO_ENGINE` in `functions/.env`: `auto` (default — Higgsfield 2.5 → ModelArk → fal → Higgsfield v1 → mock) or force `seedance25` / `ark25` / `fal25` / `seedance1`. The Claude director is told which engine is active and plans accordingly. Notes: angle/environment/keyframe **images** still generate on Higgsfield (nano-banana), so keep Higgsfield keys for the asset pass; ModelArk result URLs expire after 24h and fal's after ~1h — the pipeline always copies results into Firebase Storage immediately, and the "Refresh status" recovery should be used promptly rather than days later.

---

## Setup — one script does everything

### 0. Prerequisites

- Node 22 (`brew install node@22`) · Java for the emulator (`brew install openjdk`) · gcloud CLI (`brew install --cask gcloud-cli`)
- `npm install` in the repo root, `functions/`, and `web/`

### 1. Log in (one-time, interactive)

```bash
gcloud auth login
```

```bash
npx firebase login
```

### 2. Provision + deploy everything

```bash
./scripts/setup-gcp.sh my-video-studio-prod
```

The script is idempotent (safe to re-run) and does: project creation → billing link → API enablement → Firebase add-on → Firestore (`eur3`) → Storage default bucket → Anonymous auth → web-app registration (writes `web/.env.local` + `.firebaserc`) → **secrets in Google Cloud Secret Manager** → build + deploy. Anything it can't do via API prints the exact console link and keeps going.

**PowerShell instead of bash?** Same thing: `./scripts/setup-gcp.ps1 -ProjectId my-video-studio-prod` — works in PowerShell 7+ on Windows, macOS (`brew install --cask powershell@preview`), or Linux. The gcloud/firebase CLIs are shell-agnostic, so both scripts run identical commands; on a Mac the bash script is the zero-extra-install path.

### Secrets live in Google Cloud Secret Manager

All API keys (`HIGGSFIELD_API_KEY`, `HIGGSFIELD_API_SECRET`, `ANTHROPIC_API_KEY`, `ELEVENLABS_API_KEY`, `FAL_KEY`) are stored as native [Secret Manager](https://console.cloud.google.com/security/secret-manager) secrets; Cloud Functions v2 mounts them at runtime via `defineSecret`, and the setup script grants the runtime service account `roles/secretmanager.secretAccessor` per secret. (Note: `firebase functions:secrets:set` writes to the same Secret Manager under the hood — the script just manages them with `gcloud secrets` directly.) To rotate or add keys later:

```bash
./scripts/setup-gcp.sh my-video-studio-prod --secrets-only
```

Blank secrets are fine: each provider degrades to mock output so you can test the flow before adding keys. Redeploy functions after changing secret values (`npm run deploy:functions`) so instances pick up the new version.

### Manual deploys later

```bash
npm run deploy
```

(or `npm run deploy:functions` / `deploy:hosting` / `deploy:rules` individually). Functions deploy to **europe-west1** — change `REGION` in `functions/src/config.ts` and `VITE_FUNCTIONS_REGION` in `web/.env.local` together if you want another region.

### 4. Local development (no Firebase project needed)

```bash
npm --prefix functions run build
npx firebase emulators:start --project demo-videogen
# in a second terminal:
cd web && VITE_USE_EMULATORS=true VITE_FIREBASE_PROJECT_ID=demo-videogen npm run dev
```

Open http://localhost:5173. `functions/.env.local` sets `MOCK_MODE=true` for the emulator, so generation returns labelled placeholders instantly and the full pipeline (sheets → briefing → angles → scenes → final assembly) runs for free. Emulator UI: http://localhost:4000.

> Real API generation from the emulator works for text-only steps, but reference images are passed to Higgsfield as URLs, and emulator Storage URLs aren't publicly reachable — use a deployed environment for real video generation.

---

## Using the app

1. **New project** — add subjects (characters/products) with photos + notes, fill in the story (concept, who/what/where/when), duration, aspect ratio, style preset, dialogue and audio options. *Custom voice per character (ElevenLabs)* is the v2 feature toggle.
2. **Generate briefing** — sheets are written, then the director plans everything. Watch progress live.
3. **Briefing tab** — generate the angle sets and environment images (and voice samples), open any scene, edit any field (stages, camera, audio, stitch mode…), see the assembled Seedance prompt update live, or override it manually. Regenerate single angles you don't like.
4. **Accept briefing** → **Production tab** — generate scenes one by one or all remaining (sequential: bridged/extended scenes consume the previous scene's output). Regenerate takes as needed; "Refresh status" recovers jobs if a function timed out (the provider job keeps running server-side).
5. **Assemble final film** — one MP4, downloadable.

### Costs to expect (real engines)

- Angle images (nano-banana): cents per image; a character fast-set ≈ 8 images.
- Seedance video: on Higgsfield's consumer pricing ≈ $3.25/10s at 720p (2.5); use the `/estimate/...` endpoint (wired in `higgsfield.ts → estimateCost`) for exact platform-API pricing.
- Director pass (Claude `claude-opus-5`): typically a few tens of cents per briefing. Refusal fallback (`fallbacks: "default"`) is enabled by default on all director calls, so a safety decline automatically retries on a fallback model inside the same request — remove `fallbacks`/`betas` in `functions/src/claude.ts` if you don't want that.
- Voice design + samples (ElevenLabs): a few hundred credits per character.

---

## Repo layout

```
shared/types.ts        Domain model + angle-set definitions + storage paths
shared/assemble.ts     Deterministic prompt assembly (used by backend AND the
                       live prompt preview in the UI)
functions/src/
  config.ts            Region, engine registry/selection, secrets, params
  claude.ts            Director: vision analysis + briefing planning (structured output)
  higgsfield.ts        REST client: jobs, polling, image gen, video adapters
  elevenlabs.ts        Voice design + TTS (v2)
  media.ts             ffmpeg: last-frame extraction, concat w/ boundary trim +
                       loudnorm, mock assets, vision resize
  pipeline.ts          Orchestration for every step
  index.ts             Callable function exports
web/src/
  pages/               Dashboard, NewProject wizard, ProjectPage,
                       BriefingView, SceneEditor, ProductionView
  lib/                 Firebase init, callable wrappers, live hooks
firestore.rules        Per-user data isolation
storage.rules          Owner-only reads; image-only uploads ≤25MB
```

### Data model (Firestore, all under `users/{uid}/projects/{projectId}`)

- project doc — status, input, briefing (meta, style bible, audio plan, stitching plan, director's notes), progress, final video
- `subjects/{id}` — kind, source images, sheet (locked blocks + voice spec), angles[] with per-angle generation state
- `environments/{id}` — location refs
- `scenes/{id}` — advanced-template fields, stages, references, stitching mode + bridge frame, generation state, versions

---

## Roadmap / v2 ideas

- **ElevenLabs voices** (scaffolded): voice design + samples work now; attach samples as `@audio` refs once the Seedance 2.5 engine is live (v1 engine is silent). Post-production VO laydown (TTS with timestamps → ffmpeg mix) is the alternative path.
- Webhook-based job completion (`hf_webhook`) instead of in-function polling.
- Music generation (ElevenLabs music API) for a scored bed under the final assembly.
- Color-match pass across clips (shared LUT) before concat.
- Real auth providers (Google sign-in) — swap `signInAnonymously` in `web/src/lib/firebase.ts`.

---

## Prompting sources

The briefing engine encodes Dan Kieft's Seedance 2.5 Prompter (asset master-first workflow, the advanced video template, reference grammar "what to take / what to ignore", language-that-breaks-things list, end-state continuity) plus researched Seedance community practice (stage timing budgets, ≤8 subject refs per generation, extend-chain limits, frame-bridge stitching with boundary-frame trims, audio bracket syntax, camera vocabulary).
