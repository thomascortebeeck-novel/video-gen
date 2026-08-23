/**
 * Provider-agnostic video generation interface.
 *
 * Higgsfield and fal.ai (and future platforms) implement VideoProvider; the
 * pipeline only sees submit → poll → download. Which provider serves which
 * engine is decided in config.ts (activeEngine) + providerFor() below.
 */
import type { AspectRatio, Resolution } from '../../shared/types';
import type { ProviderName } from './config';

export interface VideoGenRequest {
  prompt: string;
  durationSec: number;
  aspectRatio: AspectRatio;
  resolution: Resolution;
  generateAudio: boolean;
  /** image reference URLs in @image tag order */
  imageRefUrls: string[];
  /** audio reference URLs in @audio tag order (character voices) */
  audioRefUrls: string[];
  /** start keyframe URL (first-frame conditioning / frame bridging) */
  startImageUrl?: string;
  /** source video URL when extending */
  extendVideoUrl?: string;
  /**
   * plain video references in @video1..N order (non-extension) — character
   * screen tests carrying identity AND voice. Platform moderation rejects
   * character *images* (ModelArk/fal since 2026-08-23) but passes videos.
   */
  videoRefUrls?: string[];
  seed?: number;
}

export interface VideoJobStatus {
  state: 'queued' | 'generating' | 'completed' | 'failed';
  videoUrl?: string;
  /** human-readable failure reason */
  error?: string;
}

export interface VideoProvider {
  name: Exclude<ProviderName, 'mock'>;
  submitVideo(req: VideoGenRequest): Promise<string>; // returns provider job id
  videoStatus(jobId: string): Promise<VideoJobStatus>;
}

/**
 * Generic poll loop: 2s → 10s interval with jitter, bounded by maxMs.
 * Throws only on transport errors; terminal states are returned.
 */
export async function waitForVideo(
  provider: VideoProvider,
  jobId: string,
  opts: { maxMs?: number; onTick?: (s: VideoJobStatus) => Promise<void> | void } = {},
): Promise<VideoJobStatus> {
  const maxMs = opts.maxMs ?? 25 * 60 * 1000;
  const start = Date.now();
  let interval = 2000;
  for (;;) {
    const status = await provider.videoStatus(jobId);
    if (opts.onTick) await opts.onTick(status);
    if (status.state === 'completed' || status.state === 'failed') return status;
    if (Date.now() - start > maxMs) {
      return {
        state: 'failed',
        error: `Still ${status.state} after ${Math.round(maxMs / 60000)} min — the provider job keeps running; use "Refresh status" later to collect it.`,
      };
    }
    await new Promise((r) => setTimeout(r, interval + Math.random() * 500));
    interval = Math.min(10000, interval * 1.5);
  }
}

export async function downloadUrl(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download result (${res.status}) from ${new URL(url).host}`);
  return Buffer.from(await res.arrayBuffer());
}
