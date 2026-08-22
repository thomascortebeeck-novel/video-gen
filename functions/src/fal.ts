/**
 * fal.ai provider — real Seedance 2.5 access today.
 *
 * Queue API: POST https://queue.fal.run/{modelId} (Authorization: Key FAL_KEY)
 * → {request_id}; status at {base}/requests/{id}/status; result JSON at
 * {base}/requests/{id} where {base} is the model's first two path segments
 * (fal routes subpath endpoints through the base model queue).
 *
 * Endpoint choice per request:
 *  - reference-to-video: whenever image references exist (subject angles,
 *    environment, bridge frame — the bridge frame rides first and the prompt
 *    declares it "the exact first frame", the Seedance-2.5-native way).
 *  - image-to-video: start frame only, no other refs (supports end_image_url).
 *  - text-to-video: no visual conditioning at all.
 */
import { FAL_KEY, FAL_SEEDANCE25_BASE, secretOrEmpty } from './config';
import type { Resolution } from '../../shared/types';
import type { VideoGenRequest, VideoProvider, VideoJobStatus } from './providers';

const QUEUE = 'https://queue.fal.run';

/** fal's docs write tags as "@Image1" — normalize our lowercase template tags. */
function falTagStyle(prompt: string): string {
  return prompt
    .replace(/@image\s?(\d+)/gi, '@Image$1')
    .replace(/@video\s?(\d+)/gi, '@Video$1')
    .replace(/@audio\s?(\d+)/gi, '@Audio$1');
}

export class FalError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = 'FalError';
  }
}

function authHeaders(): Record<string, string> {
  const key = secretOrEmpty(FAL_KEY);
  if (!key) throw new FalError('FAL_KEY is not configured');
  return { 'Authorization': `Key ${key}`, 'Content-Type': 'application/json' };
}

function baseModel(): string {
  // "bytedance/seedance-2.5" — queue status/result URLs use the base id
  return FAL_SEEDANCE25_BASE.value().trim().replace(/^\//, '').replace(/\/$/, '');
}

async function falFetch(url: string, init: RequestInit, context: string): Promise<Record<string, unknown>> {
  const res = await fetch(url, { ...init, headers: { ...authHeaders(), ...(init.headers ?? {}) } });
  if (!res.ok) {
    let detail = '';
    try { detail = JSON.stringify(await res.json()).slice(0, 500); } catch { /* ignore */ }
    throw new FalError(`fal.ai ${context} failed (HTTP ${res.status})${detail ? `: ${detail}` : ''}`, res.status);
  }
  return await res.json() as Record<string, unknown>;
}

function s25Resolution(r: Resolution): string {
  if (r === '480p') return '480p';
  if (r === '1080p' || r === '4k') return '1080p';
  return '720p';
}

/**
 * Bodies verified against fal's OpenAPI (2026-08-22):
 *  - duration is a STRING enum "auto" | "4".."30"
 *  - resolution: "480p" | "720p" | "1080p" on r2v and i2v
 *  - r2v: image_urls (≤30), video_urls (≤10), audio_urls (≤10) — prompt refers
 *    to them as @Image1… ; aspect_ratio enum incl. all ours
 *  - i2v: image_url + optional end_image_url; aspect_ratio is const "auto"
 *  - no seed input (seed is returned in the output)
 */
export function buildFalSeedanceRequest(req: VideoGenRequest): { endpoint: string; body: Record<string, unknown> } {
  const base = baseModel();
  const duration = String(Math.max(4, Math.min(30, Math.round(req.durationSec))));
  const common: Record<string, unknown> = {
    prompt: falTagStyle(req.prompt),
    duration,
    generate_audio: req.generateAudio,
    resolution: s25Resolution(req.resolution),
  };
  if (req.extendVideoUrl) {
    // Omni extension: the source clip as a video reference + continuation
    // intent in the prompt; aspect stays "auto" (locked to the source).
    return {
      endpoint: `${base}/reference-to-video`,
      body: {
        ...common,
        prompt: falTagStyle(`Extend @Video1 forward — continue the story directly from where it ends, never replaying earlier action.\n${req.prompt}`),
        video_urls: [req.extendVideoUrl],
        ...(req.imageRefUrls.length > 0 ? { image_urls: req.imageRefUrls.slice(0, 30) } : {}),
      },
    };
  }
  if (req.imageRefUrls.length > 0) {
    return {
      endpoint: `${base}/reference-to-video`,
      body: {
        ...common,
        image_urls: req.imageRefUrls.slice(0, 30),
        ...(req.audioRefUrls.length > 0 ? { audio_urls: req.audioRefUrls.slice(0, 10) } : {}),
        aspect_ratio: req.aspectRatio,
      },
    };
  }
  if (req.startImageUrl) {
    return {
      endpoint: `${base}/image-to-video`,
      body: {
        ...common,
        image_url: req.startImageUrl, // AR inherits the image ("auto")
      },
    };
  }
  return {
    endpoint: `${base}/text-to-video`,
    body: { ...common, aspect_ratio: req.aspectRatio },
  };
}

function extractVideoUrl(result: Record<string, unknown>): string | undefined {
  const video = result.video as { url?: string } | undefined;
  if (video?.url) return video.url;
  // some model outputs nest under `data` or return a list
  const data = result.data as Record<string, unknown> | undefined;
  const nested = data?.video as { url?: string } | undefined;
  if (nested?.url) return nested.url;
  return undefined;
}

export function falVideoProvider(): VideoProvider {
  return {
    name: 'fal',
    async submitVideo(req: VideoGenRequest): Promise<string> {
      const { endpoint, body } = buildFalSeedanceRequest(req);
      const submitted = await falFetch(`${QUEUE}/${endpoint}`, { method: 'POST', body: JSON.stringify(body) }, `submit ${endpoint}`);
      const requestId = submitted.request_id as string | undefined;
      if (!requestId) throw new FalError('fal.ai returned no request_id');
      return requestId;
    },
    async videoStatus(jobId: string): Promise<VideoJobStatus> {
      const base = baseModel();
      const status = await falFetch(`${QUEUE}/${base}/requests/${jobId}/status`, { method: 'GET' }, 'status');
      const state = String(status.status ?? '');
      if (state === 'IN_QUEUE') return { state: 'queued' };
      if (state === 'IN_PROGRESS') return { state: 'generating' };
      if (state === 'COMPLETED') {
        const result = await falFetch(`${QUEUE}/${base}/requests/${jobId}`, { method: 'GET' }, 'result');
        const url = extractVideoUrl(result);
        if (!url) return { state: 'failed', error: 'Completed without a video URL in the result.' };
        return { state: 'completed', videoUrl: url };
      }
      // fal reports failures via non-2xx on the result fetch or an ERROR status
      return { state: 'failed', error: `fal.ai job status: ${state || 'unknown'}` };
    },
  };
}
