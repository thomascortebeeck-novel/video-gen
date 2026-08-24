import { ReactNode, useEffect, useRef, useState } from 'react';
import { useStorageUrl } from '../lib/hooks';
import type { GenStatus } from '@shared/types';

export function Spinner({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

/**
 * The mark: a 16:9 gate and a 9:16 gate overlapping. One master, two cuts —
 * which is the whole job of this studio.
 */
export function Logo({ className = 'h-7 w-7' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      {/* offset, not concentric — two frames overlapping, not a plus sign */}
      <rect x="1.5" y="10" width="24" height="13.5" rx="3"
        stroke="currentColor" strokeWidth="2.2" className="text-accent" />
      <rect x="18" y="3" width="12.5" height="26" rx="3"
        stroke="currentColor" strokeWidth="2.2" className="text-cool" />
    </svg>
  );
}

export function Wordmark() {
  return (
    <span className="flex items-center gap-2.5">
      <Logo />
      <span className="flex flex-col leading-none">
        <span className="text-[15px] font-bold tracking-tight text-ink">Studio</span>
        <span className="mt-0.5 font-mono text-[9px] uppercase tracking-[0.16em] text-muted">
          AI film production
        </span>
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

type Theme = 'light' | 'dark' | 'system';

function readTheme(): Theme {
  try {
    const t = localStorage.getItem('studio-theme');
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}

const themeIcons: Record<Theme, ReactNode> = {
  light: (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" strokeLinecap="round" />
    </svg>
  ),
  dark: (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.8 6.8 0 0 0 10.5 10.5Z" strokeLinejoin="round" />
    </svg>
  ),
  system: (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8" strokeLinecap="round" />
    </svg>
  ),
};

/** Light / dark / follow-the-OS. The choice is stamped on <html> as data-theme. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(readTheme);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
    try {
      if (theme === 'system') localStorage.removeItem('studio-theme');
      else localStorage.setItem('studio-theme', theme);
    } catch { /* private mode — the choice just won't persist */ }
  }, [theme]);

  return (
    <div className="flex items-center gap-0.5 rounded-lg border border-line p-0.5" role="group" aria-label="Colour theme">
      {(['light', 'system', 'dark'] as const).map((t) => (
        <button key={t} type="button" title={t === 'system' ? 'Follow system' : t}
          aria-pressed={theme === t}
          className={`flex h-6 w-7 items-center justify-center rounded-md transition-colors ${
            theme === t ? 'bg-surface-2 text-ink' : 'text-muted hover:text-ink'
          }`}
          onClick={() => setTheme(t)}>
          {themeIcons[t]}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------

const statusChip: Record<GenStatus, string> = {
  idle: 'chip-neutral',
  queued: 'chip-cool',
  generating: 'chip-accent',
  completed: 'chip-ok',
  failed: 'chip-bad',
};

export function StatusChip({ status, label }: { status: GenStatus; label?: string }) {
  return (
    <span className={`chip ${statusChip[status]}`}>
      {(status === 'generating' || status === 'queued') && <Spinner className="h-3 w-3" />}
      {label ?? status}
    </span>
  );
}

// ---------------------------------------------------------------------------

export function StorageImg({ path, alt, className }: { path?: string; alt: string; className?: string }) {
  const url = useStorageUrl(path);
  if (!path) return <div className={`flex items-center justify-center bg-surface-2 text-faint ${className}`}>—</div>;
  if (!url) return <div className={`flex items-center justify-center bg-surface-2 text-muted ${className}`}><Spinner /></div>;
  return <img src={url} alt={alt} className={className} loading="lazy" />;
}

export function StorageVideo({ path, className }: { path?: string; className?: string }) {
  const url = useStorageUrl(path);
  if (!path || !url) return null;
  return <video src={url} controls className={className} preload="metadata" />;
}

export function StorageAudio({ path }: { path?: string }) {
  const url = useStorageUrl(path);
  if (!path || !url) return null;
  return <audio src={url} controls className="h-8 w-full" preload="metadata" />;
}

/** Section heading: a mono eyebrow, a hairline that runs to the action. */
export function Section({ title, subtitle, children, right }: {
  title: string; subtitle?: string; children: ReactNode; right?: ReactNode;
}) {
  return (
    <section className="mb-12">
      <div className="flex items-center gap-4">
        <h2 className="eyebrow">{title}</h2>
        <span className="hairline" />
        {right}
      </div>
      {subtitle && <p className="mt-3 max-w-[76ch] text-sm leading-relaxed text-muted">{subtitle}</p>}
      <div className="mt-5">{children}</div>
    </section>
  );
}

/** Editable text field — saves 700ms after the user stops typing. */
export function Field({ label, value, onSave, rows, mono, placeholder }: {
  label: string; value: string; onSave: (v: string) => void;
  rows?: number; mono?: boolean; placeholder?: string;
}) {
  const [local, setLocal] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const change = (v: string) => {
    setLocal(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => onSave(v), 700);
  };
  const cls = `input ${mono ? 'font-mono text-xs' : ''}`;
  return (
    <div>
      <label className="label">{label}</label>
      {rows && rows > 1 ? (
        <textarea className={cls} rows={rows} value={local} placeholder={placeholder}
          onChange={(e) => change(e.target.value)} />
      ) : (
        <input className={cls} value={local} placeholder={placeholder}
          onChange={(e) => change(e.target.value)} />
      )}
    </div>
  );
}

export function ErrorNote({ error }: { error?: string }) {
  if (!error) return null;
  return (
    <p className="mt-2 rounded-lg border border-bad/35 bg-bad-soft p-2.5 text-xs leading-relaxed text-bad">
      {error}
    </p>
  );
}
