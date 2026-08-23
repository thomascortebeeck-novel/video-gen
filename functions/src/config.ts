import { defineSecret, defineString } from 'firebase-functions/params';

/**
 * Secrets — set with:
 *   firebase functions:secrets:set HIGGSFIELD_API_KEY      (the key ID)
 *   firebase functions:secrets:set HIGGSFIELD_API_SECRET   (the key secret)
 *   firebase functions:secrets:set ANTHROPIC_API_KEY
 *   firebase functions:secrets:set ELEVENLABS_API_KEY      (optional, v2 voices)
 *
 * For the local emulator, put values in functions/.secret.local (see README).
 * Any missing key silently switches that provider into MOCK mode, so the whole
 * flow can be exercised end-to-end without spending credits.
 */
export const HIGGSFIELD_API_KEY = defineSecret('HIGGSFIELD_API_KEY');
export const HIGGSFIELD_API_SECRET = defineSecret('HIGGSFIELD_API_SECRET');
export const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');
export const ELEVENLABS_API_KEY = defineSecret('ELEVENLABS_API_KEY');
/** fal.ai key — unlocks real Seedance 2.5 video generation today. */
export const FAL_KEY = defineSecret('FAL_KEY');
/** BytePlus ModelArk key — ByteDance's official Seedance 2.5 API (cheapest). */
export const ARK_API_KEY = defineSecret('ARK_API_KEY');
/** OpenAI key — GPT Image 2 for image generation (angles/environments). */
export const OPENAI_API_KEY = defineSecret('OPENAI_API_KEY');

export const ALL_SECRETS = [
  HIGGSFIELD_API_KEY,
  HIGGSFIELD_API_SECRET,
  ANTHROPIC_API_KEY,
  ELEVENLABS_API_KEY,
  FAL_KEY,
  ARK_API_KEY,
  OPENAI_API_KEY,
];

/**
 * Video engine selection.
 *
 * Higgsfield's API-key REST surface (platform.higgsfield.ai) ships Seedance v1
 * today; Seedance 2.5 (30s clips, omni-reference, native audio, extend) is on
 * their consumer surface and its platform REST API was still pre-launch at
 * build time. The moment it lands, set SEEDANCE25_PATH to its endpoint path
 * (e.g. "bytedance/seedance/v2.5") and the 2.5 adapter takes over.
 *
 *  - auto       → seedance-2.5 when SEEDANCE25_PATH is set, else seedance-v1
 *  - seedance25 → force the 2.5 adapter (requires SEEDANCE25_PATH)
 *  - seedance1  → force the v1 keyframe pipeline
 */
export const VIDEO_ENGINE = defineString('VIDEO_ENGINE', { default: 'auto' });
export const SEEDANCE25_PATH = defineString('SEEDANCE25_PATH', { default: '' });
/** fal.ai base model id for Seedance 2.5 (variants appended per endpoint). */
export const FAL_SEEDANCE25_BASE = defineString('FAL_SEEDANCE25_BASE', { default: 'bytedance/seedance-2.5' });
/** BytePlus ModelArk API base (switch if their EU region gains Seedance 2.5). */
export const ARK_BASE_URL = defineString('ARK_BASE_URL', { default: 'https://ark.ap-southeast.bytepluses.com/api/v3' });

/** Force mock generation even when keys exist (MOCK_MODE=true in env). */
export function isForcedMock(): boolean {
  return process.env.MOCK_MODE === 'true';
}

export function secretOrEmpty(secret: { value(): string }): string {
  try {
    // Blank/whitespace versions are placeholders written by scripts/setup-gcp.*
    // — treated as "not configured" so the provider degrades to mock mode.
    return (secret.value() || '').trim();
  } catch {
    return '';
  }
}

/** Deployment region — europe-west1 (Belgium). Change here if needed. */
export const REGION = 'europe-west1';

/** Claude model that powers the director. */
export const DIRECTOR_MODEL = 'claude-opus-5';

export type EngineId = 'seedance25' | 'seedance25_ark' | 'seedance25_fal' | 'seedance1' | 'mock';
export type ProviderName = 'higgsfield' | 'ark' | 'fal' | 'mock';

export interface EngineCaps {
  id: EngineId;
  provider: ProviderName;
  label: string;
  /** single-generation duration window in seconds */
  minClipSeconds: number;
  maxClipSeconds: number;
  /** native audio (dialogue/SFX/music) generated with the video */
  nativeAudio: boolean;
  /** accepts reference images directly on the video call */
  videoRefs: boolean;
  /** supports extending an existing clip */
  extend: boolean;
}

export const ENGINE_CAPS: Record<EngineId, EngineCaps> = {
  seedance25: {
    id: 'seedance25',
    provider: 'higgsfield',
    label: 'Seedance 2.5 (Higgsfield)',
    minClipSeconds: 4,
    maxClipSeconds: 30,
    nativeAudio: true,
    videoRefs: true,
    extend: true,
  },
  seedance25_ark: {
    id: 'seedance25_ark',
    provider: 'ark',
    label: 'Seedance 2.5 (BytePlus ModelArk — official)',
    minClipSeconds: 4,
    maxClipSeconds: 30,
    nativeAudio: true,
    videoRefs: true,
    extend: true, // omni extension via reference_video (forward & backward)
  },
  seedance25_fal: {
    id: 'seedance25_fal',
    provider: 'fal',
    label: 'Seedance 2.5 (fal.ai)',
    minClipSeconds: 4,
    maxClipSeconds: 30,
    nativeAudio: true,
    videoRefs: true,
    extend: true, // omni extension via r2v video_urls + continuation prompt
  },
  seedance1: {
    id: 'seedance1',
    provider: 'higgsfield',
    label: 'Seedance v1 keyframe pipeline (Higgsfield)',
    minClipSeconds: 3,
    maxClipSeconds: 12,
    nativeAudio: false,
    videoRefs: false, // consistency comes from the generated start keyframe
    extend: false,    // stitching via frame bridging instead
  },
  mock: {
    id: 'mock',
    provider: 'mock',
    label: 'Mock engine (no API keys — placeholder output)',
    minClipSeconds: 4,
    maxClipSeconds: 30,
    nativeAudio: true,
    videoRefs: true,
    extend: true,
  },
};

export function higgsfieldConfigured(): boolean {
  return Boolean(secretOrEmpty(HIGGSFIELD_API_KEY) && secretOrEmpty(HIGGSFIELD_API_SECRET));
}

export function falConfigured(): boolean {
  return Boolean(secretOrEmpty(FAL_KEY));
}

export function arkConfigured(): boolean {
  return Boolean(secretOrEmpty(ARK_API_KEY));
}

export function openaiConfigured(): boolean {
  return Boolean(secretOrEmpty(OPENAI_API_KEY));
}

export type ImageProviderName = 'openai' | 'higgsfield' | 'ark' | 'mock';

/**
 * Image engine preference (video stays on VIDEO_ENGINE):
 *  - auto → GPT Image 2 → Higgsfield nano-banana → Seedream 5.0 Pro → mock
 *  - openai | higgsfield | ark | mock → force (falls back to auto order
 *    when the forced provider isn't configured)
 */
export const IMAGE_ENGINE = defineString('IMAGE_ENGINE', { default: 'auto' });
/** GPT Image 2 quality: low | medium | high (high ≈ 4× medium cost). */
export const OPENAI_IMAGE_QUALITY = defineString('OPENAI_IMAGE_QUALITY', { default: 'high' });

/**
 * Image generation (angles, environments, keyframes):
 * OpenAI GPT Image 2 when configured (best instruction-following, identity
 * edits and in-image text), else Higgsfield nano-banana, else BytePlus
 * Seedream 5.0 Pro (same ARK key as video), else mock.
 */
export function activeImageProvider(): ImageProviderName {
  if (isForcedMock()) return 'mock';
  const pref = IMAGE_ENGINE.value().trim();
  if (pref === 'openai' && openaiConfigured()) return 'openai';
  if (pref === 'higgsfield' && higgsfieldConfigured()) return 'higgsfield';
  if (pref === 'ark' && arkConfigured()) return 'ark';
  if (pref === 'mock') return 'mock';
  if (openaiConfigured()) return 'openai';
  if (higgsfieldConfigured()) return 'higgsfield';
  if (arkConfigured()) return 'ark';
  return 'mock';
}

/**
 * Engine selection.
 *  - VIDEO_ENGINE=seedance25 → Higgsfield Seedance 2.5 (needs SEEDANCE25_PATH)
 *  - VIDEO_ENGINE=ark25      → BytePlus ModelArk Seedance 2.5 (needs ARK_API_KEY)
 *  - VIDEO_ENGINE=fal25      → fal.ai Seedance 2.5 (needs FAL_KEY)
 *  - VIDEO_ENGINE=seedance1  → Higgsfield Seedance v1 keyframe pipeline
 *  - VIDEO_ENGINE=auto       → best available:
 *      Higgsfield 2.5 (when its REST path ships) → ModelArk 2.5 (official,
 *      cheapest) → fal.ai 2.5 → Higgsfield v1 → mock
 */
/**
 * @param prefOverride per-project engine preference (ProjectInput.videoEngine);
 * falls back to the deployment-wide VIDEO_ENGINE param when empty/'auto'.
 */
export function activeEngine(prefOverride?: string): EngineCaps {
  if (isForcedMock()) return ENGINE_CAPS.mock;
  const override = (prefOverride ?? '').trim();
  const pref = override && override !== 'auto' ? override : VIDEO_ENGINE.value();
  const hf = higgsfieldConfigured();
  const hf25 = hf && Boolean(SEEDANCE25_PATH.value().trim());
  const ark = arkConfigured();
  const fal = falConfigured();
  switch (pref) {
    case 'seedance25':
      if (hf25) return ENGINE_CAPS.seedance25;
      break;
    case 'ark25':
      if (ark) return ENGINE_CAPS.seedance25_ark;
      break;
    case 'fal25':
      if (fal) return ENGINE_CAPS.seedance25_fal;
      break;
    case 'seedance1':
      if (hf) return ENGINE_CAPS.seedance1;
      return ENGINE_CAPS.mock;
    default:
      break;
  }
  // auto (also the graceful fallback when a forced engine isn't configured)
  if (hf25) return ENGINE_CAPS.seedance25;
  if (ark) return ENGINE_CAPS.seedance25_ark;
  if (fal) return ENGINE_CAPS.seedance25_fal;
  if (hf) return ENGINE_CAPS.seedance1;
  return ENGINE_CAPS.mock;
}

/** Max reference images we attach to one image generation (angle shots). */
export const MAX_IMAGE_REFS = 8;
/** Practical cap of subject reference images per video generation. */
export const MAX_VIDEO_SUBJECT_REFS = 8;
