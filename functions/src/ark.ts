/**
 * BytePlus ModelArk provider — ByteDance's OFFICIAL Seedance 2.5 API
 * (the source the resellers wrap; cheapest per second, 1080p, native
 * forward/backward extension).
 *
 * API (verified 2026-08-22):
 *   POST https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks
 *     Authorization: Bearer <ARK_API_KEY>
 *     { model: "dreamina-seedance-2-5-260628",
 *       content: [ {type:"text", text: prompt},
 *                  {type:"image_url", image_url:{url}, role:"reference_image"|"first_frame"|"last_frame"},
 *                  {type:"audio_url", audio_url:{url}, role:"reference_audio"},
 *                  {type:"video_url", video_url:{url}, role:"reference_video"} ],
 *       resolution, ratio, duration, generate_audio, seed?, callback_url?, ... }
 *     → { id: "cgt-..." }
 *   GET  .../tasks/{id} → { status: queued|running|succeeded|failed|cancelled|expired,
 *                           content: { video_url }, usage: { completion_tokens }, ... }
 *
 * Task-type rules encoded below:
 *  - omni reference mode: any asset with a reference_* role; ratio free
 *  - first/last frame mode: role first_frame/last_frame; ratio MUST be "adaptive"
 *  - extension: reference_video + continuation intent; omni_reference_task_type
 *    "extend" pre-validates; ratio "adaptive"
 * Output URLs are valid 24h (≤100 downloads) — callers persist to Storage
 * immediately (our pipeline always does).
 */
import { ARK_API_KEY, ARK_BASE_URL, secretOrEmpty } from './config';
import type { Resolution } from '../../shared/types';
import type { VideoGenRequest, VideoProvider, VideoJobStatus } from './providers';

const BASE = () => ARK_BASE_URL.value().trim().replace(/\/$/, '');
const MODEL = 'dreamina-seedance-2-5-260628';

export class ArkError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = 'ArkError';
  }
}

function headers(): Record<string, string> {
  const key = secretOrEmpty(ARK_API_KEY);
  if (!key) throw new ArkError('ARK_API_KEY is not configured');
  return { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' };
}

async function arkFetch(path: string, init: RequestInit, context: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE()}${path}`, { ...init, headers: { ...headers(), ...(init.headers ?? {}) } });
  if (!res.ok) {
    let detail = '';
    try { detail = JSON.stringify(await res.json()).slice(0, 500); } catch { /* ignore */ }
    throw new ArkError(`ModelArk ${context} failed (HTTP ${res.status})${detail ? `: ${detail}` : ''}`, res.status);
  }
  return await res.json() as Record<string, unknown>;
}

function arkResolution(r: Resolution): string {
  if (r === '480p') return '480p';
  if (r === '1080p' || r === '4k') return '1080p';
  return '720p';
}

type ContentItem = Record<string, unknown>;

/**
 * ModelArk's docs write reference tags as "@Image 1" / "@Image1" (capitalized).
 * Our internal template uses Dan Kieft's lowercase "@image1" — normalize at
 * the wire so the prompt matches the platform's documented convention.
 * Binding is by order within each modality (confirmed by the official
 * multimodal example: Nth reference_image ⇔ @Image N, Nth reference_video ⇔
 * @Video N) — exactly the order we attach them in.
 */
function arkTagStyle(prompt: string): string {
  return prompt
    .replace(/@image\s?(\d+)/gi, '@Image $1')
    .replace(/@video\s?(\d+)/gi, '@Video $1')
    .replace(/@audio\s?(\d+)/gi, '@Audio $1');
}

export function buildArkBody(req: VideoGenRequest): Record<string, unknown> {
  const content: ContentItem[] = [];
  const duration = Math.max(4, Math.min(30, Math.round(req.durationSec)));
  const body: Record<string, unknown> = {
    model: MODEL,
    resolution: arkResolution(req.resolution),
    duration,
    generate_audio: req.generateAudio,
    watermark: false,
  };
  if (req.seed !== undefined) body.seed = req.seed;

  if (req.extendVideoUrl) {
    // Extension: reference_video + explicit continuation intent in the text.
    content.push({
      type: 'text',
      text: arkTagStyle(`Extend @Video 1 forward — continue the story directly from where it ends, never replaying earlier action.\n${req.prompt}`),
    });
    content.push({ type: 'video_url', video_url: { url: req.extendVideoUrl }, role: 'reference_video' });
    for (const url of req.imageRefUrls.slice(0, 30)) {
      content.push({ type: 'image_url', image_url: { url }, role: 'reference_image' });
    }
    body.omni_reference_task_type = 'extend';
    body.ratio = 'adaptive';
  } else if (req.imageRefUrls.length > 0 || (req.videoRefUrls?.length ?? 0) > 0) {
    // Omni reference mode: plain reference_video clips first (character
    // screen tests — @Video N binds by attachment order), then images.
    content.push({ type: 'text', text: arkTagStyle(req.prompt) });
    for (const url of (req.videoRefUrls ?? []).slice(0, 10)) {
      content.push({ type: 'video_url', video_url: { url }, role: 'reference_video' });
    }
    for (const url of req.imageRefUrls.slice(0, 30)) {
      content.push({ type: 'image_url', image_url: { url }, role: 'reference_image' });
    }
    for (const url of req.audioRefUrls.slice(0, 10)) {
      content.push({ type: 'audio_url', audio_url: { url }, role: 'reference_audio' });
    }
    body.ratio = req.aspectRatio;
  } else if (req.startImageUrl) {
    // First-frame conditioning; ratio must be adaptive (follows the image).
    content.push({ type: 'text', text: arkTagStyle(req.prompt) });
    content.push({ type: 'image_url', image_url: { url: req.startImageUrl }, role: 'first_frame' });
    body.ratio = 'adaptive';
  } else {
    content.push({ type: 'text', text: arkTagStyle(req.prompt) });
    body.ratio = req.aspectRatio;
  }
  body.content = content;
  return body;
}

// ---------------------------------------------------------------------------
// Image generation — Seedream 5.0 Pro (same key/base, synchronous API)
// POST /images/generations  { model, prompt, image: string[], size, ... }
// ---------------------------------------------------------------------------

const IMAGE_MODEL = 'dola-seedream-5-0-pro-260628';

/** Map aspect ratios to explicit ~2K dimensions (falls back to "2K"). */
function seedreamSize(aspectRatio: string): string {
  const sizes: Record<string, string> = {
    '3:4': '1536x2048',
    '4:3': '2048x1536',
    '16:9': '2048x1152',
    '9:16': '1152x2048',
    '1:1': '2048x2048',
  };
  return sizes[aspectRatio] ?? '2K';
}

export interface ArkImageRequest {
  prompt: string;
  /** reference image URLs in @image1..N order (Seedream takes up to ~10) */
  refUrls: string[];
  aspectRatio: string;
}

/** Generate one image with Seedream 5.0 Pro. Returns the PNG/JPEG bytes. */
export async function arkGenerateImage(req: ArkImageRequest): Promise<Buffer> {
  // Note: 5.0 Pro rejects `sequential_image_generation` outright (Lite-only
  // param) — do not send it, even as "disabled".
  const body: Record<string, unknown> = {
    model: IMAGE_MODEL,
    prompt: arkTagStyle(req.prompt),
    size: seedreamSize(req.aspectRatio),
    output_format: 'png',
    response_format: 'url',
    watermark: false,
  };
  if (req.refUrls.length > 0) {
    body.image = req.refUrls.slice(0, 10);
  }
  // ModelArk rate-limits image calls aggressively on fresh accounts — retry
  // "Too many requests" with growing backoff before giving up.
  let res: Record<string, unknown> | undefined;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      res = await arkFetch('/images/generations', {
        method: 'POST',
        body: JSON.stringify(body),
      }, 'image generation');
      break;
    } catch (e) {
      lastErr = e;
      const msg = String((e as Error).message ?? e);
      const rateLimited = msg.includes('Too many requests') || msg.includes('HTTP 429');
      if (!rateLimited || attempt === 5) throw e;
      await new Promise((r) => setTimeout(r, attempt * 15000));
    }
  }
  if (!res) throw lastErr instanceof Error ? lastErr : new ArkError(String(lastErr));
  const data = res.data as { url?: string }[] | undefined;
  const url = data?.[0]?.url;
  if (!url) {
    const err = res.error as { message?: string } | undefined;
    throw new ArkError(`Seedream returned no image${err?.message ? `: ${err.message}` : ''}`);
  }
  const dl = await fetch(url);
  if (!dl.ok) throw new ArkError(`Failed to download Seedream image (${dl.status})`);
  return Buffer.from(await dl.arrayBuffer());
}

export function arkVideoProvider(): VideoProvider {
  return {
    name: 'ark',
    async submitVideo(req: VideoGenRequest): Promise<string> {
      const created = await arkFetch('/contents/generations/tasks', {
        method: 'POST',
        body: JSON.stringify(buildArkBody(req)),
      }, 'create task');
      const id = created.id as string | undefined;
      if (!id) throw new ArkError('ModelArk returned no task id');
      return id;
    },
    async videoStatus(jobId: string): Promise<VideoJobStatus> {
      const task = await arkFetch(`/contents/generations/tasks/${jobId}`, { method: 'GET' }, 'retrieve task');
      const status = String(task.status ?? '');
      if (status === 'succeeded') {
        const contentObj = task.content as { video_url?: string } | undefined;
        if (!contentObj?.video_url) return { state: 'failed', error: 'Succeeded without a video_url.' };
        return { state: 'completed', videoUrl: contentObj.video_url };
      }
      if (status === 'failed' || status === 'cancelled' || status === 'expired') {
        const err = task.error as { code?: string; message?: string } | undefined;
        return { state: 'failed', error: err?.message ?? `ModelArk task ${status}${err?.code ? ` (${err.code})` : ''}` };
      }
      if (status === 'running') return { state: 'generating' };
      return { state: 'queued' };
    },
  };
}
