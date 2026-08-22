/**
 * ElevenLabs voice service (v2 feature: a voice per character).
 *
 * Flow per character:
 *  1. Design a voice from the director's designDescription
 *     (POST /v1/text-to-voice/design → previews → POST /v1/text-to-voice saves one).
 *  2. Generate a short sample line as MP3 (POST /v1/text-to-speech/{voice_id}).
 *
 * The sample is stored in Firebase Storage and attached to Seedance 2.5
 * generations as an @audio reference ("Voice reference for <role>. Match this
 * voice exactly for their dialogue."), so dialogue lip-syncs in that voice.
 */
import { ELEVENLABS_API_KEY, secretOrEmpty } from './config';
import type { VoiceSpec } from '../../shared/types';

const BASE = 'https://api.elevenlabs.io';
const TTS_MODEL = 'eleven_multilingual_v2';
const DESIGN_MODEL = 'eleven_multilingual_ttv_v2';

export function elevenLabsConfigured(): boolean {
  return Boolean(secretOrEmpty(ELEVENLABS_API_KEY));
}

function headers(): Record<string, string> {
  return {
    'xi-api-key': secretOrEmpty(ELEVENLABS_API_KEY),
    'Content-Type': 'application/json',
  };
}

async function elFetch(path: string, init: RequestInit, context: string): Promise<Response> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...headers(), ...(init.headers ?? {}) } });
  if (!res.ok) {
    let detail = '';
    try { detail = JSON.stringify(await res.json()); } catch { /* ignore */ }
    throw new Error(`ElevenLabs ${context} failed (HTTP ${res.status})${detail ? `: ${detail}` : ''}`);
  }
  return res;
}

/** Create a permanent voice from a text description. Returns the voice_id. */
export async function designVoice(name: string, spec: VoiceSpec): Promise<string> {
  const description = [
    spec.designDescription,
    spec.accent ? `Accent: ${spec.accent}.` : '',
    spec.delivery ? `Delivery: ${spec.delivery}.` : '',
    `Speaks ${spec.language}.`,
  ].filter(Boolean).join(' ').slice(0, 990);

  const designRes = await elFetch('/v1/text-to-voice/design', {
    method: 'POST',
    body: JSON.stringify({
      voice_description: description.length >= 20 ? description : `${description} A natural, believable speaking voice.`,
      model_id: DESIGN_MODEL,
      auto_generate_text: true,
    }),
  }, 'voice design');
  const design = await designRes.json() as { previews?: { generated_voice_id: string }[] };
  const preview = design.previews?.[0];
  if (!preview) throw new Error('ElevenLabs voice design returned no previews.');

  const saveRes = await elFetch('/v1/text-to-voice', {
    method: 'POST',
    body: JSON.stringify({
      voice_name: name.slice(0, 90),
      voice_description: description.length >= 20 ? description : `${description} A natural, believable speaking voice.`,
      generated_voice_id: preview.generated_voice_id,
    }),
  }, 'voice save');
  const saved = await saveRes.json() as { voice_id: string };
  if (!saved.voice_id) throw new Error('ElevenLabs did not return a voice_id.');
  return saved.voice_id;
}

/** Generate speech as an MP3 buffer. */
export async function textToSpeech(voiceId: string, text: string, spec?: VoiceSpec): Promise<Buffer> {
  const res = await elFetch(`/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
    method: 'POST',
    body: JSON.stringify({
      text,
      model_id: TTS_MODEL,
      voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.2, use_speaker_boost: true, speed: 1.0 },
      ...(spec?.language ? {} : {}),
    }),
  }, 'text-to-speech');
  return Buffer.from(await res.arrayBuffer());
}
