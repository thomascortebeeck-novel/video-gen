import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useProject, useSubjects, useScenes, useEnvironments } from '../lib/hooks';
import { api, patchDoc } from '../lib/api';
import { Spinner, StatusChip } from '../components/ui';
import BriefingView from './BriefingView';
import ProductionView from './ProductionView';
import { collections } from '@shared/types';

export default function ProjectPage({ uid }: { uid: string }) {
  const { projectId = '' } = useParams();
  const project = useProject(uid, projectId);
  const subjects = useSubjects(uid, projectId);
  const scenes = useScenes(uid, projectId);
  const environments = useEnvironments(uid, projectId);
  const [tab, setTab] = useState<'briefing' | 'production'>('briefing');
  const [engine, setEngine] = useState<{ label: string; mock: boolean } | null>(null);

  useEffect(() => {
    api.getEngineInfo().then((r) => setEngine({ label: r.engine.label, mock: r.mock })).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (project?.status === 'briefing_accepted' || project?.status === 'producing' || project?.status === 'done') {
      setTab((t) => (t === 'briefing' && (project.status === 'producing' || project.status === 'done') ? 'production' : t));
    }
  }, [project?.status]);

  if (!project) return <div className="flex items-center gap-2 text-zinc-500"><Spinner /> Loading project…</div>;

  const busy = project.status === 'analyzing' || project.status === 'briefing_generating';
  const productionUnlocked = ['briefing_accepted', 'producing', 'done'].includes(project.status);

  return (
    <div>
      <div className="mb-1 flex items-center gap-3 text-sm text-zinc-500">
        <Link to="/" className="hover:text-zinc-300">← Projects</Link>
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold text-zinc-100">{project.title}</h1>
        <StatusChip
          status={project.status === 'error' ? 'failed' : busy ? 'generating' : project.status === 'done' ? 'completed' : 'queued'}
          label={project.status.replace(/_/g, ' ')}
        />
        {engine && (
          <span className="chip bg-zinc-800 text-zinc-400" title="Active video engine">
            {engine.mock ? '🧪 Mock mode (no API keys)' : `⚙ ${engine.label}`}
          </span>
        )}
      </div>

      {busy && project.progress && (
        <div className="card mb-4 flex items-center gap-3 border-amber-900/50 p-3 text-sm text-amber-200">
          <Spinner />
          <span>{project.progress.message}</span>
          {project.progress.pct !== undefined && <span className="text-amber-400">{project.progress.pct}%</span>}
        </div>
      )}
      {project.status === 'error' && (
        <div className="card mb-4 border-red-900 p-3 text-sm text-red-300">
          {project.error}
          <button className="btn btn-ghost ml-3"
            onClick={() => { void patchDoc(collections.project(uid, projectId), { status: 'draft', error: '' }); }}>
            Dismiss
          </button>
        </div>
      )}

      <div className="mb-6 flex gap-1 border-b border-zinc-800">
        {(['briefing', 'production'] as const).map((t) => (
          <button key={t}
            className={`px-4 py-2 text-sm font-medium ${tab === t ? 'border-b-2 border-amber-500 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'} ${t === 'production' && !productionUnlocked ? 'opacity-40' : ''}`}
            onClick={() => (t === 'production' && !productionUnlocked ? undefined : setTab(t))}>
            {t === 'briefing' ? '1 · Briefing & assets' : '2 · Production'}
          </button>
        ))}
      </div>

      {tab === 'briefing' && (
        <BriefingView uid={uid} project={project} subjects={subjects ?? []} scenes={scenes ?? []} environments={environments ?? []} />
      )}
      {tab === 'production' && productionUnlocked && (
        <ProductionView uid={uid} project={project} subjects={subjects ?? []} scenes={scenes ?? []} environments={environments ?? []} />
      )}
    </div>
  );
}
