/**
 * Client API layer: Firestore document helpers + callable function wrappers.
 */
import {
  collection, doc, setDoc, updateDoc, deleteDoc,
} from 'firebase/firestore';
import { ref as storageRef, uploadBytes } from 'firebase/storage';
import { httpsCallable } from 'firebase/functions';
import { db, storage, functions, auth } from './firebase';
import type {
  ProjectDoc, ProjectInput, SubjectDoc, SubjectKind, AngleSetId,
  ScenePreviz, PipelineStepResult, ScenePatch,
  VerifySceneRequest, PlanRegenerationRequest, RegenerateSceneRequest,
} from '@shared/types';
import { collections, storagePaths } from '@shared/types';

export function uid(): string {
  const u = auth.currentUser;
  if (!u) throw new Error('Not signed in');
  return u.uid;
}

const now = () => Date.now();
const newId = () => doc(collection(db, '_ids')).id;

// ---------------------------------------------------------------------------
// Project + subject creation (client writes)
// ---------------------------------------------------------------------------

export async function createProject(input: ProjectInput, title: string): Promise<string> {
  const id = newId();
  const project: ProjectDoc = {
    id, title: title || 'Untitled project', status: 'draft', input,
    createdAt: now(), updatedAt: now(),
  };
  await setDoc(doc(db, collections.project(uid(), id)), project);
  return id;
}

export interface NewSubjectFiles {
  kind: SubjectKind;
  name: string;
  notes: string;
  angleSet: AngleSetId;
  files: File[];
}

export async function addSubject(projectId: string, s: NewSubjectFiles): Promise<string> {
  const id = newId();
  const paths: string[] = [];
  for (const file of s.files) {
    const safe = file.name.replace(/[^\w.-]+/g, '_').slice(-60);
    const path = storagePaths.upload(uid(), projectId, id, `${Date.now()}_${safe}`);
    await uploadBytes(storageRef(storage, path), file, { contentType: file.type });
    paths.push(path);
  }
  const subject: SubjectDoc = {
    id, kind: s.kind, name: s.name, notes: s.notes,
    sourceImagePaths: paths,
    angleSet: s.kind === 'product' ? 'product_auto' : s.angleSet,
    angles: [], status: 'new',
    createdAt: now(), updatedAt: now(),
  };
  await setDoc(doc(db, collections.subjects(uid(), projectId), id), subject);
  return id;
}

export async function patchDoc(path: string, patch: Record<string, unknown>): Promise<void> {
  await updateDoc(doc(db, path), { ...patch, updatedAt: now() });
}

export async function removeDoc(path: string): Promise<void> {
  await deleteDoc(doc(db, path));
}

// ---------------------------------------------------------------------------
// Callables
// ---------------------------------------------------------------------------

/** Mirrors RegenerationPlan in functions/src/pipeline.ts (the web bundle must not import from functions/). */
export interface RegenerationPlan {
  patches: (ScenePatch & { sharedText: boolean })[];
  rejected: { field: string; reason: string }[];
  unaddressable: string[];
  summary: string;
  prompt: string;
  estimatedCostUsd: number;
}

type Res = PipelineStepResult;
const call = <TReq>(name: string) => {
  const fn = httpsCallable<TReq, Res>(functions, name, { timeout: 1_800_000 });
  return async (data: TReq): Promise<Res> => {
    const r = await fn(data);
    return r.data;
  };
};

export const api = {
  analyzeSubjects: call<{ projectId: string }>('analyzeSubjects'),
  planBriefing: call<{ projectId: string }>('planBriefing'),
  generateAngles: call<{ projectId: string; subjectId: string }>('generateAngles'),
  generateScreenTest: call<{ projectId: string; subjectId: string }>('generateScreenTest'),
  generateAngleImage: call<{ projectId: string; subjectId: string; angleId: string }>('generateAngleImage'),
  generateEnvironment: call<{ projectId: string; envId: string }>('generateEnvironment'),
  generateVoiceSample: call<{ projectId: string; subjectId: string }>('generateVoiceSample'),
  generateScene: call<{ projectId: string; sceneId: string }>('generateScene'),
  buildPrevizScript: call<{ projectId: string; sceneId: string }>('buildPrevizScript'),
  ingestPreviz: call<{ projectId: string; sceneId: string }>('ingestPreviz'),
  refreshScene: call<{ projectId: string; sceneId: string }>('refreshScene'),
  assembleFinal: call<{ projectId: string }>('assembleFinal'),
  verifyScene: call<VerifySceneRequest>('verifyScene'),
  regenerateScene: call<RegenerateSceneRequest>('regenerateScene'),
  /**
   * Costs nothing: returns the patch a note would make, the prompt it would
   * send and the price of sending it. The confirm dialog is built from this,
   * so no re-roll is ever a surprise.
   */
  planRegeneration: (() => {
    const fn = httpsCallable<PlanRegenerationRequest, RegenerationPlan>(functions, 'planRegeneration', { timeout: 300_000 });
    return async (data: PlanRegenerationRequest): Promise<RegenerationPlan> => (await fn(data)).data;
  })(),
  getEngineInfo: (() => {
    const fn = httpsCallable<Record<string, never>, { engine: { id: string; label: string; maxClipSeconds: number; nativeAudio: boolean; extend: boolean }; mock: boolean }>(functions, 'getEngineInfo');
    return async () => (await fn({})).data;
  })(),
};

/**
 * Upload a previz rendered locally in Blender, then read it back into a timed
 * camera map. The render itself is free — only this readback touches an API,
 * and it is a text call, not a generation.
 */
export async function uploadPreviz(
  projectId: string, sceneId: string, file: File, previz: ScenePreviz | undefined,
): Promise<void> {
  const version = (previz?.videoPath ? Number(previz.videoPath.match(/v(\d+)\.mp4$/)?.[1] ?? 0) : 0) + 1;
  const path = storagePaths.previzVideo(uid(), projectId, sceneId, version);
  await uploadBytes(storageRef(storage, path), file, { contentType: file.type || 'video/mp4' });
  await patchDoc(`${collections.scenes(uid(), projectId)}/${sceneId}`, {
    previz: { ...(previz ?? { feed: 'map_only' }), videoPath: path, status: 'rendered', updatedAt: now() },
  });
  await api.ingestPreviz({ projectId, sceneId });
}

/**
 * The "Generate" pipeline after project creation:
 * analyze subjects → plan briefing. Errors land in Firestore status fields,
 * so callers can fire-and-forget; the project page shows live progress.
 */
export async function runBriefingPipeline(projectId: string): Promise<void> {
  await api.analyzeSubjects({ projectId });
  await api.planBriefing({ projectId });
}
