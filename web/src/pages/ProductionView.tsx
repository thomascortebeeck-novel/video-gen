import { useRef, useState } from 'react';
import { api } from '../lib/api';
import type { RegenerationPlan } from '../lib/api';
import { Section, Spinner, StatusChip, StorageImg, StorageVideo, StorageAudio, ErrorNote } from '../components/ui';
import { useStorageUrl } from '../lib/hooks';
import type { ProjectDoc, SubjectDoc, SceneDoc, EnvironmentDoc, Resolution } from '@shared/types';
import { resolveReferenceTags } from '@shared/assemble';
import { formatCameraMap } from '@shared/previz';
import {
  scoreTone, issuesByLever, verdictSummary, formatTimecode, criterionLabel, fieldLabel,
} from '@shared/verify';
import type { VerdictIssue, FixKind } from '@shared/verify';
import { estimateCostUsd, formatUsd } from '@shared/cost';

interface Props {
  uid: string; project: ProjectDoc; subjects: SubjectDoc[];
  scenes: SceneDoc[]; environments: EnvironmentDoc[];
}

export default function ProductionView({ project, subjects, scenes, environments }: Props) {
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [batchRunning, setBatchRunning] = useState(false);
  const [openDetails, setOpenDetails] = useState<Record<string, boolean>>({});
  const [shownTake, setShownTake] = useState<Record<string, string>>({});
  const [rerollFor, setRerollFor] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  // Findings carry timecodes, so the panel can put the playhead on them.
  const videoEls = useRef<Record<string, HTMLVideoElement | null>>({});
  const finalUrl = useStorageUrl(project.finalVideoPath);

  const seekTo = (sceneId: string, sec: number) => {
    const el = videoEls.current[sceneId];
    if (!el) return;
    el.currentTime = sec;
    void el.play().catch(() => { /* autoplay may be blocked; the seek still lands */ });
  };

  const openReroll = (sceneId: string, note?: string) => {
    if (note) setNotes((n) => ({ ...n, [sceneId]: note }));
    setRerollFor(sceneId);
  };

  const track = async (key: string, fn: () => Promise<unknown>) => {
    setBusy((b) => ({ ...b, [key]: true }));
    try { await fn(); } catch (e) { console.error(e); alert(String((e as Error).message ?? e)); }
    setBusy((b) => ({ ...b, [key]: false }));
  };

  const remaining = scenes.filter((s) => s.generation.status !== 'completed');
  const allDone = scenes.length > 0 && remaining.length === 0;
  // Verification is cents against a re-roll's dollars, so it is worth running
  // over every take that has not been read against its plan yet.
  const unverified = scenes.filter((s) => s.videoPath && s.verdict?.takePath !== s.videoPath);

  async function verifyAll() {
    setBatchRunning(true);
    try {
      for (const s of unverified) await api.verifyScene({ projectId: project.id, sceneId: s.id });
    } catch (e) {
      console.error(e);
      alert(String((e as Error).message ?? e));
    }
    setBatchRunning(false);
  }

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
        subtitle="Scenes generate in order — frame-bridged and extended scenes consume the previous scene's output. Every finished take is graded against its plan automatically; findings say whether a fix is free in the edit or needs new footage."
        right={
          allDone ? (
            <div className="flex items-center gap-2">
              {unverified.length > 0 && (
                <button className="btn btn-ghost" disabled={batchRunning} onClick={() => void verifyAll()}>
                  {batchRunning ? <><Spinner /> Verifying…</> : `Grade ${unverified.length} older take${unverified.length === 1 ? '' : 's'} — cents`}
                </button>
              )}
              <span className="chip chip-ok">all {scenes.length} scenes generated</span>
            </div>
          ) : (
            <button className="btn btn-primary" disabled={batchRunning}
              onClick={() => void generateAllRemaining()}>
              {batchRunning
                ? <><Spinner /> Generating {scenes.length - remaining.length + 1}/{scenes.length}…</>
                : `Generate all remaining (${remaining.length})`}
            </button>
          )
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
                  <span className="text-sm font-semibold text-muted">#{scene.index + 1}</span>
                  <h3 className="font-medium text-ink">{scene.title}</h3>
                  <span className="chip chip-mono">{scene.durationSec}s</span>
                  <span className="chip chip-accent" title={scene.stitching.notes}>
                    {scene.stitching.mode.replace('_', ' ')}
                  </span>
                  <StatusChip status={scene.generation.status} />
                  {scene.verdict?.status === 'ready' && (
                    <ScoreChip score={scene.verdict.overall}
                      label={scene.verdict.takePath === scene.videoPath ? undefined : 'stale'} />
                  )}
                  <div className="ml-auto flex gap-2">
                    {scene.videoPath && (
                      <button className="btn btn-ghost" disabled={busy[`verify_${scene.id}`] || batchRunning}
                        title="Read this take against its plan — costs cents, generates nothing"
                        onClick={() => void track(`verify_${scene.id}`, () => api.verifyScene({ projectId: project.id, sceneId: scene.id }))}>
                        {busy[`verify_${scene.id}`] ? <><Spinner /> Verifying…</> : scene.verdict ? '↻ Re-verify' : 'Verify take'}
                      </button>
                    )}
                    {(scene.generation.status === 'generating' || scene.generation.status === 'queued') && scene.generation.jobId && (
                      <button className="btn btn-ghost" disabled={busy[`refresh_${scene.id}`]}
                        onClick={() => void track(`refresh_${scene.id}`, () => api.refreshScene({ projectId: project.id, sceneId: scene.id }))}>
                        {busy[`refresh_${scene.id}`] ? <Spinner /> : '↻ Refresh status'}
                      </button>
                    )}
                    <button className="btn btn-ghost" disabled={busy[`gen_${scene.id}`] || batchRunning || blocked || scene.generation.status === 'generating'}
                      title={blocked ? 'Generate the previous scene first (this one continues from it)' : undefined}
                      onClick={() => (scene.videoPath
                        ? openReroll(scene.id)
                        : void track(`gen_${scene.id}`, () => api.generateScene({ projectId: project.id, sceneId: scene.id })))}>
                      {busy[`gen_${scene.id}`] ? <><Spinner /> Generating…</> : scene.videoPath ? '↻ Re-roll…' : blocked ? 'Waiting for previous' : 'Generate scene'}
                    </button>
                  </div>
                </div>
                <p className="mt-1 text-xs text-muted">{scene.beatSummary}</p>
                <ErrorNote error={scene.generation.status === 'failed' ? scene.generation.error : undefined} />
                {scene.generation.moderationNote && (
                  <p className="mt-2 rounded-lg border border-accent/40 bg-accent-soft p-2 text-xs text-accent">
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
                        path={shownTake[scene.id] ?? scene.videoPath} className="max-h-80 w-full rounded-lg"
                        videoRef={(el) => { videoEls.current[scene.id] = el; }} />
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        {(scene.versions ?? []).map((v, i) => {
                          const active = (shownTake[scene.id] ?? scene.videoPath) === v.videoPath;
                          const isLatest = v.videoPath === scene.videoPath;
                          return (
                            <button key={v.videoPath}
                              title={[v.note, ...(v.patchSummary ?? [])].filter(Boolean).join('\n') || undefined}
                              className={`chip ${active ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-ink-2 hover:text-ink'}`}
                              onClick={() => setShownTake((s) => ({ ...s, [scene.id]: v.videoPath }))}>
                              Take {i + 1}{isLatest ? ' · active' : ''}
                              {v.verdictScore !== undefined && <span className="ml-1 tnum text-faint">{v.verdictScore}</span>}
                              {v.note && <span className="ml-1 text-faint" title={v.note}>·note</span>}
                            </button>
                          );
                        })}
                        <button className="ml-auto btn btn-quiet btn-sm text-accent"
                          onClick={() => setOpenDetails((d) => ({ ...d, [scene.id]: !d[scene.id] }))}>
                          {openDetails[scene.id] ? 'Hide generation details' : 'How was this generated?'}
                        </button>
                      </div>
                      {(scene.versions?.length ?? 0) > 1 && (
                        <p className="mt-1 text-[11px] text-faint">
                          {scene.versions!.length} takes generated — the newest is used in the final film.
                        </p>
                      )}
                    </div>
                  )}
                </div>
                {scene.verdict && (
                  <VerdictPanel scene={scene}
                    onSeek={(sec) => seekTo(scene.id, sec)}
                    onUseNote={(note) => openReroll(scene.id, note)} />
                )}
                {rerollFor === scene.id && (
                  <RerollBox projectId={project.id} scene={scene} resolution={project.input.resolution}
                    note={notes[scene.id] ?? ''}
                    setNote={(n) => setNotes((x) => ({ ...x, [scene.id]: n }))}
                    onClose={() => setRerollFor(null)} />
                )}
                {openDetails[scene.id] && (
                  <GenerationDetails scene={scene} subjects={subjects} environments={environments} />
                )}
              </div>
            );
          })}
        </div>
      </Section>

      {(project.audioTracks?.length ?? 0) > 0 && (
        <Section title="Audio"
          subtitle="Project-level tracks laid over the assembled film. Scene generations each invent their own narrator and score, so generated speech is separated out of every take and these tracks are the film's real audio.">
          <div className="grid gap-3">
            {project.audioTracks!.map((t) => (
              <div key={t.id} className="card p-4">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className={`chip ${t.kind === 'voiceover' ? 'chip-accent' : 'chip-cool'}`}>{t.kind}</span>
                  <span className="text-sm font-medium text-ink">{t.name}</span>
                  {t.active
                    ? <span className="chip chip-ok" title="This track is in the published final mix">in final mix</span>
                    : <span className="chip" title="Uploaded and ready, not in the published mix">alternate</span>}
                  {t.duckUnderVoice && <span className="chip" title="Dips under the narrator during spoken lines">ducks under voice</span>}
                  {t.source && <span className="font-mono text-xs text-faint">{t.source}</span>}
                </div>
                <StorageAudio path={t.audioPath} />
              </div>
            ))}
          </div>
        </Section>
      )}

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
    if (r.kind === 'camera_previz') {
      // The previz reaches the model either as its contact sheet or as the
      // clip itself, depending on the scene's feed mode.
      return scene.previz?.feed === 'attach_video'
        ? { label: 'Camera previz — the move, as a clip', videoPath: scene.previz?.videoPath }
        : { label: 'Camera previz — contact sheet of the move', imagePath: scene.previz?.contactSheetPath };
    }
    return { label: r.kind };
  };

  return (
    <div className="well mt-3 p-4">
      <div className="mb-3 flex flex-wrap gap-2 text-[11px] text-ink-2">
        <span className="chip chip-mono">{gen.params?.model ?? 'engine n/a'}</span>
        <span className="chip chip-mono">{scene.durationSec}s · {gen.params?.resolution ?? '—'} · {gen.params?.aspectRatio ?? '—'}</span>
        <span className="chip chip-mono">stitch: {scene.stitching.mode.replace('_', ' ')}</span>
        {gen.provider && <span className="chip chip-mono">provider: {gen.provider}</span>}
        {gen.jobId && <span className="chip chip-mono">job: {gen.jobId}</span>}
        {gen.completedAt && <span className="chip chip-mono">{new Date(gen.completedAt).toLocaleString()}</span>}
      </div>

      <p className="label">References — what the model was given, bound to its tag</p>
      {refs.length === 0 ? (
        <p className="text-xs text-faint">No references — generated from the prompt alone.</p>
      ) : (
        <div className="mt-1 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {refs.map((r) => {
            const a = assetFor(r);
            return (
              <div key={r.assignedTag} className="flex gap-2 rounded-lg border border-line bg-surface p-2">
                <div className="w-20 shrink-0">
                  {a.videoPath
                    ? <StorageVideo path={a.videoPath} className="w-full rounded" />
                    : <StorageImg path={a.imagePath} alt={a.label} className="aspect-square w-full rounded object-cover" />}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] font-semibold text-accent">{r.assignedTag}</p>
                  <p className="truncate text-[11px] text-ink-2" title={a.label}>{a.label}</p>
                  <p className="mt-0.5 text-[10px] leading-snug text-muted">{r.use}</p>
                  {r.ignore && <p className="mt-0.5 text-[10px] leading-snug text-faint">Ignore: {r.ignore}</p>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {scene.previz?.cameraMap && scene.previz.cameraMap.length > 0 && (
        <>
          <p className="label mt-4">Camera map — measured from the Blender previz, sent as text (free)</p>
          <pre className="codeblock max-h-48">{formatCameraMap(scene.previz.cameraMap)}</pre>
        </>
      )}

      <p className="label mt-4">Assembled prompt — sent to the engine verbatim</p>
      <pre className="codeblock max-h-96">
        {scene.assembledPrompt ?? 'Not stored yet — generate this scene to capture its prompt.'}
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

function ScoreChip({ score, label }: { score: number; label?: string }) {
  const tone = scoreTone(score);
  return (
    <span className={`chip ${tone === 'ok' ? 'chip-ok' : tone === 'warn' ? 'chip-accent' : 'chip-bad'} tnum`}>
      {label ? `${label} ` : ''}{score}/100
    </span>
  );
}

const SEVERITY_CHIP: Record<VerdictIssue['severity'], string> = {
  blocker: 'chip-bad', major: 'chip-accent', minor: 'chip-neutral',
};

/** Free fixes read differently from paid ones, so they are grouped that way. */
const LEVER_COPY: Record<FixKind, { title: string; blurb: string; tone: string }> = {
  edit: { title: 'Fixable in the edit', blurb: 'costs nothing — no new footage needed', tone: 'text-ok' },
  prompt: { title: 'Needs new footage — reword the plan', blurb: 'a re-roll with a note', tone: 'text-accent' },
  reference: { title: 'Needs new footage — change what is attached', blurb: 'the reference material is the cause', tone: 'text-accent' },
  accept: { title: 'Noted, not worth fixing', blurb: '', tone: 'text-muted' },
};

/**
 * The scorecard for one take. Every finding carries a timecode that seeks the
 * player, and the lever that fixes it — because half of what goes wrong is
 * editorial and costs nothing, and the panel should make that obvious before
 * anyone reaches for the regenerate button.
 */
function VerdictPanel({ scene, onSeek, onUseNote }: {
  scene: SceneDoc;
  onSeek: (sec: number) => void;
  onUseNote: (note: string) => void;
}) {
  const [showDetail, setShowDetail] = useState(false);
  const v = scene.verdict;
  if (!v) return null;

  if (v.status === 'running') {
    // Verification runs inside the generation call, so if that call died the
    // status never advances. The take itself is unaffected — say so rather
    // than spinning forever.
    const stalled = Date.now() - v.checkedAt > 10 * 60 * 1000;
    return (
      <div className="well mt-3 flex items-center gap-2 p-4 text-xs text-muted">
        {stalled
          ? <span className="text-ink-2">Verification was interrupted — the take is fine. Press “Verify take” to read it again.</span>
          : <><Spinner /> Reading the take against the plan…</>}
      </div>
    );
  }
  if (v.status === 'failed') {
    return <div className="mt-3"><ErrorNote error={v.error ?? 'Verification failed.'} /></div>;
  }

  const stale = Boolean(v.takePath && scene.videoPath && v.takePath !== scene.videoPath);
  const byLever = issuesByLever(v);

  return (
    <div className="well mt-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <ScoreChip score={v.overall} />
        <span className={`chip ${v.call === 'ship' ? 'chip-ok' : v.call === 're_roll' ? 'chip-bad' : 'chip-accent'}`}>
          {v.call === 'ship' ? 'good to ship' : v.call === 're_roll' ? 're-roll warranted' : 'minor notes'}
        </span>
        <span className="text-[11px] text-faint">{new Date(v.checkedAt).toLocaleString()}</span>
        <button className="ml-auto btn btn-quiet btn-sm text-accent" onClick={() => setShowDetail((d) => !d)}>
          {showDetail ? 'Hide the full scorecard' : 'Full scorecard'}
        </button>
      </div>

      {stale && (
        <p className="mt-2 rounded-lg border border-accent/40 bg-accent-soft p-2 text-xs text-accent">
          This verdict judged an earlier take. Verify again to grade the one you are looking at.
        </p>
      )}

      <p className="mt-2 text-sm text-ink">{v.headline}</p>
      <p className="mt-0.5 text-[11px] text-muted">{verdictSummary(v)}</p>

      {(['edit', 'prompt', 'reference', 'accept'] as FixKind[]).map((lever) => (
        byLever[lever].length === 0 ? null : (
          <div key={lever} className="mt-3">
            <p className={`eyebrow ${LEVER_COPY[lever].tone}`}>
              {LEVER_COPY[lever].title}
              {LEVER_COPY[lever].blurb && <span className="text-faint"> · {LEVER_COPY[lever].blurb}</span>}
            </p>
            <ul className="mt-1 space-y-1.5">
              {byLever[lever].map((issue, i) => (
                <li key={`${lever}_${i}`} className="flex gap-2 rounded-lg border border-line bg-surface p-2">
                  <button className="chip chip-mono shrink-0 self-start hover:text-accent"
                    title="Jump to this moment" onClick={() => onSeek(issue.atSec)}>
                    {formatTimecode(issue.atSec)}
                  </button>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs text-ink">
                      <span className={`chip ${SEVERITY_CHIP[issue.severity]} mr-1.5`}>{issue.severity}</span>
                      {issue.what}
                    </p>
                    <p className="mt-0.5 text-[11px] leading-snug text-muted">Fix: {issue.fix}</p>
                  </div>
                  {(lever === 'prompt' || lever === 'reference') && (
                    <button className="btn btn-quiet btn-sm shrink-0 self-start text-accent"
                      onClick={() => onUseNote(issue.fix)}>Use as note</button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )
      ))}

      {v.suggestedNote && (
        <div className="mt-3 rounded-lg border border-accent/40 bg-accent-soft p-2">
          <p className="eyebrow text-accent">Suggested re-roll note</p>
          <p className="mt-1 text-xs leading-snug text-ink">{v.suggestedNote}</p>
          <button className="btn btn-ghost btn-sm mt-2" onClick={() => onUseNote(v.suggestedNote!)}>
            Use this note
          </button>
        </div>
      )}

      {showDetail && (
        <div className="mt-4 border-t border-line-soft pt-3">
          <p className="label">Criteria</p>
          <div className="mt-1 space-y-1">
            {v.criteria.map((c) => {
              const tone = scoreTone(c.score);
              return (
                <div key={c.id} className="flex items-center gap-2">
                  <span className="w-44 shrink-0 text-[11px] text-ink-2">{criterionLabel(c.id)}</span>
                  <span className="h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-surface-2">
                    <span className={`block h-full rounded-full ${tone === 'ok' ? 'bg-ok' : tone === 'warn' ? 'bg-accent' : 'bg-bad'}`}
                      style={{ width: `${Math.max(0, Math.min(100, c.score))}%` }} />
                  </span>
                  <span className="chip chip-mono shrink-0">{c.score}</span>
                  <span className="min-w-0 flex-1 truncate text-[11px] text-muted" title={c.note}>{c.note}</span>
                </div>
              );
            })}
          </div>
          {v.contactSheetPath && (
            <>
              <p className="label mt-4">Every second of the take, as read</p>
              <StorageImg path={v.contactSheetPath} alt="take contact sheet" className="mt-1 w-full rounded-lg" />
            </>
          )}
          {v.transcript && (
            <>
              <p className="label mt-4">What was actually said</p>
              <pre className="codeblock max-h-48">{v.transcript}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Re-rolls
// ---------------------------------------------------------------------------

/**
 * The two halves of a re-roll: work out what a note would change (free), then
 * — only after the diff and the price are on screen — generate. Nothing here
 * spends until the confirm button is pressed.
 */
function RerollBox({ projectId, scene, resolution, note, setNote, onClose }: {
  projectId: string; scene: SceneDoc; resolution: Resolution;
  note: string; setNote: (n: string) => void; onClose: () => void;
}) {
  const [plan, setPlan] = useState<RegenerationPlan | null>(null);
  const [busy, setBusy] = useState<'plan' | 'generate' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);

  const asIsCost = formatUsd(estimateCostUsd(scene.durationSec, resolution,
    resolveReferenceTags(scene).filter((r) => r.media === 'video').length));

  const run = async (which: 'plan' | 'generate', fn: () => Promise<unknown>) => {
    setError(null); setBusy(which);
    try { await fn(); } catch (e) { setError(String((e as Error).message ?? e)); }
    setBusy(null);
  };

  return (
    <div className="well mt-3 p-4">
      <p className="eyebrow text-accent">Re-roll this scene</p>
      <p className="mt-1 text-[11px] text-muted">
        A note patches named fields and re-assembles the prompt — it never rewrites the plan, so identity and
        wardrobe cannot drift into the next scene. You will see the exact change and the price before anything
        is generated.
      </p>

      <textarea
        className="input mt-2 font-mono text-xs" rows={3}
        placeholder="e.g. The mount never happens — spell out each physical step of climbing on."
        value={note} onChange={(e) => { setNote(e.target.value); setPlan(null); }}
      />

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button className="btn btn-ghost" disabled={!note.trim() || busy !== null}
          onClick={() => void run('plan', async () => {
            setPlan(await api.planRegeneration({ projectId, sceneId: scene.id, note }));
          })}>
          {busy === 'plan' ? <><Spinner /> Working out the change…</> : 'Preview the change — free'}
        </button>
        <button className="btn btn-quiet btn-sm" disabled={busy !== null}
          title="Send the identical prompt again for a different take"
          onClick={() => void run('generate', async () => {
            await api.regenerateScene({ projectId, sceneId: scene.id, mode: 'as_is' });
            onClose();
          })}>
          {busy === 'generate' && !plan ? <><Spinner /> Generating…</> : `Re-roll as is — ${asIsCost}`}
        </button>
        <button className="ml-auto btn btn-quiet btn-sm" onClick={onClose}>Cancel</button>
      </div>

      <ErrorNote error={error ?? undefined} />

      {plan && (
        <div className="mt-3 border-t border-line-soft pt-3">
          <p className="text-xs text-ink">{plan.summary}</p>

          {plan.patches.length === 0 && (
            <p className="mt-2 text-xs text-muted">
              No field changes were proposed — try a more specific note, or re-roll as is.
            </p>
          )}

          {plan.patches.map((p) => (
            <div key={p.field} className="mt-2 rounded-lg border border-line bg-surface p-2">
              <p className="flex flex-wrap items-center gap-2 text-[11px] font-semibold text-accent">
                {fieldLabel(p.field)}
                {p.sharedText && (
                  <span className="chip chip-bad" title="This text is reused verbatim by every other scene">
                    shared across scenes
                  </span>
                )}
              </p>
              <p className="mt-0.5 text-[10px] text-muted">{p.why}</p>
              <p className="mt-1.5 whitespace-pre-wrap text-[11px] leading-snug text-faint line-through">{p.from}</p>
              <p className="mt-1 whitespace-pre-wrap text-[11px] leading-snug text-ink">{p.to}</p>
            </div>
          ))}

          {plan.unaddressable.length > 0 && (
            <div className="mt-2 rounded-lg border border-accent/40 bg-accent-soft p-2">
              <p className="eyebrow text-accent">A re-roll will not deliver this</p>
              <ul className="mt-1 list-disc pl-4 text-[11px] leading-snug text-ink">
                {plan.unaddressable.map((u, i) => <li key={i}>{u}</li>)}
              </ul>
            </div>
          )}

          {plan.rejected.length > 0 && (
            <p className="mt-2 text-[11px] text-faint">
              Ignored: {plan.rejected.map((r) => `${r.field} (${r.reason})`).join(', ')}
            </p>
          )}

          <button className="btn btn-quiet btn-sm mt-2 text-accent" onClick={() => setShowPrompt((x) => !x)}>
            {showPrompt ? 'Hide the prompt this would send' : 'See the prompt this would send'}
          </button>
          {showPrompt && <pre className="codeblock mt-1 max-h-72">{plan.prompt}</pre>}

          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line-soft pt-3">
            <button className="btn btn-primary" disabled={busy !== null || plan.patches.length === 0}
              onClick={() => void run('generate', async () => {
                await api.regenerateScene({
                  projectId, sceneId: scene.id, mode: 'note', note,
                  patch: plan.patches.map(({ field, from, to, why }) => ({ field, from, to, why })),
                });
                onClose();
              })}>
              {busy === 'generate' ? <><Spinner /> Generating…</> : `Apply and generate — ${formatUsd(plan.estimatedCostUsd)}`}
            </button>
            <span className="text-[11px] text-muted">
              This is the only button here that spends.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
