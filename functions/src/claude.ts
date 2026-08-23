/**
 * The Director — Claude-powered analysis and briefing generation.
 *
 * Two jobs:
 *  1. analyzeSubject: look at uploaded photos → write the character/product
 *     sheet (locked identity/wardrobe/materials blocks reused verbatim later).
 *  2. planBriefing: act as writer/director/cinematographer/editor → produce
 *     the full production briefing (style bible, environments, voice casting,
 *     scene-by-scene advanced-template fields, stitching plan).
 */
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { ANTHROPIC_API_KEY, DIRECTOR_MODEL, secretOrEmpty, EngineCaps } from './config';
import type { ProjectDoc, SubjectDoc } from '../../shared/types';
import { anglesForSubject } from '../../shared/types';

function client(): Anthropic {
  const apiKey = secretOrEmpty(ANTHROPIC_API_KEY);
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured');
  return new Anthropic({ apiKey });
}

export function anthropicConfigured(): boolean {
  return Boolean(secretOrEmpty(ANTHROPIC_API_KEY));
}

type ImageInput = { data: Buffer; mediaType: 'image/png' | 'image/jpeg' | 'image/webp' };

/**
 * Run a structured-output request with server-side refusal fallback enabled
 * (falls back automatically if the primary model declines), then validate
 * with the zod schema.
 */
async function structured<T>(opts: {
  system: string;
  content: Anthropic.Messages.ContentBlockParam[];
  schema: z.ZodType<T>;
  schemaName: string;
  maxTokens: number;
}): Promise<T> {
  const c = client();
  const response = await c.beta.messages.create({
    model: DIRECTOR_MODEL,
    max_tokens: opts.maxTokens,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: opts.system,
    output_config: { format: zodOutputFormat(opts.schema) },
    messages: [{ role: 'user', content: opts.content }],
  });
  if (response.stop_reason === 'refusal') {
    const why = response.stop_details?.explanation ?? 'the request was declined';
    throw new Error(`The director model declined this request: ${why}. Adjust the concept or images and retry.`);
  }
  const text = response.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Director returned malformed JSON. Please retry.');
  }
  return opts.schema.parse(parsed);
}

// ---------------------------------------------------------------------------
// 1. Subject analysis (vision → sheet)
// ---------------------------------------------------------------------------

const VoiceSpecSchema = z.object({
  language: z.string(),
  accent: z.string().optional(),
  delivery: z.string().optional(),
  designDescription: z.string().optional(),
});

const SubjectSheetSchema = z.object({
  roleName: z.string().describe('Story role with article, lowercase: "the climber", "the vendor", "the raid bouldering shoe" — never "the man"/"the woman"'),
  oneLineRead: z.string(),
  identityBlock: z.string().optional(),
  physique: z.string().optional(),
  wardrobe: z.string().optional(),
  distinguishingMarks: z.string().optional(),
  productType: z.enum(['footwear', 'garment', 'handheld_prop', 'furniture_or_large_object', 'vehicle', 'other']).optional(),
  purposeLine: z.string().optional(),
  silhouette: z.string().optional(),
  materialsAndColour: z.string().optional(),
  hiddenSurfaces: z.string().optional(),
  negations: z.string().optional(),
});
export type AnalyzedSheet = z.infer<typeof SubjectSheetSchema>;

const ANALYZE_SYSTEM = `You are a senior character/production designer writing reference sheets for AI image and video generation (Seedance 2.5 via Higgsfield). You are given photos of a person or a product plus the owner's notes. Write the definitive sheet whose text blocks will be reused VERBATIM in every future prompt, so the design can never drift.

Craft rules (follow exactly):
- Commit to specifics. "Brown hair" gives nothing. "Dark brown hair, thick and loosely curly, cut full and a little untidy, sitting high off the forehead" gives a person.
- CHARACTERS — identityBlock describes, in this order: age and overall impression → hair (length, colour, how it sits) → brows, eyes, nose, face shape, jaw → facial hair → one or two distinguishing marks → what the face communicates → skin texture (real pores, lines, imperfections).
- physique gets numbers: "175 cm, average build with a slightly soft stomach, narrow shoulders and a subtly hunched posture" produces a person; "average build" produces a mannequin. Estimate height from context if unknown.
- wardrobe: each garment — fabric, cut, colour, condition, how it hangs. Then negations: "NOT tight, NOT technical, no logos". If the photos don't show an outfit clearly, propose ONE complete outfit that fits the notes (do not offer options) and make it specific.
- roleName is the STORY ROLE, not a description: "the climber", "the spy", "the vendor". If no story context exists yet, derive a plausible role from the notes.
- PRODUCTS — purposeLine states what it is and what it is FOR; the purpose is what makes the shape correct. silhouette: proportions, stance, weight. materialsAndColour: material first, then construction, then hardware and closures, then colour in positive colour names, then condition (wear, creases, patina) — say where each colour lives and which parts are which material. End with "No logos, no branding, no text" unless branding is the point.
- hiddenSurfaces: fully describe any surface a master view won't show (a shoe's sole, a bag's interior) — otherwise the generator invents it.
- negations: three or four things it must NOT be or look like.
- Colour words must be positive colour names ("warm camel-tan", "deep brown") — never "desaturated", "monochromatic", "muted".
- Classify products into productType. For characters, leave product fields out; for products, leave character fields out.`;

export async function analyzeSubjectWithClaude(
  subject: SubjectDoc,
  images: ImageInput[],
): Promise<AnalyzedSheet> {
  const content: Anthropic.Messages.ContentBlockParam[] = [];
  for (const img of images) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType, data: img.data.toString('base64') },
    });
  }
  content.push({
    type: 'text',
    text:
      `Subject kind: ${subject.kind}\n` +
      `Name given by owner: ${subject.name}\n` +
      `Owner notes: ${subject.notes || '(none)'}\n\n` +
      `Write the ${subject.kind} sheet from these ${images.length} photo(s).`,
  });
  return structured({
    system: ANALYZE_SYSTEM,
    content,
    schema: SubjectSheetSchema,
    schemaName: 'subject_sheet',
    maxTokens: 8000,
  });
}

// ---------------------------------------------------------------------------
// 2. Briefing planning (the director)
// ---------------------------------------------------------------------------

const StageSchema = z.object({
  index: z.number().int(),
  t0: z.number(),
  t1: z.number(),
  beatName: z.string(),
  action: z.string(),
  dialogue: z.object({
    subjectId: z.string(),
    line: z.string(),
    language: z.string().optional(),
  }).optional(),
  endState: z.string().optional(),
  cut: z.enum(['CUT', 'NO CUT']),
});

const SceneRefSchema = z.object({
  kind: z.enum(['subject_video', 'subject_angle', 'environment', 'style']),
  subjectId: z.string().optional().describe('required when kind=subject_video (characters) or subject_angle (products)'),
  angleId: z.string().optional().describe('required when kind=subject_angle: an angle id from that subject\'s inventory'),
  envKey: z.string().optional().describe('required when kind=environment: key of an environment you defined'),
  use: z.string().describe('Reference line: what to take. Name the subject by story role. E.g. "the climber — identity, hair, wardrobe and voice exactly per this clip."'),
  ignore: z.string().optional().describe('What to leave: "Do not use the image background." / "Do not replay the clip\'s staging."'),
});

const SceneSchema = z.object({
  title: z.string(),
  beatSummary: z.string(),
  durationSec: z.number().int(),
  mode: z.enum(['stages', 'continuous']),
  goal: z.string(),
  continuity: z.string(),
  stages: z.array(StageSchema),
  continuousAction: z.string().optional(),
  visualStyle: z.string(),
  cameraAndPerformance: z.string(),
  audio: z.string(),
  exclusions: z.string(),
  keepConsistent: z.string(),
  references: z.array(SceneRefSchema),
  stitchMode: z.enum(['hard_cut', 'extend_prev', 'frame_bridge']),
  stitchNotes: z.string(),
});

const BriefingPlanSchema = z.object({
  meta: z.object({
    title: z.string(),
    logline: z.string(),
  }),
  styleBible: z.object({
    look: z.string(),
    colourPalette: z.string(),
    lighting: z.string(),
    grainAndTexture: z.string(),
    mood: z.string(),
    technicalLine: z.string(),
  }),
  audioPlan: z.object({
    music: z.string().optional(),
    soundEffects: z.array(z.string()),
    ambience: z.string().optional(),
    subtitles: z.boolean(),
    dialogueLanguage: z.string().optional(),
  }),
  voiceCasting: z.array(z.object({
    subjectId: z.string(),
    voice: VoiceSpecSchema,
  })),
  environments: z.array(z.object({
    key: z.string().describe('short slug, e.g. "gym", "alley_night", "card_message1"'),
    name: z.string(),
    description: z.string(),
    refPrompt: z.string(),
    type: z.enum(['location', 'insert_card'])
      .describe('"location" = establishing shot of a place; "insert_card" = flat full-frame graphic carrying EXACT on-screen text (phone messages, menus, signs)'),
  })),
  scenes: z.array(SceneSchema),
  stitchingPlan: z.object({
    boundaries: z.array(z.object({
      fromSceneIndex: z.number().int(),
      toSceneIndex: z.number().int(),
      mode: z.enum(['hard_cut', 'extend_prev', 'frame_bridge']),
      rationale: z.string(),
    })),
    assemblyNotes: z.string(),
  }),
  directorsNotes: z.array(z.string()),
});
export type BriefingPlan = z.infer<typeof BriefingPlanSchema>;

const directorSystem = (caps: EngineCaps) => `You are a professional film director, cinematographer and editor who plans AI-generated videos for Seedance on Higgsfield. You turn a client's rough idea plus locked character/product sheets into a complete production briefing. Your output is structured JSON; a deterministic assembler renders each scene into Dan Kieft's advanced Seedance 2.5 prompt template:
[GOAL] [REFERENCE MATERIAL] [CONTINUITY] [STAGES] [VISUAL STYLE] [CAMERA AND PERFORMANCE] [AUDIO] [EXCLUSIONS] [MAINTAIN CONSISTENCY]

== ACTIVE MODEL FACTS (${caps.label}) ==
- One generation ("scene") is ${caps.minClipSeconds}-${caps.maxClipSeconds} seconds, 24 fps.
- Native audio: ${caps.nativeAudio ? 'YES — dialogue with lip-sync, SFX, ambience and music are generated with the video.' : 'NO — the model outputs silent video. Do NOT write spoken dialogue into stages (leave dialogue fields out); plan visual storytelling, and put music/VO intent in the audio plan for post-production.'}
- Reference images on the video call: ${caps.videoRefs ? 'YES — attach subject angle images, environment and style refs per scene.' : 'NO — consistency comes from a start keyframe image that is generated first from the subject reference images. STILL list the references for every scene exactly as instructed below; the pipeline uses them to build each scene\'s start keyframe.'}
- Extend support: ${caps.extend ? 'YES — stitchMode "extend_prev" is available.' : 'NO — never use stitchMode "extend_prev"; use "frame_bridge" for continuous action across a boundary.'}
- Cuts INSIDE one generation are free consistency — pack related shots of one location/moment into ONE scene with staged cuts rather than splitting into separate generations.
- References per scene: keep to ≤8 subject images + 1-2 environment/style images. Quality drops when overloaded.
- Longer duration does NOT mean more events. One primary state change per stage. Quick cuts need ≥2-3s per stage; atmospheric shots 4-5s.

== SPLITTING THE FILM INTO SCENES ==
- Scene durations must sum to the requested total (within ±10%). Each scene ${caps.minClipSeconds}-${caps.maxClipSeconds}s.
- New location or time jump → new scene with stitchMode "hard_cut".
- Continuous action that flows across a boundary (same location, motion carries over) → stitchMode "frame_bridge": the next scene will receive the previous scene's final frame as its first frame. Its first stage must CONTINUE the motion — never recap, never reverse direction. State the carried motion direction explicitly in the first stage.
- The same unbroken take growing longer → stitchMode "extend_prev": the scene is generated by extending the previous clip. Use at most 2 consecutive extends, then re-anchor with a hard cut or frame bridge. For extends: describe only what happens NEXT (one new beat), carry subject/lighting/style/camera wording over verbatim.
- The FIRST scene is always "hard_cut".
- Vary shot sizes across boundaries: open the next scene on a ≥30° angle change or a new size class, or a match on action — otherwise the cut glitches.

== WRITING STAGES ==
- Format: numbered stages with t0/t1 in seconds (t0 of first stage = 0; times partition the scene duration exactly), a short beat name, then the action.
- Physical action and staging only. "He plants his elbow on the bar and leans in", never "he's interested in her". No clauses that explain intent.
- Nothing appears out of nowhere. If a prop enters, show it entering.
- End states are the continuity fix: give each stage one primary change, endState says what is visibly true when it finishes (who holds what, where everyone is).
- Spell out choreography move by move. Micro-expressions: 2-4 observable cues (eyes, brows, mouth, breathing, hands) at emotional turns only.
- Camera: only when it matters. One primary camera move per scene, at most two, event-motivated ("the camera begins a slow push-in only after the cup tips"). Formula: movement + direction + speed + subject + framing constraint. For most stages describe action and let the model pick coverage.
- Dialogue: a spoken line runs 2-3 seconds — count lines against the runtime first. Lines ≤10 words. One speaker per stage. Speech only in dialogue fields, never inside action text. Max ~8s continuous speech per scene block.
- continuous mode (one long take, e.g. handheld/vlog/phone): use mode "continuous" and write continuousAction as one flowing paragraph including all dialogue in order; stages array stays empty.

== LANGUAGE THAT BREAKS THINGS (never use) ==
"chiaroscuro", "monochromatic", "desaturated", "heavy grain", bare "crushed blacks", slow-shutter/step-printing/low-fps concepts. Colour ALWAYS in positive names: "warm amber and deep brown". If light flickers, write it in ("low practical lamplight that flickers slightly and never sits stable").

== CONSISTENCY SYSTEM ==
- Repeat each subject's identity markers VERBATIM from their sheet in every scene's continuity and keepConsistent — never reword them; rewording causes drift.
- Name subjects by story role ("the climber", "the vendor") in all action text.
- Anchor geography once per scene: "the spy frame-left, the mark frame-right", and keep it.
- keepConsistent locks: identities, clothing, prop ownership, spatial direction, and anything that changes mid-scene with the stage where it changes.
- One location and one lighting setup per scene, stated in continuity.
- visualStyle: reuse the style bible's technical wording near-verbatim in every scene so clips grade-match when stitched.

== REFERENCES (per scene) ==
- Choose angle images matching the scene's framing: full-body angles for wide/action scenes, face close-ups for dialogue/emotion scenes, back/rear-three-quarter when the camera is behind. 2-4 angles per main subject on screen, 1-2 for secondary.
- Every reference gets: use (what to take, naming the role and the view) and ignore (what to leave — always exclude photo backgrounds).
- CHARACTERS: reference them ONLY with kind "subject_video" — the character's screen-test clip (their video master, generated separately). It carries identity AND voice: use = "…identity, hair, wardrobe and the voice exactly per this clip"; ignore = "Do not replay the clip's staging or its studio backdrop." NEVER use kind "subject_angle" for characters — the video platforms' moderation rejects character images (real-person filter); only videos pass. Dialogue lines render as: In their voice (@videoN).
- Products: reference the angle set (kind "subject_angle") and state all images are the same single object — product images pass moderation fine.
- Add the scene's environment reference (kind "environment") so location holds across scenes; define each distinct location once in environments[] with type "location".
- environments[].refPrompt: a wide establishing image prompt for that location, empty of people, describing space, materials, and how the light behaves, in the film's palette.
- ON-SCREEN TEXT: video models cannot spell reliably. Whenever the story shows text that must read EXACTLY (a phone message, chat bubble, sign, menu, scoreboard, title card), plan an environments[] entry with type "insert_card" UPFRONT — one card per distinct screen. Put the EXACT text in quotes in the description, and use refPrompt for the layout/design (UI chrome, brand colours, type hierarchy). The scene that shows it must add the card as a reference (kind "environment") with use: "reproduce this screen exactly — never respell, redraw or reflow its text", and the stage action names the card's tag at the moment it fills the frame.

== AUDIO ==
- audio field format: "(music description, when it drops out) <effect> <effect at its moment> Ambience: ... Subtitles: on/off." Write "no music" explicitly for silent scenes; state the mix hierarchy (dialogue clean and prominent, music low, ambience subtle).
- audioPlan: overall music direction, recurring SFX, ambience bed, dialogue language.
- If voices are enabled, cast every speaking character in voiceCasting: language, accent, delivery, and a designDescription (age, gender, texture, pacing — for ElevenLabs voice design). The pipeline attaches a voice sample per character as an @audio reference; dialogue then renders as: In their voice (@audioN), Language: {line}.

== STYLE ==
- styleBible.technicalLine: ONE line used everywhere — lens/format, grain, colour in positive names, how the light behaves, the sound bed. Follow the user's style preset: "cinematic" → large-format clarity, deep focus, fine true film grain; "ugc_handheld" → handheld phone video, natural shake, realistic lens breathing, live sound only; "camcorder_2000s" → early-2000s camcorder, soft video grain, blown highlights, small date stamp; "documentary" → 35mm documentary look, natural light; "commercial" → crisp commercial product photography in motion, controlled studio light.

== HONESTY ==
- directorsNotes: list everything you invented that the client should confirm (outfits, lines of dialogue, locations, music direction), one line each. Flag any contradiction you resolved.`;

export interface DirectorInput {
  project: ProjectDoc;
  subjects: SubjectDoc[];
  caps: EngineCaps;
}

export async function planBriefingWithClaude(input: DirectorInput): Promise<BriefingPlan> {
  const { project, subjects, caps } = input;
  const inp = project.input;

  const subjectBlocks = subjects.map((s) => {
    const sheet = s.sheet;
    const angleInventory = anglesForSubject(s.kind, s.angleSet, sheet?.productType)
      .map((a) => `  - ${a.id}: ${a.label}`)
      .join('\n');
    return [
      `SUBJECT ${s.id}`,
      `kind: ${s.kind}`,
      `name: ${s.name}`,
      `sheet: ${JSON.stringify(sheet ?? {}, null, 2)}`,
      `available angle image ids (use these for references):`,
      angleInventory,
    ].join('\n');
  }).join('\n\n');

  const brief = [
    `CLIENT BRIEF`,
    `Concept: ${inp.concept}`,
    inp.who ? `Who: ${inp.who}` : '',
    inp.what ? `What happens: ${inp.what}` : '',
    inp.where ? `Where: ${inp.where}` : '',
    inp.when ? `When: ${inp.when}` : '',
    inp.extraNotes ? `Extra notes: ${inp.extraNotes}` : '',
    `Total duration: ${inp.durationSec} seconds`,
    `Aspect ratio: ${inp.aspectRatio} — Resolution: ${inp.resolution}`,
    `Style preset: ${inp.stylePreset ?? 'cinematic'}${inp.styleNotes ? ` — notes: ${inp.styleNotes}` : ''}`,
    `Dialogue: ${inp.dialogueEnabled ? `yes${inp.dialogueNotes ? ` — script wishes: ${inp.dialogueNotes}` : ''}` : 'no dialogue'}`,
    `Audio: music=${inp.audio.music}, sfx=${inp.audio.sfx}, ambience=${inp.audio.ambience}, characterVoices(ElevenLabs)=${inp.audio.characterVoices}, subtitles=${inp.audio.subtitles}`,
    '',
    `SUBJECT SHEETS (identity blocks are LOCKED — reuse their wording verbatim)`,
    subjectBlocks,
  ].filter(Boolean).join('\n');

  return structured({
    system: directorSystem(caps),
    content: [{ type: 'text', text: brief }],
    schema: BriefingPlanSchema,
    schemaName: 'briefing_plan',
    maxTokens: 60000,
  });
}
