/**
 * Higgsfield platform REST client (platform.higgsfield.ai).
 *
 * Auth: `Authorization: Key {key_id}:{key_secret}` (keys from cloud.higgsfield.ai).
 * Job lifecycle: POST model endpoint → {request_id, status_url} → poll
 * GET /requests/{id}/status until terminal (completed|failed|nsfw|canceled).
 * Output URLs are retained ~7 days, so results are copied to Firebase Storage
 * immediately by the callers.
 *
 * Video engines:
 *  - seedance25: Seedance 2.5 (omni-reference, native audio, extend). Its
 *    platform REST path is configurable via SEEDANCE25_PATH because the
 *    endpoint was pre-launch at build time — the request body follows the
 *    published parameter surface (mode/t2v/video_extension, reference arrays).
 *  - seedance1: Seedance v1 pro/fast image-to-video — first-frame conditioned,
 *    2-12s, silent. Consistency comes from a nano-banana keyframe generated
 *    from the subject reference images.
 *
 * Image generation: nano-banana (accepts up to 8 reference images — ideal for
 *  the master-first angle workflow) with soul/standard as a text-only option.
 */
import {
  HIGGSFIELD_API_KEY, HIGGSFIELD_API_SECRET, SEEDANCE25_PATH,
  secretOrEmpty, EngineCaps,
} from './config';
import type { AspectRatio, Resolution } from '../../shared/types';
import type { VideoGenRequest, VideoProvider, VideoJobStatus } from './providers';

const BASE_URL = 'https://platform.higgsfield.ai';

export interface HFMediaOutput { url: string; content_type?: string }
export interface HFRequestStatus {
  status: 'queued' | 'in_progress' | 'nsfw' | 'failed' | 'completed' | 'canceled';
  request_id: string;
  status_url?: string;
  cancel_url?: string;
  error?: string | null;
  images?: HFMediaOutput[];
  video?: HFMediaOutput;
  audio?: HFMediaOutput;
}

export interface HFSubmitResponse {
  status: string;
  request_id: string;
  status_url: string;
  cancel_url: string;
}

function authHeader(): string {
  const id = secretOrEmpty(HIGGSFIELD_API_KEY);
  const secret = secretOrEmpty(HIGGSFIELD_API_SECRET);
  return `Key ${id}:${secret}`;
}

async function hfFetch(path: string, init: RequestInit): Promise<Response> {
  const url = path.startsWith('http') ? path : `${BASE_URL}/${path.replace(/^\//, '')}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      'Authorization': authHeader(),
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  return res;
}

export class HiggsfieldError extends Error {
  constructor(message: string, public status?: number, public correlationId?: string | null) {
    super(message);
    this.name = 'HiggsfieldError';
  }
}

async function throwHfError(res: Response, context: string): Promise<never> {
  const correlationId = res.headers.get('x-correlation-id');
  let detail = '';
  try {
    const body = await res.json() as { detail?: unknown };
    detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail ?? body);
  } catch { /* non-JSON body */ }
  const hints: Record<number, string> = {
    401: 'Invalid Higgsfield credentials.',
    403: 'Insufficient Higgsfield credits.',
    404: 'Model or request not found for this account.',
    422: 'Request body failed validation.',
    423: 'Model temporarily blocked for this account.',
    503: 'Model disabled or not ready.',
  };
  throw new HiggsfieldError(
    `Higgsfield ${context} failed (HTTP ${res.status}${hints[res.status] ? ` — ${hints[res.status]}` : ''})${detail ? `: ${detail}` : ''}`,
    res.status,
    correlationId,
  );
}

/** Submit a generation job. Optional webhookUrl is passed as ?hf_webhook=... */
export async function submitJob(modelPath: string, body: Record<string, unknown>, webhookUrl?: string): Promise<HFSubmitResponse> {
  const qs = webhookUrl ? `?hf_webhook=${encodeURIComponent(webhookUrl)}` : '';
  const res = await hfFetch(`${modelPath}${qs}`, { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) await throwHfError(res, `submit ${modelPath}`);
  return await res.json() as HFSubmitResponse;
}

export async function getJobStatus(requestId: string): Promise<HFRequestStatus> {
  const res = await hfFetch(`requests/${requestId}/status`, { method: 'GET' });
  if (!res.ok) await throwHfError(res, 'status');
  return await res.json() as HFRequestStatus;
}

/** Cost estimate: same path prefixed with /estimate. Returns credits + usd. */
export async function estimateCost(modelPath: string, body: Record<string, unknown>): Promise<{ credits: string; usd: string } | null> {
  try {
    const res = await hfFetch(`estimate/${modelPath}`, { method: 'POST', body: JSON.stringify(body) });
    if (!res.ok) return null;
    return await res.json() as { credits: string; usd: string };
  } catch {
    return null;
  }
}

/**
 * Poll until a terminal status. Interval starts at 2s and grows to 10s with
 * jitter (per Higgsfield's recommendation). onTick lets callers stream
 * progress into Firestore.
 */
export async function pollUntilDone(
  requestId: string,
  opts: { maxMs?: number; onTick?: (s: HFRequestStatus) => Promise<void> | void } = {},
): Promise<HFRequestStatus> {
  const maxMs = opts.maxMs ?? 25 * 60 * 1000;
  const start = Date.now();
  let interval = 2000;
  for (;;) {
    const status = await getJobStatus(requestId);
    if (opts.onTick) await opts.onTick(status);
    if (status.status === 'completed' || status.status === 'failed' || status.status === 'nsfw' || status.status === 'canceled') {
      return status;
    }
    if (Date.now() - start > maxMs) {
      throw new HiggsfieldError(`Generation ${requestId} still ${status.status} after ${Math.round(maxMs / 60000)} min — use "Refresh" later; the job keeps running server-side.`);
    }
    const jitter = Math.random() * 500;
    await new Promise((r) => setTimeout(r, interval + jitter));
    interval = Math.min(10000, interval * 1.5);
  }
}

export function assertCompleted(status: HFRequestStatus, what: string): void {
  if (status.status === 'completed') return;
  if (status.status === 'nsfw') {
    throw new HiggsfieldError(`${what} was flagged by the content filter (nsfw). Adjust the prompt/references and retry. (No credits charged.)`);
  }
  throw new HiggsfieldError(`${what} ${status.status}${status.error ? `: ${status.error}` : ''}`);
}


// ---------------------------------------------------------------------------
// Image generation (character/product angles, environments, keyframes)
// ---------------------------------------------------------------------------

/** Map our aspect ratios to nano-banana's accepted enum. */
function nanoBananaAspect(ar: AspectRatio): string {
  const ok = ['1:1', '4:3', '3:4', '16:9', '9:16', '21:9'];
  return ok.includes(ar) ? ar : 'auto';
}

export interface ImageGenRequest {
  prompt: string;
  /** Reference image URLs, in @image1..N order (max 8) */
  refUrls: string[];
  aspectRatio: AspectRatio;
  webhookUrl?: string;
}

/**
 * Generate one image with nano-banana (multi-reference) — used for subject
 * masters/angles, environment refs and scene keyframes. Returns request id.
 */
export async function submitImageJob(req: ImageGenRequest): Promise<HFSubmitResponse> {
  const body: Record<string, unknown> = {
    prompt: req.prompt,
    num_images: 1,
    aspect_ratio: nanoBananaAspect(req.aspectRatio),
    output_format: 'png',
    input_images: req.refUrls.slice(0, 8).map((u) => ({ type: 'image_url', image_url: u })),
  };
  return submitJob('nano-banana', body, req.webhookUrl);
}

// ---------------------------------------------------------------------------
// Video generation adapters
// ---------------------------------------------------------------------------

function s25Resolution(r: Resolution): string {
  // Seedance 2.5 caps at 720p on the published surface
  return r === '480p' ? '480p' : '720p';
}

function s1Resolution(r: Resolution): string {
  if (r === '480p') return '480';
  if (r === '1080p' || r === '4k') return '1080';
  return '720';
}

export function seedance25Path(): string {
  return SEEDANCE25_PATH.value().trim().replace(/^\//, '').replace(/\/$/, '');
}

/**
 * Seedance 2.5 body per the published parameter surface (mode + reference
 * arrays). VERIFY against the live schema once the platform endpoint ships —
 * this adapter is intentionally isolated so only this function needs updating.
 */
export function buildSeedance25Body(req: VideoGenRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    prompt: req.prompt,
    mode: req.extendVideoUrl ? 'video_extension' : (req.imageRefUrls.length > 0 ? 'omni_reference' : 't2v'),
    duration: Math.max(4, Math.min(30, Math.round(req.durationSec))),
    resolution: s25Resolution(req.resolution),
    aspect_ratio: req.aspectRatio,
    generate_audio: req.generateAudio,
  };
  if (req.imageRefUrls.length > 0) body.image_references = req.imageRefUrls.slice(0, 30);
  if (req.audioRefUrls.length > 0) body.audio_references = req.audioRefUrls.slice(0, 10);
  if (req.extendVideoUrl) {
    body.video_references = [req.extendVideoUrl];
    body.extension_mode = 'forward';
    delete body.aspect_ratio; // locked to source when extending
  }
  if (req.seed !== undefined) body.seed = req.seed;
  return body;
}

export async function submitVideoJob(engine: EngineCaps, req: VideoGenRequest): Promise<HFSubmitResponse> {
  if (engine.id === 'seedance25') {
    const path = seedance25Path();
    if (!path) throw new HiggsfieldError('SEEDANCE25_PATH is not configured.');
    return submitJob(path, buildSeedance25Body(req));
  }
  // Seedance v1 pro/fast image-to-video — needs a start keyframe.
  if (!req.startImageUrl) {
    throw new HiggsfieldError('Seedance v1 requires a start keyframe image.');
  }
  const body: Record<string, unknown> = {
    prompt: req.prompt,
    image_url: req.startImageUrl,
    duration: Math.max(2, Math.min(12, Math.round(req.durationSec))),
    resolution: s1Resolution(req.resolution),
    aspect_ratio: req.aspectRatio === '3:4' ? '3:4' : req.aspectRatio,
    camera_fixed: false,
  };
  return submitJob('bytedance/seedance/v1/pro/fast/image-to-video', body);
}

/** VideoProvider implementation over the Higgsfield job lifecycle. */
export function higgsfieldVideoProvider(engine: EngineCaps): VideoProvider {
  return {
    name: 'higgsfield',
    async submitVideo(req: VideoGenRequest): Promise<string> {
      const submitted = await submitVideoJob(engine, req);
      return submitted.request_id;
    },
    async videoStatus(jobId: string): Promise<VideoJobStatus> {
      const s = await getJobStatus(jobId);
      switch (s.status) {
        case 'completed':
          if (!s.video?.url) return { state: 'failed', error: 'Completed without a video URL.' };
          return { state: 'completed', videoUrl: s.video.url };
        case 'failed':
          return { state: 'failed', error: s.error ?? 'Generation failed.' };
        case 'nsfw':
          return { state: 'failed', error: 'Flagged by the content filter (nsfw). Adjust the prompt/references and retry — no credits charged.' };
        case 'canceled':
          return { state: 'failed', error: 'Job was canceled.' };
        case 'in_progress':
          return { state: 'generating' };
        default:
          return { state: 'queued' };
      }
    },
  };
}
