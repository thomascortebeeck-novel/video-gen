import { useEffect, useState } from 'react';
import { Routes, Route, Link } from 'react-router-dom';
import { useUser } from './lib/hooks';
import { api } from './lib/api';
import { ErrorNote, Spinner, ThemeToggle, Wordmark } from './components/ui';
import Dashboard from './pages/Dashboard';
import NewProject from './pages/NewProject';
import ProjectPage from './pages/ProjectPage';

/** Which engine the deployment is actually running on — global, so it lives in the bar. */
function EngineBadge() {
  const [engine, setEngine] = useState<{ label: string; mock: boolean } | null>(null);
  useEffect(() => {
    api.getEngineInfo()
      .then((r) => setEngine({ label: r.engine.label, mock: r.mock }))
      .catch(() => undefined);
  }, []);
  if (!engine) return null;
  return (
    <span className={`chip ${engine.mock ? 'chip-accent' : 'chip-mono'}`}
      title={engine.mock ? 'No API keys configured — generations return placeholders' : 'Active video engine'}>
      <span className={`h-1.5 w-1.5 rounded-full ${engine.mock ? 'bg-accent' : 'bg-ok'}`} />
      {engine.mock ? 'Mock mode' : engine.label}
    </span>
  );
}

export default function App() {
  const { uid, error } = useUser();

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="card max-w-lg p-6">
          <h1 className="text-lg font-semibold text-bad">Sign-in failed</h1>
          <ErrorNote error={error} />
          <p className="mt-3 text-sm text-muted">
            Enable <span className="font-mono text-ink-2">Anonymous</span> auth in the Firebase console
            (Authentication → Sign-in method), then reload.
          </p>
        </div>
      </div>
    );
  }

  if (!uid) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted">
        <Spinner /> Connecting…
      </div>
    );
  }

  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-30 border-b border-line bg-ground/85 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-5 py-3">
          <Link to="/" className="shrink-0" aria-label="Studio — all projects"><Wordmark /></Link>
          <div className="ml-auto flex items-center gap-2.5">
            <span className="hidden sm:inline-flex"><EngineBadge /></span>
            <ThemeToggle />
            <Link to="/new" className="btn btn-primary btn-sm">New project</Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-5 py-9">
        <Routes>
          <Route path="/" element={<Dashboard uid={uid} />} />
          <Route path="/new" element={<NewProject />} />
          <Route path="/p/:projectId/*" element={<ProjectPage uid={uid} />} />
        </Routes>
      </main>
    </div>
  );
}
