# CLAUDE.md — operational knowledge for this repo

AI Video Studio: Firebase + React app that turns photos + a story form into
multi-scene AI films (character sheets → director briefing → angle images →
Seedance 2.5 scenes → ffmpeg assembly). Full product docs in [README.md](README.md).

## Deployment (live)

- Firebase project **`aiwebatelier-spine`** · account **thomas@aiwebatelier.com** · functions region **europe-west1**
- App: https://aiwebatelier-spine.web.app · Repo: https://github.com/thomascortebeeck-novel/video-gen
- Deploy: `npm run deploy` (or `deploy:functions` / `deploy:hosting`). Functions are v2/Node 22; `--force` avoids interactive prompts.
- Secrets live in **Google Cloud Secret Manager** (`HIGGSFIELD_API_KEY/SECRET`, `ANTHROPIC_API_KEY`, `ELEVENLABS_API_KEY`, `FAL_KEY`, `ARK_API_KEY`). Blank value = that provider runs mock. Set via `./scripts/setup-gcp.sh aiwebatelier-spine --secrets-only`, then redeploy functions. Local emulator reads `functions/.secret.local` (gitignored — holds the real ARK key; never commit).

## Engine system (functions/src/config.ts)

- Video `auto` order: Higgsfield Seedance 2.5 (needs `SEEDANCE25_PATH`, still unreleased) → **BytePlus ModelArk** (`ARK_API_KEY`, active today) → fal.ai (`FAL_KEY`) → Higgsfield v1 keyframe → mock. Force with `VIDEO_ENGINE` in `functions/.env`.
- Images (`activeImageProvider`): Higgsfield nano-banana → **ModelArk Seedream 5.0 Pro** (same ARK key, active today) → mock.
- Providers implement `VideoProvider` (functions/src/providers.ts); adapters: `ark.ts`, `fal.ts`, `higgsfield.ts`. Prompt assembly is deterministic in **shared/assemble.ts** (Dan Kieft advanced template) — the web UI renders live previews from the same code.

## Hard-won provider facts (do not rediscover)

- **ModelArk video** `dreamina-seedance-2-5-260628`, `POST {ARK_BASE_URL}/contents/generations/tasks`, content items carry roles (`reference_image|reference_audio|reference_video|first_frame|last_frame`). First/last-frame & extension need `ratio:"adaptive"`; extension needs continuation keywords + `omni_reference_task_type:"extend"`. Result URLs valid 24h/100 downloads — pipeline persists to Storage immediately. Models must be **activated** in the Ark console; Seedance 2.5 needs a **$30+ balance**. `BalanceNotEnough`/`ModelNotOpen` errors = console-side fixes.
- **Seedream 5.0 Pro images** `dola-seedream-5-0-pro-260628`, sync `POST /images/generations`, `image` = ref URL array (≤10), explicit sizes (`1536x2048` etc., area ≤ 4,624,220 px), `watermark:false`. It **rejects `sequential_image_generation`** entirely (Lite-only). Rate-limits fresh accounts hard → angle generation runs sequentially with backoff retries (pipeline.ts CONCURRENCY=1 for ark).
- **Reference tags**: internal format is lowercase `@image1` (Dan Kieft); adapters normalize on the wire — `@Image 1` for ModelArk, `@Image1` for fal. **Binding is by attachment order per modality** (Nth image = @Image N) — tags and URLs are built from one ordered list, so they cannot drift.
- **ModelArk privacy filter** (verified by probe 2026-08-22): Seedance *video* create-task rejects reference images with realistic faces — `InputImageSensitiveContentDetected.PrivacyInformation`, listing offending `content[i]` slots — **even for AI-generated faces**. Face close-ups (cu_*) fail; full-body angles of the same character pass; Seedream *image* gen accepts the same faces fine. The filter runs before the prompt is read (prompt disclaimers useless). `runGenerateScene` auto-recovers: drops exactly the flagged refs, rebuilds prompt (dense retagging), resubmits (≤3 tries), stores `generation.moderationNote`. Rejected creates bill nothing; running tasks cannot be cancelled (DELETE → 409, only `queued` can).
- **fal.ai**: queue API `queue.fal.run/bytedance/seedance-2.5/{variant}`; `duration` is a STRING enum ("4".."30"|"auto"); no seed input; r2v supports `audio_urls` (voice refs) and `video_urls` (extension via continuation prompt); results expire ~1h.
- **Costs** (720p): video ≈ $0.231/s on ModelArk (tokens = W×H×s×24/1024 × $10.70/M); 480p ≈ $0.10/s, 1080p ≈ $0.41/s. Seedream images ≈ $0.05–0.09 each. Only successful generations bill.

## GCP org quirks (aiwebatelier.com org)

- Compute SA gets **no default roles** — new projects need manual grants: `cloudbuild.builds.builder` (else builds fail), `datastore.user`, `storage.objectAdmin`, `logging.logWriter`, per-secret `secretmanager.secretAccessor`.
- **Domain Restricted Sharing** org policy blocks `allUsers` — callable functions need a project-level override of `iam.allowedPolicyMemberDomains` (allowAll) + `run.invoker` for `allUsers` on each service. Thomas holds org-policy-admin; the override persists on aiwebatelier-spine.
- First deploys can hit the gcf-v2-sources bucket 409 race (retry) and hosting uploaded-but-not-released (run `deploy --only hosting`).

## Director flow

- With `ANTHROPIC_API_KEY` blank, briefings/sheets are mock. Thomas prefers Claude **hand-directing in-session**: write sheets/environments/scenes/briefing straight into Firestore via REST with a gcloud user token (encode fields as typed values; PATCH with `updateMask.fieldPaths`). App user uid so far: `TOME9sRbSBYULrdL89kRABCry0z1` (anonymous — changes if browser storage clears). Wait for project `status: briefing_ready` before overwriting (the app's mock pipeline races otherwise).
- Craft rules for briefings live in `functions/src/claude.ts` (director system prompt) and mirror `docs/reference/` (local only, gitignored — Dan Kieft's guides; README links the originals).
- Scene docs must reference only **existing** angle ids (`shared/types.ts` angle sets) and environment doc ids; `subject_upload` refs use `sourceImagePaths[0]` and need no angle generation (used for the novel? mascot).

## Conventions

- Sheets' text blocks are reused **verbatim** across prompts — never reword identity/wardrobe/materials between scenes.
- One scene = one Seedance generation (4–30s); long films = multiple scenes stitched (hard cut / frame bridge / extend). Voiceover lines go in stage actions as `Voiceover — her/his voice: "…"` plus "mouths never sync" in continuity; lip-synced dialogue uses the stage `dialogue` field.
- Storage layout + Firestore paths: `shared/types.ts` (`storagePaths`, `collections`). Scene videos version as `v{n}.mp4`; every provider result is copied to Storage immediately.
