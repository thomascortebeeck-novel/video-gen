import { useState } from 'react';
import { api, patchDoc } from '../lib/api';
import { Section, Field, StatusChip, StorageImg, StorageAudio, Spinner, ErrorNote } from '../components/ui';
import SceneEditor from './SceneEditor';
import type { ProjectDoc, SubjectDoc, SceneDoc, EnvironmentDoc, Briefing } from '@shared/types';
import { collections } from '@shared/types';

interface Props {
  uid: string; project: ProjectDoc; subjects: SubjectDoc[];
  scenes: SceneDoc[]; environments: EnvironmentDoc[];
}

export default function BriefingView({ uid, project, subjects, scenes, environments }: Props) {
  const [busyKeys, setBusyKeys] = useState<Record<string, boolean>>({});
  const briefing = project.briefing;
  const projectPath = collections.project(uid, project.id);

  const track = async (key: string, fn: () => Promise<unknown>) => {
    setBusyKeys((b) => ({ ...b, [key]: true }));
    try { await fn(); } catch (e) { console.error(e); alert(String((e as Error).message ?? e)); }
    setBusyKeys((b) => ({ ...b, [key]: false }));
  };

  const saveBriefing = (patch: Partial<Briefing> | Record<string, unknown>) =>
    void patchDoc(projectPath, { briefing: { ...briefing, ...patch } });

  const allAnglesReady = subjects.length > 0
    && subjects.every((s) => s.angles.length > 0 && s.angles.every((a) => a.generation.status === 'completed'))
    && environments.every((e) => e.generation.status === 'completed');
  const anyAngleIdle = subjects.some((s) => s.angles.some((a) => a.generation.status === 'idle' || a.generation.status === 'failed'));

  return (
    <div>
      {/* ================= Subjects & angle sets ================= */}
      <Section
        title="Reference sheets & angle images"
        subtitle="Master angle first — it locks the design; every other angle references it so nothing drifts."
        right={anyAngleIdle && briefing ? (
          <button className="btn btn-primary" disabled={busyKeys['all_angles']}
            onClick={() => void track('all_angles', async () => {
              for (const s of subjects) await api.generateAngles({ projectId: project.id, subjectId: s.id });
            })}>
            {busyKeys['all_angles'] ? <><Spinner /> Generating…</> : 'Generate all angle sets'}
          </button>
        ) : undefined}
      >
        {subjects.map((s) => (
          <SubjectCard key={s.id} uid={uid} project={project} subject={s}
            busy={busyKeys} track={track} voicesEnabled={Boolean(project.input.audio.characterVoices)} />
        ))}
      </Section>

      {/* ================= Environments ================= */}
      {environments.length > 0 && (
        <Section title="Environment references"
          subtitle="Generated once per location and attached to every scene set there, so the world stays consistent.">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {environments.map((env) => (
              <div key={env.id} className="card p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h3 className="text-sm font-medium text-zinc-200">{env.name}</h3>
                  <StatusChip status={env.generation.status} />
                </div>
                <StorageImg path={env.imagePath} alt={env.name} className="aspect-video w-full rounded-lg object-cover" />
                <Field label="Description" rows={2} value={env.description}
                  onSave={(v) => void patchDoc(`${collections.environments(uid, project.id)}/${env.id}`, { description: v })} />
                <div className="mt-2 flex gap-2">
                  <button className="btn btn-ghost" disabled={busyKeys[`env_${env.id}`]}
                    onClick={() => void track(`env_${env.id}`, () => api.generateEnvironment({ projectId: project.id, envId: env.id }))}>
                    {busyKeys[`env_${env.id}`] ? <Spinner /> : env.imagePath ? 'Regenerate' : 'Generate'}
                  </button>
                </div>
                <ErrorNote error={env.generation.status === 'failed' ? env.generation.error : undefined} />
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* ================= Briefing document ================= */}
      {briefing ? (
        <>
          <Section title="Briefing — style bible"
            subtitle="These lines are reused verbatim in every scene prompt so all clips grade-match when stitched.">
            <div className="card grid gap-4 p-4 sm:grid-cols-2">
              <Field label="Title" value={briefing.meta.title}
                onSave={(v) => { saveBriefing({ meta: { ...briefing.meta, title: v } }); void patchDoc(projectPath, { title: v }); }} />
              <Field label="Logline" value={briefing.meta.logline}
                onSave={(v) => saveBriefing({ meta: { ...briefing.meta, logline: v } })} />
              <Field label="Look" value={briefing.styleBible.look}
                onSave={(v) => saveBriefing({ styleBible: { ...briefing.styleBible, look: v } })} />
              <Field label="Colour palette (positive names only)" value={briefing.styleBible.colourPalette}
                onSave={(v) => saveBriefing({ styleBible: { ...briefing.styleBible, colourPalette: v } })} />
              <Field label="Lighting" value={briefing.styleBible.lighting}
                onSave={(v) => saveBriefing({ styleBible: { ...briefing.styleBible, lighting: v } })} />
              <Field label="Grain & texture" value={briefing.styleBible.grainAndTexture}
                onSave={(v) => saveBriefing({ styleBible: { ...briefing.styleBible, grainAndTexture: v } })} />
              <Field label="Mood" value={briefing.styleBible.mood}
                onSave={(v) => saveBriefing({ styleBible: { ...briefing.styleBible, mood: v } })} />
              <div className="sm:col-span-2">
                <Field label="Technical line (one line, used in every scene)" rows={2} value={briefing.styleBible.technicalLine}
                  onSave={(v) => saveBriefing({ styleBible: { ...briefing.styleBible, technicalLine: v } })} />
              </div>
            </div>
          </Section>

          <Section title="Audio plan">
            <div className="card grid gap-4 p-4 sm:grid-cols-2">
              <Field label="Music" value={briefing.audioPlan.music ?? ''}
                onSave={(v) => saveBriefing({ audioPlan: { ...briefing.audioPlan, music: v } })} />
              <Field label="Ambience" value={briefing.audioPlan.ambience ?? ''}
                onSave={(v) => saveBriefing({ audioPlan: { ...briefing.audioPlan, ambience: v } })} />
              <Field label="Recurring sound effects (comma-separated)" value={briefing.audioPlan.soundEffects.join(', ')}
                onSave={(v) => saveBriefing({ audioPlan: { ...briefing.audioPlan, soundEffects: v.split(',').map((x) => x.trim()).filter(Boolean) } })} />
              <Field label="Dialogue language" value={briefing.audioPlan.dialogueLanguage ?? ''}
                onSave={(v) => saveBriefing({ audioPlan: { ...briefing.audioPlan, dialogueLanguage: v } })} />
            </div>
          </Section>

          {briefing.directorsNotes.length > 0 && (
            <Section title="Director's notes" subtitle="Things the director invented — confirm or adjust them above.">
              <div className="card p-4">
                <ul className="list-disc space-y-1 pl-5 text-sm text-zinc-400">
                  {briefing.directorsNotes.map((n, i) => <li key={i}>{n}</li>)}
                </ul>
              </div>
            </Section>
          )}

          <Section title={`Scenes (${scenes.length})`}
            subtitle="Each scene is one Seedance generation, written in the advanced template. Edit any field — the prompt reassembles live. Stitching: hard cut / frame bridge (last frame → first frame) / extend.">
            <div className="space-y-3">
              {scenes.map((scene) => (
                <SceneEditor key={scene.id} uid={uid} project={project} scene={scene}
                  subjects={subjects} environments={environments} />
              ))}
            </div>
          </Section>

          <Section title="Stitching plan" subtitle={briefing.stitchingPlan.assemblyNotes}>
            <div className="card p-4 text-sm text-zinc-400">
              {briefing.stitchingPlan.boundaries.length === 0 && <p>Single scene — no boundaries.</p>}
              <ul className="space-y-1">
                {briefing.stitchingPlan.boundaries.map((b, i) => (
                  <li key={i}>
                    <span className="text-zinc-200">Scene {b.fromSceneIndex + 1} → {b.toSceneIndex + 1}</span>
                    {' '}<span className="chip bg-zinc-800 text-amber-300">{b.mode.replace('_', ' ')}</span>
                    {' '}<span>{b.rationale}</span>
                  </li>
                ))}
              </ul>
            </div>
          </Section>

          {/* ================= Accept ================= */}
          <div className="card sticky bottom-4 z-10 flex flex-wrap items-center gap-3 border-amber-900/40 p-4">
            <div className="text-sm">
              <p className="font-medium text-zinc-100">Happy with the briefing?</p>
              <p className="text-xs text-zinc-500">
                {allAnglesReady ? 'All reference assets are ready.' : 'Tip: generate the angle sets & environments first — scenes need them as references.'}
              </p>
            </div>
            <div className="ml-auto flex gap-2">
              <button className="btn btn-ghost" disabled={busyKeys['replan']}
                onClick={() => void track('replan', () => api.planBriefing({ projectId: project.id }))}>
                {busyKeys['replan'] ? <><Spinner /> Re-planning…</> : '↻ Regenerate briefing'}
              </button>
              {project.status !== 'briefing_accepted' && project.status !== 'producing' && project.status !== 'done' ? (
                <button className="btn btn-primary"
                  onClick={() => void patchDoc(projectPath, { status: 'briefing_accepted' })}>
                  Accept briefing → production
                </button>
              ) : (
                <span className="chip bg-emerald-950 text-emerald-300">Briefing accepted</span>
              )}
            </div>
          </div>
        </>
      ) : (
        <div className="card p-6 text-sm text-zinc-500">
          {project.status === 'draft'
            ? <>No briefing yet. <button className="btn btn-primary ml-2" onClick={() => void track('start', async () => { await api.analyzeSubjects({ projectId: project.id }); await api.planBriefing({ projectId: project.id }); })}>{busyKeys['start'] ? <><Spinner /> Working…</> : 'Generate briefing'}</button></>
            : 'The director is working — the briefing appears here when ready.'}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function SubjectCard({ uid, project, subject, busy, track, voicesEnabled }: {
  uid: string; project: ProjectDoc; subject: SubjectDoc;
  busy: Record<string, boolean>;
  track: (key: string, fn: () => Promise<unknown>) => Promise<void>;
  voicesEnabled: boolean;
}) {
  const path = `${collections.subjects(uid, project.id)}/${subject.id}`;
  const sheet = subject.sheet;
  const [showSheet, setShowSheet] = useState(false);
  const doneCount = subject.angles.filter((a) => a.generation.status === 'completed').length;

  return (
    <div className="card mb-4 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="font-medium text-zinc-100">{subject.name}</h3>
        <span className="chip bg-zinc-800 text-zinc-400">{subject.kind}</span>
        {sheet && <span className="text-xs text-zinc-500">{sheet.roleName}</span>}
        <StatusChip
          status={subject.status === 'error' ? 'failed' : subject.status === 'ready' ? 'completed' : subject.status === 'generating_angles' || subject.status === 'analyzing' ? 'generating' : 'idle'}
          label={subject.status.replace(/_/g, ' ')} />
        <div className="ml-auto flex gap-2">
          <button className="btn btn-ghost" onClick={() => setShowSheet((v) => !v)}>
            {showSheet ? 'Hide sheet' : 'Edit sheet'}
          </button>
          {sheet && (
            <button className="btn btn-primary" disabled={busy[`angles_${subject.id}`]}
              onClick={() => void track(`angles_${subject.id}`, () => api.generateAngles({ projectId: project.id, subjectId: subject.id }))}>
              {busy[`angles_${subject.id}`] ? <><Spinner /> {doneCount}/{subject.angles.length}</> : doneCount > 0 ? 'Regenerate missing' : 'Generate angles'}
            </button>
          )}
        </div>
      </div>
      <ErrorNote error={subject.error} />

      {showSheet && sheet && (
        <div className="mt-4 grid gap-3 rounded-lg border border-zinc-800 p-4 sm:grid-cols-2">
          <Field label="Story role" value={sheet.roleName} onSave={(v) => void patchDoc(path, { sheet: { ...sheet, roleName: v } })} />
          <Field label="One-line read" value={sheet.oneLineRead} onSave={(v) => void patchDoc(path, { sheet: { ...sheet, oneLineRead: v } })} />
          {subject.kind === 'character' ? (
            <>
              <div className="sm:col-span-2"><Field label="Identity block (locked wording reused in every prompt)" rows={3} value={sheet.identityBlock ?? ''} onSave={(v) => void patchDoc(path, { sheet: { ...sheet, identityBlock: v } })} /></div>
              <Field label="Physique (with numbers)" rows={2} value={sheet.physique ?? ''} onSave={(v) => void patchDoc(path, { sheet: { ...sheet, physique: v } })} />
              <Field label="Distinguishing marks" rows={2} value={sheet.distinguishingMarks ?? ''} onSave={(v) => void patchDoc(path, { sheet: { ...sheet, distinguishingMarks: v } })} />
              <div className="sm:col-span-2"><Field label="Wardrobe (fabric, cut, colour, condition + negations)" rows={3} value={sheet.wardrobe ?? ''} onSave={(v) => void patchDoc(path, { sheet: { ...sheet, wardrobe: v } })} /></div>
            </>
          ) : (
            <>
              <div className="sm:col-span-2"><Field label="Purpose line (what it is and what it's for)" rows={2} value={sheet.purposeLine ?? ''} onSave={(v) => void patchDoc(path, { sheet: { ...sheet, purposeLine: v } })} /></div>
              <Field label="Silhouette" rows={2} value={sheet.silhouette ?? ''} onSave={(v) => void patchDoc(path, { sheet: { ...sheet, silhouette: v } })} />
              <Field label="Hidden surfaces (sole, interior…)" rows={2} value={sheet.hiddenSurfaces ?? ''} onSave={(v) => void patchDoc(path, { sheet: { ...sheet, hiddenSurfaces: v } })} />
              <div className="sm:col-span-2"><Field label="Materials & colour" rows={3} value={sheet.materialsAndColour ?? ''} onSave={(v) => void patchDoc(path, { sheet: { ...sheet, materialsAndColour: v } })} /></div>
            </>
          )}
          <div className="sm:col-span-2"><Field label="Must NOT be (negations)" rows={2} value={sheet.negations ?? ''} onSave={(v) => void patchDoc(path, { sheet: { ...sheet, negations: v } })} /></div>
        </div>
      )}

      {subject.angles.length > 0 && (
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
          {subject.angles.map((a) => (
            <div key={a.id} className="group relative">
              <StorageImg path={a.imagePath} alt={a.label} className="aspect-[3/4] w-full rounded-lg object-cover" />
              <div className="absolute inset-x-0 bottom-0 rounded-b-lg bg-zinc-950/80 p-1.5">
                <p className="truncate text-[10px] text-zinc-300">{a.isMaster ? '★ ' : ''}{a.label}</p>
                <div className="mt-0.5 flex items-center justify-between">
                  <StatusChip status={a.generation.status} />
                  <button className="hidden text-[10px] text-amber-400 hover:text-amber-300 group-hover:block"
                    disabled={busy[`angle_${a.id}`]}
                    onClick={() => void track(`angle_${a.id}`, () => api.generateAngleImage({ projectId: project.id, subjectId: subject.id, angleId: a.id }))}>
                    ↻ redo
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {voicesEnabled && subject.kind === 'character' && sheet?.voice && (
        <div className="mt-4 rounded-lg border border-zinc-800 p-3">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Voice (ElevenLabs)</span>
            <StatusChip status={sheet.voice.sampleStatus ?? 'idle'} />
            <button className="btn btn-ghost ml-auto" disabled={busy[`voice_${subject.id}`]}
              onClick={() => void track(`voice_${subject.id}`, () => api.generateVoiceSample({ projectId: project.id, subjectId: subject.id }))}>
              {busy[`voice_${subject.id}`] ? <Spinner /> : sheet.voice.sampleAudioPath ? 'Regenerate sample' : 'Design voice & sample'}
            </button>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Language" value={sheet.voice.language} onSave={(v) => void patchDoc(path, { sheet: { ...sheet, voice: { ...sheet.voice, language: v } } })} />
            <Field label="Accent" value={sheet.voice.accent ?? ''} onSave={(v) => void patchDoc(path, { sheet: { ...sheet, voice: { ...sheet.voice, accent: v } } })} />
            <Field label="Delivery" value={sheet.voice.delivery ?? ''} onSave={(v) => void patchDoc(path, { sheet: { ...sheet, voice: { ...sheet.voice, delivery: v } } })} />
            <div className="sm:col-span-3">
              <Field label="Voice design description" rows={2} value={sheet.voice.designDescription ?? ''} onSave={(v) => void patchDoc(path, { sheet: { ...sheet, voice: { ...sheet.voice, designDescription: v } } })} />
            </div>
          </div>
          {sheet.voice.sampleAudioPath && <div className="mt-2"><StorageAudio path={sheet.voice.sampleAudioPath} /></div>}
        </div>
      )}
    </div>
  );
}
