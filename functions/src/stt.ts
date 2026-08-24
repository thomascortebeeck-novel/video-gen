/**
 * Speech-to-text for take verification.
 *
 * Claude cannot hear — no model accepts audio input — so a take's dialogue
 * can only be checked against the plan by transcribing it first. ElevenLabs
 * Scribe runs on the key we already hold for voice casting.
 *
 * Audio-event tagging is on: "(laughter)", "(footsteps)" and friends are the
 * only evidence we get that the [AUDIO] block was honoured, since the words
 * alone say nothing about the bed underneath them.
 */
import { ELEVENLABS_API_KEY, secretOrEmpty } from './config';

const BASE = 'https://api.elevenlabs.io';
const STT_MODEL = 'scribe_v2';

export interface TranscriptWord {
  text: string;
  type?: string;
  start?: number;
  end?: number;
  speakerId?: string;
}

export interface Transcript {
  text: string;
  words: TranscriptWord[];
  /** Distinct speakers Scribe heard — a cheap cross-check on who spoke. */
  speakers: string[];
}

export function sttConfigured(): boolean {
  return Boolean(secretOrEmpty(ELEVENLABS_API_KEY));
}

/**
 * Transcribe a clip's audio with word timings and speaker labels. Returns
 * undefined when no key is configured, so verification degrades to a
 * picture-only read instead of failing outright.
 */
export async function transcribeTake(
  audio: Buffer, opts: { language?: string; maxSpeakers?: number } = {},
): Promise<Transcript | undefined> {
  const key = secretOrEmpty(ELEVENLABS_API_KEY);
  if (!key) return undefined;

  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/mpeg' }), 'take.mp3');
  form.append('model_id', STT_MODEL);
  form.append('diarize', 'true');
  form.append('timestamps_granularity', 'word');
  form.append('tag_audio_events', 'true');
  if (opts.language) form.append('language_code', opts.language);
  if (opts.maxSpeakers) form.append('num_speakers', String(opts.maxSpeakers));

  const res = await fetch(`${BASE}/v1/speech-to-text`, {
    method: 'POST',
    headers: { 'xi-api-key': key },
    body: form,
  });
  if (!res.ok) {
    let detail = '';
    try { detail = JSON.stringify(await res.json()); } catch { /* ignore */ }
    throw new Error(`ElevenLabs transcription failed (HTTP ${res.status})${detail ? `: ${detail}` : ''}`);
  }
  const body = await res.json() as {
    text?: string;
    words?: { text?: string; type?: string; start?: number; end?: number; speaker_id?: string }[];
  };
  const words: TranscriptWord[] = (body.words ?? []).map((w) => ({
    text: w.text ?? '',
    type: w.type,
    start: w.start,
    end: w.end,
    speakerId: w.speaker_id,
  }));
  const speakers = [...new Set(words.map((w) => w.speakerId).filter((s): s is string => Boolean(s)))];
  return { text: (body.text ?? '').trim(), words, speakers };
}

/**
 * Render a transcript as timed lines, grouped by speaker turn — the form the
 * verifier compares against the planned dialogue. Word soup with 200 separate
 * timestamps would bury the comparison it exists to support.
 */
export function formatTranscript(t: Transcript): string {
  if (t.words.length === 0) return t.text || '(silence — no speech detected)';
  const lines: string[] = [];
  let speaker: string | undefined;
  let start = 0;
  let buf: string[] = [];
  const flush = (end: number) => {
    if (buf.length === 0) return;
    const who = speaker ? `${speaker}` : 'speaker';
    lines.push(`${start.toFixed(1)}-${end.toFixed(1)}s ${who}: ${buf.join(' ').replace(/\s+([,.!?])/g, '$1').trim()}`);
    buf = [];
  };
  for (const w of t.words) {
    if (!w.text.trim()) continue;
    if (w.speakerId !== speaker) {
      flush(w.start ?? start);
      speaker = w.speakerId;
      start = w.start ?? 0;
    }
    buf.push(w.text);
  }
  flush(t.words[t.words.length - 1]?.end ?? start);
  return lines.join('\n');
}
