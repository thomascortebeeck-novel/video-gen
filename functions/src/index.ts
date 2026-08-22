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
  runRefreshScene, runAssembleFinal,
} from './pipeline';
import type {
  AnalyzeSubjectsRequest, PlanBriefingRequest, GenerateAnglesRequest,
  GenerateAngleImageRequest, GenerateEnvironmentRequest, GenerateSceneRequest,
  AssembleFinalRequest, GenerateVoiceSampleRequest, PipelineStepResult,
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

/** Stitch all scene clips into the final film. */
export const assembleFinal = onCall(
  { secrets: ALL_SECRETS, timeoutSeconds: 1800, memory: '2GiB' },
  wrap<AssembleFinalRequest>(async (uid, d) => { await runAssembleFinal(uid, d.projectId); }),
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
