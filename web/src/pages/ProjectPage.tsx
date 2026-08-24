import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useProject, useSubjects, useScenes, useEnvironments } from '../lib/hooks';
import { patchDoc } from '../lib/api';
import { Spinner, StatusChip } from '../components/ui';
import BriefingView from './BriefingView';
import ProductionView from './ProductionView';
import { collections } from '@shared/types';

const TABS = [
  { id: 'briefing', step: '1', label: 'Briefing & assets' },
  { id: 'production', step: '2', label: 'Production' },
] as const;

export default function ProjectPage({ uid }: { uid: string }) {
  const { projectId = '' } = useParams();
  const project = useProject(uid, projectId);
  const subjects = useSubjects(uid, projectId);
  const scenes = useScenes(uid, projectId);
  const environments = useEnvironments(uid, projectId);
  const [tab, setTab] = useState<'briefing' | 'production'>('briefing');

  useEffect(() => {
    if (project?.status === 'producing' || project?.status === 'done') {
      setTab((t) => (t === 'briefing' ? 'production' : t));
    }
  }, [project?.status]);

  if (!project) {
    return <div className="flex items-center gap-2 text-sm text-muted"><Spinner /> Loading project…</div>;
  }

  const busy = project.status === 'analyzing' || project.status === 'briefing_generating';
  const productionUnlocked = ['briefing_accepted', 'producing', 'done'].includes(project.status);

  return (
    <div>
      <Link to="/" className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted hover:text-ink">
        ← All projects
      </Link>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold tracking-tight text-ink">{project.title}</h1>
        <StatusChip
          status={project.status === 'error' ? 'failed' : busy ? 'generating' : project.status === 'done' ? 'completed' : 'queued'}
          label={project.status.replace(/_/g, ' ')}
        />
      </div>
      {project.briefing?.meta.logline && (
        <p className="mt-2 max-w-[76ch] text-sm leading-relaxed text-muted">{project.briefing.meta.logline}</p>
      )}
      <div className="mt-3 flex flex-wrap gap-1.5">
        <span className="chip chip-mono">{project.input?.durationSec}s</span>
        <span className="chip chip-mono">{project.input?.aspectRatio}</span>
        <span className="chip chip-mono">{project.input?.resolution}</span>
        <span className="chip chip-mono">{scenes?.length ?? 0} scenes</span>
        <span className="chip chip-mono">{subjects?.length ?? 0} cast</span>
      </div>

      {busy && project.progress && (
        <div className="card mt-6 flex items-center gap-3 border-accent/40 p-3.5 text-sm text-ink-2">
          <span className="text-accent"><Spinner /></span>
          <span>{project.progress.message}</span>
          {project.progress.pct !== undefined && (
            <span className="ml-auto font-mono text-xs tnum text-accent">{project.progress.pct}%</span>
          )}
        </div>
      )}
      {project.status === 'error' && (
        <div className="card mt-6 flex flex-wrap items-center gap-3 border-bad/35 p-3.5 text-sm text-bad">
          <span className="flex-1">{project.error}</span>
          <button className="btn btn-ghost btn-sm"
            onClick={() => { void patchDoc(collections.project(uid, projectId), { status: 'draft', error: '' }); }}>
            Dismiss
          </button>
        </div>
      )}

      <div className="mt-8 mb-9 flex gap-1 rounded-xl border border-line bg-surface p-1">
        {TABS.map((t) => {
          const locked = t.id === 'production' && !productionUnlocked;
          const active = tab === t.id;
          return (
            <button key={t.id} type="button" disabled={locked}
              title={locked ? 'Accept the briefing first' : undefined}
              className={`flex flex-1 items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                active ? 'bg-surface-2 text-ink' : 'text-muted hover:text-ink'
              } ${locked ? 'cursor-not-allowed opacity-40 hover:text-muted' : ''}`}
              onClick={() => (locked ? undefined : setTab(t.id))}>
              <span className={`font-mono text-[10px] ${active ? 'text-accent' : ''}`}>{t.step}</span>
              {t.label}
              {locked && <span aria-hidden="true" className="text-[11px]">🔒</span>}
            </button>
          );
        })}
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
