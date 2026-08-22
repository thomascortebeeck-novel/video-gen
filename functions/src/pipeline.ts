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
import { anthropicConfigured, analyzeSubjectWithClaude, planBriefingWithClaude, BriefingPlan } from './claude';
import {
  submitImageJob, pollUntilDone, assertCompleted, higgsfieldVideoProvider,
} from './higgsfield';
import { falVideoProvider } from './fal';
import { arkVideoProvider, arkGenerateImage } from './ark';
import { waitForVideo, downloadUrl, VideoProvider } from './providers';
import { elevenLabsConfigured, designVoice, textToSpeech } from './elevenlabs';
import {
  makeMockImage, makeMockVideo, makeMockAudio, resizeForVision,
  extractLastFrame, concatVideos, ensureAudioTrack, ConcatItem,
} from './media';
import {
  buildCharacterMasterPrompt, buildProductMasterPrompt, buildAnglePrompt,
  buildEnvironmentPrompt, buildScenePrompt, buildKeyframePrompt, buildV1MotionPrompt,
  resolveReferenceTags, ResolvedRef,
} from '../../shared/assemble';
import type {
  ProjectDoc, SubjectDoc, SubjectAngle, SceneDoc, EnvironmentDoc,
  Briefing, GenerationInfo, SubjectSheet,
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
  const caps = activeEngine();
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
  const caps = activeEngine();
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
          tag: '', kind: r.kind === 'environment' ? 'environment' : r.kind === 'style' ? 'style' : 'subject_angle',
          ...(r.subjectId ? { subjectId: r.subjectId } : {}),
          ...(r.angleId ? { angleId: r.angleId } : {}),
          ...(r.envKey ? { envId: r.envKey } : {}),
          use: r.use, ...(r.ignore ? { ignore: r.ignore } : {}),
        })),
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
    // rate-limits fresh accounts hard — go sequential there.
    const CONCURRENCY = activeImageProvider() === 'ark' ? 1 : 3;
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
    }
    if (path) {
      out.push({ ...r, path, url: videoMock ? `mock://${path}` : await publicUrl(path) });
    }
  }
  return { refs: out, missing };
}

/** Re-assign tags after dropping unresolvable refs so numbering stays dense. */
function retag(refs: ResolvedRefWithUrl[]): ResolvedRefWithUrl[] {
  let img = 0; let aud = 0;
  return refs.map((r) => ({
    ...r,
    assignedTag: r.media === 'audio' ? `@audio${++aud}` : `@image${++img}`,
  }));
}

export async function runGenerateScene(uid: string, projectId: string, sceneId: string): Promise<void> {
  const project = await getProject(uid, projectId);
  const scenes = await getScenes(uid, projectId);
  const scene = scenes.find((s) => s.id === sceneId);
  if (!scene) throw new HttpsError('not-found', `Scene ${sceneId} not found.`);
  const subjects = await getSubjects(uid, projectId);
  const environments = await getEnvironments(uid, projectId);
  const caps = activeEngine();
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

    // --- Resolve references to URLs ---
    const { refs: rawRefs, missing } = await resolveRefUrls(uid, projectId, scene, subjects, environments, videoMock);
    if (missing.length > 0 && !videoMock) {
      throw new HttpsError('failed-precondition', `Missing reference assets: ${missing.join('; ')}. Generate them on the briefing page first.`);
    }
    let refs = retag(rawRefs);
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
    let jobId = '';
    for (let attempt = 0; ; attempt++) {
      const enginePrompt = caps.id === 'seedance1' ? buildV1MotionPrompt(scene) : prompt;
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
        // block; in extension mode content[1] is the reference video.
        const slotOffset = extendVideoUrl ? 2 : 1;
        const imageRefs = refs.filter((r) => r.media === 'image' && r.url);
        const toDrop = new Set(flagged.map((i) => imageRefs[i - slotOffset]).filter(Boolean));
        const keep = refs.filter((r) => !toDrop.has(r));
        const usableLeft = keep.some((r) => r.media === 'image' && r.kind !== 'bridge_frame');
        if (toDrop.size === 0 || !usableLeft) {
          throw new Error(
            `ModelArk's privacy filter rejected the reference images for "${scene.title}" — it treats `
            + 'realistic faces (even AI-generated ones) as real-person photos, and no usable references '
            + `remain after dropping the flagged ones. Original error: ${msg}`,
          );
        }
        for (const r of toDrop) {
          droppedRefs.push(
            r.kind === 'subject_angle' ? `${r.subjectId} ${r.angleId}`
              : r.kind === 'environment' ? `environment ${r.envId}`
                : r.kind,
          );
        }
        refs = retag(keep);
        prompt = buildScenePrompt(scene, subjects, refs);
        await sceneRef.set({ assembledPrompt: prompt, updatedAt: now() }, { merge: true });
        await setProgress(uid, projectId, 'scene',
          `${scene.title}: ModelArk's privacy filter flagged ${toDrop.size} reference image(s) — retrying without ${droppedRefs.join(', ')}…`);
      }
    }
    const moderationNote = droppedRefs.length > 0
      ? `ModelArk's privacy filter rejected ${droppedRefs.join(', ')} as possible real-person photos — `
        + 'the scene was generated without them (identity rides on the remaining references).'
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
      versions: [...(scene.versions ?? []), { videoPath: outPath, createdAt: now() }],
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
      : higgsfieldVideoProvider(activeEngine());
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
