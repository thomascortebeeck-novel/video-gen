import { useState } from 'react';
import { api } from '../lib/api';
import { Section, Spinner, StatusChip, StorageImg, StorageVideo, ErrorNote } from '../components/ui';
import { useStorageUrl } from '../lib/hooks';
import type { ProjectDoc, SubjectDoc, SceneDoc, EnvironmentDoc } from '@shared/types';

interface Props {
  uid: string; project: ProjectDoc; subjects: SubjectDoc[];
  scenes: SceneDoc[]; environments: EnvironmentDoc[];
}

export default function ProductionView({ project, scenes }: Props) {
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [batchRunning, setBatchRunning] = useState(false);
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
                <div className="mt-3 flex flex-wrap items-start gap-4">
                  {scene.stitching.bridgeFramePath && (
                    <div className="w-40">
                      <p className="label">Start frame</p>
                      <StorageImg path={scene.stitching.bridgeFramePath} alt="start frame" className="w-full rounded-lg" />
                    </div>
                  )}
                  {scene.videoPath && (
                    <div className="min-w-64 flex-1">
                      <StorageVideo path={scene.videoPath} className="max-h-80 w-full rounded-lg" />
                      {(scene.versions?.length ?? 0) > 1 && (
                        <p className="mt-1 text-[11px] text-zinc-600">{scene.versions!.length} takes generated — latest shown</p>
                      )}
                    </div>
                  )}
                </div>
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
