import { useMemo, useState } from 'react';
import { api, patchDoc, uploadPreviz } from '../lib/api';
import { Field, StatusChip, Spinner, StorageVideo, StorageImg, ErrorNote } from '../components/ui';
import { useStorageUrl } from '../lib/hooks';
import type {
  ProjectDoc, SubjectDoc, SceneDoc, EnvironmentDoc, SceneStage, StitchMode,
  PrevizFeed, Resolution,
} from '@shared/types';
import { collections } from '@shared/types';
import { buildScenePrompt, resolveReferenceTags } from '@shared/assemble';
import { previzCommand, formatCameraMap } from '@shared/previz';

interface Props {
  uid: string; project: ProjectDoc; scene: SceneDoc;
  subjects: SubjectDoc[]; environments: EnvironmentDoc[];
}

export default function SceneEditor({ uid, project, scene, subjects }: Props) {
  const [open, setOpen] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);
  const path = `${collections.scenes(uid, project.id)}/${scene.id}`;
  const save = (patch: Record<string, unknown>) => void patchDoc(path, patch);

  const promptPreview = useMemo(() => {
    try {
      const refs = resolveReferenceTags(scene);
      return buildScenePrompt(scene, subjects, refs);
    } catch (e) {
      return `(prompt preview error: ${String((e as Error).message ?? e)})`;
    }
  }, [scene, subjects]);

  const characterSubjects = subjects.filter((s) => s.kind === 'character');

  const saveStage = (idx: number, patch: Partial<SceneStage>) => {
    const stages = scene.stages.map((st, i) => (i === idx ? { ...st, ...patch } : st));
    save({ stages });
  };

  const stitchOptions: { id: StitchMode; label: string }[] = [
    { id: 'hard_cut', label: 'Hard cut (new setup)' },
    { id: 'frame_bridge', label: 'Frame bridge (last→first frame)' },
    { id: 'extend_prev', label: 'Extend previous clip' },
  ];

  return (
    <div className="card">
      <button className="flex w-full flex-wrap items-center gap-3 p-4 text-left" onClick={() => setOpen((v) => !v)}>
        <span className="text-sm font-semibold text-muted">#{scene.index + 1}</span>
        <span className="font-medium text-ink">{scene.title}</span>
        <span className="chip chip-mono">{scene.durationSec}s</span>
        <span className="chip chip-accent">{scene.stitching.mode.replace('_', ' ')}</span>
        <span className="chip chip-mono">{scene.mode === 'stages' ? `${scene.stages.length} stages` : 'one take'}</span>
        {scene.previz && (
          <span className="chip chip-mono" title={scene.previzReason}>
            previz: {scene.previz.status === 'mapped' ? 'camera locked' : scene.previz.status.replace('_', ' ')}
          </span>
        )}
        <StatusChip status={scene.generation.status} />
        <span className="ml-auto text-muted">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div className="border-t border-line p-4">
          <p className="mb-3 text-sm text-ink-2">{scene.beatSummary}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Title" value={scene.title} onSave={(v) => save({ title: v })} />
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Duration (s)</label>
                <input type="number" className="input" min={2} max={30} value={scene.durationSec}
                  onChange={(e) => save({ durationSec: Number(e.target.value) })} />
              </div>
              <div>
                <label className="label">Joins previous via</label>
                <select className="input" value={scene.stitching.mode} disabled={scene.index === 0}
                  onChange={(e) => save({ stitching: { ...scene.stitching, mode: e.target.value as StitchMode } })}>
                  {stitchOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                </select>
              </div>
            </div>
            <div className="sm:col-span-2">
              <Field label="[GOAL]" rows={2} value={scene.goal} onSave={(v) => save({ goal: v })} />
            </div>
            <div className="sm:col-span-2">
              <Field label="[CONTINUITY]" rows={2} value={scene.continuity} onSave={(v) => save({ continuity: v })} />
            </div>
          </div>

          {/* Stages */}
          {scene.mode === 'stages' ? (
            <div className="mt-4">
              <label className="label">[STAGES] — one primary change each; end states are the continuity fix</label>
              <div className="space-y-2">
                {scene.stages.map((st, i) => (
                  <div key={i} className="well p-3">
                    <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
                      <span className="font-semibold text-muted">STAGE {st.index}</span>
                      <input type="number" className="input w-16 px-2 py-1" value={st.t0} onChange={(e) => saveStage(i, { t0: Number(e.target.value) })} />
                      <span className="text-faint">→</span>
                      <input type="number" className="input w-16 px-2 py-1" value={st.t1} onChange={(e) => saveStage(i, { t1: Number(e.target.value) })} />
                      <span className="text-faint">s</span>
                      <input className="input w-40 px-2 py-1" value={st.beatName} placeholder="beat name"
                        onChange={(e) => saveStage(i, { beatName: e.target.value })} />
                      <select className="input w-28 px-2 py-1" value={st.cut}
                        onChange={(e) => saveStage(i, { cut: e.target.value as 'CUT' | 'NO CUT' })}>
                        <option value="CUT">CUT</option><option value="NO CUT">NO CUT</option>
                      </select>
                      <button className="btn btn-danger ml-auto px-2 py-1 text-[11px]"
                        onClick={() => save({ stages: scene.stages.filter((_, j) => j !== i).map((s2, j) => ({ ...s2, index: j + 1 })) })}>
                        ✕
                      </button>
                    </div>
                    <Field label="Action (physical action & staging only)" rows={2} value={st.action} onSave={(v) => saveStage(i, { action: v })} />
                    <div className="mt-2 grid gap-2 sm:grid-cols-2">
                      <Field label="End state (what is visibly true at the end)" value={st.endState ?? ''} onSave={(v) => saveStage(i, { endState: v })} />
                      <div className="flex items-end gap-2">
                        <div className="w-40">
                          <label className="label">Speaker</label>
                          <select className="input px-2 py-2" value={st.dialogue?.subjectId ?? ''}
                            onChange={(e) => saveStage(i, {
                              dialogue: e.target.value
                                ? { subjectId: e.target.value, line: st.dialogue?.line ?? '' }
                                : undefined,
                            })}>
                            <option value="">— silent —</option>
                            {characterSubjects.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                          </select>
                        </div>
                        {st.dialogue && (
                          <div className="flex-1">
                            <Field label="Line (≤10 words)" value={st.dialogue.line}
                              onSave={(v) => saveStage(i, { dialogue: { ...st.dialogue!, line: v } })} />
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              <button className="btn btn-ghost mt-2"
                onClick={() => {
                  const last = scene.stages[scene.stages.length - 1];
                  const t0 = last ? last.t1 : 0;
                  save({
                    stages: [...scene.stages, {
                      index: scene.stages.length + 1, t0, t1: Math.min(scene.durationSec, t0 + 2),
                      beatName: 'New beat', action: '', cut: 'CUT',
                    }],
                  });
                }}>
                + Add stage
              </button>
            </div>
          ) : (
            <div className="mt-4">
              <Field label="One continuous take — action & dialogue as one paragraph" rows={5}
                value={scene.continuousAction ?? ''} onSave={(v) => save({ continuousAction: v })} />
            </div>
          )}

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Field label="[VISUAL STYLE]" rows={3} value={scene.visualStyle} onSave={(v) => save({ visualStyle: v })} />
            <Field label="[CAMERA AND PERFORMANCE]" rows={3} value={scene.cameraAndPerformance} onSave={(v) => save({ cameraAndPerformance: v })} />
            <Field label="[AUDIO] — (music) <sfx> ambience, subtitles" rows={3} value={scene.audio} onSave={(v) => save({ audio: v })} />
            <Field label="[EXCLUSIONS]" rows={3} value={scene.exclusions} onSave={(v) => save({ exclusions: v })} />
            <div className="sm:col-span-2">
              <Field label="[MAINTAIN CONSISTENCY]" rows={2} value={scene.keepConsistent} onSave={(v) => save({ keepConsistent: v })} />
            </div>
          </div>

          <PrevizPanel uid={uid} project={project} scene={scene} />

          {/* References */}
          <div className="mt-4">
            <label className="label">Reference material ({scene.references.length})</label>
            <div className="space-y-1 text-xs">
              {scene.references.map((r, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2 rounded border border-line px-2 py-1.5">
                  <span className="chip chip-mono">{r.kind.replace('_', ' ')}</span>
                  <span className="text-ink-2">{r.use}</span>
                  {r.ignore && <span className="text-faint">· {r.ignore}</span>}
                </div>
              ))}
            </div>
          </div>

          {/* Prompt preview */}
          <div className="mt-4">
            <button className="btn btn-ghost" onClick={() => setShowPrompt((v) => !v)}>
              {showPrompt ? 'Hide' : 'Show'} assembled Seedance prompt
            </button>
            {showPrompt && (
              <div className="mt-2">
                <pre className="codeblock max-h-96">
                  {scene.promptOverride?.trim() ? scene.promptOverride : promptPreview}
                </pre>
                <Field label="Manual prompt override (leave empty to use the assembled prompt)" rows={4} mono
                  value={scene.promptOverride ?? ''} onSave={(v) => save({ promptOverride: v })} />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}


// ---------------------------------------------------------------------------
// Camera previz
//
// The move is blocked out in Blender before any credits are spent. Rendering
// is local and free, so the camera can be iterated as many times as it takes;
// the measured timing then rides into the prompt as text, which costs nothing
// to send. Attaching the clip itself is the only option that costs money.
// ---------------------------------------------------------------------------

const RES_PIXELS: Record<Resolution, [number, number]> = {
  '480p': [854, 480], '720p': [1280, 720], '1080p': [1920, 1080], '4k': [3840, 2160],
};

/** What one extra reference video adds to a generation: ≈ +1× base tokens. */
function refVideoCost(durationSec: number, resolution: Resolution): string {
  const [w, h] = RES_PIXELS[resolution] ?? RES_PIXELS['720p'];
  const tokens = (w * h * durationSec * 24) / 1024;
  return `$${((tokens / 1_000_000) * 10.7).toFixed(2)}`;
}

function PrevizPanel({ uid, project, scene }: { uid: string; project: ProjectDoc; scene: SceneDoc }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const previz = scene.previz;
  const scriptUrl = useStorageUrl(previz?.scriptPath);
  const path = `${collections.scenes(uid, project.id)}/${scene.id}`;
  const fileName = `previz_${scene.id}.py`;

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setError(null); setBusy(label);
    try { await fn(); } catch (e) { setError(String((e as Error).message ?? e)); }
    setBusy(null);
  };

  // Previz is optional: when the project has it off, the panel disappears.
  if ((project.input.previz ?? 'auto') === 'off') return null;

  // No plan: say why, and how to get one. Most scenes do not need one.
  if (!previz?.plan) {
    return (
      <div className="well mt-4 p-3">
        <p className="eyebrow">Camera previz</p>
        <p className="mt-1 text-xs text-muted">
          {scene.previzReason
            ?? 'No camera plan for this scene — previz is for moves a sentence cannot pin down.'}
        </p>
        <p className="mt-1 text-[11px] text-faint">
          To get one anyway, set Camera previz to “Always” above and regenerate the briefing.
        </p>
      </div>
    );
  }

  const plan = previz.plan;
  const feed: PrevizFeed = previz.feed ?? 'map_only';
  const durationMismatch = Math.abs(plan.durationSec - scene.durationSec) > 0.01;

  return (
    <div className="well mt-4 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="eyebrow">Camera previz</p>
        <span className="chip chip-mono">{plan.camera.length} keyframes</span>
        <span className="chip chip-mono">{plan.set.length} blocks</span>
        {scene.cameraComplexity && <span className="chip chip-accent">{scene.cameraComplexity} move</span>}
        <span className="ml-auto chip chip-mono">{previz.status.replace('_', ' ')}</span>
      </div>
      <p className="mt-2 text-xs text-ink-2">{plan.intent}</p>
      {scene.previzReason && <p className="mt-1 text-[11px] text-faint">Why: {scene.previzReason}</p>}
      {durationMismatch && (
        <p className="mt-2 text-[11px] text-accent">
          The plan is {plan.durationSec}s but the scene is {scene.durationSec}s — rebuilding the script
          re-times it to the scene so the camera map and the stages share one clock.
        </p>
      )}

      {/* 1 — build the script */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button className="btn btn-ghost" disabled={busy !== null}
          onClick={() => void run('script', () => api.buildPrevizScript({ projectId: project.id, sceneId: scene.id }))}>
          {busy === 'script' ? <><Spinner /> Building…</> : previz.scriptPath ? '↻ Rebuild Blender script' : 'Build Blender script'}
        </button>
        {scriptUrl && (
          <a className="btn btn-ghost" href={scriptUrl} download={fileName} target="_blank" rel="noreferrer">
            ⬇ {fileName}
          </a>
        )}
        <span className="text-[11px] text-faint">Rendering is local and free — iterate as much as you like.</span>
      </div>
      {previz.scriptPath && (
        <pre className="codeblock mt-2">{previzCommand(fileName)}</pre>
      )}

      {/* 2 — upload the render */}
      <div className="mt-3">
        <label className="label">Rendered previz (.mp4)</label>
        <input type="file" accept="video/mp4,video/*" className="input" disabled={busy !== null}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void run('upload', () => uploadPreviz(project.id, scene.id, f, previz));
            e.target.value = '';
          }} />
        {busy === 'upload' && <p className="mt-1 text-xs text-muted"><Spinner /> Reading the camera move from the frames…</p>}
      </div>

      {previz.videoPath && (
        <div className="mt-3 flex flex-wrap items-start gap-3">
          <div className="w-64">
            <p className="label">The move</p>
            <StorageVideo path={previz.videoPath} className="w-full rounded-lg" />
          </div>
          {previz.contactSheetPath && (
            <div className="min-w-48 flex-1">
              <p className="label">One frame per second</p>
              <StorageImg path={previz.contactSheetPath} alt="previz contact sheet" className="w-full rounded-lg" />
            </div>
          )}
        </div>
      )}

      {/* 3 — the camera map that goes into the prompt */}
      {previz.cameraMap && previz.cameraMap.length > 0 && (
        <div className="mt-3">
          <p className="label">Camera map — goes into [CAMERA AND PERFORMANCE] verbatim</p>
          <pre className="codeblock">{formatCameraMap(previz.cameraMap)}</pre>
          {previz.riskiestMoment && (
            <p className="mt-2 text-[11px] text-ink-2">
              <span className="text-muted">Riskiest moment:</span> {previz.riskiestMoment}
              {previz.fallbackFix && <> <span className="text-muted">— if it goes wrong:</span> {previz.fallbackFix}</>}
            </p>
          )}
          <button className="btn btn-quiet btn-sm mt-1 text-accent" disabled={busy !== null}
            onClick={() => void run('remap', () => api.ingestPreviz({ projectId: project.id, sceneId: scene.id }))}>
            {busy === 'remap' ? <><Spinner /> Re-reading…</> : '↻ Re-read the camera map'}
          </button>
        </div>
      )}

      {previz.timingWarnings && previz.timingWarnings.length > 0 && (
        <div className="mt-3 rounded-lg border border-accent/40 bg-accent-soft p-2">
          <p className="text-[11px] font-semibold text-accent">Timing — a beat only lands if the camera is on it</p>
          <ul className="mt-1 space-y-1">
            {previz.timingWarnings.map((w, i) => (
              <li key={i} className="text-[11px] leading-snug text-accent">{w}</li>
            ))}
          </ul>
        </div>
      )}

      {/* 4 — how it reaches the model */}
      <div className="mt-3">
        <label className="label">What the model receives</label>
        <select className="input" value={feed} disabled={busy !== null}
          onChange={(e) => void patchDoc(path, { previz: { ...previz, feed: e.target.value as PrevizFeed } })}>
          <option value="map_only">The camera map only — free</option>
          <option value="map_plus_sheet">Camera map + the contact sheet as a reference image — free</option>
          <option value="attach_video">Camera map + the previz clip as a reference video — +{refVideoCost(scene.durationSec, project.input.resolution)}</option>
        </select>
        <p className="mt-1 text-[11px] text-faint">
          {feed === 'map_only'
            ? 'The timing rides inside the prompt as text and costs nothing to send. Start here.'
            : feed === 'map_plus_sheet'
              ? 'Reference images are token-free, but Seedance weights reference media above style wording — watch for the grey blocks bleeding into the look.'
              : `Each attached reference video adds roughly one extra generation's worth of tokens (≈ ${refVideoCost(scene.durationSec, project.input.resolution)} for this ${scene.durationSec}s scene at ${project.input.resolution}), on top of the character screen test.`}
        </p>
      </div>

      <ErrorNote error={error ?? undefined} />
    </div>
  );
}
