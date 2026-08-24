/**
 * Deterministic prompt assembly.
 *
 * The director (Claude) produces structured fields; these functions turn them
 * into the exact prompt formats from Dan Kieft's Seedance 2.5 system:
 *  - asset master/angle prompts (studio-grey, master-first workflow)
 *  - environment reference prompts
 *  - the advanced video template:
 *    [GOAL] [REFERENCE MATERIAL] [CONTINUITY] [STAGES] [VISUAL STYLE]
 *    [CAMERA AND PERFORMANCE] [AUDIO] [EXCLUSIONS] [MAINTAIN CONSISTENCY]
 *
 * Assembly is code, not AI: users can edit any structured field in the UI and
 * the prompt regenerates identically.
 */
import type {
  SubjectDoc, SubjectAngle, SceneDoc, SceneReference, EnvironmentDoc, Briefing,
} from './types';
import { anglesForSubject } from './types';
import { buildCameraPathBlock } from './previz';

// ---------------------------------------------------------------------------
// Asset prompts (character / product angle images)
// ---------------------------------------------------------------------------

const CHARACTER_LOOK_FULL =
  'Look: plain solid mid-grey seamless studio background, flat even shadow-free studio lighting, matte fabrics with no sheen, 35mm lens, sharp full-length fashion photography, photorealistic. One person alone in frame — no props, no other objects, no second figure.';
const CHARACTER_LOOK_CLOSEUP =
  'Look: plain solid mid-grey seamless studio background, flat even shadow-free studio lighting, matte fabrics with no sheen, 85mm lens, photorealistic. One person alone in frame.';
const PRODUCT_LOOK =
  'Look: plain solid mid-grey seamless background, soft even shadow-free lighting with a gentle top light to reveal the surface changes, matte with no gloss or reflections, 85mm lens, f/8, sharp commercial product photography, photorealistic with fine material detail.';

/**
 * Master prompt for a character.
 * With a reference photo: face locked to @image1, clothing described.
 * Without: the face is described inline and this generation becomes the master.
 */
export function buildCharacterMasterPrompt(subject: SubjectDoc, hasSourcePhoto: boolean): string {
  const s = subject.sheet;
  if (!s) throw new Error('Subject sheet missing');
  const lines: string[] = [];
  if (hasSourcePhoto) {
    lines.push(
      "@image1 — Look ref. The person's face, head and hair. Face and identity exactly per ref. Do not use the image background, lighting or clothing.",
    );
  }
  lines.push(
    'A single full-body photograph of ' +
    (hasSourcePhoto ? 'the same person as @image1, ' : '') +
    'standing straight and facing the camera in a relaxed pose with their arms hanging at their sides, full height in frame from head to toe, camera at chest height, no cropping at the feet or the top of the head.',
  );
  const identity = [
    hasSourcePhoto ? 'The person: face and head matching @image1 exactly' : 'The person',
    s.identityBlock,
    s.physique ? `Physique: ${s.physique}` : undefined,
    s.distinguishingMarks,
    'Calm neutral expression, mouth closed, looking straight into the lens. Real skin texture with visible pores, photorealistic RAW detail, zero retouching.',
  ].filter(Boolean).join(' — ');
  lines.push(identity);
  if (s.wardrobe) lines.push(`Clothing: ${s.wardrobe}`);
  if (s.negations) lines.push(`NOT: ${s.negations}`);
  lines.push(CHARACTER_LOOK_FULL);
  return lines.join('\n');
}

/** Master prompt for a product — flattest, most informative orthographic view. */
export function buildProductMasterPrompt(subject: SubjectDoc, masterAngleWording: string, hasSourcePhoto: boolean): string {
  const s = subject.sheet;
  if (!s) throw new Error('Subject sheet missing');
  const lines: string[] = [];
  if (hasSourcePhoto) {
    lines.push(
      '@image1 — Product ref. The product exactly as photographed: structure, proportions, materials, colour and every detail per ref. Do not use the image background or any props.',
    );
  }
  lines.push(
    `A single product photograph of one ${s.roleName} alone, ${masterAngleWording}, no perspective distortion.`,
  );
  if (s.purposeLine) lines.push(`The product: ${s.purposeLine}`);
  if (s.silhouette) lines.push(`The silhouette is ${s.silhouette}`);
  if (s.negations) lines.push(`NOT ${s.negations}`);
  if (s.materialsAndColour) {
    lines.push(`Materials and colour: ${s.materialsAndColour} No logos, no branding, no text anywhere on the product.`);
  }
  if (s.hiddenSurfaces) lines.push(s.hiddenSurfaces);
  lines.push(`${PRODUCT_LOOK} One ${s.roleName} alone in frame — no hanger, no stand, no hands, no other objects.`);
  return lines.join('\n');
}

/**
 * Angle prompt — every non-master image. @image1 is always the generated
 * master; on character close-ups the original face photo rides along as
 * @image2 (at close-up framing the master softens).
 */
export function buildAnglePrompt(subject: SubjectDoc, angle: SubjectAngle, includeFacePhoto: boolean): string {
  const s = subject.sheet;
  if (!s) throw new Error('Subject sheet missing');
  const tpl = anglesForSubject(subject.kind, subject.angleSet, s.productType).find((a) => a.id === angle.id);
  const wording = tpl?.angleWording ?? angle.label;

  if (subject.kind === 'product') {
    const lines = [
      `@image1 — Product ref. The ${s.roleName}. Structure, proportions, materials, colour and every detail exactly per ref. This is the same single ${s.roleName}.`,
      `A single product photograph of the same ${s.roleName} as @image1, ${wording}.`,
    ];
    // Any surface the master doesn't show needs its own full description.
    if (angle.id === 'p_underside' && s.hiddenSurfaces) lines.push(s.hiddenSurfaces);
    if (angle.id === 'p_detail' && s.materialsAndColour) lines.push(`Detail focus: ${s.materialsAndColour}`);
    lines.push(`${PRODUCT_LOOK} One ${s.roleName} alone in frame — no stand, no hands, no second ${s.roleName}.`);
    return lines.join('\n');
  }

  const isCloseup = angle.framing === 'close_up';
  const lines = [
    '@image1 — Look ref. The person, their face, hair, clothing and shoes. Appearance exactly per ref.',
  ];
  if (isCloseup && includeFacePhoto) {
    lines.push('@image2 — the original face photo. Face and identity exactly per ref. Do not use the image background, lighting or clothing.');
  }
  lines.push(
    `A single ${isCloseup ? 'head and shoulders' : 'full-body'} photograph of the same person as @image1, ${wording}, ` +
    (isCloseup ? 'the entire head fully inside the frame, camera at eye level, no cropping.' : 'full height in frame from head to toe, camera at chest height, no cropping.'),
  );
  lines.push(isCloseup ? CHARACTER_LOOK_CLOSEUP : CHARACTER_LOOK_FULL);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Environment reference prompt
// ---------------------------------------------------------------------------

export function buildEnvironmentPrompt(env: EnvironmentDoc, briefing: Briefing | undefined): string {
  if (env.type === 'insert_card') {
    // Full-frame graphic with exact text — video models copy attached text
    // far more faithfully than they invent it.
    return [
      `A flat, full-frame insert graphic, filling the entire frame edge to edge: ${env.name}.`,
      env.description,
      env.refPrompt,
      'Render every piece of text EXACTLY as written above — letter for letter, correct spelling, no invented words, no additional text anywhere.',
      'Crisp, perfectly legible type; clean vector-sharp rendering; no people, no watermark.',
    ].join('\n');
  }
  const style = briefing?.styleBible;
  const lines = [
    `A single wide establishing photograph of ${env.name}, completely empty of people.`,
    env.description,
    env.refPrompt,
  ];
  if (style) {
    lines.push(`Colour and light: ${style.colourPalette}. ${style.lighting}.`);
  }
  lines.push('No people, no animals, no text, no logos anywhere in frame. Photorealistic, sharp, high detail.');
  return lines.join('\n');
}

/**
 * Casting clip ("screen test") for a character: one person alone, a slow turn
 * for angle coverage, then a spoken line to camera — the clip becomes the
 * character's identity AND voice anchor, attached to scenes as @video.
 * Composition follows video-reference best practice (single subject, face
 * large and clearly lit, consistent wardrobe, clean audio).
 */
export function buildScreenTestPrompt(subject: SubjectDoc, durationSec: number): string {
  const sheet = subject.sheet;
  const name = sheet?.roleName ?? subject.name;
  const voice = sheet?.voice;
  const voiceLine = voice
    ? `${voice.delivery ?? 'natural, warm'}, ${voice.language ?? 'English'}${voice.accent ? ` with a ${voice.accent} accent` : ''}`
    : 'a natural, warm voice matching their age and presence';
  const half = Math.round(durationSec / 2);
  return [
    `[GOAL]\nA casting screen test of one single person: ${name}. Duration: ${durationSec} seconds.`,
    `[CHARACTER]\n${[sheet?.identityBlock, sheet?.physique, sheet?.wardrobe, sheet?.distinguishingMarks].filter(Boolean).join(' ')}${sheet?.negations ? ` ${sheet.negations}.` : ''}`,
    `[CONTINUITY]\nOne person alone in a plain warm-grey casting studio, soft even key light, no props. The same person, hair and wardrobe from first frame to last.`,
    `[STAGE 1 | 0-${half}s | The turn] Full body visible, standing centred; they turn slowly once around — front, side, back, and back to front — relaxed and natural. NO CUT.`,
    `[STAGE 2 | ${half}-${durationSec}s | The line] The camera moves closer to a chest-up framing, their face large and clearly lit; they look straight into the lens, smile naturally, and speak with accurate lip-sync. ${name} — in ${voiceLine}: {Hi, I'm ${subject.name}. This is how I look and sound.} End: holding an easy smile at the camera. NO CUT.`,
    `[VISUAL STYLE]\nClean neutral casting-tape look: photoreal, true colours, soft even light, real skin texture with visible pores, fine grain.`,
    `[AUDIO]\nno music <quiet room tone> Their voice clean, close and dry. No other voices.`,
    `[EXCLUSIONS]\nNo other people, no text, no captions, no logos, no watermarks, no props.`,
    `[MAINTAIN CONSISTENCY]\nsame single person throughout; same wardrobe and hair; plain studio unchanged.`,
  ].join('\n\n');
}

// ---------------------------------------------------------------------------
// Scene prompt — the advanced Seedance 2.5 template
// ---------------------------------------------------------------------------

export interface ResolvedRef extends SceneReference {
  /** e.g. "@image3", "@video1" or "@audio1" — assigned here, in listed order */
  assignedTag: string;
  /** whether this reference resolves to an image, video or audio file */
  media: 'image' | 'video' | 'audio';
}

/**
 * Assign @image / @audio tags in order. Grouping follows the guide: products
 * first, then characters, then scenes (environments), then colour/light, then
 * bridge frames, then audio.
 */
export function resolveReferenceTags(scene: SceneDoc): ResolvedRef[] {
  const orderOf = (r: SceneReference): number => {
    switch (r.kind) {
      case 'subject_video': return 1; // character screen tests lead with the subjects
      case 'subject_angle': return 1;
      case 'subject_upload': return 1;
      case 'environment': return 2;
      case 'style': return 3;
      case 'camera_previz': return 4; // camera reference sits after the look
      case 'bridge_frame': return 0; // first frame ref leads the list
      case 'voice_audio': return 9;
      default: return 5;
    }
  };
  const sorted = [...scene.references].sort((a, b) => orderOf(a) - orderOf(b));
  // A previz reaches the model as a contact-sheet image or as the clip
  // itself, depending on the scene's feed mode.
  const previzIsVideo = scene.previz?.feed === 'attach_video';
  let img = 0; let vid = 0; let aud = 0;
  return sorted.map((r) => {
    const media: 'image' | 'video' | 'audio' =
      r.kind === 'voice_audio' ? 'audio'
        : r.kind === 'subject_video' ? 'video'
          : r.kind === 'camera_previz' ? (previzIsVideo ? 'video' : 'image')
            : 'image';
    const assignedTag = media === 'audio' ? `@audio${++aud}` : media === 'video' ? `@video${++vid}` : `@image${++img}`;
    return { ...r, assignedTag, media };
  });
}

function refLine(r: ResolvedRef): string {
  const ignore = r.ignore ? ` ${r.ignore}` : '';
  return `${r.assignedTag} — ${r.use}${ignore}`;
}

function fmtTime(t: number): string {
  return Number.isInteger(t) ? String(t) : t.toFixed(1);
}

/**
 * Keyframe prompt for the Seedance v1 pipeline: the scene's opening moment as
 * a single still, generated with nano-banana from the subject/environment
 * references, then animated with image-to-video.
 */
export function buildKeyframePrompt(
  scene: SceneDoc,
  subjects: SubjectDoc[],
  refs: ResolvedRef[],
): string {
  const lines: string[] = [];
  refs.filter((r) => r.media === 'image').forEach((r) => {
    lines.push(`${r.assignedTag} — ${r.use}${r.ignore ? ` ${r.ignore}` : ''}`);
  });
  const opening = scene.mode === 'stages' && scene.stages.length > 0
    ? scene.stages[0].action
    : (scene.continuousAction ?? scene.goal);
  const presentSubjects = new Set(refs.map((r) => r.subjectId).filter(Boolean));
  const identityLines = subjects
    .filter((s) => presentSubjects.has(s.id) && s.sheet)
    .map((s) => {
      const sh = s.sheet!;
      const core = s.kind === 'character'
        ? [sh.identityBlock, sh.wardrobe].filter(Boolean).join(' ')
        : [sh.purposeLine, sh.materialsAndColour].filter(Boolean).join(' ');
      return `${sh.roleName}: appearance exactly per the reference images. ${core}`;
    });
  lines.push(
    `A single cinematic still frame — the exact opening frame of this shot: ${opening}`,
    ...identityLines,
    `Setting and continuity: ${scene.continuity}`,
    `Look: ${scene.visualStyle}`,
    'Photorealistic, sharp, no text, no watermarks, no logos.',
  );
  return lines.join('\n');
}

/**
 * Condensed motion prompt for Seedance v1 image-to-video (short prompts work
 * better there than the full advanced template).
 */
export function buildV1MotionPrompt(scene: SceneDoc): string {
  const action = scene.mode === 'stages' && scene.stages.length > 0
    ? scene.stages.map((s) => s.action).join(' Then ')
    : (scene.continuousAction ?? scene.goal);
  return [
    action,
    scene.cameraAndPerformance,
    scene.visualStyle,
  ].filter(Boolean).join(' ');
}

export function buildScenePrompt(
  scene: SceneDoc,
  subjects: SubjectDoc[],
  refs: ResolvedRef[],
): string {
  if (scene.promptOverride && scene.promptOverride.trim().length > 0) {
    return scene.promptOverride.trim();
  }

  const roleOf = (subjectId: string | undefined): string => {
    const subj = subjects.find((s) => s.id === subjectId);
    return subj?.sheet?.roleName ?? subj?.name ?? 'the character';
  };
  const voiceTagOf = (subjectId: string | undefined): string | undefined =>
    refs.find((r) => r.kind === 'voice_audio' && r.subjectId === subjectId)?.assignedTag
    ?? refs.find((r) => r.kind === 'subject_video' && r.subjectId === subjectId)?.assignedTag;

  const sections: string[] = [];

  // [GOAL]
  sections.push(`[GOAL]\n${scene.goal.trim()} Duration: ${scene.durationSec} seconds.`);

  // [REFERENCE MATERIAL] — grouped, every reference bound to its own tag
  const groups: { title: string; kinds: string[] }[] = [
    { title: 'Bridge frame', kinds: ['bridge_frame'] },
    { title: 'Characters and products', kinds: ['subject_video', 'subject_angle', 'subject_upload'] },
    { title: 'Scenes', kinds: ['environment'] },
    { title: 'Colour and light', kinds: ['style'] },
    { title: 'Camera', kinds: ['camera_previz'] },
    { title: 'Voice', kinds: ['voice_audio'] },
  ];
  const refLines: string[] = [];
  for (const g of groups) {
    const inGroup = refs.filter((r) => g.kinds.includes(r.kind));
    for (const r of inGroup) refLines.push(refLine(r));
  }
  if (refLines.length > 0) {
    sections.push(`[REFERENCE MATERIAL]\n${refLines.join('\n')}\nDo not use any of the backgrounds from the photos.`);
  }

  // [CONTINUITY]
  sections.push(`[CONTINUITY]\n${scene.continuity.trim()}`);

  // [STAGES] or continuous paragraph
  if (scene.mode === 'stages' && scene.stages.length > 0) {
    const stageLines = scene.stages.map((st) => {
      let line = `[STAGE ${st.index} | ${fmtTime(st.t0)}-${fmtTime(st.t1)}s | ${st.beatName}] ${st.action.trim()}`;
      if (st.dialogue) {
        const vTag = voiceTagOf(st.dialogue.subjectId);
        const lang = st.dialogue.language ?? 'English';
        const voicePart = vTag ? `In their voice (${vTag}), ${lang}` : `${lang}`;
        line += ` ${roleOf(st.dialogue.subjectId)} — ${voicePart}: {${st.dialogue.line.trim()}}`;
      }
      if (st.endState) line += ` End: ${st.endState.trim()}`;
      line += ` ${st.cut === 'CUT' ? 'CUT.' : 'NO CUT.'}`;
      return line;
    });
    sections.push(stageLines.join('\n'));
  } else if (scene.continuousAction) {
    sections.push(`One long continuous take, no cuts. ${scene.continuousAction.trim()}`);
  }

  // [VISUAL STYLE]
  sections.push(`[VISUAL STYLE]\n${scene.visualStyle.trim()}`);

  // [CAMERA AND PERFORMANCE] — when a previz has been rendered and read back,
  // the measured camera map replaces guesswork about where the camera is at
  // any moment. It costs nothing to send: it is text, not another reference.
  const cameraMap = scene.previz?.cameraMap;
  sections.push([
    '[CAMERA AND PERFORMANCE]',
    scene.cameraAndPerformance.trim(),
    ...(cameraMap && cameraMap.length > 0 ? [buildCameraPathBlock(cameraMap)] : []),
  ].join('\n'));

  // [AUDIO]
  sections.push(`[AUDIO]\n${scene.audio.trim()}`);

  // [EXCLUSIONS]
  sections.push(`[EXCLUSIONS]\n${scene.exclusions.trim()}`);

  // [MAINTAIN CONSISTENCY]
  sections.push(`[MAINTAIN CONSISTENCY]\n${scene.keepConsistent.trim()}`);

  return sections.join('\n\n');
}
