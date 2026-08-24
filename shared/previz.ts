/**
 * Camera previz — deterministic Blender script generation and prompt wiring.
 *
 * A complex camera move written as prose is a guess, and every guess costs a
 * paid generation. So the director plans the move as GEOMETRY instead: a
 * blocky placeholder set plus a keyframed camera (a `CameraPlan`). This file
 * turns that plan into a Blender Python script — plain code, never
 * model-authored Python, which is both reproducible and avoids executing
 * generated code (Blender's own MCP server ships without guards for exactly
 * that reason).
 *
 * Blender renders the previz locally for FREE. Its frames are then read back
 * into a timed camera map ("0-3s holds, slow push in / 3-7s pans right onto
 * the man") that goes into the scene prompt's [CAMERA AND PERFORMANCE].
 *
 * Cost note — why the map is text and not an attached clip: on ModelArk each
 * attached reference_video adds roughly +1x base tokens, while reference
 * images are token-free (measured: 172.8k -> 346.5k -> 519.3k for base ->
 * +1 video -> +2 videos +1 image). Characters already spend their one
 * reference video on the screen test.
 */
import type {
  CameraPlan, CameraMapEntry, PrevizFeed, SceneDoc, AspectRatio,
} from './types';

/**
 * The prompting guide's default camera behaviour: unless the shot explicitly
 * calls for handheld, whip pans, crash zooms or speed ramps, the camera is
 * always steady and constant-speed. Written into every previz-backed prompt.
 */
export const DEFAULT_CAMERA_BEHAVIOUR =
  'The camera move is smooth and stabilized throughout: no jitter, no acceleration or deceleration — the same constant speed from start to finish — no camera roll, and one single continuous move with no cuts.';

// ---------------------------------------------------------------------------
// Previz render size — small on purpose. This is a camera path, not a picture.
// ---------------------------------------------------------------------------

export function previzDimensions(aspectRatio: AspectRatio): { w: number; h: number } {
  const ratios: Record<AspectRatio, [number, number]> = {
    '16:9': [16, 9], '9:16': [9, 16], '1:1': [1, 1],
    '4:3': [4, 3], '3:4': [3, 4], '21:9': [21, 9],
  };
  const [rw, rh] = ratios[aspectRatio] ?? [16, 9];
  const w = 640;
  const h = Math.round((w * rh) / rw / 2) * 2;
  return { w, h };
}

// ---------------------------------------------------------------------------
// The Blender script
// ---------------------------------------------------------------------------

/**
 * Fixed Python template. Only the JSON plan, the resolution and the default
 * output path are substituted, so every script is the same reviewable code
 * and a broken plan can never produce broken Python.
 */
const PY_TEMPLATE = `# Auto-generated camera previz — AI Video Studio
# Scene: __TITLE__
# Move:  __INTENT__
#
#   blender -b -P __FILENAME__                 # renders next to this script
#   blender -b -P __FILENAME__ -- /path/out.mp4
#
# Nothing here is art. The blocks are stand-ins so the CAMERA can be judged
# before a single credit is spent. Edit PLAN below and re-run to iterate.
import bpy, json, math, os, sys

PLAN = json.loads(r'''__PLAN_JSON__''')

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "__OUT_NAME__")
_argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
if _argv:
    OUT = _argv[0]

FPS = int(PLAN["fps"])
DUR = float(PLAN["durationSec"])
RES_X, RES_Y = __RES_X__, __RES_Y__


def frame_at(t):
    """Seconds -> Blender frame. t=0 is frame 1."""
    return max(1, int(round(float(t) * FPS)) + 1)


# --- empty scene ------------------------------------------------------------
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.fps = FPS
scene.frame_start = 1
# frames 1..DUR*FPS is exactly DUR seconds — frame_at(DUR) would be one frame
# long, and the previz must match the scene duration to the frame.
scene.frame_end = max(1, int(round(DUR * FPS)))
scene.render.resolution_x = RES_X
scene.render.resolution_y = RES_Y
scene.render.resolution_percentage = 100

# --- Workbench: flat, fast, needs no lighting rig ---------------------------
scene.render.engine = 'BLENDER_WORKBENCH'
shading = scene.display.shading
shading.light = 'STUDIO'
shading.color_type = 'OBJECT'
shading.show_cavity = True
shading.show_object_outline = True
try:
    scene.display.render_aa = '8'
except Exception:
    pass
scene.world = bpy.data.worlds.new("previz")
scene.world.color = (0.05, 0.05, 0.06)

# Neutral greys only — a previz must never look like a style reference.
COLOUR = {
    'plane':    (0.24, 0.24, 0.26, 1.0),
    'box':      (0.45, 0.45, 0.48, 1.0),
    'cylinder': (0.38, 0.38, 0.41, 1.0),
    'figure':   (0.85, 0.83, 0.80, 1.0),
}


def _place(obj, name, pos, rot_z, kind):
    obj.name = name
    obj.location = (pos[0], pos[1], pos[2])
    obj.rotation_euler = (0.0, 0.0, math.radians(float(rot_z or 0.0)))
    obj.color = COLOUR.get(kind, COLOUR['box'])
    return obj


def add_block(item):
    kind = item.get("kind", "box")
    name = "%s_%s" % (kind, item.get("id", "x"))
    pos = item.get("pos", [0, 0, 0])
    size = item.get("size", [1, 1, 1])
    rot_z = item.get("rotZdeg", 0)

    if kind == 'plane':
        bpy.ops.mesh.primitive_plane_add(size=1.0, location=(0, 0, 0))
        obj = bpy.context.object
        obj.scale = (max(size[0], 0.01), max(size[1], 0.01), 1.0)
        return _place(obj, name, pos, rot_z, kind)

    if kind == 'cylinder':
        bpy.ops.mesh.primitive_cylinder_add(radius=0.5, depth=1.0, location=(0, 0, 0))
        obj = bpy.context.object
        obj.scale = (max(size[0], 0.01), max(size[1], 0.01), max(size[2], 0.01))
        return _place(obj, name, pos, rot_z, kind)

    if kind == 'figure':
        # A blocky stand-in person: legs, torso, head. Its only job is to put
        # a correct eyeline and volume where a real performer will be.
        h = max(size[2], 0.2)
        w = max(size[0], 0.15)
        d = max(size[1], 0.15)
        root = bpy.data.objects.new(name, None)
        root.empty_display_size = 0.15
        scene.collection.objects.link(root)
        # Contiguous segments measured from the top down, so the parts touch
        # instead of leaving the head floating: legs [-0.50h, 0.02h],
        # torso [0.02h, 0.37h], head [0.37h, 0.50h].
        parts = [
            ("legs",  (0.0, 0.0, -h * 0.24),  (w * 0.75, d * 0.75, h * 0.52)),
            ("torso", (0.0, 0.0, h * 0.195),  (w, d, h * 0.35)),
            ("head",  (0.0, 0.0, h * 0.435),  (w * 0.55, d * 0.65, h * 0.13)),
        ]
        for part, offset, scale in parts:
            bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0, 0, 0))
            piece = bpy.context.object
            piece.name = "%s_%s" % (name, part)
            piece.scale = scale
            piece.location = offset
            piece.color = COLOUR['figure']
            piece.parent = root
        # The parts are offset around the root, so pos[2] is the figure's
        # mid-height: a person standing on the floor has pos[2] = size[2] / 2.
        root.location = (pos[0], pos[1], pos[2])
        root.rotation_euler = (0.0, 0.0, math.radians(float(rot_z or 0.0)))
        return root

    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0, 0, 0))
    obj = bpy.context.object
    obj.scale = (max(size[0], 0.01), max(size[1], 0.01), max(size[2], 0.01))
    return _place(obj, name, pos, rot_z, 'box')


for item in PLAN.get("set", []):
    add_block(item)

# --- camera -----------------------------------------------------------------
cam_data = bpy.data.cameras.new("previz_cam")
cam = bpy.data.objects.new("previz_cam", cam_data)
scene.collection.objects.link(cam)
scene.camera = cam

target = bpy.data.objects.new("cam_target", None)
target.empty_display_size = 0.2
scene.collection.objects.link(target)

# Aiming via TRACK_TO keeps the horizon level for free — no camera roll, which
# is what the prompting guide asks for by default.
con = cam.constraints.new(type='TRACK_TO')
con.target = target
con.track_axis = 'TRACK_NEGATIVE_Z'
con.up_axis = 'UP_Y'

keys = sorted(PLAN.get("camera", []), key=lambda k: float(k["t"]))
if not keys:
    raise SystemExit("previz: camera plan has no keyframes")

easing_at = {}
for k in keys:
    f = frame_at(k["t"])
    easing_at[f] = k.get("easing", "linear")
    cam.location = tuple(k["pos"])
    cam.keyframe_insert("location", frame=f)
    target.location = tuple(k["lookAt"])
    target.keyframe_insert("location", frame=f)
    cam_data.lens = float(k.get("focalMm", 35))
    cam_data.keyframe_insert("lens", frame=f)


def all_fcurves(datablock):
    """F-curves for a datablock, across both the legacy and slotted (4.4+)
    action layouts."""
    ad = getattr(datablock, "animation_data", None)
    if not ad or not ad.action:
        return []
    action = ad.action
    curves = list(getattr(action, "fcurves", []) or [])
    if curves:
        return curves
    slot = getattr(ad, "action_slot", None)
    for layer in getattr(action, "layers", []):
        for strip in getattr(layer, "strips", []):
            bag = None
            try:
                bag = strip.channelbag(slot) if slot is not None else None
            except Exception:
                bag = None
            if bag is not None:
                curves.extend(bag.fcurves)
    return curves


# Constant speed by default: LINEAR everywhere except keys marked 'smooth'.
for db in (cam, target, cam_data):
    for fc in all_fcurves(db):
        for kp in fc.keyframe_points:
            f = int(round(kp.co[0]))
            kp.interpolation = 'BEZIER' if easing_at.get(f) == 'smooth' else 'LINEAR'
        fc.update()

# --- output -----------------------------------------------------------------
# Not every Blender build can write video: the macOS 5.x builds ship with
# image formats only (no FFMPEG in the file_format enum). Render a PNG
# sequence and mux it ourselves when that is the case.
def has_video_output():
    # The static RNA enum still advertises FFMPEG on builds that were compiled
    # without it, so the only reliable probe is the assignment itself.
    try:
        scene.render.image_settings.file_format = 'FFMPEG'
        return True
    except Exception:
        return False


def find_ffmpeg():
    import shutil
    found = shutil.which("ffmpeg")
    if found:
        return found
    for candidate in ("/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"):
        if os.path.exists(candidate):
            return candidate
    return None


out_dir = os.path.dirname(os.path.abspath(OUT))
if out_dir:
    os.makedirs(out_dir, exist_ok=True)

print("previz: %d frames (%.2fs @ %dfps) -> %s" % (scene.frame_end, DUR, FPS, OUT))

if has_video_output():
    scene.render.ffmpeg.format = 'MPEG4'
    scene.render.ffmpeg.codec = 'H264'
    scene.render.ffmpeg.constant_rate_factor = 'HIGH'
    scene.render.ffmpeg.ffmpeg_preset = 'GOOD'
    scene.render.use_file_extension = False
    scene.render.filepath = OUT
    bpy.ops.render.render(animation=True)
    print("previz: done -> %s" % OUT)
else:
    import shutil, subprocess, tempfile
    frames_dir = tempfile.mkdtemp(prefix="previz_frames_")
    scene.render.image_settings.file_format = 'PNG'
    scene.render.filepath = os.path.join(frames_dir, "f_")
    bpy.ops.render.render(animation=True)
    pattern = os.path.join(frames_dir, "f_%04d.png")
    ffmpeg = find_ffmpeg()
    if ffmpeg:
        subprocess.run([
            ffmpeg, "-y", "-loglevel", "error",
            "-framerate", str(FPS), "-start_number", str(scene.frame_start),
            "-i", pattern, "-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p", OUT,
        ], check=True)
        shutil.rmtree(frames_dir, ignore_errors=True)
        print("previz: done -> %s" % OUT)
    else:
        print("previz: this Blender build has no video output and ffmpeg was not found.")
        print("previz: the frames are in %s — mux them with:" % frames_dir)
        print('  ffmpeg -framerate %d -start_number %d -i "%s" -c:v libx264 -pix_fmt yuv420p "%s"'
              % (FPS, scene.frame_start, pattern, OUT))
`;

export interface PrevizScriptOpts {
  sceneTitle: string;
  aspectRatio: AspectRatio;
  /** file name the script will be saved as, used in its own usage comment */
  fileName: string;
  /** default output file name, written next to the script */
  outputName: string;
}

/** Render a `CameraPlan` into a runnable Blender script. */
export function buildPrevizScript(plan: CameraPlan, opts: PrevizScriptOpts): string {
  const { w, h } = previzDimensions(opts.aspectRatio);
  // The plan rides along as JSON inside a Python raw string so the script
  // stays readable and hand-editable. Guard the only sequence that could
  // close that string early.
  const json = JSON.stringify(plan, null, 2).replace(/'{3,}/g, "''");
  return PY_TEMPLATE
    .replace(/__TITLE__/g, oneLine(opts.sceneTitle))
    .replace(/__INTENT__/g, oneLine(plan.intent))
    .replace(/__FILENAME__/g, opts.fileName)
    .replace(/__OUT_NAME__/g, opts.outputName)
    .replace(/__RES_X__/g, String(w))
    .replace(/__RES_Y__/g, String(h))
    .replace('__PLAN_JSON__', json);
}

function oneLine(s: string): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

/** The exact command to run a downloaded previz script. */
export function previzCommand(fileName: string): string {
  return `blender -b -P ${fileName}`;
}

// ---------------------------------------------------------------------------
// Prompt wiring
// ---------------------------------------------------------------------------

export function formatCameraMap(map: CameraMapEntry[]): string {
  return map
    .slice()
    .sort((a, b) => a.t0 - b.t0)
    .map((m) => `${fmt(m.t0)}-${fmt(m.t1)}s — ${m.move.trim()}`)
    .join('\n');
}

function fmt(t: number): string {
  return Number.isInteger(t) ? String(t) : t.toFixed(1);
}

/**
 * The [CAMERA AND PERFORMANCE] addition for a previz-backed scene: the
 * measured path, then the default steadiness rules.
 */
export function buildCameraPathBlock(map: CameraMapEntry[]): string {
  return `Camera path — follow this timing exactly:\n${formatCameraMap(map)}\n${DEFAULT_CAMERA_BEHAVIOUR}`;
}

/**
 * Reference line for an attached previz. Written defensively: reference media
 * outweighs style wording for Seedance, so the previz must be named as
 * geometry-and-timing only, in the same breath as the tag.
 */
export function buildPrevizRefLine(feed: PrevizFeed): { use: string; ignore: string } {
  const what = feed === 'attach_video'
    ? 'A camera movement reference ONLY — copy the camera path, framing, speed and timing from this clip exactly.'
    : 'A camera framing reference ONLY — a contact sheet of the planned camera path, one frame per second, read left to right.';
  return {
    use: what,
    ignore:
      'Everything else in it must be ignored: the grey blocks are unrendered placeholders standing in for people and furniture, not set dressing. '
      + 'Do not copy its geometry, materials, colours, lighting, flat shading or empty background, and never treat its look as the visual style.',
  };
}

// ---------------------------------------------------------------------------
// Timing check
// ---------------------------------------------------------------------------

/**
 * A beat only lands if the camera is pointed at it when it happens. Compare
 * each stage's window against the camera map and flag stages that fall
 * outside every window, or that straddle a camera move mid-line.
 */
export function checkStageTiming(scene: SceneDoc, map: CameraMapEntry[]): string[] {
  if (map.length === 0 || scene.mode !== 'stages') return [];
  const warnings: string[] = [];
  const span = map.reduce((acc, m) => Math.max(acc, m.t1), 0);

  if (Math.abs(span - scene.durationSec) > 0.75) {
    warnings.push(
      `The previz runs ${fmt(span)}s but the scene is ${scene.durationSec}s — re-render the previz at the scene's duration so the camera map and the stages share one clock.`,
    );
  }

  for (const st of scene.stages) {
    const overlapping = map.filter((m) => st.t0 < m.t1 && st.t1 > m.t0);
    if (overlapping.length === 0) {
      warnings.push(
        `[STAGE ${st.index} | ${fmt(st.t0)}-${fmt(st.t1)}s | ${st.beatName}] falls outside every camera window — the camera is not pointed at this beat while it happens.`,
      );
      continue;
    }
    if (st.dialogue && overlapping.length > 1) {
      warnings.push(
        `[STAGE ${st.index} | ${st.beatName}] has a spoken line that straddles a camera move (${overlapping.map((m) => `${fmt(m.t0)}-${fmt(m.t1)}s`).join(', ')}) — move the line inside one window or the delivery gets cut across the move.`,
      );
    }
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// Recommendation
// ---------------------------------------------------------------------------

/** Does this project setting allow previz on this scene? */
export function previzAllowed(
  mode: 'off' | 'auto' | 'always' | undefined,
  recommended: boolean | undefined,
): boolean {
  const m = mode ?? 'auto';
  if (m === 'off') return false;
  if (m === 'always') return true;
  return Boolean(recommended);
}
