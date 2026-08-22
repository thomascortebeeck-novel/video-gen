import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore, Firestore, DocumentReference } from 'firebase-admin/firestore';
import { getStorage, getDownloadURL } from 'firebase-admin/storage';
import { HttpsError, CallableRequest } from 'firebase-functions/v2/https';
import type {
  ProjectDoc, SubjectDoc, SceneDoc, EnvironmentDoc,
} from '../../shared/types';
import { collections } from '../../shared/types';

if (getApps().length === 0) {
  initializeApp();
}

export const db: Firestore = getFirestore();
export const bucket = () => getStorage().bucket();

export function requireAuth(request: CallableRequest): string {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError('unauthenticated', 'Sign in required.');
  }
  return uid;
}

export function projectRef(uid: string, projectId: string): DocumentReference {
  return db.doc(collections.project(uid, projectId));
}

export async function getProject(uid: string, projectId: string): Promise<ProjectDoc> {
  const snap = await projectRef(uid, projectId).get();
  if (!snap.exists) throw new HttpsError('not-found', `Project ${projectId} not found.`);
  return { ...(snap.data() as ProjectDoc), id: snap.id };
}

export async function getSubjects(uid: string, projectId: string): Promise<SubjectDoc[]> {
  const snap = await db.collection(collections.subjects(uid, projectId)).orderBy('createdAt').get();
  return snap.docs.map((d) => ({ ...(d.data() as SubjectDoc), id: d.id }));
}

export async function getSubject(uid: string, projectId: string, subjectId: string): Promise<SubjectDoc> {
  const snap = await db.collection(collections.subjects(uid, projectId)).doc(subjectId).get();
  if (!snap.exists) throw new HttpsError('not-found', `Subject ${subjectId} not found.`);
  return { ...(snap.data() as SubjectDoc), id: snap.id };
}

export async function getScenes(uid: string, projectId: string): Promise<SceneDoc[]> {
  const snap = await db.collection(collections.scenes(uid, projectId)).orderBy('index').get();
  return snap.docs.map((d) => ({ ...(d.data() as SceneDoc), id: d.id }));
}

export async function getScene(uid: string, projectId: string, sceneId: string): Promise<SceneDoc> {
  const snap = await db.collection(collections.scenes(uid, projectId)).doc(sceneId).get();
  if (!snap.exists) throw new HttpsError('not-found', `Scene ${sceneId} not found.`);
  return { ...(snap.data() as SceneDoc), id: snap.id };
}

export async function getEnvironments(uid: string, projectId: string): Promise<EnvironmentDoc[]> {
  const snap = await db.collection(collections.environments(uid, projectId)).orderBy('createdAt').get();
  return snap.docs.map((d) => ({ ...(d.data() as EnvironmentDoc), id: d.id }));
}

export async function getEnvironment(uid: string, projectId: string, envId: string): Promise<EnvironmentDoc> {
  const snap = await db.collection(collections.environments(uid, projectId)).doc(envId).get();
  if (!snap.exists) throw new HttpsError('not-found', `Environment ${envId} not found.`);
  return { ...(snap.data() as EnvironmentDoc), id: snap.id };
}

export async function setProgress(uid: string, projectId: string, step: string, message: string, pct?: number): Promise<void> {
  await projectRef(uid, projectId).set(
    { progress: { step, message, ...(pct !== undefined ? { pct } : {}) }, updatedAt: Date.now() },
    { merge: true },
  );
}

/** Download a Storage object into a Buffer. */
export async function downloadToBuffer(path: string): Promise<Buffer> {
  const [buf] = await bucket().file(path).download();
  return buf;
}

/** Save a Buffer to Storage. */
export async function saveBuffer(path: string, data: Buffer, contentType: string): Promise<void> {
  await bucket().file(path).save(data, { contentType, resumable: false });
}

/**
 * Durable, token-based public download URL for a stored object — used to hand
 * reference images/videos to external APIs (Higgsfield fetches them by URL).
 */
export async function publicUrl(path: string): Promise<string> {
  return getDownloadURL(bucket().file(path));
}

/** Guess a content type from a storage path. */
export function contentTypeFor(path: string): string {
  const p = path.toLowerCase();
  if (p.endsWith('.png')) return 'image/png';
  if (p.endsWith('.jpg') || p.endsWith('.jpeg')) return 'image/jpeg';
  if (p.endsWith('.webp')) return 'image/webp';
  if (p.endsWith('.svg')) return 'image/svg+xml';
  if (p.endsWith('.mp4')) return 'video/mp4';
  if (p.endsWith('.mp3')) return 'audio/mpeg';
  return 'application/octet-stream';
}
