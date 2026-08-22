import { Routes, Route, Link } from 'react-router-dom';
import { useUser } from './lib/hooks';
import Dashboard from './pages/Dashboard';
import NewProject from './pages/NewProject';
import ProjectPage from './pages/ProjectPage';

export default function App() {
  const { uid, error } = useUser();
  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="card max-w-lg p-6">
          <h1 className="text-lg font-semibold text-red-400">Sign-in failed</h1>
          <p className="mt-2 text-sm text-zinc-400">{error}</p>
          <p className="mt-2 text-sm text-zinc-500">
            Enable <span className="font-mono">Anonymous</span> auth in the Firebase console
            (Authentication → Sign-in method), then reload.
          </p>
        </div>
      </div>
    );
  }
  if (!uid) {
    return <div className="flex h-full items-center justify-center text-zinc-500">Connecting…</div>;
  }
  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-20 border-b border-zinc-800 bg-zinc-950/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3">
          <Link to="/" className="flex items-center gap-2 text-zinc-100">
            <span className="text-xl">🎬</span>
            <span className="font-semibold tracking-tight">AI Video Studio</span>
          </Link>
          <span className="text-xs text-zinc-600">Seedance 2.5 · Higgsfield · Firebase</span>
          <div className="ml-auto" />
          <Link to="/new" className="btn btn-primary">New project</Link>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">
        <Routes>
          <Route path="/" element={<Dashboard uid={uid} />} />
          <Route path="/new" element={<NewProject />} />
          <Route path="/p/:projectId/*" element={<ProjectPage uid={uid} />} />
        </Routes>
      </main>
    </div>
  );
}
