/**
 * Shared domain model for the AI Video Studio.
 *
 * A Project moves through this pipeline:
 *   draft → (analyze subjects) → (plan briefing) → briefing_ready →
 *   (user edits + accepts) → briefing_accepted → (generate assets + scenes) →
 *   (assemble) → done
 *
 * The briefing structure mirrors Dan Kieft's Seedance 2.5 advanced prompt
 * template: [GOAL] [REFERENCE MATERIAL] [CONTINUITY] [STAGES] [VISUAL STYLE]
 * [CAMERA AND PERFORMANCE] [AUDIO] [EXCLUSIONS] [MAINTAIN CONSISTENCY].
 * Scene prompts are assembled deterministically from these structured fields,
 * so users can edit any field and the prompt regenerates.
 */

// ---------------------------------------------------------------------------
// Generation status shared by all generated assets
// ---------------------------------------------------------------------------

export type GenStatus =
  | 'idle'        // not yet requested
  | 'queued'      // job submitted to provider
  | 'generating'  // provider reports in progress
  | 'completed'   // asset stored in Firebase Storage
  | 'failed';

export interface GenerationInfo {
  status: GenStatus;
  jobSetId?: string;      // legacy field
  jobId?: string;         // provider job/request id
  /** which provider ran this job: 'higgsfield' | 'fal' | 'mock' */
  provider?: string;
  error?: string;
  startedAt?: number;     // epoch ms
  completedAt?: number;
  /** provider result URL (temporary); the durable copy lives at `path` */
  resultUrl?: string;
  /** set when the provider's content filter rejected some reference images
   *  and the job was retried without them (e.g. ModelArk flags face
   *  close-ups as "may contain real person", even AI-generated ones) */
  moderationNote?: string;
}

// ---------------------------------------------------------------------------
// Subjects (characters & products)
// ---------------------------------------------------------------------------

export type SubjectKind = 'character' | 'product';

export type ProductType =
  | 'footwear'
  | 'garment'
  | 'handheld_prop'
  | 'furniture_or_large_object'
  | 'vehicle'
  | 'other';

/**
 * Angle-set presets, following the prompting guide:
 *  - characters: "fast" = 4 full-body + 4 close-ups (recommended default),
 *    "full" = 8 full-body + 4 close-ups, "minimal" = 4 full-body only.
 *  - products: count derived from product type (footwear 6, garment 4–5,
 *    handheld prop 4, furniture 5–6, vehicle 6–8).
 */
export type AngleSetId = 'minimal' | 'fast' | 'full' | 'product_auto';

export interface VoiceSpec {
  /** e.g. "English", "Dutch" */
  language: string;
  /** e.g. "neutral American", "soft Flemish accent" */
  accent?: string;
  /** e.g. "warm, unhurried, slightly amused" */
  delivery?: string;
  /** Text description used for ElevenLabs voice design (v2 feature) */
  designDescription?: string;
  /** Assigned ElevenLabs voice id once chosen/created */
  elevenLabsVoiceId?: string;
  /** Storage path of a generated voice sample (attach to Seedance as @audio ref) */
  sampleAudioPath?: string;
  sampleStatus?: GenStatus;
}

/**
 * The character/product sheet — everything the director needs to write
 * consistent prompts. Text blocks are written once and reused VERBATIM in
 * every prompt so the design cannot drift.
 */
export interface SubjectSheet {
  /** Story role used in prompts: "the climber", "the vendor" — never "the man" */
  roleName: string;
  /** One-line read on who/what this is */
  oneLineRead: string;

  // -- character fields --
  /** Age → hair → brows/eyes/nose/face shape/jaw → facial hair → marks → what the face communicates → skin texture */
  identityBlock?: string;
  /** Physique with numbers: "175 cm, average build with narrow shoulders…" */
  physique?: string;
  /** Each garment: fabric, cut, colour, condition, how it hangs + negations */
  wardrobe?: string;
  /** One or two distinguishing marks worth locking */
  distinguishingMarks?: string;
  /** Voice casting for dialogue (drives ElevenLabs in v2) */
  voice?: VoiceSpec;

  // -- product fields --
  productType?: ProductType;
  /** "What it is and what it's for" — the purpose line that makes the shape correct */
  purposeLine?: string;
  /** Proportions, stance, weight */
  silhouette?: string;
  /** Material → construction → hardware → colour (positive names) → condition */
  materialsAndColour?: string;
  /** Surfaces the master view doesn't show (e.g. a sole) that need full description */
  hiddenSurfaces?: string;

  /** Things it must NOT be/look like (negations do more work than descriptions) */
  negations?: string;
}

export interface SubjectAngle {
  id: string;
  /** e.g. "Full body — front (master)", "Face — three-quarter" */
  label: string;
  framing: 'full_body' | 'close_up' | 'product_view';
  /** True for the master angle: generated first, referenced by all others */
  isMaster?: boolean;
  /** The exact image prompt used (assembled by the director) */
  prompt?: string;
  generation: GenerationInfo;
  /** Storage path of the generated image */
  imagePath?: string;
}

export interface SubjectDoc {
  id: string;
  kind: SubjectKind;
  /** User-facing name, e.g. "Lena", "Raid bouldering shoe" */
  name: string;
  /** Free-form notes from the user (outfit wishes, what matters) */
  notes?: string;
  /** Uploaded source images (Storage paths) */
  sourceImagePaths: string[];
  angleSet: AngleSetId;
  sheet?: SubjectSheet;
  angles: SubjectAngle[];
  status: 'new' | 'analyzing' | 'analyzed' | 'generating_angles' | 'ready' | 'error';
  error?: string;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Environments (location reference images generated in the background)
// ---------------------------------------------------------------------------

export interface EnvironmentDoc {
  id: string;
  /** e.g. "the bouldering gym", "the neon alley at night" */
  name: string;
  /** Space, materials, light behaviour */
  description: string;
  /** Image prompt used to generate the reference */
  refPrompt: string;
  /**
   * 'location' (default): a wide establishing shot of a place.
   * 'insert_card': a flat full-frame graphic with EXACT on-screen text
   * (phone messages, menus, signs) — generated upfront so video scenes can
   * reproduce the text pixel-faithfully instead of inventing it.
   */
  type?: 'location' | 'insert_card';
  generation: GenerationInfo;
  imagePath?: string;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Briefing & scenes
// ---------------------------------------------------------------------------

export type AspectRatio = '16:9' | '9:16' | '1:1' | '4:3' | '3:4' | '21:9';
export type Resolution = '480p' | '720p' | '1080p' | '4k';

/** How a scene connects to the PREVIOUS scene in the final edit. */
export type StitchMode =
  /** First scene, or an intentional hard cut to a new setup */
  | 'hard_cut'
  /** Generated by extending the previous scene's video (same continuous shot) */
  | 'extend_prev'
  /** Uses the last frame of the previous scene as its first frame (seamless bridge) */
  | 'frame_bridge';

export interface SceneStage {
  index: number;
  /** seconds from scene start */
  t0: number;
  t1: number;
  /** Beat name, e.g. "Case lands" */
  beatName: string;
  /** Physical action + framing, moment by moment. No intent clauses. */
  action: string;
  /** Optional spoken line */
  dialogue?: {
    subjectId: string;
    /** The literal line, no braces/quotes — assembler adds {} */
    line: string;
    language?: string;
  };
  /** What is visibly true when this stage finishes (continuity anchor) */
  endState?: string;
  cut: 'CUT' | 'NO CUT';
}

export type SceneRefKind =
  | 'subject_angle'   // a generated angle image of a subject
  | 'subject_upload'  // an original uploaded image
  | 'environment'     // generated environment reference
  | 'style'           // colour & light reference
  | 'bridge_frame'    // last frame of previous scene (start-frame stitching)
  | 'voice_audio';    // ElevenLabs voice sample (@audio ref)

export interface SceneReference {
  /** Tag as used in the prompt, assigned at assembly: "@image1", "@audio1" */
  tag: string;
  kind: SceneRefKind;
  subjectId?: string;
  angleId?: string;
  envId?: string;
  /** Resolved Storage path (filled at generation time for bridge frames) */
  path?: string;
  /** What to take from this reference */
  use: string;
  /** What to ignore ("Do not use the image background") */
  ignore?: string;
}

export interface SceneDoc {
  id: string;
  index: number;
  title: string;
  /** What this scene accomplishes in the story */
  beatSummary: string;
  durationSec: number;

  /** stages = director cuts every shot; continuous = one take, single paragraph */
  mode: 'stages' | 'continuous';

  /** [GOAL] — what kind of video + beginning-to-end in one sentence */
  goal: string;
  /** [CONTINUITY] — per-character look/wardrobe + single location & lighting */
  continuity: string;
  stages: SceneStage[];
  /** Mode B: the single flowing paragraph incl. dialogue */
  continuousAction?: string;
  /** [VISUAL STYLE] — sharpness/format, colour in positive names, light, mood */
  visualStyle: string;
  /** [CAMERA AND PERFORMANCE] — cutting rhythm, banned moves, how performances read */
  cameraAndPerformance: string;
  /** [AUDIO] — (music…) <effect at moment> ambience, subtitles on/off */
  audio: string;
  /** [EXCLUSIONS] — logos, extra people, on-screen text… */
  exclusions: string;
  /** [MAINTAIN CONSISTENCY] footer */
  keepConsistent: string;

  references: SceneReference[];

  stitching: {
    mode: StitchMode;
    /** Director's note on why/how this boundary works */
    notes?: string;
    /** Filled when a bridge frame has been extracted from the previous scene */
    bridgeFramePath?: string;
  };

  /** If the user edits the raw prompt directly, it wins over assembly */
  promptOverride?: string;
  /** Last assembled/used prompt (for display) */
  assembledPrompt?: string;

  generation: GenerationInfo & {
    params?: {
      model: string;
      durationSec: number;
      aspectRatio: AspectRatio;
      resolution: Resolution;
      seed?: number;
    };
  };
  /** Storage path of the generated clip */
  videoPath?: string;
  /** Previous takes kept for comparison */
  versions?: { videoPath: string; createdAt: number; note?: string }[];

  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

export interface ProjectInput {
  /** Free-form concept: what the video is about */
  concept: string;
  /** WHO is in it (beyond uploaded subjects) */
  who?: string;
  /** WHAT happens */
  what?: string;
  /** WHERE it takes place */
  where?: string;
  /** WHEN (time of day / era / season) */
  when?: string;
  /** Anything else: tone, jokes, must-haves */
  extraNotes?: string;

  durationSec: number;
  aspectRatio: AspectRatio;
  resolution: Resolution;

  /** preferred video engine for this project; 'auto' (default) = best available */
  videoEngine?: 'auto' | 'ark25' | 'fal25' | 'seedance25' | 'seedance1';

  /** e.g. "cinematic", "ugc_handheld", "camcorder_2000s", "documentary", "commercial" */
  stylePreset?: string;
  styleNotes?: string;

  dialogueEnabled: boolean;
  /** Script wishes / actual lines if the user has them */
  dialogueNotes?: string;

  audio: {
    music: boolean;
    sfx: boolean;
    ambience: boolean;
    /** v2: ElevenLabs voice per character, attached as @audio refs */
    characterVoices: boolean;
    subtitles: boolean;
  };
}

export interface BriefingMeta {
  title: string;
  logline: string;
  durationSec: number;
  aspectRatio: AspectRatio;
  resolution: Resolution;
  /** Higgsfield model used for scenes */
  videoModel: string;
}

export interface StyleBible {
  /** Sharpness & format: "large-format IMAX clarity" / "handheld phone video" */
  look: string;
  /** POSITIVE colour names only — never "desaturated"/"monochromatic" */
  colourPalette: string;
  /** How the light behaves (incl. flicker if practicals) */
  lighting: string;
  grainAndTexture: string;
  mood: string;
  /** The one technical line reused in every scene prompt */
  technicalLine: string;
}

export interface AudioPlan {
  music?: string;
  soundEffects: string[];
  ambience?: string;
  subtitles: boolean;
  dialogueLanguage?: string;
  voicesEnabled: boolean;
}

export interface StitchBoundary {
  fromSceneIndex: number;
  toSceneIndex: number;
  mode: StitchMode;
  /** e.g. "match cut on the door closing", "extend keeps the take unbroken" */
  rationale: string;
}

export interface Briefing {
  meta: BriefingMeta;
  styleBible: StyleBible;
  audioPlan: AudioPlan;
  /** Director's plan for how scenes join into one film */
  stitchingPlan: {
    boundaries: StitchBoundary[];
    assemblyNotes: string;
  };
  /** Things the director invented that the user should confirm/adjust */
  directorsNotes: string[];
}

export type ProjectStatus =
  | 'draft'
  | 'analyzing'          // subject sheets being written
  | 'briefing_generating'
  | 'briefing_ready'     // user reviews & edits
  | 'briefing_accepted'  // locked; production enabled
  | 'producing'
  | 'done'
  | 'error';

export interface ProjectDoc {
  id: string;
  title: string;
  status: ProjectStatus;
  input: ProjectInput;
  briefing?: Briefing;
  /** Live progress line for the UI while pipelines run */
  progress?: { step: string; message: string; pct?: number };
  error?: string;
  finalVideoPath?: string;
  finalAssembly?: { status: GenStatus; error?: string; completedAt?: number };
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Callable function payloads
// ---------------------------------------------------------------------------

export interface AnalyzeSubjectsRequest { projectId: string; }
export interface PlanBriefingRequest { projectId: string; }
export interface GenerateAnglesRequest { projectId: string; subjectId: string; }
export interface GenerateAngleImageRequest { projectId: string; subjectId: string; angleId: string; }
export interface GenerateEnvironmentRequest { projectId: string; envId: string; }
export interface GenerateSceneRequest { projectId: string; sceneId: string; }
export interface ExtendSceneRequest { projectId: string; sceneId: string; extraSeconds: number; prompt?: string; }
export interface AssembleFinalRequest { projectId: string; }
export interface GenerateVoiceSampleRequest { projectId: string; subjectId: string; }

export interface PipelineStepResult {
  ok: boolean;
  message?: string;
}

// ---------------------------------------------------------------------------
// Angle-set definitions (single source of truth used by director & UI)
// ---------------------------------------------------------------------------

export interface AngleTemplate {
  id: string;
  label: string;
  framing: 'full_body' | 'close_up' | 'product_view';
  isMaster?: boolean;
  /** Precise angle wording that Seedance/image models respond to */
  angleWording: string;
}

export const CHARACTER_ANGLES_FULL: AngleTemplate[] = [
  { id: 'fb_front', label: 'Full body — front (master)', framing: 'full_body', isMaster: true, angleWording: 'standing straight and facing the camera in a relaxed pose with their arms hanging at their sides' },
  { id: 'fb_34_left', label: 'Full body — three-quarter left', framing: 'full_body', angleWording: 'rotated 45 degrees to their left so both the front and one side of the body are visible, head turned to face the lens' },
  { id: 'fb_side_left', label: 'Full body — side profile left', framing: 'full_body', angleWording: 'turned 90 degrees so their left side faces the camera in a direct profile, looking straight ahead and not at the lens' },
  { id: 'fb_rear34_left', label: 'Full body — rear three-quarter left', framing: 'full_body', angleWording: 'rotated 135 degrees so they are mostly facing away, one shoulder and the edge of the jaw visible, not looking at the lens' },
  { id: 'fb_back', label: 'Full body — back', framing: 'full_body', angleWording: 'seen from directly behind, their face is not visible at all' },
  { id: 'fb_rear34_right', label: 'Full body — rear three-quarter right', framing: 'full_body', angleWording: 'rotated 225 degrees so they are mostly facing away to the right, one shoulder and the edge of the jaw visible, not looking at the lens' },
  { id: 'fb_side_right', label: 'Full body — side profile right', framing: 'full_body', angleWording: 'turned 270 degrees so their right side faces the camera in a direct profile, looking straight ahead and not at the lens' },
  { id: 'fb_34_right', label: 'Full body — three-quarter right', framing: 'full_body', angleWording: 'rotated 315 degrees so both the front and their right side are visible, head turned to face the lens' },
  { id: 'cu_front', label: 'Face — front', framing: 'close_up', angleWording: 'a head and shoulders portrait facing the camera directly, the entire head fully inside the frame, camera at eye level' },
  { id: 'cu_34', label: 'Face — three-quarter', framing: 'close_up', angleWording: 'a head and shoulders portrait rotated 45 degrees, both eyes visible, the entire head fully inside the frame, camera at eye level' },
  { id: 'cu_side', label: 'Face — side profile', framing: 'close_up', angleWording: 'a head and shoulders portrait in direct profile, looking straight ahead and not at the lens, the entire head fully inside the frame' },
  { id: 'cu_back', label: 'Head — back', framing: 'close_up', angleWording: 'the back of the head facing the camera at eye level, showing the crown, the taper down the neck and around the ears' },
];

/** Fast set (default): 4 full-body + 4 close-ups — covers most scenes */
export const CHARACTER_ANGLES_FAST: AngleTemplate[] = CHARACTER_ANGLES_FULL.filter((a) =>
  ['fb_front', 'fb_34_left', 'fb_side_left', 'fb_back', 'cu_front', 'cu_34', 'cu_side', 'cu_back'].includes(a.id),
);

/** Minimal set: 4 full-body only — for quick tests */
export const CHARACTER_ANGLES_MINIMAL: AngleTemplate[] = CHARACTER_ANGLES_FULL.filter((a) =>
  ['fb_front', 'fb_34_left', 'fb_side_left', 'fb_back'].includes(a.id),
);

export const PRODUCT_ANGLE_SETS: Record<ProductType, AngleTemplate[]> = {
  footwear: [
    { id: 'p_side', label: 'Side profile (master)', framing: 'product_view', isMaster: true, angleWording: 'shown in a direct side profile with no perspective distortion' },
    { id: 'p_34_front', label: 'Three-quarter front', framing: 'product_view', angleWording: 'shown in a three-quarter front view' },
    { id: 'p_top', label: 'Top down', framing: 'product_view', angleWording: 'shown directly from above, top down' },
    { id: 'p_underside', label: 'Underside / sole', framing: 'product_view', angleWording: 'shown directly from below, the entire underside visible' },
    { id: 'p_front', label: 'Front', framing: 'product_view', angleWording: 'shown in a direct front view' },
    { id: 'p_back', label: 'Back', framing: 'product_view', angleWording: 'shown in a direct rear view' },
  ],
  garment: [
    { id: 'p_front', label: 'Flat front (master)', framing: 'product_view', isMaster: true, angleWording: 'shown in a flat direct front view with no perspective distortion' },
    { id: 'p_back', label: 'Back', framing: 'product_view', angleWording: 'shown in a direct rear view' },
    { id: 'p_side', label: 'Side', framing: 'product_view', angleWording: 'shown in a direct side profile' },
    { id: 'p_detail', label: 'Detail — closures/hardware', framing: 'product_view', angleWording: 'a close-up detail shot of the closures and hardware' },
  ],
  handheld_prop: [
    { id: 'p_front', label: 'Front (master)', framing: 'product_view', isMaster: true, angleWording: 'shown in a direct front view with no perspective distortion' },
    { id: 'p_back', label: 'Back', framing: 'product_view', angleWording: 'shown in a direct rear view' },
    { id: 'p_side', label: 'Side', framing: 'product_view', angleWording: 'shown in a direct side profile' },
    { id: 'p_top', label: 'Top down', framing: 'product_view', angleWording: 'shown in a true top-down view — the camera points straight down from directly overhead while the object stands upright, so only the top surface and upper edges are visible, strongly foreshortened; not a three-quarter view' },
  ],
  furniture_or_large_object: [
    { id: 'p_front', label: 'Front (master)', framing: 'product_view', isMaster: true, angleWording: 'shown in a direct front view with no perspective distortion' },
    { id: 'p_34', label: 'Three-quarter', framing: 'product_view', angleWording: 'shown in a three-quarter view' },
    { id: 'p_side', label: 'Side', framing: 'product_view', angleWording: 'shown in a direct side profile' },
    { id: 'p_back', label: 'Back', framing: 'product_view', angleWording: 'shown in a direct rear view' },
    { id: 'p_top', label: 'Top down', framing: 'product_view', angleWording: 'shown directly from above, top down' },
  ],
  vehicle: [
    { id: 'p_side', label: 'Side (master)', framing: 'product_view', isMaster: true, angleWording: 'shown in a direct side profile with no perspective distortion' },
    { id: 'p_front', label: 'Front', framing: 'product_view', angleWording: 'shown in a direct front view' },
    { id: 'p_34_front', label: 'Three-quarter front', framing: 'product_view', angleWording: 'shown in a three-quarter front view at 45 degrees' },
    { id: 'p_34_rear', label: 'Three-quarter rear', framing: 'product_view', angleWording: 'shown in a three-quarter rear view at 135 degrees' },
    { id: 'p_back', label: 'Back', framing: 'product_view', angleWording: 'shown in a direct rear view' },
    { id: 'p_top', label: 'Top down', framing: 'product_view', angleWording: 'shown directly from above, top down' },
  ],
  other: [
    { id: 'p_front', label: 'Front (master)', framing: 'product_view', isMaster: true, angleWording: 'shown in a direct front view with no perspective distortion' },
    { id: 'p_34', label: 'Three-quarter', framing: 'product_view', angleWording: 'shown in a three-quarter view' },
    { id: 'p_side', label: 'Side', framing: 'product_view', angleWording: 'shown in a direct side profile' },
    { id: 'p_back', label: 'Back', framing: 'product_view', angleWording: 'shown in a direct rear view' },
  ],
};

export function anglesForSubject(kind: SubjectKind, angleSet: AngleSetId, productType?: ProductType): AngleTemplate[] {
  if (kind === 'product') {
    return PRODUCT_ANGLE_SETS[productType ?? 'other'];
  }
  switch (angleSet) {
    case 'minimal': return CHARACTER_ANGLES_MINIMAL;
    case 'full': return CHARACTER_ANGLES_FULL;
    default: return CHARACTER_ANGLES_FAST;
  }
}

// ---------------------------------------------------------------------------
// Storage path helpers (mirrored by storage.rules)
// ---------------------------------------------------------------------------

export const storagePaths = {
  upload: (uid: string, projectId: string, subjectId: string, fileName: string) =>
    `users/${uid}/projects/${projectId}/uploads/${subjectId}/${fileName}`,
  angle: (uid: string, projectId: string, subjectId: string, angleId: string) =>
    `users/${uid}/projects/${projectId}/angles/${subjectId}/${angleId}.png`,
  environment: (uid: string, projectId: string, envId: string) =>
    `users/${uid}/projects/${projectId}/environments/${envId}.png`,
  sceneVideo: (uid: string, projectId: string, sceneId: string, version: number) =>
    `users/${uid}/projects/${projectId}/scenes/${sceneId}/v${version}.mp4`,
  bridgeFrame: (uid: string, projectId: string, sceneId: string) =>
    `users/${uid}/projects/${projectId}/scenes/${sceneId}/bridge_in.png`,
  voiceSample: (uid: string, projectId: string, subjectId: string) =>
    `users/${uid}/projects/${projectId}/audio/${subjectId}_voice_sample.mp3`,
  finalVideo: (uid: string, projectId: string, version: number) =>
    `users/${uid}/projects/${projectId}/final/final_v${version}.mp4`,
};

// Firestore collection helpers
export const collections = {
  projects: (uid: string) => `users/${uid}/projects`,
  project: (uid: string, projectId: string) => `users/${uid}/projects/${projectId}`,
  subjects: (uid: string, projectId: string) => `users/${uid}/projects/${projectId}/subjects`,
  environments: (uid: string, projectId: string) => `users/${uid}/projects/${projectId}/environments`,
  scenes: (uid: string, projectId: string) => `users/${uid}/projects/${projectId}/scenes`,
};
