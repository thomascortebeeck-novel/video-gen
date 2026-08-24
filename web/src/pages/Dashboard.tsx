import { Link } from 'react-router-dom';
import { useProjects } from '../lib/hooks';
import { Logo, StatusChip } from '../components/ui';
import type { GenStatus, ProjectStatus } from '@shared/types';

const statusLabel: Record<ProjectStatus, { label: string; kind: GenStatus }> = {
  draft: { label: 'Draft', kind: 'idle' },
  analyzing: { label: 'Analysing subjects', kind: 'generating' },
  briefing_generating: { label: 'Director working', kind: 'generating' },
  briefing_ready: { label: 'Briefing ready', kind: 'queued' },
  briefing_accepted: { label: 'Briefing accepted', kind: 'queued' },
  producing: { label: 'Producing', kind: 'generating' },
  done: { label: 'Done', kind: 'completed' },
  error: { label: 'Error', kind: 'failed' },
};

export default function Dashboard({ uid }: { uid: string }) {
  const projects = useProjects(uid);
  const ordered = projects?.slice().reverse() ?? [];

  return (
    <div>
      <div className="mb-8 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between sm:gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink">Projects</h1>
          <p className="mt-1.5 text-sm text-muted">
            Photos and a story form in; a cut film out. Every project keeps its briefing, its
            cast and every take.
          </p>
        </div>
        {projects && projects.length > 0 && (
          <span className="chip chip-mono tnum shrink-0">{projects.length} total</span>
        )}
      </div>

      {projects === null && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="card h-40 animate-pulse opacity-50" />
          ))}
        </div>
      )}

      {projects?.length === 0 && (
        <div className="card flex flex-col items-center px-8 py-14 text-center">
          <Logo className="h-11 w-11" />
          <h2 className="mt-5 text-lg font-semibold text-ink">Nothing shot yet</h2>
          <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted">
            Upload photos of a person or a product, describe what should happen, and the
            director writes the briefing, the cast sheets and every scene prompt for you.
          </p>
          <Link to="/new" className="btn btn-primary mt-6">Start your first project</Link>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {ordered.map((p) => {
          const s = statusLabel[p.status] ?? statusLabel.draft;
          return (
            <Link key={p.id} to={`/p/${p.id}`}
              className="card group flex flex-col p-5 transition-colors hover:border-accent/60">
              <div className="flex items-start justify-between gap-3">
                <h2 className="font-semibold leading-snug text-ink group-hover:text-accent">{p.title}</h2>
                <StatusChip status={s.kind} label={s.label} />
              </div>
              <p className="mt-2 line-clamp-3 text-sm leading-relaxed text-muted">{p.input?.concept}</p>
              <div className="mt-auto flex flex-wrap gap-1.5 pt-4">
                <span className="chip chip-mono">{p.input?.durationSec}s</span>
                <span className="chip chip-mono">{p.input?.aspectRatio}</span>
                <span className="chip chip-mono">{p.input?.resolution}</span>
                {p.finalVideoPath && <span className="chip chip-ok">film assembled</span>}
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
