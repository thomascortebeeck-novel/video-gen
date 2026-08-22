import { useMemo, useState } from 'react';
import { patchDoc } from '../lib/api';
import { Field, StatusChip } from '../components/ui';
import type { ProjectDoc, SubjectDoc, SceneDoc, EnvironmentDoc, SceneStage, StitchMode } from '@shared/types';
import { collections } from '@shared/types';
import { buildScenePrompt, resolveReferenceTags } from '@shared/assemble';

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
        <span className="text-sm font-semibold text-zinc-500">#{scene.index + 1}</span>
        <span className="font-medium text-zinc-100">{scene.title}</span>
        <span className="chip bg-zinc-800 text-zinc-400">{scene.durationSec}s</span>
        <span className="chip bg-zinc-800 text-amber-300">{scene.stitching.mode.replace('_', ' ')}</span>
        <span className="chip bg-zinc-800 text-zinc-400">{scene.mode === 'stages' ? `${scene.stages.length} stages` : 'one take'}</span>
        <StatusChip status={scene.generation.status} />
        <span className="ml-auto text-zinc-500">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div className="border-t border-zinc-800 p-4">
          <p className="mb-3 text-sm text-zinc-400">{scene.beatSummary}</p>
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
                  <div key={i} className="rounded-lg border border-zinc-800 p-3">
                    <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
                      <span className="font-semibold text-zinc-500">STAGE {st.index}</span>
                      <input type="number" className="input w-16 px-2 py-1" value={st.t0} onChange={(e) => saveStage(i, { t0: Number(e.target.value) })} />
                      <span className="text-zinc-600">→</span>
                      <input type="number" className="input w-16 px-2 py-1" value={st.t1} onChange={(e) => saveStage(i, { t1: Number(e.target.value) })} />
                      <span className="text-zinc-600">s</span>
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

          {/* References */}
          <div className="mt-4">
            <label className="label">Reference material ({scene.references.length})</label>
            <div className="space-y-1 text-xs">
              {scene.references.map((r, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2 rounded border border-zinc-800/70 px-2 py-1.5">
                  <span className="chip bg-zinc-800 text-zinc-400">{r.kind.replace('_', ' ')}</span>
                  <span className="text-zinc-300">{r.use}</span>
                  {r.ignore && <span className="text-zinc-600">· {r.ignore}</span>}
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
                <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-lg border border-zinc-800 bg-zinc-950 p-3 font-mono text-[11px] leading-relaxed text-zinc-300">
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
