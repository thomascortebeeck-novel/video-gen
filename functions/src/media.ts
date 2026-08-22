/**
 * ffmpeg helpers: mock asset generation, last-frame extraction (for
 * frame-bridge stitching) and final concat assembly.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import type { AspectRatio } from '../../shared/types';

const execFileAsync = promisify(execFile);

function ffmpeg(): string {
  if (!ffmpegPath) throw new Error('ffmpeg-static binary not found');
  return ffmpegPath as unknown as string;
}

export function dimensionsFor(aspectRatio: AspectRatio, base = 720): { w: number; h: number } {
  const ratios: Record<AspectRatio, [number, number]> = {
    '16:9': [16, 9], '9:16': [9, 16], '1:1': [1, 1], '4:3': [4, 3], '3:4': [3, 4], '21:9': [21, 9],
  };
  const [rw, rh] = ratios[aspectRatio] ?? [16, 9];
  // even dimensions required by h264
  if (rw >= rh) {
    const h = base % 2 === 0 ? base : base + 1;
    const w = Math.round((h * rw) / rh / 2) * 2;
    return { w, h };
  }
  const w = base % 2 === 0 ? base : base + 1;
  const h = Math.round((w * rh) / rw / 2) * 2;
  return { w, h };
}

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'vidgen-'));
}

function escapeDrawText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:').replace(/%/g, '\\%');
}

/** Solid-colour PNG with a label — mock stand-in for a generated image. */
export async function makeMockImage(label: string, aspectRatio: AspectRatio, colour = '0x1f2937'): Promise<Buffer> {
  const { w, h } = dimensionsFor(aspectRatio, 768);
  const dir = await tmpDir();
  const out = path.join(dir, 'mock.png');
  const text = escapeDrawText(label.slice(0, 60));
  try {
    await execFileAsync(ffmpeg(), [
      '-y', '-f', 'lavfi',
      '-i', `color=c=${colour}:s=${w}x${h}`,
      '-vf', `drawtext=text='${text}':fontcolor=white:fontsize=${Math.round(h / 18)}:x=(w-text_w)/2:y=(h-text_h)/2:font=Arial`,
      '-frames:v', '1', out,
    ]);
    return await fs.readFile(out);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** Short labelled clip — mock stand-in for a generated video. */
export async function makeMockVideo(label: string, durationSec: number, aspectRatio: AspectRatio): Promise<Buffer> {
  const { w, h } = dimensionsFor(aspectRatio, 480);
  const dir = await tmpDir();
  const out = path.join(dir, 'mock.mp4');
  const text = escapeDrawText(label.slice(0, 60));
  const dur = Math.max(2, Math.min(durationSec, 30));
  try {
    await execFileAsync(ffmpeg(), [
      '-y', '-f', 'lavfi',
      '-i', `color=c=0x111827:s=${w}x${h}:d=${dur}`,
      '-f', 'lavfi', '-i', `sine=frequency=440:duration=${dur}`,
      '-vf', `drawtext=text='${text}':fontcolor=white:fontsize=${Math.round(h / 16)}:x=(w-text_w)/2:y=(h-text_h)/2:font=Arial`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out,
    ]);
    return await fs.readFile(out);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** Extract the last frame of a video as PNG — the frame-bridge stitch input. */
export async function extractLastFrame(video: Buffer): Promise<Buffer> {
  const dir = await tmpDir();
  const inFile = path.join(dir, 'in.mp4');
  const outFile = path.join(dir, 'last.png');
  try {
    await fs.writeFile(inFile, video);
    // -sseof seeks from the end; grab the final decodable frame
    await execFileAsync(ffmpeg(), [
      '-y', '-sseof', '-0.5', '-i', inFile,
      '-vsync', '0', '-q:v', '2', '-update', 'true', outFile,
    ]);
    return await fs.readFile(outFile);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

export interface ConcatItem {
  video: Buffer;
  /**
   * True for frame-bridged clips: their first frame duplicates the previous
   * clip's last frame, so we drop it at the seam to avoid a stutter.
   */
  trimFirstFrame?: boolean;
}

/**
 * Concatenate clips into one MP4. Clips are re-encoded to a common size/fps
 * so differently-sized takes still join cleanly, audio is loudness-normalised
 * per clip, and frame-bridged clips have their duplicated boundary frame
 * dropped (stitching best practice).
 */
export async function concatVideos(items: ConcatItem[], aspectRatio: AspectRatio): Promise<Buffer> {
  if (items.length === 0) throw new Error('No videos to concatenate');
  const { w, h } = dimensionsFor(aspectRatio, 720);
  const dir = await tmpDir();
  try {
    const inputs: string[] = [];
    for (let i = 0; i < items.length; i++) {
      const f = path.join(dir, `part${i}.mp4`);
      await fs.writeFile(f, items[i].video);
      inputs.push(f);
    }
    const out = path.join(dir, 'final.mp4');
    const args: string[] = ['-y'];
    for (const f of inputs) args.push('-i', f);
    // Normalise every stream, then concat. Audio is optional per input, so we
    // synthesise silent audio for inputs that lack it (via ensureAudioTrack
    // upstream); loudnorm evens out per-clip levels.
    const filters: string[] = [];
    const pairs: string[] = [];
    for (let i = 0; i < items.length; i++) {
      const trim = items[i].trimFirstFrame && i > 0 ? 'trim=start_frame=1,setpts=PTS-STARTPTS,' : '';
      filters.push(`[${i}:v]${trim}scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,format=yuv420p[v${i}]`);
      filters.push(`[${i}:a]aresample=44100,aformat=channel_layouts=stereo,loudnorm=I=-14:TP=-1.5:LRA=11[a${i}]`);
      pairs.push(`[v${i}][a${i}]`);
    }
    filters.push(`${pairs.join('')}concat=n=${items.length}:v=1:a=1[outv][outa]`);
    args.push(
      '-filter_complex', filters.join(';'),
      '-map', '[outv]', '-map', '[outa]',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-c:a', 'aac', out,
    );
    await execFileAsync(ffmpeg(), args, { maxBuffer: 64 * 1024 * 1024 });
    return await fs.readFile(out);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/**
 * Downscale an image so its long edge is ≤1568px (Claude vision sweet spot)
 * and re-encode as JPEG — keeps vision payloads small.
 */
export async function resizeForVision(image: Buffer): Promise<Buffer> {
  const dir = await tmpDir();
  const inFile = path.join(dir, 'in.img');
  const outFile = path.join(dir, 'out.jpg');
  try {
    await fs.writeFile(inFile, image);
    await execFileAsync(ffmpeg(), [
      '-y', '-i', inFile,
      '-vf', "scale='min(1568,iw)':'min(1568,ih)':force_original_aspect_ratio=decrease",
      '-frames:v', '1', '-q:v', '3', outFile,
    ]);
    return await fs.readFile(outFile);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** Short spoken-word-length MP3 tone — mock stand-in for a voice sample. */
export async function makeMockAudio(durationSec = 3): Promise<Buffer> {
  const dir = await tmpDir();
  const out = path.join(dir, 'mock.mp3');
  try {
    await execFileAsync(ffmpeg(), [
      '-y', '-f', 'lavfi', '-i', `sine=frequency=330:duration=${durationSec}`,
      '-filter:a', 'volume=0.4', '-c:a', 'libmp3lame', '-q:a', '4', out,
    ]);
    return await fs.readFile(out);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** Ensure a clip has an audio track (some models return video-only files). */
export async function ensureAudioTrack(video: Buffer): Promise<Buffer> {
  const dir = await tmpDir();
  const inFile = path.join(dir, 'in.mp4');
  const outFile = path.join(dir, 'out.mp4');
  try {
    await fs.writeFile(inFile, video);
    const { stdout } = await execFileAsync(ffmpeg(), ['-i', inFile, '-hide_banner'], { maxBuffer: 8 * 1024 * 1024 }).catch((e) => ({ stdout: String(e.stderr ?? '') }));
    const hasAudio = /Stream #.*Audio/.test(String(stdout));
    if (hasAudio) return video;
    await execFileAsync(ffmpeg(), [
      '-y', '-i', inFile, '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
      '-c:v', 'copy', '-c:a', 'aac', '-shortest', outFile,
    ]);
    return await fs.readFile(outFile);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
