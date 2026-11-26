import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { TRACE_HOLD_MS, type TraceFrame, type TraceWindow } from '../domain/trace.ts';
import type { Coverage } from '../domain/display.ts';
import type { TracePlayer } from '../lib/trace-player.ts';
import { Icon } from './Icon.tsx';
import './trace-editor.css';

const channels = [
  { key: 'presence', label: 'Presence' }, { key: 'tools', label: 'Tool pulses' }, { key: 'links', label: 'Links' },
] as const;
const speeds = [0.5, 1, 2, 4, 16];
const ticks = [0, 0.25, 0.5, 0.75, 1];
const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const minute = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const day = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
function localMinute(ms: number) {
  const d = new Date(ms);
  return new Date(ms - d.getTimezoneOffset()*60_000).toISOString().slice(0,16);
}

// Adjacent identical samples share a run. Silence never extends one past hold expiry.
type Run = { left: number; right: number; height: number };
function extend(runs: Run[], left: number, right: number, height: number) {
  if (right <= left || height <= 0) return;
  const last = runs.at(-1);
  if (last && last.right === left && last.height === height) last.right = right;
  else runs.push({ left, right, height });
}
function bandPath(runs: Run[]) {
  return runs.map(({ left, right, height }) => `M${left} ${5-height/2}H${right}v${height}H${left}Z`).join('');
}
function score(w: TraceWindow | null) {
  const known: Run[] = [], partial: Run[] = [], presence: Run[] = [], links: Run[] = [], tools: string[] = [];
  if (w && w.endMs > w.startMs) {
    const x = (ms: number) => +((ms-w.startMs)/(w.endMs-w.startMs)*1000).toFixed(3);
    w.frames.forEach((frame, i) => {
      if (frame.coverage === 'unknown') return;
      const left = x(Math.max(w.startMs, frame.atMs));
      const right = x(Math.min(w.endMs, frame.atMs + TRACE_HOLD_MS, w.frames[i+1]?.atMs ?? w.endMs));
      extend(known, left, right, 10);
      if (frame.coverage === 'partial') extend(partial, left, right, 10);
      const count = frame.actors.length, linkCount = frame.actors.filter(a => a.parentId).length;
      if (count) extend(presence, left, right, Math.min(9, 3+count*1.5));
      if (linkCount) extend(links, left, right, Math.min(9, 3+linkCount*1.5));
      // A counter increase is a sampled event, not continuous tool use across the hold interval.
      if (frame.atMs >= w.startMs && frame.actors.some(a => a.signal === 'tool')) tools.push(`M${left} 1v8`);
    });
  }
  return { known: bandPath(known), partial: bandPath(partial), presence: bandPath(presence), links: bandPath(links), tools: tools.join('') };
}
function describe(frame: TraceFrame) {
  const n = frame.actors.length, pulses = frame.actors.filter(a => a.signal === 'tool').length, links = frame.actors.filter(a => a.parentId).length;
  return [frame.coverage === 'partial' ? 'Partial sample' : 'Verified sample', n ? `${n} present` : 'No actors observed',
    pulses && `${pulses} tool pulse${pulses === 1 ? '' : 's'}`, links && `${links} link${links === 1 ? '' : 's'}`].filter(Boolean).join(' · ');
}

/** Only a new recording window invalidates the paths and ruler; the playhead is a separate sibling. */
function Score(props: { player: TracePlayer; window: TraceWindow | null; valueText: string; enabled: boolean }) {
  const p = props.player;
  const paths = createMemo(() => score(props.window));
  const times = createMemo(() => { const w = props.window; return ticks.map(f => w ? minute.format(w.startMs+(w.endMs-w.startMs)*f) : '—'); });
  const position = createMemo(() => {
    const w = props.window; return w && w.endMs > w.startMs ? Math.max(0, Math.min(100, (p.cursorMs()-w.startMs)/(w.endMs-w.startMs)*100)) : 0;
  });
  return <div class="trace-score">
    <div class="trace-keys" aria-hidden="true"><span class="trace-index">Signal</span><For each={channels}>{c => <span class={`trace-key trace-${c.key}`}><i/>{c.label}</span>}</For></div>
    <div class="trace-rail">
      <div class="trace-ruler" aria-hidden="true"><For each={ticks}>{(f, i) => <span style={{ left: `${f*100}%` }}>{times()[i()]}</span>}</For></div>
      <div class="trace-strips" data-testid="trace-lanes" data-loaded={Boolean(props.window)} aria-hidden="true">
        <For each={channels}>{c => <svg class={`trace-lane trace-${c.key}`} data-testid={`trace-lane-${c.key}`} viewBox="0 0 1000 10" preserveAspectRatio="none">
          <path class="trace-known" d={paths().known}/><path class="trace-partial" d={paths().partial}/>
          <path data-signal="" d={paths()[c.key]} vector-effect="non-scaling-stroke"/>
        </svg>}</For>
      </div>
      <Show when={props.window}><i class="trace-needle" aria-hidden="true" style={{ left: `${position()}%` }}/></Show>
      <input type="range" data-testid="trace-range" aria-label="Recording time" aria-describedby="trace-range-help" aria-valuetext={props.valueText}
        min={props.window?.startMs ?? 0} max={props.window?.endMs ?? 1} step="1" value={p.cursorMs()} disabled={!props.enabled}
        onKeyDown={e => {
          if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.isComposing) return;
          const direction = ['ArrowLeft','ArrowDown'].includes(e.key) ? -1 : ['ArrowRight','ArrowUp'].includes(e.key) ? 1 : 0;
          if (direction) { e.preventDefault(); p.seek(e.currentTarget.valueAsNumber+1000*direction); }
        }}
        onInput={event => p.seek(event.currentTarget.valueAsNumber)}/>
    </div>
    <span class="sr-only" id="trace-range-help">Scrub the recorded hour. Arrow keys move one second. Tracks show presence, tool pulses and observed links. Hatching means no observation.</span>
  </div>;
}

export function TraceEditor(props: { player: TracePlayer; liveCoverage: Coverage; savedStatusMs: number | null; onClose: () => void }) {
  const p = props.player;
  const [speed, setSpeed] = createSignal(1);
  const [archiveOpen, setArchiveOpen] = createSignal(false), [readingHour, setReadingHour] = createSignal(false);
  const [endInput, setEndInput] = createSignal(''), [maxInput, setMaxInput] = createSignal('');
  let root!: HTMLElement, archiveButton!: HTMLButtonElement, dateInput: HTMLInputElement | undefined;
  onMount(() => {
    root.focus({ preventScroll: true });
    // This HUD describes the existing camera control only while its usual Team controls are hidden.
    const canvas = root.closest('main')?.querySelector('canvas');
    if (!canvas) return;
    const previous = canvas.getAttribute('aria-labelledby');
    canvas.setAttribute('aria-labelledby', 'trace-scene-name');
    onCleanup(() => { if (previous === null) canvas.removeAttribute('aria-labelledby'); else canvas.setAttribute('aria-labelledby', previous); });
  });
  const second = createMemo(() => Math.floor(p.cursorMs()/1000)*1000);
  const saved = createMemo(() => p.live() && !!p.error() && !p.frame() && props.savedStatusMs !== null);
  const readoutMs = createMemo(() => saved() ? props.savedStatusMs : p.window() ? second() : null);
  const stamp = createMemo(() => { const at = readoutMs(); return at !== null ? clock.format(at) : '—:—:—'; });
  const date = createMemo(() => { const at = readoutMs(); return at !== null ? day.format(at) : 'Local time'; });
  const mode = createMemo(() => {
    if (p.archived()) return 'Archive';
    if (!p.live()) return 'Replay';
    if (saved()) return 'Saved status';
    const w = p.window(), f = p.frame();
    if (!w) return p.error() ? 'Unavailable' : 'Loading';
    if (w.firstMs === null) return 'No recording';
    // Following the newest returned timestamp does not prove that it is a current observation.
    const fresh = f && f.coverage !== 'unknown' && Math.max(Math.abs(second()-f.atMs),Math.abs(Date.now()-f.atMs)) < TRACE_HOLD_MS;
    return fresh && !p.error() && props.savedStatusMs === null ? 'Live head' : 'Recorded head';
  });
  // Keep a known hour during a poll, but never draw an unfetched prefix as recording gaps.
  const fullWindow = p.fullWindow;
  const allowed = createMemo(() => !!fullWindow()?.frames.length);
  const first = createMemo(() => p.window()?.firstMs ?? null);
  const beforeFirst = createMemo(() => { const first = p.window()?.firstMs; return first != null && p.cursorMs() < first; });
  const sample = createMemo(() => {
    const w = p.window(), f = p.frame();
    if (p.live() && p.error() && !f) return props.liveCoverage === 'unknown' ? 'Recorder unavailable · Current activity unknown' : 'Recorder unavailable · Current office shown';
    if (!w) return 'Loading recording…';
    if (!fullWindow()) return p.loading() ? 'Loading full hour…' : p.archived() ? 'Partial window · Return to live to reload' : 'Full hour unavailable · Latest sample shown';
    if (w.firstMs === null) return 'No recordings yet';
    if (beforeFirst()) return 'Before first capture';
    if (p.live() && !f && w.lastMs !== null) return `No current sample · Last recorded ${day.format(w.lastMs)}, ${clock.format(w.lastMs)}`;
    if (!w.frames.length) return 'No samples in this hour';
    if (!f || f.coverage === 'unknown') return f ? 'Activity unverified' : 'Recording gap · No sample';
    return describe(f);
  });
  const valueText = () => p.window() ? `${date()}, ${stamp()}, local time. ${sample()}` : 'No recording loaded';
  const shuttle = () => p.live() ? mode() === 'Live head' ? 'Following head' : mode() === 'Recorded head' ? 'Latest recording' : 'No playback'
    : !p.rate() ? 'Paused' : `${p.rate()<0?'Reverse':'Forward'} · ${Math.abs(p.rate())}×`;
  function play(direction: number) { if (allowed()) p.play(direction*speed()); }
  function toggleArchive() {
    if (archiveOpen()) { setArchiveOpen(false); return; }
    const now = Date.now();
    setMaxInput(localMinute(now)); setEndInput(localMinute(Math.min(p.window()?.endMs ?? now, now)));
    setArchiveOpen(true); queueMicrotask(() => dateInput?.focus({ preventScroll: true }));
  }
  async function loadHour(e: SubmitEvent) {
    e.preventDefault();
    const ms = new Date(endInput()).getTime();
    if (!Number.isSafeInteger(ms) || ms < 0 || !dateInput?.reportValidity()) return;
    setArchiveOpen(false); archiveButton.focus({ preventScroll: true }); setReadingHour(true);
    try { await p.openArchive(ms); } finally { setReadingHour(false); }
  }
  function saveHour() {
    const w = p.window();
    if (!w || !p.completeHour()) return;
    // The player has already validated this complete response. No second fetch, upload or saved live roster.
    const url = URL.createObjectURL(new Blob([JSON.stringify(w)], { type: 'application/json' }));
    try {
      const download = document.createElement('a'); download.href = url;
      download.download = `office-hour-${new Date(w.endMs).toISOString().replace(/[:.]/g,'-')}.json`; download.click();
    } finally { window.setTimeout(() => URL.revokeObjectURL(url), 1000); }
  }
  function changeSpeed(next: number) { setSpeed(next); if (!p.live() && p.rate()) p.play(Math.sign(p.rate())*next); }
  function shortcut(e: KeyboardEvent) {
    if (e.key === 'Escape' && archiveOpen() && !e.isComposing && !e.defaultPrevented) {
      e.preventDefault(); e.stopPropagation(); setArchiveOpen(false); archiveButton.focus({ preventScroll: true }); return;
    }
    if (e.defaultPrevented || e.isComposing || e.repeat || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || !allowed()) return;
    if (e.target instanceof Element && e.target.closest('input,select,textarea,[contenteditable]:not([contenteditable="false"])')) return;
    switch (e.key.toLowerCase()) {
      case 'j': e.preventDefault(); play(-1); break;
      case 'k': e.preventDefault(); p.pause(); break;
      case 'l': e.preventDefault(); play(1); break;
    }
  }
  return <section ref={root} class="trace-editor" data-testid="trace-editor" aria-labelledby="trace-title" tabindex="-1" onKeyDown={shortcut}>
    <span class="sr-only" id="trace-scene-name">Office recording inspector. Drag to orbit, plus and minus to zoom, Home to reset the camera.</span>
    <div class="trace-rack">
      <header class="trace-id"><div class="trace-eyebrow"><i aria-hidden="true"/>Office hours / Signal tape</div><h2 id="trace-title">Braindance editor</h2>
        <span class="trace-mode" data-testid="trace-mode" data-mode={mode()}><i aria-hidden="true"/>{mode()}</span></header>
      <Score player={p} window={fullWindow()} valueText={valueText()} enabled={allowed()}/>
      <div class="trace-readout"><span class="trace-index">{saved() ? 'Saved' : 'Cursor'} <b>/</b> local</span><time data-testid="trace-clock" datetime={readoutMs() !== null ? new Date(readoutMs()!).toISOString() : undefined}>{stamp()}</time><span class="trace-date">{date()}</span></div>
      <button class="trace-close" type="button" aria-label="Close editor" title="Close editor" onClick={props.onClose}><Icon name="close" size={19}/></button>
    </div>
    <div class="trace-console">
      <div class="trace-shuttle" role="group" aria-label="Playback controls">
        <button type="button" class="trace-drive trace-reverse" aria-label="Play reverse" aria-keyshortcuts="J" title="Play reverse (J)" disabled={!allowed()} aria-pressed={!p.live() && p.rate()<0} onClick={() => play(-1)}><Icon name="motion" size={17}/><kbd>J</kbd></button>
        <button type="button" class="trace-drive" aria-label="Pause playback" aria-keyshortcuts="K" title="Pause playback (K)" disabled={!allowed()} aria-pressed={!p.live() && p.rate()===0} onClick={p.pause}><Icon name="pause" size={17}/><kbd>K</kbd></button>
        <button type="button" class="trace-drive" aria-label="Play forward" aria-keyshortcuts="L" title="Play forward (L)" disabled={!allowed()} aria-pressed={!p.live() && p.rate()>0} onClick={() => play(1)}><Icon name="motion" size={17}/><kbd>L</kbd></button>
        <label class="trace-speed"><span class="sr-only">Playback speed</span><select value={speed()} disabled={!allowed()} onChange={e => changeSpeed(Number(e.currentTarget.value))}><For each={speeds}>{s => <option value={s}>{s}×</option>}</For></select><Icon name="chevron" size={13}/></label>
      </div>
      <div class="trace-observation"><span class="trace-shuttle-state" data-testid="trace-shuttle-state">{shuttle()}</span><p data-testid="trace-sample">{sample()}</p>
        <small class="trace-scene-advice" role="status">3D view unavailable. The recording controls still work.</small>
        <Show when={readingHour() || (p.window() && p.error())}><small class="trace-notice" role="status">{readingHour() ? 'Loading saved hour…' : p.error()}</small></Show></div>
      <div class="trace-guide"><span class="trace-gap-legend" title="Hatched spans have no observation"><i aria-hidden="true"/>No sample</span><small>Scene cues are illustrative</small></div>
      <div class="trace-actions">
        <button ref={archiveButton} class="trace-archive-toggle" type="button" aria-label="Browse archive" aria-expanded={archiveOpen()} aria-controls={archiveOpen() ? 'trace-archive' : undefined} onClick={toggleArchive}><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true"><path d="M2 3h4l2 2h6v8H2zM4 8h8"/></svg>Archive</button>
        <button class="trace-live" type="button" onClick={() => { setArchiveOpen(false); p.goLive(); }}><i aria-hidden="true"/>Return to live</button>
      </div>
      <Show when={archiveOpen()}><form id="trace-archive" class="trace-archive" data-testid="trace-archive" aria-label="Recording archive" onSubmit={loadHour}>
        <label for="trace-hour">Hour ending (local time)</label>
        <div class="trace-archive-pick"><input id="trace-hour" ref={dateInput} type="datetime-local" required min={first() !== null ? localMinute(first()!) : undefined} max={maxInput()} value={endInput()} onInput={e => setEndInput(e.currentTarget.value)}/><button type="submit">Load hour</button></div>
        <p>{first() === null ? 'No captures indexed.' : `First capture: ${day.format(first()!)} · ${minute.format(first()!)}`}</p>
        <div class="trace-archive-foot"><span title="Scene cues are illustrative; tracks show only sampled signals."><i aria-hidden="true"/>Hatched: no sample</span><button class="trace-save" type="button" disabled={!p.completeHour()} onClick={saveHour}>Save hour as JSON</button></div>
      </form></Show>
    </div>
  </section>;
}
