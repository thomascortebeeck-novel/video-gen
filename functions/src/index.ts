/**
 * Cloud Functions entry point — thin callable wrappers around the pipeline.
 * All functions require auth; data is scoped to the caller's uid.
 */
import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { setGlobalOptions } from 'firebase-functions/v2';
import { requireAuth } from './fire';
import { ALL_SECRETS, REGION, activeEngine, activeImageProvider } from './config';
import {
  runAnalyzeSubjects, runPlanBriefing, runGenerateAngles, runGenerateSingleAngle,
  runGenerateEnvironment, runGenerateVoiceSample, runGenerateScene,
  runRefreshScene, runAssembleFinal, runGenerateScreenTest,
  runBuildPrevizScript, runIngestPreviz,
  runVerifyScene, runPlanRegeneration, runRegenerateScene,
} from './pipeline';
import type {
  AnalyzeSubjectsRequest, PlanBriefingRequest, GenerateAnglesRequest,
  GenerateAngleImageRequest, GenerateEnvironmentRequest, GenerateSceneRequest,
  AssembleFinalRequest, GenerateVoiceSampleRequest, GenerateScreenTestRequest,
  BuildPrevizScriptRequest, IngestPrevizRequest, PipelineStepResult,
  VerifySceneRequest, PlanRegenerationRequest, RegenerateSceneRequest,
} from '../../shared/types';

setGlobalOptions({ region: REGION, maxInstances: 10 });

function wrap<TReq>(
  handler: (uid: string, data: TReq) => Promise<string | void>,
) {
  return async (request: CallableRequest<TReq>): Promise<PipelineStepResult> => {
    const uid = requireAuth(request);
    try {
      const message = await handler(uid, request.data);
      return { ok: true, ...(message ? { message } : {}) };
    } catch (e) {
      if (e instanceof HttpsError) throw e;
      throw new HttpsError('internal', String((e as Error).message ?? e));
    }
  };
}

/** Write character/product sheets from the uploaded photos. */
export const analyzeSubjects = onCall(
  { secrets: ALL_SECRETS, timeoutSeconds: 540, memory: '1GiB' },
  wrap<AnalyzeSubjectsRequest>(async (uid, d) => { await runAnalyzeSubjects(uid, d.projectId); }),
);

/** The director pass: briefing + environments + scenes + voice casting. */
export const planBriefing = onCall(
  { secrets: ALL_SECRETS, timeoutSeconds: 900, memory: '1GiB' },
  wrap<PlanBriefingRequest>(async (uid, d) => { await runPlanBriefing(uid, d.projectId); }),
);

/** Generate a subject's full angle set (master first, then the rest). */
export const generateAngles = onCall(
  { secrets: ALL_SECRETS, timeoutSeconds: 1800, memory: '1GiB' },
  wrap<GenerateAnglesRequest>(async (uid, d) => { await runGenerateAngles(uid, d.projectId, d.subjectId); }),
);

/** Regenerate one angle image. */
export const generateAngleImage = onCall(
  { secrets: ALL_SECRETS, timeoutSeconds: 900, memory: '1GiB' },
  wrap<GenerateAngleImageRequest>(async (uid, d) => { await runGenerateSingleAngle(uid, d.projectId, d.subjectId, d.angleId); }),
);

/** Generate a character's casting screen test (video master: identity + voice). */
export const generateScreenTest = onCall(
  { secrets: ALL_SECRETS, timeoutSeconds: 1800, memory: '1GiB' },
  wrap<GenerateScreenTestRequest>(async (uid, d) => { await runGenerateScreenTest(uid, d.projectId, d.subjectId); }),
);

/** Generate an environment reference image. */
export const generateEnvironment = onCall(
  { secrets: ALL_SECRETS, timeoutSeconds: 900, memory: '1GiB' },
  wrap<GenerateEnvironmentRequest>(async (uid, d) => { await runGenerateEnvironment(uid, d.projectId, d.envId); }),
);

/** v2: design + sample a character voice with ElevenLabs. */
export const generateVoiceSample = onCall(
  { secrets: ALL_SECRETS, timeoutSeconds: 540, memory: '1GiB' },
  wrap<GenerateVoiceSampleRequest>(async (uid, d) => { await runGenerateVoiceSample(uid, d.projectId, d.subjectId); }),
);

/** Generate one scene's video (engine-aware, handles stitching inputs). */
export const generateScene = onCall(
  { secrets: ALL_SECRETS, timeoutSeconds: 1800, memory: '2GiB' },
  wrap<GenerateSceneRequest>(async (uid, d) => { await runGenerateScene(uid, d.projectId, d.sceneId); }),
);

/** Re-check a stuck scene job and finalize it if the provider finished. */
export const refreshScene = onCall(
  { secrets: ALL_SECRETS, timeoutSeconds: 300, memory: '1GiB' },
  wrap<GenerateSceneRequest>(async (uid, d) => runRefreshScene(uid, d.projectId, d.sceneId)),
);

/**
 * Build the Blender script for a scene's camera move. Spends nothing — the
 * user renders it locally and iterates for free before any credits go out.
 */
export const buildPrevizScript = onCall(
  { secrets: ALL_SECRETS, timeoutSeconds: 120, memory: '512MiB' },
  wrap<BuildPrevizScriptRequest>(async (uid, d) => {
    const { fileName } = await runBuildPrevizScript(uid, d.projectId, d.sceneId);
    return `${fileName} ready — download it and run: blender -b -P ${fileName}`;
  }),
);

/** Read an uploaded previz back into a timed camera map. */
export const ingestPreviz = onCall(
  { secrets: ALL_SECRETS, timeoutSeconds: 540, memory: '1GiB' },
  wrap<IngestPrevizRequest>(async (uid, d) => {
    const { windows, warnings } = await runIngestPreviz(uid, d.projectId, d.sceneId);
    return `Camera map ready — ${windows} window${windows === 1 ? '' : 's'}`
      + (warnings.length > 0 ? `, ${warnings.length} timing warning${warnings.length === 1 ? '' : 's'}` : '');
  }),
);

/** Stitch all scene clips into the final film. */
export const assembleFinal = onCall(
  { secrets: ALL_SECRETS, timeoutSeconds: 1800, memory: '2GiB' },
  wrap<AssembleFinalRequest>(async (uid, d) => { await runAssembleFinal(uid, d.projectId); }),
);

/**
 * Grade a take against its plan. Costs cents (vision + transcription) against
 * a re-roll's dollars, so it is meant to run before the regenerate button.
 */
export const verifyScene = onCall(
  { secrets: ALL_SECRETS, timeoutSeconds: 540, memory: '1GiB' },
  wrap<VerifySceneRequest>(async (uid, d) => {
    const { overall, call, issues } = await runVerifyScene(uid, d.projectId, d.sceneId, d.takePath);
    return `${overall}/100 — ${issues} finding${issues === 1 ? '' : 's'}`
      + `${call === 're_roll' ? ', a re-roll is warranted' : call === 'ship' ? ', good to ship' : ''}`;
  }),
);

/**
 * Work out what a re-roll note would change and what it would cost. Spends
 * nothing and writes nothing — this is what fills the confirm dialog.
 */
export const planRegeneration = onCall(
  { secrets: ALL_SECRETS, timeoutSeconds: 300, memory: '512MiB' },
  async (request: CallableRequest<PlanRegenerationRequest>) => {
    const uid = requireAuth(request);
    try {
      return await runPlanRegeneration(uid, request.data.projectId, request.data.sceneId, request.data.note);
    } catch (e) {
      if (e instanceof HttpsError) throw e;
      throw new HttpsError('internal', String((e as Error).message ?? e));
    }
  },
);

/** Re-roll a scene, optionally applying an already-approved patch. This spends. */
export const regenerateScene = onCall(
  { secrets: ALL_SECRETS, timeoutSeconds: 1800, memory: '2GiB' },
  wrap<RegenerateSceneRequest>(async (uid, d) => {
    await runRegenerateScene(uid, d.projectId, d.sceneId, { mode: d.mode, note: d.note, patch: d.patch });
  }),
);

/** Report which engine/providers are active (shown in the UI footer). */
export const getEngineInfo = onCall(
  { secrets: ALL_SECRETS, timeoutSeconds: 60 },
  async (request) => {
    requireAuth(request);
    const caps = activeEngine();
    return {
      engine: caps,
      imageProvider: activeImageProvider(),
      mock: caps.id === 'mock',
    };
  },
);
