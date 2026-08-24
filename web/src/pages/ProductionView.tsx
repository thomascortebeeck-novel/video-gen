import { useState } from 'react';
import { api } from '../lib/api';
import { Section, Spinner, StatusChip, StorageImg, StorageVideo, ErrorNote } from '../components/ui';
import { useStorageUrl } from '../lib/hooks';
import type { ProjectDoc, SubjectDoc, SceneDoc, EnvironmentDoc } from '@shared/types';
import { resolveReferenceTags } from '@shared/assemble';

interface Props {
  uid: string; project: ProjectDoc; subjects: SubjectDoc[];
  scenes: SceneDoc[]; environments: EnvironmentDoc[];
}

export default function ProductionView({ project, subjects, scenes, environments }: Props) {
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [batchRunning, setBatchRunning] = useState(false);
  const [openDetails, setOpenDetails] = useState<Record<string, boolean>>({});
  const [shownTake, setShownTake] = useState<Record<string, string>>({});
  const finalUrl = useStorageUrl(project.finalVideoPath);

  const track = async (key: string, fn: () => Promise<unknown>) => {
    setBusy((b) => ({ ...b, [key]: true }));
    try { await fn(); } catch (e) { console.error(e); alert(String((e as Error).message ?? e)); }
    setBusy((b) => ({ ...b, [key]: false }));
  };

  const remaining = scenes.filter((s) => s.generation.status !== 'completed');
  const allDone = scenes.length > 0 && remaining.length === 0;

  async function generateAllRemaining() {
    setBatchRunning(true);
    try {
      // Sequential: bridged/extended scenes need the previous scene's output.
      for (const s of [...scenes].sort((a, b) => a.index - b.index)) {
        if (s.generation.status === 'completed') continue;
        await api.generateScene({ projectId: project.id, sceneId: s.id });
      }
    } catch (e) {
      console.error(e);
      alert(String((e as Error).message ?? e));
    }
    setBatchRunning(false);
  }

  return (
    <div>
      <Section
        title="Scenes"
        subtitle="Scenes generate in order — frame-bridged and extended scenes consume the previous scene's output. Each clip lands here for review; regenerate any take you don't like."
        right={
          <button className="btn btn-primary" disabled={batchRunning || remaining.length === 0}
            onClick={() => void generateAllRemaining()}>
            {batchRunning ? <><Spinner /> Generating {scenes.length - remaining.length + 1}/{scenes.length}…</> : `Generate all remaining (${remaining.length})`}
          </button>
        }
      >
        <div className="space-y-3">
          {scenes.map((scene) => {
            const prevDone = scene.index === 0 || scenes.find((s) => s.index === scene.index - 1)?.generation.status === 'completed';
            const needsPrev = scene.stitching.mode !== 'hard_cut';
            const blocked = needsPrev && !prevDone;
            return (
              <div key={scene.id} className="card p-4">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-sm font-semibold text-zinc-500">#{scene.index + 1}</span>
                  <h3 className="font-medium text-zinc-100">{scene.title}</h3>
                  <span className="chip bg-zinc-800 text-zinc-400">{scene.durationSec}s</span>
                  <span className="chip bg-zinc-800 text-amber-300" title={scene.stitching.notes}>
                    {scene.stitching.mode.replace('_', ' ')}
                  </span>
                  <StatusChip status={scene.generation.status} />
                  <div className="ml-auto flex gap-2">
                    {(scene.generation.status === 'generating' || scene.generation.status === 'queued') && scene.generation.jobId && (
                      <button className="btn btn-ghost" disabled={busy[`refresh_${scene.id}`]}
                        onClick={() => void track(`refresh_${scene.id}`, () => api.refreshScene({ projectId: project.id, sceneId: scene.id }))}>
                        {busy[`refresh_${scene.id}`] ? <Spinner /> : '↻ Refresh status'}
                      </button>
                    )}
                    <button className="btn btn-primary" disabled={busy[`gen_${scene.id}`] || batchRunning || blocked || scene.generation.status === 'generating'}
                      title={blocked ? 'Generate the previous scene first (this one continues from it)' : undefined}
                      onClick={() => void track(`gen_${scene.id}`, () => api.generateScene({ projectId: project.id, sceneId: scene.id }))}>
                      {busy[`gen_${scene.id}`] ? <><Spinner /> Generating…</> : scene.videoPath ? '↻ Regenerate' : blocked ? 'Waiting for previous' : 'Generate scene'}
                    </button>
                  </div>
                </div>
                <p className="mt-1 text-xs text-zinc-500">{scene.beatSummary}</p>
                <ErrorNote error={scene.generation.status === 'failed' ? scene.generation.error : undefined} />
                {scene.generation.moderationNote && (
                  <p className="mt-2 rounded-lg border border-amber-900/60 bg-amber-950/30 p-2 text-xs text-amber-200/90">
                    {scene.generation.moderationNote}
                  </p>
                )}
                <div className="mt-3 flex flex-wrap items-start gap-4">
                  {scene.stitching.bridgeFramePath && (
                    <div className="w-40">
                      <p className="label">Start frame</p>
                      <StorageImg path={scene.stitching.bridgeFramePath} alt="start frame" className="w-full rounded-lg" />
                    </div>
                  )}
                  {scene.videoPath && (
                    <div className="min-w-64 flex-1">
                      <StorageVideo key={shownTake[scene.id] ?? scene.videoPath}
                        path={shownTake[scene.id] ?? scene.videoPath} className="max-h-80 w-full rounded-lg" />
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        {(scene.versions ?? []).map((v, i) => {
                          const active = (shownTake[scene.id] ?? scene.videoPath) === v.videoPath;
                          const isLatest = v.videoPath === scene.videoPath;
                          return (
                            <button key={v.videoPath} title={v.note ?? undefined}
                              className={`chip ${active ? 'bg-amber-500/20 text-amber-200' : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'}`}
                              onClick={() => setShownTake((s) => ({ ...s, [scene.id]: v.videoPath }))}>
                              Take {i + 1}{isLatest ? ' · active' : ''}
                            </button>
                          );
                        })}
                        <button className="ml-auto text-xs text-amber-400 hover:text-amber-300"
                          onClick={() => setOpenDetails((d) => ({ ...d, [scene.id]: !d[scene.id] }))}>
                          {openDetails[scene.id] ? 'Hide generation details' : 'How was this generated?'}
                        </button>
                      </div>
                      {(scene.versions?.length ?? 0) > 1 && (
                        <p className="mt-1 text-[11px] text-zinc-600">
                          {scene.versions!.length} takes generated — the newest is used in the final film.
                        </p>
                      )}
                    </div>
                  )}
                </div>
                {openDetails[scene.id] && (
                  <GenerationDetails scene={scene} subjects={subjects} environments={environments} />
                )}
              </div>
            );
          })}
        </div>
      </Section>

      <Section title="Final film"
        subtitle="Concatenates all scenes in order: boundary-frame trim on bridged joins, per-clip loudness normalisation, one shared encode.">
        <div className="card p-4">
          <div className="flex flex-wrap items-center gap-3">
            <button className="btn btn-primary" disabled={!allDone || busy['assemble'] || project.finalAssembly?.status === 'generating'}
              title={allDone ? undefined : 'Generate all scenes first'}
              onClick={() => void track('assemble', () => api.assembleFinal({ projectId: project.id }))}>
              {busy['assemble'] || project.finalAssembly?.status === 'generating'
                ? <><Spinner /> Assembling…</>
                : project.finalVideoPath ? '↻ Re-assemble final film' : 'Assemble final film'}
            </button>
            {project.finalAssembly && <StatusChip status={project.finalAssembly.status} />}
            {finalUrl && (
              <a href={finalUrl} download className="btn btn-ghost" target="_blank" rel="noreferrer">⬇ Download MP4</a>
            )}
          </div>
          <ErrorNote error={project.finalAssembly?.status === 'failed' ? project.finalAssembly.error : undefined} />
          {project.finalVideoPath && (
            <div className="mt-4">
              <StorageVideo path={project.finalVideoPath} className="max-h-[70vh] w-full rounded-lg" />
            </div>
          )}
        </div>
      </Section>
    </div>
  );
}

/**
 * "How was this generated?" — the exact inputs behind a take: every reference
 * with its @tag and what the model was told to take from it, the engine
 * parameters, and the assembled prompt.
 */
function GenerationDetails({ scene, subjects, environments }: {
  scene: SceneDoc; subjects: SubjectDoc[]; environments: EnvironmentDoc[];
}) {
  const gen = scene.generation;
  const refs = resolveReferenceTags(scene);
  const assetFor = (r: ReturnType<typeof resolveReferenceTags>[number]) => {
    if (r.kind === 'subject_video') {
      const s = subjects.find((x) => x.id === r.subjectId);
      return { label: `${s?.name ?? r.subjectId} — screen test`, videoPath: s?.screenTest?.videoPath };
    }
    if (r.kind === 'subject_angle') {
      const s = subjects.find((x) => x.id === r.subjectId);
      const a = s?.angles.find((x) => x.id === r.angleId);
      return { label: `${s?.name ?? r.subjectId} — ${a?.label ?? r.angleId}`, imagePath: a?.imagePath };
    }
    if (r.kind === 'subject_upload') {
      const s = subjects.find((x) => x.id === r.subjectId);
      return { label: `${s?.name ?? r.subjectId} — uploaded image`, imagePath: s?.sourceImagePaths?.[0] };
    }
    if (r.kind === 'environment') {
      const e = environments.find((x) => x.id === r.envId);
      return { label: e?.name ?? r.envId ?? 'environment', imagePath: e?.imagePath };
    }
    if (r.kind === 'bridge_frame') {
      return { label: 'Bridge frame (previous scene\'s last frame)', imagePath: scene.stitching.bridgeFramePath };
    }
    return { label: r.kind };
  };

  return (
    <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-950/60 p-4">
      <div className="mb-3 flex flex-wrap gap-2 text-[11px] text-zinc-400">
        <span className="chip bg-zinc-800">{gen.params?.model ?? 'engine n/a'}</span>
        <span className="chip bg-zinc-800">{scene.durationSec}s · {gen.params?.resolution ?? '—'} · {gen.params?.aspectRatio ?? '—'}</span>
        <span className="chip bg-zinc-800">stitch: {scene.stitching.mode.replace('_', ' ')}</span>
        {gen.provider && <span className="chip bg-zinc-800">provider: {gen.provider}</span>}
        {gen.jobId && <span className="chip bg-zinc-800">job: {gen.jobId}</span>}
        {gen.completedAt && <span className="chip bg-zinc-800">{new Date(gen.completedAt).toLocaleString()}</span>}
      </div>

      <p className="label">References — what the model was given, bound to its tag</p>
      {refs.length === 0 ? (
        <p className="text-xs text-zinc-600">No references — generated from the prompt alone.</p>
      ) : (
        <div className="mt-1 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {refs.map((r) => {
            const a = assetFor(r);
            return (
              <div key={r.assignedTag} className="flex gap-2 rounded-lg border border-zinc-800 p-2">
                <div className="w-20 shrink-0">
                  {a.videoPath
                    ? <StorageVideo path={a.videoPath} className="w-full rounded" />
                    : <StorageImg path={a.imagePath} alt={a.label} className="aspect-square w-full rounded object-cover" />}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] font-semibold text-amber-300">{r.assignedTag}</p>
                  <p className="truncate text-[11px] text-zinc-300" title={a.label}>{a.label}</p>
                  <p className="mt-0.5 text-[10px] leading-snug text-zinc-500">{r.use}</p>
                  {r.ignore && <p className="mt-0.5 text-[10px] leading-snug text-zinc-600">Ignore: {r.ignore}</p>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <p className="label mt-4">Assembled prompt — sent to the engine verbatim</p>
      <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-lg bg-zinc-900 p-3 text-[11px] leading-relaxed text-zinc-300">
        {scene.assembledPrompt ?? 'Not stored yet — generate this scene to capture its prompt.'}
      </pre>
    </div>
  );
}
