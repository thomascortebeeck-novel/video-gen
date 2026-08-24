/**
 * Take verification — grading a generated clip against the plan it came from.
 *
 * A re-roll costs $1.85-6.78; reading the take costs cents. So every take can
 * be checked before anyone reaches for the regenerate button, and — more
 * importantly — each finding says WHICH lever fixes it. Half of what goes
 * wrong is editorial (a slow first second, a music bed over a line) and can be
 * fixed for free; only the other half needs new footage.
 *
 * The criteria below are not generic QC. They are the failures this pipeline
 * has actually hit and recorded in CLAUDE.md — style bleed from drawn
 * references, action beats flattened into a pose, insert-card text respelled,
 * a camera move drifting off its measured previz map.
 */
import type { SceneDoc } from './types';

/** Which lever fixes a finding — the routing decision the whole feature turns on. */
export type FixKind =
  | 'edit'       // free: the editor can fix it (trim, duck, reframe, grade)
  | 'prompt'     // paid: needs new footage from a reworded prompt
  | 'reference'  // paid: needs different reference material attached
  | 'accept';    // not worth fixing

export type VerdictCall = 'ship' | 'minor' | 're_roll';

export type CriterionId =
  | 'beat_coverage'
  | 'style_match'
  | 'camera_vs_plan'
  | 'identity'
  | 'wardrobe_continuity'
  | 'dialogue_accuracy'
  | 'lip_sync'
  | 'onscreen_text'
  | 'audio_bed'
  | 'duration_pacing'
  | 'artifacts';

export interface CriterionSpec {
  id: CriterionId;
  label: string;
  /** What the model is asked to judge. */
  question: string;
  /** Skip criteria that cannot apply — an unscored criterion beats a guessed one. */
  applies: (scene: SceneDoc) => boolean;
}

const hasSpokenOnCamera = (scene: SceneDoc): boolean =>
  scene.stages.some((s) => Boolean(s.dialogue?.line.trim()));

/** Spoken lines OR a voiceover written into the continuous paragraph. */
const hasDialogue = (scene: SceneDoc): boolean =>
  hasSpokenOnCamera(scene) || /voiceover\b/i.test(scene.continuousAction ?? '');

export const VERIFY_CRITERIA: CriterionSpec[] = [
  {
    id: 'beat_coverage',
    label: 'Beats covered',
    question:
      'Does every planned stage actually happen, in order, as a physical action? A beat that was flattened into a '
      + 'pose (planned "climbs onto it and rides away", delivered "stands beside it") is a failure, not a minor note. '
      + 'Name any beat that is missing, truncated, or reduced to standing still.',
    applies: (s) => s.stages.length > 0,
  },
  {
    id: 'style_match',
    label: 'Style match',
    question:
      'Does the rendered look match [VISUAL STYLE] — photoreal where photoreal was asked for, drawn where drawn was '
      + 'asked for? Reference images outweigh style wording in this model, so a photoreal brief that came back '
      + 'illustrated (or vice versa) is a reference problem, not a prompt problem.',
    applies: () => true,
  },
  {
    id: 'camera_vs_plan',
    label: 'Camera vs plan',
    question:
      'Compare the camera against the measured camera map, window by window. Is the move in the right place at the '
      + 'right time, at a constant speed, with a level horizon and no cuts? Say which window drifted.',
    applies: (s) => (s.previz?.cameraMap?.length ?? 0) > 0,
  },
  {
    id: 'identity',
    label: 'Identity',
    question:
      'Do the people match their reference material — same face, same hair? Identity drift within the clip (a face '
      + 'that morphs between shots) counts here too.',
    applies: (s) => s.references.some((r) => r.kind === 'subject_video' || r.kind === 'subject_angle' || r.kind === 'subject_upload'),
  },
  {
    id: 'wardrobe_continuity',
    label: 'Wardrobe & continuity',
    question:
      'Does wardrobe, location and lighting hold to [CONTINUITY] for the whole clip, without garments or props '
      + 'changing between beats?',
    applies: (s) => Boolean(s.continuity?.trim()),
  },
  {
    id: 'dialogue_accuracy',
    label: 'Dialogue accuracy',
    question:
      'Compare the transcript word for word against the planned lines. Report any line that was changed, dropped, '
      + 'invented, or spoken by the wrong character.',
    applies: hasDialogue,
  },
  {
    id: 'lip_sync',
    label: 'Lip sync',
    question:
      'Do mouths match the spoken words for on-camera dialogue? For voiceover, mouths should NOT move — flag it if '
      + 'they do.',
    applies: hasSpokenOnCamera,
  },
  {
    id: 'onscreen_text',
    label: 'On-screen text',
    question:
      'Read every piece of text visible in frame — signs, screens, menus, cards. Is it spelled EXACTLY as written in '
      + 'the plan? Any respelling, garbling or invented lettering is a blocker.',
    applies: (s) => /[""].*[""]/.test(s.exclusions + s.goal) || s.references.some((r) => r.kind === 'environment'),
  },
  {
    id: 'audio_bed',
    label: 'Audio',
    question:
      'Does the audio deliver what [AUDIO] asked for — music, ambience, effects at the right moments — without '
      + 'drowning dialogue or cutting off abruptly at the end?',
    applies: (s) => Boolean(s.audio?.trim()),
  },
  {
    id: 'duration_pacing',
    label: 'Duration & pacing',
    question:
      'Is the clip the planned length, and is the action spread across it — or is there dead air at either end, or '
      + 'everything crammed into the first half?',
    applies: () => true,
  },
  {
    id: 'artifacts',
    label: 'Artifacts',
    question:
      'Any generation artifacts: extra or malformed fingers, warping faces, objects that pop in or vanish, physics '
      + 'that break, duplicated limbs, flicker. Give the timecode.',
    applies: () => true,
  },
];

export function criteriaFor(scene: SceneDoc): CriterionSpec[] {
  return VERIFY_CRITERIA.filter((c) => c.applies(scene));
}

export function criterionLabel(id: string): string {
  return VERIFY_CRITERIA.find((c) => c.id === id)?.label ?? id;
}

export interface VerdictCriterion {
  id: CriterionId | string;
  /** 0-100. */
  score: number;
  note: string;
}

export interface VerdictIssue {
  severity: 'blocker' | 'major' | 'minor';
  /** Where it happens, in seconds from the clip start. */
  atSec: number;
  what: string;
  fixKind: FixKind;
  /** The concrete fix — an edit instruction, or wording to change. */
  fix: string;
}

export interface SceneVerdict {
  status: 'running' | 'ready' | 'failed';
  /** The take this verdict judged — verdicts do not carry over to a new take. */
  takePath?: string;
  /** 0-100, the weighted read of the criteria below. */
  overall: number;
  call: VerdictCall;
  headline: string;
  criteria: VerdictCriterion[];
  issues: VerdictIssue[];
  /** Ready-to-use note for a re-roll, when one is warranted. */
  suggestedNote?: string;
  /** What Scribe heard, for the dialogue comparison shown in the UI. */
  transcript?: string;
  contactSheetPath?: string;
  checkedAt: number;
  error?: string;
}

/** Free fixes first — the editor should absorb everything it can. */
export function issuesByLever(verdict: SceneVerdict | undefined): Record<FixKind, VerdictIssue[]> {
  const out: Record<FixKind, VerdictIssue[]> = { edit: [], prompt: [], reference: [], accept: [] };
  for (const i of verdict?.issues ?? []) out[i.fixKind]?.push(i);
  return out;
}

export function scoreTone(score: number): 'ok' | 'warn' | 'bad' {
  if (score >= 80) return 'ok';
  if (score >= 55) return 'warn';
  return 'bad';
}

export function verdictSummary(v: SceneVerdict): string {
  const free = v.issues.filter((i) => i.fixKind === 'edit').length;
  const paid = v.issues.filter((i) => i.fixKind === 'prompt' || i.fixKind === 'reference').length;
  if (v.issues.length === 0) return 'Nothing found against the plan.';
  const parts: string[] = [];
  if (paid > 0) parts.push(`${paid} needing new footage`);
  if (free > 0) parts.push(`${free} fixable in the edit`);
  return `${v.issues.length} finding${v.issues.length === 1 ? '' : 's'} — ${parts.join(', ')}.`;
}

export function formatTimecode(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest.toFixed(1).padStart(4, '0')}`;
}

// ---------------------------------------------------------------------------
// Re-roll notes → field-level patches
//
// A note never rewrites the prompt. It patches named fields, and the prompt is
// re-assembled from them by the same deterministic code that built it the
// first time — so a note about one beat cannot quietly reword a character's
// wardrobe three scenes later.
// ---------------------------------------------------------------------------

import type { ScenePatch } from './types';

/** Fields whose text is reused verbatim by other scenes — patch with care. */
export const SHARED_TEXT_FIELDS = new Set(['continuity', 'keepConsistent']);

const SCALAR_FIELDS = [
  'goal', 'continuity', 'visualStyle', 'cameraAndPerformance',
  'audio', 'exclusions', 'keepConsistent', 'continuousAction',
] as const;

type ScalarField = typeof SCALAR_FIELDS[number];

/** field path → current text: exactly the set a note is allowed to change. */
export function patchableFields(scene: SceneDoc): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of SCALAR_FIELDS) {
    const v = scene[f];
    if (typeof v === 'string') out[f] = v;
  }
  scene.stages.forEach((st, i) => {
    out[`stages[${i}].beatName`] = st.beatName;
    out[`stages[${i}].action`] = st.action;
    if (st.endState !== undefined) out[`stages[${i}].endState`] = st.endState;
    if (st.dialogue) out[`stages[${i}].dialogue.line`] = st.dialogue.line;
  });
  return out;
}

const STAGE_PATH = /^stages\[(\d+)\]\.(beatName|action|endState|dialogue\.line)$/;

export function isPatchableField(scene: SceneDoc, field: string): boolean {
  if ((SCALAR_FIELDS as readonly string[]).includes(field)) return true;
  const m = STAGE_PATH.exec(field);
  if (!m) return false;
  const stage = scene.stages[Number(m[1])];
  if (!stage) return false;
  return m[2] !== 'dialogue.line' || Boolean(stage.dialogue);
}

export interface PatchResult {
  scene: SceneDoc;
  applied: ScenePatch[];
  /** Paths the model named that do not exist on this scene — reported, never applied. */
  rejected: { field: string; reason: string }[];
}

/**
 * Apply patches to a copy of the scene. Unknown or malformed field paths are
 * rejected rather than coerced: a patch that silently lands on the wrong field
 * is worse than one that visibly did not land.
 */
export function applyScenePatches(scene: SceneDoc, patches: ScenePatch[]): PatchResult {
  const next: SceneDoc = { ...scene, stages: scene.stages.map((s) => ({ ...s, ...(s.dialogue ? { dialogue: { ...s.dialogue } } : {}) })) };
  const applied: ScenePatch[] = [];
  const rejected: { field: string; reason: string }[] = [];

  for (const p of patches) {
    if (!isPatchableField(scene, p.field)) {
      rejected.push({ field: p.field, reason: 'not a patchable field on this scene' });
      continue;
    }
    if (p.to === p.from) {
      rejected.push({ field: p.field, reason: 'no change' });
      continue;
    }
    if ((SCALAR_FIELDS as readonly string[]).includes(p.field)) {
      (next as unknown as Record<ScalarField, string>)[p.field as ScalarField] = p.to;
      applied.push(p);
      continue;
    }
    const m = STAGE_PATH.exec(p.field)!;
    const stage = next.stages[Number(m[1])];
    if (m[2] === 'dialogue.line') stage.dialogue!.line = p.to;
    else if (m[2] === 'beatName') stage.beatName = p.to;
    else if (m[2] === 'action') stage.action = p.to;
    else stage.endState = p.to;
    applied.push(p);
  }
  return { scene: next, applied, rejected };
}

/** Human label for a field path, for the diff view. */
export function fieldLabel(field: string): string {
  const m = STAGE_PATH.exec(field);
  if (m) {
    const which = m[2] === 'dialogue.line' ? 'dialogue' : m[2] === 'beatName' ? 'beat name' : m[2] === 'endState' ? 'end state' : 'action';
    return `Stage ${Number(m[1]) + 1} — ${which}`;
  }
  return ({
    goal: 'Goal',
    continuity: 'Continuity',
    visualStyle: 'Visual style',
    cameraAndPerformance: 'Camera and performance',
    audio: 'Audio',
    exclusions: 'Exclusions',
    keepConsistent: 'Maintain consistency',
    continuousAction: 'Continuous action',
  } as Record<string, string>)[field] ?? field;
}
