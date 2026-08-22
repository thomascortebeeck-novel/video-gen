import { ReactNode, useRef, useState } from 'react';
import { useStorageUrl } from '../lib/hooks';
import type { GenStatus } from '@shared/types';

export function Spinner({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

const statusStyles: Record<GenStatus, string> = {
  idle: 'bg-zinc-800 text-zinc-400',
  queued: 'bg-sky-950 text-sky-300',
  generating: 'bg-amber-950 text-amber-300',
  completed: 'bg-emerald-950 text-emerald-300',
  failed: 'bg-red-950 text-red-300',
};

export function StatusChip({ status, label }: { status: GenStatus; label?: string }) {
  return (
    <span className={`chip ${statusStyles[status]}`}>
      {(status === 'generating' || status === 'queued') && <Spinner className="mr-1 h-3 w-3" />}
      {label ?? status}
    </span>
  );
}

export function StorageImg({ path, alt, className }: { path?: string; alt: string; className?: string }) {
  const url = useStorageUrl(path);
  if (!path) return <div className={`flex items-center justify-center bg-zinc-900 text-zinc-700 ${className}`}>—</div>;
  if (!url) return <div className={`flex items-center justify-center bg-zinc-900 text-zinc-600 ${className}`}><Spinner /></div>;
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

export function Section({ title, subtitle, children, right }: {
  title: string; subtitle?: string; children: ReactNode; right?: ReactNode;
}) {
  return (
    <section className="mb-8">
      <div className="mb-3 flex items-end justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-zinc-100">{title}</h2>
          {subtitle && <p className="mt-0.5 text-xs text-zinc-500">{subtitle}</p>}
        </div>
        {right}
      </div>
      {children}
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
  return <p className="mt-2 rounded-lg border border-red-900 bg-red-950/40 p-2 text-xs text-red-300">{error}</p>;
}
