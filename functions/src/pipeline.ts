/**
 * Pipeline orchestration — the meat behind every callable.
 *
 * Flow: analyze subjects → plan briefing (creates envs + scenes + voice
 * casting) → generate angle sets (master first) + environment refs (+ voice
 * samples) → user accepts briefing → generate scenes (engine-aware, with
 * frame-bridge / extend stitching) → assemble final film.
 */
import { HttpsError } from 'firebase-functions/v2/https';
import {
  db, getProject, getSubjects, getSubject, getScenes, getScene,
  getEnvironments, getEnvironment, projectRef, setProgress,
  downloadToBuffer, saveBuffer, publicUrl,
} from './fire';
import {
  activeEngine, activeImageProvider, isForcedMock, MAX_IMAGE_REFS, EngineCaps,
} from './config';
import {
  anthropicConfigured, analyzeSubjectWithClaude, planBriefingWithClaude,
  describePrevizWithClaude, verifyTakeWithClaude, patchSceneFromNote, BriefingPlan,
} from './claude';
import { sttConfigured, transcribeTake, formatTranscript } from './stt';
import {
  submitImageJob, pollUntilDone, assertCompleted, higgsfieldVideoProvider,
} from './higgsfield';
import { falVideoProvider } from './fal';
import { arkVideoProvider, arkGenerateImage } from './ark';
import { openaiGenerateImage } from './openai_image';
import { waitForVideo, downloadUrl, VideoProvider } from './providers';
import { elevenLabsConfigured, designVoice, textToSpeech } from './elevenlabs';
import {
  makeMockImage, makeMockVideo, makeMockAudio, resizeForVision,
  extractLastFrame, extractFramesAtFps, buildContactSheet,
  concatVideos, ensureAudioTrack, ConcatItem, probeVideo, extractAudio,
} from './media';
import {
  buildCharacterMasterPrompt, buildProductMasterPrompt, buildAnglePrompt,
  buildEnvironmentPrompt, buildScenePrompt, buildKeyframePrompt, buildV1MotionPrompt,
  buildScreenTestPrompt, resolveReferenceTags, ResolvedRef,
} from '../../shared/assemble';
import {
  buildPrevizScript, buildPrevizRefLine, checkStageTiming, previzAllowed,
} from '../../shared/previz';
import {
  criteriaFor, applyScenePatches, patchableFields, isPatchableField,
  fieldLabel, SHARED_TEXT_FIELDS,
} from '../../shared/verify';
import { estimateCostUsd } from '../../shared/cost';
import type { SceneVerdict, VerdictIssue } from '../../shared/verify';
import type {
  ProjectDoc, SubjectDoc, SubjectAngle, SceneDoc, EnvironmentDoc,
  Briefing, GenerationInfo, SubjectSheet, CameraPlan, CameraMapEntry, ScenePreviz, PrevizFeed,
  ScenePatch, SceneTake,
} from '../../shared/types';
import { anglesForSubject, collections, storagePaths } from '../../shared/types';

const now = () => Date.now();

function videoProviderFor(caps: EngineCaps): VideoProvider {
  if (caps.provider === 'fal') return falVideoProvider();
  if (caps.provider === 'ark') return arkVideoProvider();
  return higgsfieldVideoProvider(caps);
}

// ---------------------------------------------------------------------------
// 1. Analyze subjects
// ---------------------------------------------------------------------------

function mockSheet(subject: SubjectDoc): SubjectSheet {
  const base = {
    roleName: subject.kind === 'character' ? `the ${subject.name.toLowerCase()}` : `the ${subject.name.toLowerCase()}`,
    oneLineRead: `${subject.name} — ${subject.notes || 'as uploaded'} (mock analysis: add API keys for a real sheet)`,
  };
  if (subject.kind === 'character') {
    return {
      ...base,
      identityBlock: 'Mid-30s with an open, approachable presence — dark brown hair, short and neatly kept, sitting close to the head; straight brows, attentive brown eyes, a defined jaw; light stubble; a face that reads calm and capable; real skin texture with visible pores.',
      physique: '178 cm, athletic build with square shoulders and an upright, easy posture.',
      wardrobe: 'A plain washed-navy cotton t-shirt that hangs loose; straight dark-grey trousers with a soft drape, lightly creased; simple white low-profile sneakers, lightly worn. NOT tight, NOT technical, no logos.',
      distinguishingMarks: 'A small faint scar above the left eyebrow.',
      negations: 'no hats, no glasses, no jewellery, no visible branding',
    };
  }
  return {
    ...base,
    productType: 'other',
    purposeLine: `${subject.name}, a product designed for everyday use — its purpose defines its clean, functional shape.`,
    silhouette: 'compact and balanced, with even visual weight',
    materialsAndColour: 'Primary body in matte moulded polymer, warm off-white; a soft-grey accent band around the base; subtle seams; light everyday wear. No logos, no branding, no text anywhere on the product.',
    hiddenSurfaces: 'The underside is completely flat, matte, and featureless — no tread pattern, no grooves, no texture.',
    negations: 'NOT glossy, NOT futuristic, NOT miniature, NOT toy-like',
  };
}

export async function runAnalyzeSubjects(uid: string, projectId: string): Promise<void> {
  const project = await getProject(uid, projectId);
  const subjects = await getSubjects(uid, projectId);
  if (subjects.length === 0) throw new HttpsError('failed-precondition', 'Add at least one subject (character or product) first.');

  await projectRef(uid, projectId).set({ status: 'analyzing', error: null, updatedAt: now() }, { merge: true });

  for (const subject of subjects) {
    if (subject.status === 'ready' || subject.status === 'analyzed') continue;
    const ref = db.collection(collections.subjects(uid, projectId)).doc(subject.id);
    await ref.set({ status: 'analyzing', error: null, updatedAt: now() }, { merge: true });
    await setProgress(uid, projectId, 'analyze', `Reading ${subject.name}'s photos and writing the ${subject.kind} sheet…`);
    try {
      let sheet: SubjectSheet;
      if (anthropicConfigured() && !isForcedMock()) {
        const images = [] as { data: Buffer; mediaType: 'image/jpeg' }[];
        for (const p of subject.sourceImagePaths.slice(0, 4)) {
          const raw = await downloadToBuffer(p);
          images.push({ data: await resizeForVision(raw), mediaType: 'image/jpeg' });
        }
        if (images.length === 0) throw new Error('No source images uploaded for this subject.');
        sheet = await analyzeSubjectWithClaude(subject, images);
      } else {
        sheet = mockSheet(subject);
      }
      const angles: SubjectAngle[] = anglesForSubject(subject.kind, subject.angleSet, sheet.productType)
        .map((t) => ({
          id: t.id, label: t.label, framing: t.framing, isMaster: t.isMaster ?? false,
          generation: { status: 'idle' } as GenerationInfo,
        }));
      await ref.set({ sheet, angles, status: 'analyzed', updatedAt: now() }, { merge: true });
    } catch (e) {
      await ref.set({ status: 'error', error: String((e as Error).message ?? e), updatedAt: now() }, { merge: true });
      throw e;
    }
  }
  await projectRef(uid, projectId).set({ status: project.briefing ? 'briefing_ready' : 'analyzing', updatedAt: now() }, { merge: true });
}

// ---------------------------------------------------------------------------
// 2. Plan briefing
// ---------------------------------------------------------------------------

function mockPlan(project: ProjectDoc, subjects: SubjectDoc[]): BriefingPlan {
  const caps = activeEngine(project.input.videoEngine);
  const total = project.input.durationSec;
  const nScenes = Math.max(1, Math.ceil(total / caps.maxClipSeconds));
  const per = Math.max(caps.minClipSeconds, Math.min(caps.maxClipSeconds, Math.round(total / nScenes)));
  const subjRefs = (sceneIdx: number) => subjects.flatMap((s) => {
    const master = anglesForSubject(s.kind, s.angleSet, s.sheet?.productType).find((a) => a.isMaster);
    const second = anglesForSubject(s.kind, s.angleSet, s.sheet?.productType).find((a) => !a.isMaster);
    const mk = (angleId: string, label: string) => ({
      kind: 'subject_angle' as const, subjectId: s.id, angleId,
      use: `${s.sheet?.roleName ?? s.name}, ${label}. Appearance exactly per ref.`,
      ignore: 'Do not use the image background.',
    });
    return [master ? mk(master.id, master.label.toLowerCase()) : null, sceneIdx === 0 && second ? mk(second.id, second.label.toLowerCase()) : null]
      .filter((x): x is NonNullable<typeof x> => x !== null);
  });
  const where = project.input.where || 'a bright, believable everyday location';
  return {
    meta: { title: project.title || 'Untitled film', logline: project.input.concept.slice(0, 140) },
    styleBible: {
      look: 'Cinematic large-format clarity, deep focus',
      colourPalette: 'warm amber, soft ivory and deep charcoal',
      lighting: 'soft natural key light with gentle falloff',
      grainAndTexture: 'fine true film grain',
      mood: 'confident and warm',
      technicalLine: 'Cinematic large-format clarity, deep focus, warm amber and soft ivory palette, soft natural key light, fine true film grain.',
    },
    audioPlan: {
      music: project.input.audio.music ? 'Understated instrumental bed, dropping out under dialogue' : undefined,
      soundEffects: project.input.audio.sfx ? ['ambient movement', 'natural contact sounds'] : [],
      ambience: project.input.audio.ambience ? `Live sound of ${where}` : undefined,
      subtitles: project.input.audio.subtitles,
      dialogueLanguage: project.input.dialogueEnabled ? 'English' : undefined,
    },
    voiceCasting: project.input.audio.characterVoices
      ? subjects.filter((s) => s.kind === 'character').map((s) => ({
        subjectId: s.id,
        voice: { language: 'English', accent: 'neutral', delivery: 'warm, natural, conversational', designDescription: 'A warm natural adult voice, mid-range, unhurried and friendly.' },
      }))
      : [],
    environments: [{
      key: 'main_location', name: where,
      description: `${where} — believable materials, depth, and a clear light direction.`,
      refPrompt: 'Wide establishing view, eye level, natural perspective.',
      type: 'location' as const,
    }],
    scenes: Array.from({ length: nScenes }, (_, i) => {
      const dur = i === nScenes - 1 ? Math.max(caps.minClipSeconds, total - per * (nScenes - 1)) : per;
      return {
        title: `Scene ${i + 1}`,
        beatSummary: `Beat ${i + 1} of the story: ${project.input.concept.slice(0, 80)}`,
        durationSec: Math.min(dur, caps.maxClipSeconds),
        mode: 'stages' as const,
        goal: `${project.input.concept} (part ${i + 1} of ${nScenes}).`,
        continuity: `${subjects.map((s) => `${s.sheet?.roleName ?? s.name}: appearance and wardrobe exactly per references, unchanged throughout.`).join(' ')} Scene: ${where}, one lighting setup, the same from start to finish.`,
        stages: [
          { index: 1, t0: 0, t1: Math.round(dur / 2), beatName: 'Opening', action: `Wide shot establishing ${where}; the subject enters frame and settles into the moment.`, endState: 'Subject centred, at rest, facing frame-right.', cut: 'NO CUT' as const },
          { index: 2, t0: Math.round(dur / 2), t1: dur, beatName: 'Development', action: 'Medium shot; the subject performs the key action of this beat, one clear movement at a time.', endState: 'Action completed; subject holds position.', cut: 'CUT' as const },
        ],
        visualStyle: 'Cinematic large-format clarity, deep focus, warm amber and soft ivory palette, soft natural key light, fine true film grain.',
        cameraAndPerformance: 'Calm, held shots with one slow push-in motivated by the action — no whip pans, no crash zooms. Performance reads through small, controlled physical cues.',
        audio: `${project.input.audio.music ? '(Understated instrumental bed, low under everything) ' : 'no music '}<natural contact sounds at each action> Ambience: ${project.input.audio.ambience ? `live sound of ${where}` : 'quiet room tone'}. Subtitles: ${project.input.audio.subtitles ? 'on' : 'off'}.`,
        exclusions: 'No brand logos, no on-screen text, no extra people, no watermarks.',
        keepConsistent: `${subjects.map((s) => `same ${s.sheet?.roleName ?? s.name} throughout (face, clothing, props)`).join('; ')}; same location and lighting throughout; spatial directions stay fixed.`,
        references: [
          ...subjRefs(i),
          { kind: 'environment' as const, envKey: 'main_location', use: `${where}. Space, materials and lighting only.`, ignore: 'Do not use any people from the image.' },
        ],
        // Mock mode still exercises the previz path end to end: the opening
        // scene gets a real, runnable camera plan (push in, then turn onto
        // the subject) so the Blender step can be tested without any keys.
        cameraComplexity: (i === 0 ? 'complex' : 'simple') as 'complex' | 'simple',
        previzRecommended: i === 0 && (project.input.previz ?? 'auto') !== 'off',
        previzReason: i === 0
          ? 'The camera changes subject mid-shot — worth blocking out before spending a generation.'
          : 'A single held shot with one slow push-in; prose describes it completely.',
        ...(i === 0 && (project.input.previz ?? 'auto') !== 'off' ? {
          cameraPlan: {
            durationSec: Math.min(dur, caps.maxClipSeconds),
            intent: 'Opens wide on the room, pushes in slowly and level, then turns to settle on the subject.',
            set: [
              { id: 'floor', kind: 'plane' as const, label: 'the floor', pos: [0, 0, 0], size: [12, 12, 1] },
              { id: 'back_wall', kind: 'box' as const, label: 'the back wall', pos: [0, 5, 1.5], size: [12, 0.2, 3] },
              { id: 'table', kind: 'box' as const, label: 'the table', pos: [0, 1.2, 0.38], size: [1.6, 0.8, 0.75] },
              { id: 'subject', kind: 'figure' as const, label: 'the subject', pos: [0.6, 2.0, 0.875], size: [0.5, 0.3, 1.75], rotZdeg: 180 },
            ],
            camera: [
              { t: 0, pos: [0, -5.5, 1.6], lookAt: [0, 1.2, 1.1], focalMm: 28, note: 'holds the wide opening angle' },
              { t: Math.round(Math.min(dur, caps.maxClipSeconds) / 2), pos: [0, -2.6, 1.6], lookAt: [0, 1.2, 1.1], focalMm: 35, note: 'slow push in, level' },
              { t: Math.min(dur, caps.maxClipSeconds), pos: [-0.4, -1.6, 1.6], lookAt: [0.6, 2.0, 1.5], focalMm: 50, easing: 'smooth' as const, note: 'turns and settles on the subject' },
            ],
          },
        } : {}),
        stitchMode: i === 0 ? ('hard_cut' as const) : ('frame_bridge' as const),
        stitchNotes: i === 0 ? 'Opening scene.' : 'Continues directly from the previous scene\'s final frame; motion carries forward.',
      };
    }),
    stitchingPlan: {
      boundaries: Array.from({ length: Math.max(0, nScenes - 1) }, (_, i) => ({
        fromSceneIndex: i, toSceneIndex: i + 1, mode: 'frame_bridge' as const,
        rationale: 'Continuous action across the boundary; last frame feeds the next scene\'s first frame.',
      })),
      assemblyNotes: 'Hard concat with boundary-frame trim on bridged joins; loudness-normalised audio; one shared grade.',
    },
    directorsNotes: ['Mock briefing (no API keys configured) — add ANTHROPIC_API_KEY for a real director pass.'],
  };
}

export async function runPlanBriefing(uid: string, projectId: string): Promise<void> {
  const project = await getProject(uid, projectId);
  const subjects = await getSubjects(uid, projectId);
  const notReady = subjects.filter((s) => s.status !== 'analyzed' && s.status !== 'ready' && s.status !== 'generating_angles');
  if (notReady.length > 0) {
    throw new HttpsError('failed-precondition', `Analyze subjects first (${notReady.map((s) => s.name).join(', ')}).`);
  }
  const caps = activeEngine(project.input.videoEngine);
  await projectRef(uid, projectId).set({ status: 'briefing_generating', error: null, updatedAt: now() }, { merge: true });
  await setProgress(uid, projectId, 'briefing', 'The director is planning your film: style bible, scenes, camera, audio and stitching…');

  try {
    const plan: BriefingPlan = (anthropicConfigured() && !isForcedMock())
      ? await planBriefingWithClaude({ project, subjects, caps })
      : mockPlan(project, subjects);

    // Merge voice casting into subject sheets
    for (const cast of plan.voiceCasting) {
      const subj = subjects.find((s) => s.id === cast.subjectId);
      if (!subj?.sheet) continue;
      await db.collection(collections.subjects(uid, projectId)).doc(subj.id).set(
        { sheet: { ...subj.sheet, voice: { ...cast.voice } }, updatedAt: now() }, { merge: true },
      );
    }

    // Replace environments
    const envCol = db.collection(collections.environments(uid, projectId));
    const oldEnvs = await envCol.get();
    const batch1 = db.batch();
    oldEnvs.docs.forEach((d) => batch1.delete(d.ref));
    await batch1.commit();
    for (const env of plan.environments) {
      const doc: EnvironmentDoc = {
        id: env.key, name: env.name, description: env.description, refPrompt: env.refPrompt,
        type: env.type ?? 'location',
        generation: { status: 'idle' }, createdAt: now(), updatedAt: now(),
      };
      await envCol.doc(env.key).set(doc);
    }

    // Replace scenes
    const sceneCol = db.collection(collections.scenes(uid, projectId));
    const oldScenes = await sceneCol.get();
    const batch2 = db.batch();
    oldScenes.docs.forEach((d) => batch2.delete(d.ref));
    await batch2.commit();
    for (let i = 0; i < plan.scenes.length; i++) {
      const s = plan.scenes[i];
      const id = `scene_${String(i + 1).padStart(2, '0')}`;
      const doc: SceneDoc = {
        id, index: i, title: s.title, beatSummary: s.beatSummary,
        durationSec: Math.max(caps.minClipSeconds, Math.min(caps.maxClipSeconds, s.durationSec)),
        mode: s.mode,
        goal: s.goal, continuity: s.continuity,
        stages: s.stages.map((st) => ({ ...st })),
        ...(s.continuousAction ? { continuousAction: s.continuousAction } : {}),
        visualStyle: s.visualStyle, cameraAndPerformance: s.cameraAndPerformance,
        audio: s.audio, exclusions: s.exclusions, keepConsistent: s.keepConsistent,
        references: s.references.map((r) => ({
          tag: '', kind: r.kind === 'environment' ? 'environment' : r.kind === 'style' ? 'style' : r.kind === 'subject_video' ? 'subject_video' : 'subject_angle',
          ...(r.subjectId ? { subjectId: r.subjectId } : {}),
          ...(r.angleId ? { angleId: r.angleId } : {}),
          ...(r.envKey ? { envId: r.envKey } : {}),
          use: r.use, ...(r.ignore ? { ignore: r.ignore } : {}),
        })),
        ...(s.cameraComplexity ? { cameraComplexity: s.cameraComplexity } : {}),
        ...(s.previzRecommended !== undefined ? { previzRecommended: s.previzRecommended } : {}),
        ...(s.previzReason ? { previzReason: s.previzReason } : {}),
        ...(previzDocFor(project, s)),
        stitching: {
          mode: (!caps.extend && s.stitchMode === 'extend_prev') ? 'frame_bridge' : s.stitchMode,
          notes: s.stitchNotes,
        },
        generation: { status: 'idle' },
        createdAt: now(), updatedAt: now(),
      };
      await sceneCol.doc(id).set(doc);
    }

    // Voice refs: if voices are enabled, attach voice_audio references for speaking characters
    if (project.input.audio.characterVoices && caps.videoRefs) {
      const scenesSnap = await sceneCol.orderBy('index').get();
      for (const d of scenesSnap.docs) {
        const scene = d.data() as SceneDoc;
        const speakers = new Set(scene.stages.filter((st) => st.dialogue).map((st) => st.dialogue!.subjectId));
        const refs = [...scene.references];
        for (const speakerId of speakers) {
          const subj = subjects.find((s) => s.id === speakerId);
          if (!subj) continue;
          refs.push({
            tag: '', kind: 'voice_audio', subjectId: speakerId,
            use: `Voice reference for ${subj.sheet?.roleName ?? subj.name}. Match this voice exactly for their dialogue.`,
            ignore: 'Do not use any other audio from it.',
          });
        }
        await d.ref.set({ references: refs, updatedAt: now() }, { merge: true });
      }
    }

    const briefing: Briefing = {
      meta: {
        title: plan.meta.title, logline: plan.meta.logline,
        durationSec: project.input.durationSec,
        aspectRatio: project.input.aspectRatio,
        resolution: project.input.resolution,
        videoModel: caps.label,
      },
      styleBible: plan.styleBible,
      audioPlan: { ...plan.audioPlan, voicesEnabled: project.input.audio.characterVoices },
      stitchingPlan: plan.stitchingPlan,
      directorsNotes: plan.directorsNotes,
    };
    await projectRef(uid, projectId).set({
      briefing, title: plan.meta.title, status: 'briefing_ready',
      progress: { step: 'briefing', message: 'Briefing ready for review.' },
      updatedAt: now(),
    }, { merge: true });
  } catch (e) {
    await projectRef(uid, projectId).set({
      status: 'error', error: String((e as Error).message ?? e), updatedAt: now(),
    }, { merge: true });
    throw e;
  }
}

// ---------------------------------------------------------------------------
// 3. Angle image generation (master first, then the rest)
// ---------------------------------------------------------------------------

async function generateOneImage(opts: {
  uid: string; projectId: string; prompt: string; refPaths: string[];
  outPath: string; label: string; aspectRatio: '3:4' | '1:1' | '16:9' | '9:16';
}): Promise<void> {
  const provider = activeImageProvider();
  if (provider === 'mock') {
    const img = await makeMockImage(opts.label, opts.aspectRatio === '3:4' ? '3:4' : opts.aspectRatio);
    await saveBuffer(opts.outPath, img, 'image/png');
    return;
  }
  const refUrls: string[] = [];
  for (const p of opts.refPaths.slice(0, MAX_IMAGE_REFS)) refUrls.push(await publicUrl(p));
  if (provider === 'openai') {
    // GPT Image 2 — best identity edits and in-image text rendering.
    const buf = await openaiGenerateImage({ prompt: opts.prompt, refUrls, aspectRatio: opts.aspectRatio });
    await saveBuffer(opts.outPath, buf, 'image/png');
    return;
  }
  if (provider === 'ark') {
    // Seedream 5.0 Pro — synchronous, same ARK key as video generation.
    const buf = await arkGenerateImage({ prompt: opts.prompt, refUrls, aspectRatio: opts.aspectRatio });
    await saveBuffer(opts.outPath, buf, 'image/png');
    return;
  }
  const submit = await submitImageJob({ prompt: opts.prompt, refUrls, aspectRatio: opts.aspectRatio });
  const status = await pollUntilDone(submit.request_id, { maxMs: 10 * 60 * 1000 });
  assertCompleted(status, opts.label);
  const url = status.images?.[0]?.url;
  if (!url) throw new Error(`${opts.label}: no image in result`);
  const buf = await downloadUrl(url);
  await saveBuffer(opts.outPath, buf, 'image/png');
}

async function writeAngles(uid: string, projectId: string, subjectId: string, angles: SubjectAngle[]): Promise<void> {
  await db.collection(collections.subjects(uid, projectId)).doc(subjectId)
    .set({ angles, updatedAt: now() }, { merge: true });
}

export async function runGenerateAngles(uid: string, projectId: string, subjectId: string): Promise<void> {
  const subject = await getSubject(uid, projectId, subjectId);
  if (!subject.sheet) throw new HttpsError('failed-precondition', 'Analyze this subject first.');
  const subjRef = db.collection(collections.subjects(uid, projectId)).doc(subjectId);
  await subjRef.set({ status: 'generating_angles', error: null, updatedAt: now() }, { merge: true });

  const angles = subject.angles.map((a) => ({ ...a }));
  const master = angles.find((a) => a.isMaster);
  if (!master) throw new HttpsError('internal', 'No master angle defined.');
  const hasPhoto = subject.sourceImagePaths.length > 0;
  const portrait = '3:4' as const;

  try {
    // 1. Master first — locks the design.
    if (master.generation.status !== 'completed') {
      master.generation = { status: 'generating', startedAt: now() };
      master.prompt = subject.kind === 'character'
        ? buildCharacterMasterPrompt(subject, hasPhoto)
        : buildProductMasterPrompt(subject, anglesForSubject('product', 'product_auto', subject.sheet.productType).find((a) => a.isMaster)?.angleWording ?? 'shown in a direct front view', hasPhoto);
      await writeAngles(uid, projectId, subjectId, angles);
      await setProgress(uid, projectId, 'angles', `${subject.name}: generating the master angle…`);
      const outPath = storagePaths.angle(uid, projectId, subjectId, master.id);
      await generateOneImage({
        uid, projectId, prompt: master.prompt,
        refPaths: hasPhoto ? subject.sourceImagePaths.slice(0, 3) : [],
        outPath, label: `${subject.name} — master`, aspectRatio: portrait,
      });
      master.imagePath = outPath;
      master.generation = { status: 'completed', completedAt: now() };
      await writeAngles(uid, projectId, subjectId, angles);
    }

    // 2. Remaining angles reference the master (+ face photo on close-ups).
    const rest = angles.filter((a) => !a.isMaster && a.generation.status !== 'completed');
    const masterPath = master.imagePath!;
    const facePhoto = subject.kind === 'character' && hasPhoto ? subject.sourceImagePaths[0] : undefined;
    let done = angles.filter((a) => a.generation.status === 'completed').length;

    // Higgsfield tolerates a few parallel jobs; ModelArk's image endpoint
    // rate-limits fresh accounts hard — go sequential there. OpenAI sits in
    // between (per-org image rate limits, images take up to ~2 min each).
    const imgProvider = activeImageProvider();
    const CONCURRENCY = imgProvider === 'ark' ? 1 : imgProvider === 'openai' ? 2 : 3;
    const queue = [...rest];
    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      for (;;) {
        const angle = queue.shift();
        if (!angle) return;
        angle.generation = { status: 'generating', startedAt: now() };
        const includeFace = angle.framing === 'close_up' && Boolean(facePhoto);
        angle.prompt = buildAnglePrompt(subject, angle, includeFace);
        await writeAngles(uid, projectId, subjectId, angles);
        try {
          const outPath = storagePaths.angle(uid, projectId, subjectId, angle.id);
          await generateOneImage({
            uid, projectId, prompt: angle.prompt,
            refPaths: includeFace && facePhoto ? [masterPath, facePhoto] : [masterPath],
            outPath, label: `${subject.name} — ${angle.label}`, aspectRatio: portrait,
          });
          angle.imagePath = outPath;
          angle.generation = { status: 'completed', completedAt: now() };
        } catch (e) {
          angle.generation = { status: 'failed', error: String((e as Error).message ?? e) };
        }
        done += 1;
        await setProgress(uid, projectId, 'angles', `${subject.name}: ${done}/${angles.length} angle images done`, Math.round((done / angles.length) * 100));
        await writeAngles(uid, projectId, subjectId, angles);
      }
    });
    await Promise.all(workers);

    const anyFailed = angles.some((a) => a.generation.status === 'failed');
    await subjRef.set({ status: anyFailed ? 'analyzed' : 'ready', updatedAt: now() }, { merge: true });
  } catch (e) {
    await subjRef.set({ status: 'error', error: String((e as Error).message ?? e), updatedAt: now() }, { merge: true });
    throw e;
  }
}

export async function runGenerateSingleAngle(uid: string, projectId: string, subjectId: string, angleId: string): Promise<void> {
  const subject = await getSubject(uid, projectId, subjectId);
  if (!subject.sheet) throw new HttpsError('failed-precondition', 'Analyze this subject first.');
  const angles = subject.angles.map((a) => ({ ...a }));
  const angle = angles.find((a) => a.id === angleId);
  if (!angle) throw new HttpsError('not-found', `Angle ${angleId} not found.`);
  const master = angles.find((a) => a.isMaster);
  const hasPhoto = subject.sourceImagePaths.length > 0;

  angle.generation = { status: 'generating', startedAt: now() };
  await writeAngles(uid, projectId, subjectId, angles);
  try {
    const outPath = storagePaths.angle(uid, projectId, subjectId, angle.id);
    if (angle.isMaster) {
      angle.prompt = subject.kind === 'character'
        ? buildCharacterMasterPrompt(subject, hasPhoto)
        : buildProductMasterPrompt(subject, anglesForSubject('product', 'product_auto', subject.sheet.productType).find((a) => a.isMaster)?.angleWording ?? 'shown in a direct front view', hasPhoto);
      await generateOneImage({
        uid, projectId, prompt: angle.prompt,
        refPaths: hasPhoto ? subject.sourceImagePaths.slice(0, 3) : [],
        outPath, label: `${subject.name} — master`, aspectRatio: '3:4',
      });
    } else {
      if (!master?.imagePath) throw new HttpsError('failed-precondition', 'Generate the master angle first.');
      const includeFace = angle.framing === 'close_up' && subject.kind === 'character' && hasPhoto;
      angle.prompt = buildAnglePrompt(subject, angle, includeFace);
      await generateOneImage({
        uid, projectId, prompt: angle.prompt,
        refPaths: includeFace ? [master.imagePath, subject.sourceImagePaths[0]] : [master.imagePath],
        outPath, label: `${subject.name} — ${angle.label}`, aspectRatio: '3:4',
      });
    }
    angle.imagePath = outPath;
    angle.generation = { status: 'completed', completedAt: now() };
  } catch (e) {
    angle.generation = { status: 'failed', error: String((e as Error).message ?? e) };
    await writeAngles(uid, projectId, subjectId, angles);
    throw e;
  }
  await writeAngles(uid, projectId, subjectId, angles);
}

// ---------------------------------------------------------------------------
// 3b. Character screen test — the video master (identity + voice anchor).
// Text-to-video only (no image refs), so it passes the platforms' real-person
// input moderation; the resulting clip anchors every scene as a @video ref.
// ---------------------------------------------------------------------------

export async function runGenerateScreenTest(uid: string, projectId: string, subjectId: string): Promise<void> {
  const project = await getProject(uid, projectId);
  const subject = await getSubject(uid, projectId, subjectId);
  if (subject.kind !== 'character') throw new HttpsError('failed-precondition', 'Screen tests are for characters — products use angle images.');
  if (!subject.sheet) throw new HttpsError('failed-precondition', 'Analyze this subject first.');
  const caps = activeEngine(project.input.videoEngine);
  const subjRef = db.collection(collections.subjects(uid, projectId)).doc(subjectId);
  const durationSec = Math.max(caps.minClipSeconds, Math.min(8, caps.maxClipSeconds));
  const prompt = buildScreenTestPrompt(subject, durationSec);
  const prevVersions = subject.screenTest?.versions ?? [];
  const pending = {
    prompt, durationSec,
    ...(subject.screenTest?.videoPath ? { videoPath: subject.screenTest.videoPath } : {}),
    versions: prevVersions,
    generation: { status: 'generating', startedAt: now() } as GenerationInfo,
  };
  await subjRef.set({ screenTest: pending, updatedAt: now() }, { merge: true });
  await setProgress(uid, projectId, 'screen_test', `${subject.name}: casting screen test generating (${durationSec}s — identity and voice)…`);
  try {
    const version = prevVersions.length + 1;
    const outPath = storagePaths.screenTest(uid, projectId, subjectId, version);
    if (caps.provider === 'mock') {
      const vid = await makeMockVideo(`${subject.name} — screen test`, durationSec, project.input.aspectRatio);
      await saveBuffer(outPath, vid, 'video/mp4');
    } else {
      const provider = videoProviderFor(caps);
      const jobId = await provider.submitVideo({
        prompt, durationSec,
        aspectRatio: project.input.aspectRatio,
        resolution: project.input.resolution,
        generateAudio: true, // the voice lock is half the point
        imageRefUrls: [], audioRefUrls: [],
      });
      await subjRef.set({ screenTest: { ...pending, generation: { status: 'generating', jobId, provider: provider.name, startedAt: now() } }, updatedAt: now() }, { merge: true });
      const finalStatus = await waitForVideo(provider, jobId, { maxMs: 25 * 60 * 1000 });
      if (finalStatus.state !== 'completed' || !finalStatus.videoUrl) {
        throw new Error(finalStatus.error ?? `${subject.name}'s screen test failed.`);
      }
      let video = await downloadUrl(finalStatus.videoUrl);
      video = await ensureAudioTrack(video);
      await saveBuffer(outPath, video, 'video/mp4');
    }
    await subjRef.set({
      screenTest: {
        prompt, durationSec, videoPath: outPath,
        versions: [...prevVersions, { videoPath: outPath, createdAt: now() }],
        generation: { status: 'completed', completedAt: now(), provider: caps.provider },
      },
      updatedAt: now(),
    }, { merge: true });
  } catch (e) {
    await subjRef.set({
      screenTest: { ...pending, generation: { status: 'failed', error: String((e as Error).message ?? e) } },
      updatedAt: now(),
    }, { merge: true });
    throw e;
  }
}

// ---------------------------------------------------------------------------
// 4. Environment reference generation
// ---------------------------------------------------------------------------

export async function runGenerateEnvironment(uid: string, projectId: string, envId: string): Promise<void> {
  const project = await getProject(uid, projectId);
  const env = await getEnvironment(uid, projectId, envId);
  const ref = db.collection(collections.environments(uid, projectId)).doc(envId);
  await ref.set({ generation: { status: 'generating', startedAt: now() }, updatedAt: now() }, { merge: true });
  try {
    const outPath = storagePaths.environment(uid, projectId, envId);
    const prompt = buildEnvironmentPrompt(env, project.briefing);
    await generateOneImage({
      uid, projectId, prompt, refPaths: [], outPath,
      label: `Environment — ${env.name}`,
      aspectRatio: project.input.aspectRatio === '9:16' ? '9:16' : '16:9',
    });
    await ref.set({ imagePath: outPath, generation: { status: 'completed', completedAt: now() }, updatedAt: now() }, { merge: true });
  } catch (e) {
    await ref.set({ generation: { status: 'failed', error: String((e as Error).message ?? e) }, updatedAt: now() }, { merge: true });
    throw e;
  }
}

// ---------------------------------------------------------------------------
// 5. Voice samples (v2 — ElevenLabs)
// ---------------------------------------------------------------------------

export async function runGenerateVoiceSample(uid: string, projectId: string, subjectId: string): Promise<void> {
  const subject = await getSubject(uid, projectId, subjectId);
  if (!subject.sheet?.voice) throw new HttpsError('failed-precondition', 'No voice spec — enable character voices and regenerate the briefing.');
  const subjRef = db.collection(collections.subjects(uid, projectId)).doc(subjectId);
  const voice = { ...subject.sheet.voice };
  const save = async () => subjRef.set({ sheet: { ...subject.sheet, voice }, updatedAt: now() }, { merge: true });

  voice.sampleStatus = 'generating';
  await save();
  try {
    const outPath = storagePaths.voiceSample(uid, projectId, subjectId);
    if (elevenLabsConfigured() && !isForcedMock()) {
      if (!voice.elevenLabsVoiceId) {
        voice.elevenLabsVoiceId = await designVoice(`${subject.name} (${projectId.slice(0, 6)})`, voice);
        await save();
      }
      const sampleLine = `Hi, this is how ${subject.name} sounds. The first move is what sets everything in motion.`;
      const audio = await textToSpeech(voice.elevenLabsVoiceId, sampleLine, voice);
      await saveBuffer(outPath, audio, 'audio/mpeg');
    } else {
      await saveBuffer(outPath, await makeMockAudio(3), 'audio/mpeg');
    }
    voice.sampleAudioPath = outPath;
    voice.sampleStatus = 'completed';
    await save();
  } catch (e) {
    voice.sampleStatus = 'failed';
    await save();
    throw e;
  }
}

// ---------------------------------------------------------------------------
// 5b. Camera previz (Blender)
//
// A complex camera move written as prose is a guess, and every guess costs a
// paid generation. The director instead plans the move as geometry; we turn
// that into a Blender script the user runs locally for FREE, then read the
// rendered frames back into an exact timed camera map that goes into the
// prompt as TEXT — reference images are token-free on ModelArk, reference
// videos are not.
// ---------------------------------------------------------------------------

/** The briefing schema gives number[]; the domain type wants a fixed triple. */
function vec3(v: number[] | undefined, fallback: [number, number, number] = [0, 0, 0]): [number, number, number] {
  if (!v || v.length < 3) return fallback;
  return [v[0], v[1], v[2]];
}

/** SceneDoc.previz from a planned scene — only when previz is warranted. */
function previzDocFor(project: ProjectDoc, s: BriefingPlan['scenes'][number]): { previz?: ScenePreviz } {
  if (!previzAllowed(project.input.previz, s.previzRecommended)) return {};
  if (!s.cameraPlan) return {};
  const plan: CameraPlan = {
    durationSec: s.cameraPlan.durationSec,
    fps: 24,
    intent: s.cameraPlan.intent,
    set: s.cameraPlan.set.map((o) => ({
      id: o.id, kind: o.kind, label: o.label,
      pos: vec3(o.pos), size: vec3(o.size, [1, 1, 1]),
      ...(o.rotZdeg !== undefined ? { rotZdeg: o.rotZdeg } : {}),
      ...(o.subjectId ? { subjectId: o.subjectId } : {}),
    })),
    camera: s.cameraPlan.camera.map((k) => ({
      t: k.t, pos: vec3(k.pos), lookAt: vec3(k.lookAt), focalMm: k.focalMm,
      ...(k.easing ? { easing: k.easing } : {}),
      ...(k.note ? { note: k.note } : {}),
    })),
  };
  return { previz: { status: 'planned', plan, feed: 'map_only', updatedAt: now() } };
}

/** Fallback camera map (mock mode): read the plan's own keyframe notes. */
function mapFromPlan(plan: CameraPlan | undefined, durationSec: number): CameraMapEntry[] {
  if (!plan || plan.camera.length === 0) return [];
  const keys = [...plan.camera].sort((a, b) => a.t - b.t);
  const out: CameraMapEntry[] = [];
  for (let i = 0; i < keys.length; i++) {
    const t0 = keys[i].t;
    const t1 = i + 1 < keys.length ? keys[i + 1].t : durationSec;
    if (t1 <= t0) continue;
    out.push({ t0, t1, move: keys[i].note ?? (i === 0 ? 'holds the opening angle' : 'continues the move') });
  }
  return out;
}

function sceneDocRef(uid: string, projectId: string, sceneId: string) {
  return db.collection(collections.scenes(uid, projectId)).doc(sceneId);
}

/**
 * Turn the scene's camera plan into a Blender script. Costs nothing and
 * spends no credits — the user runs it locally and iterates for free.
 */
export async function runBuildPrevizScript(
  uid: string, projectId: string, sceneId: string,
): Promise<{ scriptPath: string; fileName: string }> {
  const project = await getProject(uid, projectId);
  const scene = await getScene(uid, projectId, sceneId);
  const plan = scene.previz?.plan;
  if (!plan) {
    throw new HttpsError('failed-precondition',
      `Scene "${scene.title}" has no camera plan. The director writes one only for complex moves — set the project's previz mode to "always" and re-plan the briefing if you want one here.`);
  }
  // The previz and the generation must share one clock, or the camera map
  // cannot be timed against the stages.
  const synced: CameraPlan = { ...plan, durationSec: scene.durationSec };
  const fileName = `previz_${sceneId}.py`;
  const script = buildPrevizScript(synced, {
    sceneTitle: scene.title,
    aspectRatio: project.input.aspectRatio,
    fileName,
    outputName: `previz_${sceneId}.mp4`,
  });
  const scriptPath = storagePaths.previzScript(uid, projectId, sceneId);
  await saveBuffer(scriptPath, Buffer.from(script, 'utf8'), 'text/x-python');
  await sceneDocRef(uid, projectId, sceneId).set({
    previz: {
      ...(scene.previz ?? { feed: 'map_only' as PrevizFeed }),
      plan: synced, status: 'script_ready', scriptPath, updatedAt: now(),
    },
    updatedAt: now(),
  }, { merge: true });
  return { scriptPath, fileName };
}

/**
 * Read a rendered previz back: sample it at 1 fps, tile the frames into a
 * contact sheet, and have Claude step through the frames to write the timed
 * camera map. Then check every stage lands while the camera is pointed at it.
 */
export async function runIngestPreviz(
  uid: string, projectId: string, sceneId: string,
): Promise<{ windows: number; warnings: string[] }> {
  const scene = await getScene(uid, projectId, sceneId);
  const previz = scene.previz;
  if (!previz?.videoPath) {
    throw new HttpsError('failed-precondition', 'Upload the rendered previz MP4 for this scene first.');
  }
  await setProgress(uid, projectId, 'previz', `${scene.title}: reading the previz…`);

  const video = await downloadToBuffer(previz.videoPath);
  const frames = await extractFramesAtFps(video, 1, 40);
  if (frames.length === 0) {
    throw new HttpsError('failed-precondition', 'No frames could be read from that previz clip — re-render it and upload again.');
  }
  const sheetPath = storagePaths.previzSheet(uid, projectId, sceneId);
  await saveBuffer(sheetPath, await buildContactSheet(frames, { cols: 5, secondsPerFrame: 1 }), 'image/png');

  let cameraMap: CameraMapEntry[];
  let riskiestMoment: string | undefined;
  let fallbackFix: string | undefined;
  if (anthropicConfigured() && !isForcedMock()) {
    const read = await describePrevizWithClaude({
      frames: frames.map((f) => ({ data: f, mediaType: 'image/png' as const })),
      durationSec: scene.durationSec,
      sceneTitle: scene.title,
      intent: previz.plan?.intent ?? scene.cameraAndPerformance,
      blockLabels: (previz.plan?.set ?? []).map((o) => `${o.id} = ${o.label}`),
    });
    cameraMap = read.map;
    riskiestMoment = read.riskiestMoment;
    fallbackFix = read.fallbackFix;
  } else {
    cameraMap = mapFromPlan(previz.plan, scene.durationSec);
  }

  const warnings = checkStageTiming({ ...scene, previz: { ...previz, cameraMap } }, cameraMap);
  await sceneDocRef(uid, projectId, sceneId).set({
    previz: {
      ...previz,
      status: 'mapped', contactSheetPath: sheetPath, cameraMap,
      ...(riskiestMoment ? { riskiestMoment } : {}),
      ...(fallbackFix ? { fallbackFix } : {}),
      timingWarnings: warnings,
      updatedAt: now(),
    },
    updatedAt: now(),
  }, { merge: true });
  await setProgress(uid, projectId, 'previz', `${scene.title}: camera map ready (${cameraMap.length} windows).`);
  return { windows: cameraMap.length, warnings };
}

// ---------------------------------------------------------------------------
// 6. Scene generation
// ---------------------------------------------------------------------------

interface ResolvedRefWithUrl extends ResolvedRef { url?: string }

async function resolveRefUrls(
  uid: string, projectId: string, scene: SceneDoc,
  subjects: SubjectDoc[], environments: EnvironmentDoc[],
  videoMock: boolean,
): Promise<{ refs: ResolvedRefWithUrl[]; missing: string[] }> {
  const resolved = resolveReferenceTags(scene);
  const out: ResolvedRefWithUrl[] = [];
  const missing: string[] = [];
  for (const r of resolved) {
    let path: string | undefined;
    if (r.kind === 'subject_angle') {
      const subj = subjects.find((s) => s.id === r.subjectId);
      const angle = subj?.angles.find((a) => a.id === r.angleId && a.generation.status === 'completed');
      path = angle?.imagePath ?? subj?.angles.find((a) => a.isMaster && a.generation.status === 'completed')?.imagePath;
      if (!path) missing.push(`${subj?.name ?? r.subjectId}: angle ${r.angleId}`);
    } else if (r.kind === 'subject_video') {
      const subj = subjects.find((s) => s.id === r.subjectId);
      path = subj?.screenTest?.generation.status === 'completed' ? subj.screenTest.videoPath : undefined;
      if (!path) missing.push(`screen test for ${subj?.name ?? r.subjectId} (generate it on the briefing page)`);
    } else if (r.kind === 'subject_upload') {
      const subj = subjects.find((s) => s.id === r.subjectId);
      path = subj?.sourceImagePaths[0];
    } else if (r.kind === 'environment') {
      const env = environments.find((e) => e.id === r.envId);
      path = env?.generation.status === 'completed' ? env.imagePath : undefined;
      if (!path) missing.push(`environment ${r.envId}`);
    } else if (r.kind === 'voice_audio') {
      const subj = subjects.find((s) => s.id === r.subjectId);
      path = subj?.sheet?.voice?.sampleAudioPath;
      if (!path) missing.push(`voice sample for ${subj?.name ?? r.subjectId}`);
    } else if (r.kind === 'bridge_frame') {
      path = scene.stitching.bridgeFramePath;
    } else if (r.kind === 'camera_previz') {
      // Injected at generation time with its asset already resolved.
      path = r.path;
    }
    if (path) {
      out.push({ ...r, path, url: videoMock ? `mock://${path}` : await publicUrl(path) });
    }
  }
  return { refs: out, missing };
}

/** Re-assign tags after dropping unresolvable refs so numbering stays dense. */
function retag(refs: ResolvedRefWithUrl[]): ResolvedRefWithUrl[] {
  let img = 0; let vid = 0; let aud = 0;
  return refs.map((r) => ({
    ...r,
    assignedTag: r.media === 'audio' ? `@audio${++aud}` : r.media === 'video' ? `@video${++vid}` : `@image${++img}`,
  }));
}

/**
 * Generate (or re-roll) one scene. `take` carries the reason this version
 * exists — the note that asked for it and what it changed — so the take
 * gallery reads as a history rather than a pile of numbered files.
 */
export async function runGenerateScene(
  uid: string, projectId: string, sceneId: string, take?: { note?: string; patchSummary?: string[] },
): Promise<void> {
  const project = await getProject(uid, projectId);
  const scenes = await getScenes(uid, projectId);
  const scene = scenes.find((s) => s.id === sceneId);
  if (!scene) throw new HttpsError('not-found', `Scene ${sceneId} not found.`);
  const subjects = await getSubjects(uid, projectId);
  const environments = await getEnvironments(uid, projectId);
  const caps = activeEngine(project.input.videoEngine);
  const sceneRef = db.collection(collections.scenes(uid, projectId)).doc(sceneId);

  const setGen = async (patch: Partial<SceneDoc['generation']> & Record<string, unknown>) => {
    await sceneRef.set({ generation: { ...scene.generation, ...patch }, updatedAt: now() }, { merge: true });
  };

  const videoMock = caps.provider === 'mock';
  await projectRef(uid, projectId).set({ status: 'producing', updatedAt: now() }, { merge: true });
  await setGen({ status: 'queued', error: '', startedAt: now(), provider: caps.provider, params: {
    model: caps.label, durationSec: scene.durationSec,
    aspectRatio: project.input.aspectRatio, resolution: project.input.resolution,
  } });

  try {
    // --- Stitching inputs from the previous scene ---
    const prev = scenes.find((s) => s.index === scene.index - 1);
    let extendVideoUrl: string | undefined;
    if (scene.stitching.mode === 'frame_bridge') {
      if (!prev?.videoPath) throw new HttpsError('failed-precondition', `Scene ${scene.index} bridges from the previous scene — generate scene ${scene.index} (index ${scene.index - 1}) first.`);
      const prevVideo = await downloadToBuffer(prev.videoPath);
      const frame = await extractLastFrame(prevVideo);
      const bridgePath = storagePaths.bridgeFrame(uid, projectId, sceneId);
      await saveBuffer(bridgePath, frame, 'image/png');
      scene.stitching.bridgeFramePath = bridgePath;
      await sceneRef.set({ stitching: { ...scene.stitching }, updatedAt: now() }, { merge: true });
      if (!scene.references.some((r) => r.kind === 'bridge_frame')) {
        scene.references = [{
          tag: '', kind: 'bridge_frame',
          use: 'This is the exact first frame of this video — the final frame of the previous shot. Continue forward from this precise moment.',
          ignore: 'Do not replay or recreate any action from before this frame.',
        }, ...scene.references];
      }
    } else if (scene.stitching.mode === 'extend_prev') {
      if (!caps.extend) throw new HttpsError('failed-precondition', 'The active engine does not support extend — switch this scene to frame_bridge.');
      if (!prev?.videoPath) throw new HttpsError('failed-precondition', 'Generate the previous scene first.');
      extendVideoUrl = videoMock ? `mock://${prev.videoPath}` : await publicUrl(prev.videoPath);
    }

    // --- Camera previz ---
    // The timed camera map always rides along inside the prompt (free). The
    // previz asset itself is attached only when the scene asks for it: the
    // contact sheet is token-free, the clip costs ~+1x base tokens.
    const previzFeed: PrevizFeed = scene.previz?.feed ?? 'map_only';
    const previzAsset = previzFeed === 'attach_video' ? scene.previz?.videoPath
      : previzFeed === 'map_plus_sheet' ? scene.previz?.contactSheetPath
        : undefined;
    if (previzAsset && !scene.references.some((r) => r.kind === 'camera_previz')) {
      const line = buildPrevizRefLine(previzFeed);
      scene.references = [...scene.references, {
        tag: '', kind: 'camera_previz', path: previzAsset, use: line.use, ignore: line.ignore,
      }];
    }

    // --- Resolve references to URLs ---
    const { refs: rawRefs, missing } = await resolveRefUrls(uid, projectId, scene, subjects, environments, videoMock);
    if (missing.length > 0 && !videoMock) {
      throw new HttpsError('failed-precondition', `Missing reference assets: ${missing.join('; ')}. Generate them on the briefing page first.`);
    }
    // In extend mode the source clip already carries every character's
    // identity and voice, and the adapters attach exactly one reference_video
    // (the clip being extended) — so any OTHER video ref (screen tests, an
    // attached previz) would be named in the prompt but never sent. Drop
    // every video ref here, before the prompt is built, so the tag list and
    // the payload can never drift apart.
    let refs = retag(extendVideoUrl ? rawRefs.filter((r) => r.media !== 'video') : rawRefs);
    let prompt = buildScenePrompt(scene, subjects, refs);
    await sceneRef.set({ assembledPrompt: prompt, updatedAt: now() }, { merge: true });

    const wantsAudio = caps.nativeAudio && (
      project.input.dialogueEnabled || project.input.audio.music ||
      project.input.audio.sfx || project.input.audio.ambience
    );

    // --- Mock path ---
    const version = (scene.versions?.length ?? 0) + 1;
    const outPath = storagePaths.sceneVideo(uid, projectId, sceneId, version);
    if (videoMock) {
      await setGen({ status: 'generating' });
      const vid = await makeMockVideo(`${scene.title} (${scene.durationSec}s mock)`, scene.durationSec, project.input.aspectRatio);
      await saveBuffer(outPath, vid, 'video/mp4');
      await sceneRef.set({
        videoPath: outPath,
        versions: [...(scene.versions ?? []), { videoPath: outPath, createdAt: now(), note: 'mock' }],
        generation: { status: 'completed', completedAt: now(), params: { model: 'mock', durationSec: scene.durationSec, aspectRatio: project.input.aspectRatio, resolution: project.input.resolution } },
        updatedAt: now(),
      }, { merge: true });
      return;
    }

    // --- Seedance v1 keyframe pipeline: build the start frame first ---
    let startImageUrl: string | undefined;
    if (caps.id === 'seedance1' && !extendVideoUrl) {
      const bridge = refs.find((r) => r.kind === 'bridge_frame');
      if (bridge?.path) {
        startImageUrl = await publicUrl(bridge.path);
      } else {
        await setGen({ status: 'generating' });
        await setProgress(uid, projectId, 'scene', `${scene.title}: generating the start keyframe…`);
        const kfPrompt = buildKeyframePrompt(scene, subjects, refs);
        const kfPath = storagePaths.bridgeFrame(uid, projectId, sceneId).replace('bridge_in.png', 'keyframe.png');
        await generateOneImage({
          uid, projectId, prompt: kfPrompt,
          refPaths: refs.filter((r) => r.media === 'image' && r.path).map((r) => r.path!),
          outPath: kfPath, label: `${scene.title} — keyframe`,
          aspectRatio: project.input.aspectRatio === '9:16' ? '9:16' : project.input.aspectRatio === '1:1' ? '1:1' : '16:9',
        });
        startImageUrl = await publicUrl(kfPath);
        await sceneRef.set({ stitching: { ...scene.stitching, bridgeFramePath: kfPath }, updatedAt: now() }, { merge: true });
      }
    }

    // --- Submit + poll (provider-agnostic) ---
    // ModelArk runs a privacy filter over the input images BEFORE reading the
    // prompt: portrait-style face crops are rejected as "may contain real
    // person" even when the face is AI-generated (verified 2026-08-22 —
    // full-body refs of the same character pass). The error names the
    // offending content[i] slots, so we drop exactly those refs, rebuild the
    // prompt (tag numbering stays dense) and resubmit.
    const provider = videoProviderFor(caps);
    const droppedRefs: string[] = [];
    let fallbackTakeUrl: string | undefined;
    let jobId = '';
    for (let attempt = 0; ; attempt++) {
      const enginePrompt = caps.id === 'seedance1' ? buildV1MotionPrompt(scene) : prompt;
      const videoRefUrls = [
        ...refs.filter((r) => r.media === 'video' && r.url).map((r) => r.url!),
        ...(fallbackTakeUrl ? [fallbackTakeUrl] : []),
      ];
      try {
        jobId = await provider.submitVideo({
          prompt: enginePrompt,
          durationSec: scene.durationSec,
          aspectRatio: project.input.aspectRatio,
          resolution: project.input.resolution,
          generateAudio: Boolean(wantsAudio),
          imageRefUrls: refs.filter((r) => r.media === 'image' && r.url).map((r) => r.url!),
          audioRefUrls: refs.filter((r) => r.media === 'audio' && r.url).map((r) => r.url!),
          startImageUrl,
          extendVideoUrl,
          videoRefUrls,
        });
        break;
      } catch (e) {
        const msg = String((e as Error).message ?? e);
        const flagged = [...msg.matchAll(/content\[(\d+)\]/g)].map((m) => Number(m[1]));
        const recoverable = provider.name === 'ark'
          && msg.includes('InputImageSensitiveContentDetected')
          && flagged.length > 0 && attempt < 3;
        if (!recoverable) throw e;
        // Map content[] slots back to image refs: content[0] is the text
        // block; reference videos (extension or screen tests) occupy the
        // slots before the images.
        const slotOffset = 1 + (extendVideoUrl ? 1 : videoRefUrls.length);
        const imageRefs = refs.filter((r) => r.media === 'image' && r.url);
        const toDrop = new Set(flagged.map((i) => imageRefs[i - slotOffset]).filter(Boolean));
        if (toDrop.size === 0) throw e;
        for (const r of toDrop) {
          droppedRefs.push(
            r.kind === 'subject_angle' ? `${r.subjectId} ${r.angleId}`
              : r.kind === 'environment' ? `environment ${r.envId}`
                : r.kind,
          );
        }
        const keep = refs.filter((r) => !toDrop.has(r));
        const anchorLeft = keep.some((r) =>
          (r.media === 'image' && (r.kind === 'subject_angle' || r.kind === 'subject_upload'))
          || r.kind === 'subject_video');
        refs = retag(keep);
        prompt = buildScenePrompt(scene, subjects, refs);
        if (!anchorLeft && !extendVideoUrl) {
          // Every character reference was rejected. Fall back to carrying
          // identity via the scene's own previous take as a plain reference
          // video — videos pass the filter.
          const prevTake = scene.versions?.[scene.versions.length - 1]?.videoPath ?? scene.videoPath;
          if (!prevTake) {
            throw new Error(
              `The platform's moderation rejected ALL character references for "${scene.title}" (${droppedRefs.join(', ')}) `
              + 'and this scene has no previous take or screen test to use as a video identity anchor. Generate a screen '
              + 'test for each character on the briefing page first, or contact BytePlus support about the moderation policy.',
            );
          }
          fallbackTakeUrl = videoMock ? `mock://${prevTake}` : await publicUrl(prevTake);
          prompt = prompt.replace('[REFERENCE MATERIAL]\n',
            '[REFERENCE MATERIAL]\n@video1 — the characters exactly as filmed in this footage: identical faces, hair and wardrobe. '
            + 'Identity reference only — perform the staging written below, never replay this footage.\n');
        }
        await sceneRef.set({ assembledPrompt: prompt, updatedAt: now() }, { merge: true });
        await setProgress(uid, projectId, 'scene',
          `${scene.title}: the privacy filter flagged ${toDrop.size} reference image(s) — retrying `
          + `${!anchorLeft && fallbackTakeUrl ? 'with the previous take as the identity reference' : `without ${droppedRefs.join(', ')}`}…`);
      }
    }
    const moderationNote = droppedRefs.length > 0
      ? `The platform's privacy filter rejected ${droppedRefs.join(', ')} as possible real-person imagery — `
        + (fallbackTakeUrl
          ? 'identity was carried by the previous take as a video reference instead.'
          : 'the scene was generated without them (identity rides on the remaining references).')
      : undefined;
    await setGen({ status: 'queued', jobId, provider: provider.name, ...(moderationNote ? { moderationNote } : {}) });
    await setProgress(uid, projectId, 'scene', `${scene.title}: video generating on ${provider.name} (this can take several minutes)…`);

    const finalStatus = await waitForVideo(provider, jobId, {
      maxMs: 25 * 60 * 1000,
      onTick: async (s) => {
        if (s.state === 'generating') await setGen({ status: 'generating', jobId, provider: provider.name, ...(moderationNote ? { moderationNote } : {}) });
      },
    });
    if (finalStatus.state !== 'completed' || !finalStatus.videoUrl) {
      throw new Error(finalStatus.error ?? `${scene.title} generation failed.`);
    }
    let video = await downloadUrl(finalStatus.videoUrl);
    video = await ensureAudioTrack(video);
    await saveBuffer(outPath, video, 'video/mp4');
    await sceneRef.set({
      videoPath: outPath,
      versions: [...(scene.versions ?? []), {
        videoPath: outPath, createdAt: now(),
        ...(take?.note ? { note: take.note } : {}),
        ...(take?.patchSummary?.length ? { patchSummary: take.patchSummary } : {}),
      } satisfies SceneTake],
      generation: {
        status: 'completed', jobId, provider: provider.name, completedAt: now(), resultUrl: finalStatus.videoUrl,
        ...(moderationNote ? { moderationNote } : {}),
        params: { model: caps.label, durationSec: scene.durationSec, aspectRatio: project.input.aspectRatio, resolution: project.input.resolution },
      },
      updatedAt: now(),
    }, { merge: true });
  } catch (e) {
    await sceneRef.set({
      generation: { ...scene.generation, status: 'failed', error: String((e as Error).message ?? e) },
      updatedAt: now(),
    }, { merge: true });
    throw e;
  }
}

/** Re-check a stuck scene job (e.g. after a function timeout) and finalize it. */
export async function runRefreshScene(uid: string, projectId: string, sceneId: string): Promise<string> {
  const project = await getProject(uid, projectId);
  const scene = await getScene(uid, projectId, sceneId);
  const jobId = scene.generation.jobId;
  if (!jobId) return 'No job to refresh.';
  const sceneRef = db.collection(collections.scenes(uid, projectId)).doc(sceneId);
  const provider: VideoProvider = scene.generation.provider === 'fal'
    ? falVideoProvider()
    : scene.generation.provider === 'ark'
      ? arkVideoProvider()
      : higgsfieldVideoProvider(activeEngine(project.input.videoEngine));
  const status = await provider.videoStatus(jobId);
  if (status.state === 'completed' && status.videoUrl) {
    let video = await downloadUrl(status.videoUrl);
    video = await ensureAudioTrack(video);
    const version = (scene.versions?.length ?? 0) + 1;
    const outPath = storagePaths.sceneVideo(uid, projectId, sceneId, version);
    await saveBuffer(outPath, video, 'video/mp4');
    await sceneRef.set({
      videoPath: outPath,
      versions: [...(scene.versions ?? []), { videoPath: outPath, createdAt: now() }],
      generation: { ...scene.generation, status: 'completed', completedAt: now() },
      updatedAt: now(),
    }, { merge: true });
    return 'Scene video retrieved and saved.';
  }
  if (status.state === 'failed') {
    await sceneRef.set({ generation: { ...scene.generation, status: 'failed', error: status.error ?? 'failed' }, updatedAt: now() }, { merge: true });
    return `Job failed: ${status.error ?? 'unknown reason'}.`;
  }
  await sceneRef.set({ generation: { ...scene.generation, status: status.state === 'queued' ? 'queued' : 'generating' }, updatedAt: now() }, { merge: true });
  return `Still ${status.state} for project ${project.id}.`;
}

// ---------------------------------------------------------------------------
// 7. Final assembly
// ---------------------------------------------------------------------------

export async function runAssembleFinal(uid: string, projectId: string): Promise<void> {
  const project = await getProject(uid, projectId);
  const scenes = await getScenes(uid, projectId);
  const missing = scenes.filter((s) => !s.videoPath);
  if (scenes.length === 0) throw new HttpsError('failed-precondition', 'No scenes to assemble.');
  if (missing.length > 0) {
    throw new HttpsError('failed-precondition', `Generate all scenes first — missing: ${missing.map((s) => s.title).join(', ')}.`);
  }
  await projectRef(uid, projectId).set({ finalAssembly: { status: 'generating' }, updatedAt: now() }, { merge: true });
  await setProgress(uid, projectId, 'assemble', 'Stitching scenes into the final film (concat, boundary-frame trims, loudness pass)…');
  try {
    const items: ConcatItem[] = [];
    for (const s of scenes) {
      const video = await downloadToBuffer(s.videoPath!);
      items.push({ video: await ensureAudioTrack(video), trimFirstFrame: s.stitching.mode === 'frame_bridge' });
    }
    const finalVideo = await concatVideos(items, project.input.aspectRatio);
    const version = Date.now();
    const outPath = storagePaths.finalVideo(uid, projectId, version);
    await saveBuffer(outPath, finalVideo, 'video/mp4');
    await projectRef(uid, projectId).set({
      finalVideoPath: outPath, status: 'done',
      finalAssembly: { status: 'completed', completedAt: now() },
      progress: { step: 'done', message: 'Final film assembled.' },
      updatedAt: now(),
    }, { merge: true });
  } catch (e) {
    await projectRef(uid, projectId).set({
      finalAssembly: { status: 'failed', error: String((e as Error).message ?? e) },
      updatedAt: now(),
    }, { merge: true });
    throw e;
  }
}

// ---------------------------------------------------------------------------
// 7. Take verification and re-rolls
//
// Reading a take costs cents; re-rolling it costs dollars. So every finding
// carries the lever that fixes it, and the two steps that spend money are
// split in half: runPlanRegeneration works out what a note would change and
// what it would cost (free), and only runRegenerateScene actually generates.
// ---------------------------------------------------------------------------

/** The lines as planned, for the transcript comparison. */
function plannedDialogueOf(scene: SceneDoc, subjects: SubjectDoc[]): string | undefined {
  const named = (id: string) => subjects.find((s) => s.id === id)?.name ?? id;
  const lines = scene.stages
    .filter((st) => st.dialogue?.line?.trim())
    .map((st) => `${st.t0}-${st.t1}s ${named(st.dialogue!.subjectId)}: "${st.dialogue!.line}"`);
  if (lines.length === 0) return undefined;
  return lines.join('\n');
}

/** What was attached to the generation — the model needs this to blame the right lever. */
function referenceSummaryOf(scene: SceneDoc): string | undefined {
  const refs = resolveReferenceTags(scene);
  if (refs.length === 0) return 'Nothing was attached — this take was generated from the prompt alone.';
  return refs.map((r) => `${r.assignedTag} (${r.kind}): ${r.use}`).join('\n');
}

function mockVerdict(scene: SceneDoc, takePath: string): SceneVerdict {
  const criteria = criteriaFor(scene).map((c) => ({ id: c.id, score: 88, note: 'Mock verification — no ANTHROPIC_API_KEY configured.' }));
  return {
    status: 'ready', takePath, overall: 88, call: 'minor',
    headline: 'Mock verdict — set ANTHROPIC_API_KEY to have the take actually read.',
    criteria,
    issues: [{
      severity: 'minor', atSec: 0,
      what: 'Verification is running in mock mode, so nothing was actually watched.',
      fixKind: 'accept',
      fix: 'Configure ANTHROPIC_API_KEY (and ELEVENLABS_API_KEY for dialogue) to get a real read.',
    }],
    checkedAt: now(),
  };
}

/**
 * Grade one take against the plan it came from. Spends cents: frames go to
 * Claude vision, audio to Scribe. Nothing here generates video.
 */
export async function runVerifyScene(
  uid: string, projectId: string, sceneId: string, takePath?: string,
): Promise<{ overall: number; call: SceneVerdict['call']; issues: number }> {
  const scene = await getScene(uid, projectId, sceneId);
  const subjects = await getSubjects(uid, projectId);
  const path = takePath ?? scene.videoPath;
  if (!path) throw new HttpsError('failed-precondition', `Generate "${scene.title}" before verifying it.`);

  const ref = sceneDocRef(uid, projectId, sceneId);
  await ref.set({
    verdict: { status: 'running', takePath: path, overall: 0, call: 'minor', headline: 'Reading the take…', criteria: [], issues: [], checkedAt: now() },
    updatedAt: now(),
  }, { merge: true });
  await setProgress(uid, projectId, 'verify', `${scene.title}: reading the take against the plan…`);

  try {
    const video = await downloadToBuffer(path);
    const probe = await probeVideo(video);
    const durationSec = probe.durationSec || scene.durationSec;

    // Two frames a second on short clips: enough to catch a beat that never
    // happens, without paying for near-duplicates on a long one.
    const fps = durationSec <= 12 ? 2 : 1;
    // JPEG, not PNG: two dozen photographic frames as PNG is ~4 MB of payload
    // for no gain — vision bills by dimensions, and the upload is the slow part.
    const frames = await extractFramesAtFps(video, fps, 24, 'jpeg');
    if (frames.length === 0) {
      throw new HttpsError('failed-precondition', 'No frames could be read from that take.');
    }
    // The sheet is for the human, so it stays at one tile per second whatever
    // rate the model was fed at — its timecode stamps are integer seconds.
    const sheetFrames = fps === 2 ? frames.filter((_, i) => i % 2 === 0) : frames;
    const sheetPath = storagePaths.verifySheet(uid, projectId, sceneId, now());
    await saveBuffer(sheetPath, await buildContactSheet(sheetFrames, { cols: 6, secondsPerFrame: 1 }), 'image/png');

    let transcript: string | undefined;
    if (sttConfigured() && !isForcedMock()) {
      const audio = await extractAudio(video);
      if (audio) {
        const t = await transcribeTake(audio, { maxSpeakers: Math.max(1, subjects.length) });
        if (t) transcript = formatTranscript(t);
      }
    }

    let verdict: SceneVerdict;
    if (anthropicConfigured() && !isForcedMock()) {
      const specs = criteriaFor(scene);
      const read = await verifyTakeWithClaude({
        frames: frames.map((f, i) => ({
          image: { data: f, mediaType: 'image/jpeg' as const },
          atSec: i / fps,
        })),
        durationSec,
        plan: scene.assembledPrompt ?? buildScenePrompt(scene, subjects, resolveReferenceTags(scene)),
        criteria: specs.map((c) => ({ id: c.id, label: c.label, question: c.question })),
        transcript,
        plannedDialogue: plannedDialogueOf(scene, subjects),
        referenceSummary: referenceSummaryOf(scene),
      });
      verdict = {
        status: 'ready',
        takePath: path,
        overall: Math.round(read.overall),
        call: read.call,
        headline: read.headline,
        criteria: read.criteria.map((c) => ({ id: c.id, score: Math.round(c.score), note: c.note })),
        issues: read.issues as VerdictIssue[],
        ...(read.suggestedNote ? { suggestedNote: read.suggestedNote } : {}),
        ...(transcript ? { transcript } : {}),
        contactSheetPath: sheetPath,
        checkedAt: now(),
      };
    } else {
      verdict = { ...mockVerdict(scene, path), contactSheetPath: sheetPath, ...(transcript ? { transcript } : {}) };
    }

    // Stamp the score onto the take itself, so the gallery shows which
    // version scored what without opening each verdict.
    const versions = (scene.versions ?? []).map((v) =>
      (v.videoPath === path ? { ...v, verdictScore: verdict.overall } : v));

    await ref.set({ verdict, ...(versions.length ? { versions } : {}), updatedAt: now() }, { merge: true });
    await setProgress(uid, projectId, 'verify',
      `${scene.title}: ${verdict.overall}/100 — ${verdict.issues.length} finding${verdict.issues.length === 1 ? '' : 's'}.`);
    return { overall: verdict.overall, call: verdict.call, issues: verdict.issues.length };
  } catch (e) {
    await ref.set({
      verdict: {
        status: 'failed', takePath: path, overall: 0, call: 'minor',
        headline: 'Verification failed.', criteria: [], issues: [],
        error: String((e as Error).message ?? e), checkedAt: now(),
      },
      updatedAt: now(),
    }, { merge: true });
    throw e;
  }
}

export interface RegenerationPlan {
  patches: (ScenePatch & { sharedText: boolean })[];
  rejected: { field: string; reason: string }[];
  unaddressable: string[];
  summary: string;
  /** The prompt this re-roll would actually send. */
  prompt: string;
  estimatedCostUsd: number;
}

/**
 * Work out what a note would change — and what generating it would cost —
 * without spending anything. This is the half of the re-roll that runs before
 * the confirm dialog; nothing here touches Firestore or the engine.
 */
export async function runPlanRegeneration(
  uid: string, projectId: string, sceneId: string, note: string,
): Promise<RegenerationPlan> {
  if (!note.trim()) throw new HttpsError('invalid-argument', 'Write a note describing what should change.');
  const project = await getProject(uid, projectId);
  const scene = await getScene(uid, projectId, sceneId);
  const subjects = await getSubjects(uid, projectId);
  const fields = patchableFields(scene);

  let raw: { field: string; to: string; why: string }[] = [];
  let unaddressable: string[] = [];
  let summary = '';
  if (anthropicConfigured() && !isForcedMock()) {
    const verdict = scene.verdict?.status === 'ready' && scene.verdict.takePath === scene.videoPath
      ? [scene.verdict.headline, ...scene.verdict.issues.map((i) => `${i.atSec}s [${i.fixKind}] ${i.what} — ${i.fix}`)].join('\n')
      : undefined;
    const plan = await patchSceneFromNote({
      note, sceneTitle: scene.title, durationSec: scene.durationSec, fields,
      ...(verdict ? { verdictContext: verdict } : {}),
    });
    raw = plan.patches;
    unaddressable = plan.unaddressable ?? [];
    summary = plan.summary;
  } else {
    // Mock: append the note to the camera block so the shape of the flow is
    // exercisable without a key. Deliberately visible as a mock.
    raw = [{
      field: 'cameraAndPerformance',
      to: `${fields.cameraAndPerformance}\n\n[MOCK PATCH — no ANTHROPIC_API_KEY] ${note.trim()}`,
      why: 'Mock patch so the re-roll flow can be exercised without an API key.',
    }];
    summary = 'Mock patch — set ANTHROPIC_API_KEY for a real revision.';
  }

  const patches: ScenePatch[] = raw
    .filter((p) => isPatchableField(scene, p.field))
    .map((p) => ({ field: p.field, from: fields[p.field] ?? '', to: p.to, why: p.why }));
  const { scene: patched, applied, rejected } = applyScenePatches(scene, patches);
  const unknown = raw
    .filter((p) => !isPatchableField(scene, p.field))
    .map((p) => ({ field: p.field, reason: 'not a field on this scene' }));

  // One attached reference video is the usual case (a screen test or the
  // clip being extended); images are token-free either way.
  const patchedRefs = resolveReferenceTags(patched);
  const refVideos = patchedRefs.filter((r) => r.media === 'video').length;
  return {
    patches: applied.map((p) => ({ ...p, sharedText: SHARED_TEXT_FIELDS.has(p.field) })),
    rejected: [...rejected, ...unknown],
    unaddressable,
    summary,
    prompt: buildScenePrompt(patched, subjects, patchedRefs),
    estimatedCostUsd: estimateCostUsd(scene.durationSec, project.input.resolution, refVideos),
  };
}

/**
 * Re-roll a scene. 'as_is' sends the identical prompt again; 'note' applies an
 * already-approved patch first. Either way this SPENDS — it is only ever
 * reached from an explicit confirmation in the UI.
 */
export async function runRegenerateScene(
  uid: string, projectId: string, sceneId: string,
  opts: { mode: 'as_is' | 'note'; note?: string; patch?: ScenePatch[] },
): Promise<void> {
  const scene = await getScene(uid, projectId, sceneId);
  let patchSummary: string[] | undefined;

  if (opts.mode === 'note') {
    if (!opts.patch?.length) {
      throw new HttpsError('invalid-argument', 'No approved patch to apply — plan the re-roll first.');
    }
    const { scene: patched, applied, rejected } = applyScenePatches(scene, opts.patch);
    if (applied.length === 0) {
      throw new HttpsError('failed-precondition',
        `None of the proposed changes could be applied${rejected.length ? `: ${rejected.map((r) => `${r.field} (${r.reason})`).join(', ')}` : '.'}`);
    }
    const write: Record<string, unknown> = { updatedAt: now() };
    for (const p of applied) {
      if (p.field.startsWith('stages[')) write.stages = patched.stages;
      else write[p.field] = p.to;
    }
    await sceneDocRef(uid, projectId, sceneId).set(write, { merge: true });
    patchSummary = applied.map((p) => `${fieldLabel(p.field)}: ${p.why}`);
  }

  await runGenerateScene(uid, projectId, sceneId, {
    ...(opts.note?.trim() ? { note: opts.note.trim() } : {}),
    ...(patchSummary ? { patchSummary } : {}),
  });
}
