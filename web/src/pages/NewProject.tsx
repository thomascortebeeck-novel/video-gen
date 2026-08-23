import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { createProject, addSubject, runBriefingPipeline, NewSubjectFiles } from '../lib/api';
import { Spinner } from '../components/ui';
import type { AspectRatio, ProjectInput, Resolution } from '@shared/types';

interface DraftSubject extends NewSubjectFiles { key: number }

const STYLE_PRESETS = [
  { id: 'cinematic', label: 'Cinematic', hint: 'Large-format clarity, deep focus, true film grain' },
  { id: 'ugc_handheld', label: 'UGC / handheld', hint: 'Phone video, natural shake, live sound' },
  { id: 'commercial', label: 'Commercial', hint: 'Crisp product-ad look, controlled light' },
  { id: 'documentary', label: 'Documentary', hint: '35mm doc look, natural light' },
  { id: 'camcorder_2000s', label: '2000s camcorder', hint: 'Soft video grain, blown highlights, date stamp' },
];

export default function NewProject() {
  const nav = useNavigate();
  const [subjects, setSubjects] = useState<DraftSubject[]>([
    { key: 1, kind: 'character', name: '', notes: '', angleSet: 'fast', files: [] },
  ]);
  const [title, setTitle] = useState('');
  const [concept, setConcept] = useState('');
  const [who, setWho] = useState('');
  const [what, setWhat] = useState('');
  const [where, setWhere] = useState('');
  const [when, setWhen] = useState('');
  const [extraNotes, setExtraNotes] = useState('');
  const [durationSec, setDurationSec] = useState(30);
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>('16:9');
  const [resolution, setResolution] = useState<Resolution>('720p');
  const [videoEngine, setVideoEngine] = useState<NonNullable<ProjectInput['videoEngine']>>('auto');
  const [stylePreset, setStylePreset] = useState('cinematic');
  const [styleNotes, setStyleNotes] = useState('');
  const [dialogueEnabled, setDialogueEnabled] = useState(true);
  const [dialogueNotes, setDialogueNotes] = useState('');
  const [audio, setAudio] = useState({ music: true, sfx: true, ambience: true, characterVoices: false, subtitles: false });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const patchSubject = (key: number, patch: Partial<DraftSubject>) =>
    setSubjects((ss) => ss.map((s) => (s.key === key ? { ...s, ...patch } : s)));

  const canSubmit = concept.trim().length >= 3
    && subjects.every((s) => s.name.trim().length > 0)
    && subjects.some((s) => s.files.length > 0 || s.kind === 'character');

  async function submit() {
    setError(null);
    setBusy('Creating project…');
    try {
      const input: ProjectInput = {
        concept, who, what, where, when, extraNotes,
        durationSec, aspectRatio, resolution, videoEngine, stylePreset, styleNotes,
        dialogueEnabled, dialogueNotes,
        audio,
      };
      const projectId = await createProject(input, title || concept.slice(0, 48));
      for (const s of subjects) {
        setBusy(`Uploading ${s.name}…`);
        await addSubject(projectId, s);
      }
      setBusy('Starting the director…');
      // Fire and forget — progress is streamed to the project page via Firestore.
      void runBriefingPipeline(projectId).catch((e) => console.error('pipeline', e));
      nav(`/p/${projectId}`);
    } catch (e) {
      setError(String((e as Error).message ?? e));
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-1 text-xl font-semibold text-zinc-100">New project</h1>
      <p className="mb-6 text-sm text-zinc-500">
        1 — Upload the people/products that must appear. 2 — Tell the director what the video is about. 3 — Generate.
      </p>

      {/* ---- Subjects ---- */}
      <div className="card mb-6 p-5">
        <h2 className="mb-1 font-medium text-zinc-100">1 · Characters & products</h2>
        <p className="mb-4 text-xs text-zinc-500">
          Characters get a locked written sheet + a casting <strong>screen test</strong> (a short video master — the
          identity and voice every scene follows; recast until you like the person). Products get a reference sheet +
          angle images (count auto-chosen by product type).
        </p>
        {subjects.map((s) => (
          <div key={s.key} className="mb-3 rounded-lg border border-zinc-800 p-4">
            <div className="flex flex-wrap items-center gap-3">
              <select className="input w-36" value={s.kind}
                onChange={(e) => patchSubject(s.key, { kind: e.target.value as 'character' | 'product' })}>
                <option value="character">Character</option>
                <option value="product">Product</option>
              </select>
              <input className="input flex-1 min-w-40" placeholder={s.kind === 'character' ? 'Name (e.g. Lena)' : 'Product name (e.g. Raid climbing shoe)'}
                value={s.name} onChange={(e) => patchSubject(s.key, { name: e.target.value })} />
              {s.kind === 'character' && (
                <select className="input w-44" value={s.angleSet}
                  onChange={(e) => patchSubject(s.key, { angleSet: e.target.value as DraftSubject['angleSet'] })}>
                  <option value="fast">Fast set (8 angles)</option>
                  <option value="full">Full set (12 angles)</option>
                  <option value="minimal">Minimal (4 angles)</option>
                </select>
              )}
              {subjects.length > 1 && (
                <button className="btn btn-danger" onClick={() => setSubjects((ss) => ss.filter((x) => x.key !== s.key))}>
                  Remove
                </button>
              )}
            </div>
            <textarea className="input mt-3" rows={2}
              placeholder={s.kind === 'character'
                ? 'Notes: who are they in the story, outfit wishes, anything that matters…'
                : 'Notes: what is it for, materials, what it must NOT look like…'}
              value={s.notes} onChange={(e) => patchSubject(s.key, { notes: e.target.value })} />
            <div className="mt-3 flex items-center gap-3">
              <input type="file" accept="image/*" multiple
                className="text-sm text-zinc-400 file:mr-3 file:rounded-lg file:border-0 file:bg-zinc-800 file:px-3 file:py-1.5 file:text-sm file:text-zinc-200 hover:file:bg-zinc-700"
                onChange={(e) => patchSubject(s.key, { files: Array.from(e.target.files ?? []) })} />
              <span className="text-xs text-zinc-500">
                {s.files.length > 0 ? `${s.files.length} photo(s)` : s.kind === 'character' ? 'No photo → the director invents the face' : 'Product photos strongly recommended'}
              </span>
            </div>
          </div>
        ))}
        <button className="btn btn-ghost"
          onClick={() => setSubjects((ss) => [...ss, { key: Date.now(), kind: 'character', name: '', notes: '', angleSet: 'fast', files: [] }])}>
          + Add another subject
        </button>
      </div>

      {/* ---- Story ---- */}
      <div className="card mb-6 p-5">
        <h2 className="mb-4 font-medium text-zinc-100">2 · The video</h2>
        <div className="grid gap-4">
          <div>
            <label className="label">Working title (optional)</label>
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Raid shoes — gym review" />
          </div>
          <div>
            <label className="label">Concept — what is this video about?</label>
            <textarea className="input" rows={3} value={concept} onChange={(e) => setConcept(e.target.value)}
              placeholder="e.g. A UGC-style review: our climber tests the Raid shoes in a bouldering gym, casual and funny, ends with an honest verdict." />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div><label className="label">Who</label><input className="input" value={who} onChange={(e) => setWho(e.target.value)} placeholder="Who appears / who speaks" /></div>
            <div><label className="label">What happens</label><input className="input" value={what} onChange={(e) => setWhat(e.target.value)} placeholder="Key beats or actions" /></div>
            <div><label className="label">Where</label><input className="input" value={where} onChange={(e) => setWhere(e.target.value)} placeholder="Location(s)" /></div>
            <div><label className="label">When</label><input className="input" value={when} onChange={(e) => setWhen(e.target.value)} placeholder="Time of day / era / season" /></div>
          </div>
          <div>
            <label className="label">Anything else</label>
            <textarea className="input" rows={2} value={extraNotes} onChange={(e) => setExtraNotes(e.target.value)} placeholder="Tone, jokes, must-have shots, references…" />
          </div>
        </div>
      </div>

      {/* ---- Format & style ---- */}
      <div className="card mb-6 p-5">
        <h2 className="mb-4 font-medium text-zinc-100">3 · Format, style & audio</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <label className="label">Duration — {durationSec}s</label>
            <input type="range" min={5} max={120} step={5} value={durationSec}
              onChange={(e) => setDurationSec(Number(e.target.value))} className="w-full accent-amber-500" />
            <p className="mt-1 text-[11px] text-zinc-600">Longer videos are split into scenes and stitched (extend / frame bridging).</p>
          </div>
          <div>
            <label className="label">Aspect ratio</label>
            <select className="input" value={aspectRatio} onChange={(e) => setAspectRatio(e.target.value as AspectRatio)}>
              <option>16:9</option><option>9:16</option><option>1:1</option><option>4:3</option><option>3:4</option><option>21:9</option>
            </select>
          </div>
          <div>
            <label className="label">Resolution</label>
            <select className="input" value={resolution} onChange={(e) => setResolution(e.target.value as Resolution)}>
              <option>480p</option><option>720p</option><option>1080p</option>
            </select>
          </div>
        </div>
        <div className="mt-4">
          <label className="label">Video engine</label>
          <select className="input" value={videoEngine} onChange={(e) => setVideoEngine(e.target.value as NonNullable<ProjectInput['videoEngine']>)}>
            <option value="auto">Auto — best available (recommended)</option>
            <option value="ark25">Seedance 2.5 — BytePlus ModelArk (official, cheapest)</option>
            <option value="fal25">Seedance 2.5 — fal.ai</option>
          </select>
          <p className="mt-1 text-[11px] text-zinc-600">
            Note: all Seedance 2.5 APIs currently reject reference images of people — character identity is
            carried by generated footage (extends and video references) instead of the angle sheets.
          </p>
        </div>
        <div className="mt-4">
          <label className="label">Style</label>
          <div className="flex flex-wrap gap-2">
            {STYLE_PRESETS.map((p) => (
              <button key={p.id} title={p.hint}
                className={`btn ${stylePreset === p.id ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => setStylePreset(p.id)}>
                {p.label}
              </button>
            ))}
          </div>
          <input className="input mt-2" value={styleNotes} onChange={(e) => setStyleNotes(e.target.value)}
            placeholder="Style notes: palette, references, lens wishes…" />
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="flex items-center gap-2 text-sm text-zinc-300">
            <input type="checkbox" className="accent-amber-500" checked={dialogueEnabled} onChange={(e) => setDialogueEnabled(e.target.checked)} />
            Characters speak (dialogue with lip-sync)
          </label>
          {dialogueEnabled && (
            <input className="input sm:col-span-2" value={dialogueNotes} onChange={(e) => setDialogueNotes(e.target.value)}
              placeholder="Script wishes or exact lines (optional — the director writes them otherwise)" />
          )}
          {([
            ['music', 'Music'], ['sfx', 'Sound effects'], ['ambience', 'Ambience'],
            ['subtitles', 'Subtitles'], ['characterVoices', 'Custom voice per character (ElevenLabs, v2)'],
          ] as const).map(([k, label]) => (
            <label key={k} className="flex items-center gap-2 text-sm text-zinc-300">
              <input type="checkbox" className="accent-amber-500" checked={audio[k]}
                onChange={(e) => setAudio((a) => ({ ...a, [k]: e.target.checked }))} />
              {label}
            </label>
          ))}
        </div>
      </div>

      {error && <p className="mb-4 rounded-lg border border-red-900 bg-red-950/40 p-3 text-sm text-red-300">{error}</p>}
      <div className="flex items-center gap-3">
        <button className="btn btn-primary px-6 py-2.5 text-base" disabled={!canSubmit || busy !== null} onClick={() => void submit()}>
          {busy ? (<><Spinner /> {busy}</>) : 'Generate briefing'}
        </button>
        <p className="text-xs text-zinc-500">
          Generates the character/product sheets, angle images, environments and the full scene briefing — you review everything before any video is made.
        </p>
      </div>
    </div>
  );
}
