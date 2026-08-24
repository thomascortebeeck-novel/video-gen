/**
 * What a generation costs, in one place.
 *
 * ModelArk bills video by pixel-seconds: tokens = W x H x seconds x 24 / 1024,
 * at $10.70 per million. Each attached reference VIDEO adds roughly one more
 * base's worth of tokens; reference IMAGES add nothing (measured series
 * 172.8k -> 346.5k -> 519.3k for base -> +1 ref video -> +2 ref videos + 1
 * image). That asymmetry is why previz rides along as text, and why every
 * button that spends money shows its price before it is pressed.
 */
import type { Resolution } from './types';

export const RES_PIXELS: Record<Resolution, [number, number]> = {
  '480p': [854, 480], '720p': [1280, 720], '1080p': [1920, 1080], '4k': [3840, 2160],
};

const USD_PER_MILLION_TOKENS = 10.7;

export function generationTokens(durationSec: number, resolution: Resolution, refVideos = 0): number {
  const [w, h] = RES_PIXELS[resolution] ?? RES_PIXELS['720p'];
  const base = (w * h * durationSec * 24) / 1024;
  return base * (1 + Math.max(0, refVideos));
}

export function estimateCostUsd(durationSec: number, resolution: Resolution, refVideos = 0): number {
  return (generationTokens(durationSec, resolution, refVideos) / 1_000_000) * USD_PER_MILLION_TOKENS;
}

export function formatUsd(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

/** What one extra reference video adds to a generation: ≈ +1× base tokens. */
export function refVideoCost(durationSec: number, resolution: Resolution): string {
  return formatUsd(estimateCostUsd(durationSec, resolution, 0));
}
