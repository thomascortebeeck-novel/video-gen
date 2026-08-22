/**
 * OpenAI GPT Image 2 provider — image generation for angle sheets,
 * environments and keyframes.
 *
 * API (verified 2026-08-23 with this project's key):
 *   POST https://api.openai.com/v1/images/generations   (no reference images)
 *     { model:"gpt-image-2", prompt, size, quality, n }  → data[0].b64_json
 *   POST https://api.openai.com/v1/images/edits          (with references)
 *     multipart form: model, prompt, size, quality, n, image[] (binary parts,
 *     attachment order = reference order) → data[0].b64_json
 *
 * Facts that matter:
 *  - Requires OpenAI Organization Verification (done on this account).
 *  - Arbitrary WxH sizes allowed: edges multiples of 16, ≤3840, ratio ≤3:1 —
 *    so true 3:4 portrait sheets work (Seedream parity).
 *  - Input fidelity is always high on gpt-image-2 (no param); reference
 *    images containing faces are accepted (unlike ModelArk's video filter).
 *  - Billing is per output token (≈ pixels × quality): quality "high" costs
 *    ≈4× "medium". OPENAI_IMAGE_QUALITY switches globally.
 *  - Complex prompts can take up to ~2 minutes per image.
 */
import { OPENAI_API_KEY, OPENAI_IMAGE_QUALITY, secretOrEmpty } from './config';

const BASE = 'https://api.openai.com/v1';
const MODEL = 'gpt-image-2';

export class OpenAiImageError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = 'OpenAiImageError';
  }
}

/** GPT Image doesn't use @image tags — rewrite to plain-language references. */
function openaiTagStyle(prompt: string): string {
  return prompt.replace(/@image\s?(\d+)/gi, 'reference image $1');
}

/** Aspect ratio → explicit size (edges must be multiples of 16). */
function imageSize(aspectRatio: string): string {
  const sizes: Record<string, string> = {
    '3:4': '1152x1536',
    '4:3': '1536x1152',
    '16:9': '2048x1152',
    '9:16': '1152x2048',
    '1:1': '1536x1536',
  };
  return sizes[aspectRatio] ?? '1536x1536';
}

function quality(): string {
  const q = OPENAI_IMAGE_QUALITY.value().trim().toLowerCase();
  return ['low', 'medium', 'high'].includes(q) ? q : 'high';
}

export interface OpenAiImageRequest {
  prompt: string;
  /** reference image URLs in @image1..N order (attachment order binds them) */
  refUrls: string[];
  aspectRatio: string;
}

/** Generate one image with GPT Image 2. Returns the PNG bytes. */
export async function openaiGenerateImage(req: OpenAiImageRequest): Promise<Buffer> {
  const key = secretOrEmpty(OPENAI_API_KEY);
  if (!key) throw new OpenAiImageError('OPENAI_API_KEY is not configured');
  const prompt = openaiTagStyle(req.prompt);
  const size = imageSize(req.aspectRatio);

  const send = async (): Promise<Response> => {
    if (req.refUrls.length === 0) {
      return fetch(`${BASE}/images/generations`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL, prompt, size, quality: quality(), n: 1 }),
      });
    }
    // Download refs ourselves and attach the bytes — attachment order is the
    // reference order the prompt talks about ("reference image N").
    const fd = new FormData();
    fd.append('model', MODEL);
    fd.append('prompt', prompt);
    fd.append('size', size);
    fd.append('quality', quality());
    fd.append('n', '1');
    for (let i = 0; i < Math.min(req.refUrls.length, 16); i++) {
      const dl = await fetch(req.refUrls[i]);
      if (!dl.ok) throw new OpenAiImageError(`Failed to download reference ${i + 1} (${dl.status})`);
      fd.append('image[]', new Blob([await dl.arrayBuffer()], { type: 'image/png' }), `ref${i + 1}.png`);
    }
    return fetch(`${BASE}/images/edits`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}` },
      body: fd,
    });
  };

  // Retry rate limits and transient 5xx with growing backoff.
  let lastDetail = '';
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await send();
    if (res.ok) {
      const json = await res.json() as { data?: { b64_json?: string }[] };
      const b64 = json.data?.[0]?.b64_json;
      if (!b64) throw new OpenAiImageError('GPT Image 2 returned no image data');
      return Buffer.from(b64, 'base64');
    }
    let detail = '';
    try {
      const err = (await res.json() as { error?: { message?: string; code?: string } }).error;
      detail = err ? `${err.code ? `[${err.code}] ` : ''}${err.message ?? ''}` : '';
    } catch { /* ignore */ }
    lastDetail = `GPT Image 2 request failed (HTTP ${res.status})${detail ? `: ${detail}` : ''}`;
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt === 4) throw new OpenAiImageError(lastDetail, res.status);
    const retryAfter = Number(res.headers.get('retry-after') ?? '') * 1000;
    await new Promise((r) => setTimeout(r, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : attempt * 15000));
  }
  throw new OpenAiImageError(lastDetail || 'GPT Image 2 request failed');
}
