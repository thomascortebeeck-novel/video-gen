import { Link } from 'react-router-dom';
import { useProjects } from '../lib/hooks';
import { StatusChip } from '../components/ui';
import type { ProjectStatus } from '@shared/types';

const statusLabel: Record<ProjectStatus, { label: string; kind: 'idle' | 'queued' | 'generating' | 'completed' | 'failed' }> = {
  draft: { label: 'Draft', kind: 'idle' },
  analyzing: { label: 'Analyzing subjects', kind: 'generating' },
  briefing_generating: { label: 'Director working', kind: 'generating' },
  briefing_ready: { label: 'Briefing ready', kind: 'queued' },
  briefing_accepted: { label: 'Briefing accepted', kind: 'queued' },
  producing: { label: 'Producing', kind: 'generating' },
  done: { label: 'Done', kind: 'completed' },
  error: { label: 'Error', kind: 'failed' },
};

export default function Dashboard({ uid }: { uid: string }) {
  const projects = useProjects(uid);
  return (
    <div>
      <h1 className="mb-4 text-xl font-semibold text-zinc-100">Projects</h1>
      {projects === null && <p className="text-zinc-500">Loading…</p>}
      {projects?.length === 0 && (
        <div className="card p-8 text-center">
          <p className="text-3xl">🎬</p>
          <p className="mt-2 text-zinc-300">No projects yet.</p>
          <p className="mt-1 text-sm text-zinc-500">
            Upload photos of a person or product, describe the video, and the AI director does the rest.
          </p>
          <Link to="/new" className="btn btn-primary mt-4">Create your first project</Link>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {projects?.slice().reverse().map((p) => {
          const s = statusLabel[p.status] ?? statusLabel.draft;
          return (
            <Link key={p.id} to={`/p/${p.id}`} className="card block p-4 hover:border-zinc-600">
              <div className="flex items-start justify-between gap-2">
                <h2 className="font-medium text-zinc-100">{p.title}</h2>
                <StatusChip status={s.kind === 'idle' ? 'idle' : s.kind} label={s.label} />
              </div>
              <p className="mt-1 line-clamp-2 text-sm text-zinc-500">{p.input?.concept}</p>
              <p className="mt-3 text-xs text-zinc-600">
                {p.input?.durationSec}s · {p.input?.aspectRatio} · {p.input?.resolution}
              </p>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
