import { createMemo, createSignal, For, Index, onCleanup, onMount, Show } from 'solid-js';
import { Icon } from './components/Icon.tsx';
import { IconControl, IconControls, moveToolbarFocus } from './components/IconControl.tsx';
import { PANEL_CONTROLS, PANEL_TITLES, TEAM_ICONS } from './ui/controls.ts';
import { OfficeScene, type SceneHandle } from './components/OfficeScene.tsx';
import { TraceEditor } from './components/TraceEditor.tsx';
import { createOfficeStatus } from './lib/status.ts';
import { createTracePlayer } from './lib/trace-player.ts';
import { TRACE_HOLD_MS, traceAgents, type SceneTape } from './domain/trace.ts';
import { officeDisplay, participantFacts, qualifiedCount, workingLabel } from './domain/display.ts';
import { presentationFor } from './domain/presentation.ts';
import { STATE_LABELS, TEAM_LABELS, type OfficeAgent, type Team } from './domain/types.ts';
import { agentColor } from './scene/layout.ts';
import { ROOM_TITLES, type CampusView } from './scene/campus.ts';
import type { RoomProjection } from './scene/engine.ts';
const TEAMS: Team[] = ['general', 'studio', 'development', 'game', 'science'];
type Panel = 'team' | 'view' | 'status' | 'help' | 'agent';
const TITLES = PANEL_TITLES;
function Dot(props: { state: string }) { return <span class={`state-dot ${props.state}`} aria-hidden="true"/>; }
function Avatar(props: { agent: OfficeAgent; large?: boolean }) {
  return <span class={`avatar signal-avatar ${props.large ? 'large' : ''}`} style={{ '--avatar-color': agentColor(props.agent.id) }} aria-hidden="true"><span class="avatar-shell"/><span class="avatar-lens"/><span class="avatar-core"/></span>;
}
export default function Experience() {
  let savedView: string | null = null;
  try { savedView = localStorage.getItem('hermes-office-view-v2'); } catch { /* Storage is optional. */ }
  const presentation = presentationFor(location.search, savedView, window.self !== window.top), embedded = presentation.embedded;
  const [ambient, setAmbient] = createSignal(presentation.ambient);
  const [normalSource, setNormalSource] = createSignal(presentation.source), [team, setTeam] = createSignal<CampusView>(presentation.team);
  const mode = createMemo(() => embedded ? 'demo' : ambient() ? 'live' : normalSource());
  const eligible = () => !embedded && mode() === 'live';
  const editorRoute = () => new URLSearchParams(location.search).getAll('view').includes('editor');
  const [editorRequested, setEditorRequested] = createSignal(eligible() && editorRoute());
  const editing = createMemo(() => eligible() && editorRequested());
  const [roomLabels, setRoomLabels] = createSignal<RoomProjection[]>([]);
  const [search, setSearch] = createSignal(''), [onlyWorking, setOnlyWorking] = createSignal(false);
  const [selected, setSelected] = createSignal<string | null>(null), [panel, setPanel] = createSignal<Panel | null>(null);
  const [night, setNight] = createSignal(false), [motion, setMotion] = createSignal(true);
  const [fullscreen, setFullscreen] = createSignal(false), [screenNotice, setScreenNotice] = createSignal('');
  const [now, setNow] = createSignal(Date.now());

  const data = createOfficeStatus(mode);
  const player = createTracePlayer(eligible, editing);
  let stage!: HTMLElement, dialog!: HTMLDialogElement, viewToggle!: HTMLButtonElement, handle: SceneHandle | undefined;
  let editorEntry: HTMLButtonElement | undefined;
  let returnFocus: HTMLElement | null = null;
  const display = createMemo(() => officeDisplay(data.snapshot(), mode(), mode() === 'demo' ? 0 : now(), Boolean(data.error())));
  const savedStatusMs = createMemo(() => {
    const status = data.snapshot();
    return status?.mode === 'live' && !display().bridgeConnected ? Date.parse(status.observedAt) : null;
  });
  const agents = () => display().agents;
  // A failed recorder need not take down the original live office. A gap in replay is never a live fallback.
  const fallbackToLive = () => player.live() && Boolean(player.error()) && !player.frame();
  const rosterSource = createMemo(() => editing() && !fallbackToLive() ? 'recording' : 'office');
  const sceneAgents = createMemo(() => rosterSource() === 'recording' ? traceAgents(player.frame()) : agents(), [] as OfficeAgent[], {
    equals: (prev, next) => prev.length === next.length && prev.every((a, i) => a.id === next[i].id && a.team === next[i].team && a.state === next[i].state),
  });
  // The status roster owns live identity. An older head cannot add a worker or connect an absent parent.
  const matchedLiveActors = createMemo(() => {
    if (!eligible() || editing() || !player.live() || display().coverage === 'unknown') return [];
    const frame = player.frame();
    if (!frame || frame.coverage === 'unknown' || Math.abs(now()-frame.atMs) >= TRACE_HOLD_MS) return [];
    const observed = new Map(agents().filter(a => a.state !== 'offline').map(a => [a.id, a]));
    const matched = frame.actors.filter(a => { const current = observed.get(a.id); return current?.team === a.team && current.state === a.state; });
    const ids = new Set(matched.map(a => a.id));
    return matched.map(a => { if (!a.parentId || ids.has(a.parentId)) return a; const { parentId, ...withoutLink } = a; return withoutLink; });
  });
  const sceneTape = (): SceneTape | undefined => {
    if (!eligible()) return;
    const tape = player.tape();
    if (!tape || editing()) return tape;
    const actors = matchedLiveActors();
    return actors.length ? { ...tape, actors } : undefined;
  };
  const activity = (count: number) => workingLabel(display().coverage, count);
  const sessionCount = (count?: number) => qualifiedCount(display().coverage, count);
  const campusActivity = createMemo(() => activity(agents().filter(a => a.state === 'working').length));
  const rosterCount = (count: number) => display().coverage === 'unknown' ? 'Activity unknown' : `${count} ${count === 1 ? 'agent' : 'agents'}${display().coverage === 'partial' ? ' shown' : ''}`;
  const rosterBadge = (count: number) => display().coverage === 'unknown' ? undefined : count;
  const roomAgents = createMemo(() => agents().filter(a => team() === 'all' || a.team === team()));
  const filtered = createMemo(() => roomAgents().filter(a => (!onlyWorking() || a.state === 'working') && `${a.name} ${a.role}`.toLowerCase().includes(search().trim().toLowerCase())));
  const chosen = createMemo(() => agents().find(a => a.id === selected()));
  const person = createMemo(() => participantFacts(selected(), display().participants, display().profiles));
  const stateLabel = (agent: OfficeAgent) => mode() === 'live' && agent.state === 'offline' ? 'Activity unknown' : STATE_LABELS[agent.state];
  const contextTitle = () => team() === 'all' ? 'All swarms' : TEAM_LABELS[team() as Team];
  const working = createMemo(() => roomAgents().filter(a => a.state === 'working').length);
  const resting = createMemo(() => roomAgents().filter(a => ['idle', 'paused'].includes(a.state)).length);
  const attention = createMemo(() => roomAgents().filter(a => ['waiting', 'blocked'].includes(a.state)).length);
  const general = createMemo(() => display().profiles.find(a => a.id === 'default'));
  const bridgeConnected = () => display().bridgeConnected;
  const notice = createMemo(() => data.error() ?? (!data.snapshot() || mode() === 'demo' || display().coverage === 'verified' ? null
    : !bridgeConnected() ? 'The last observation is out of date. Current activity is unknown.'
    : display().coverage === 'unknown' ? 'No current activity could be verified.' : 'Some activity is unverified. Only observed work is counted.'));
  const observed = createMemo(() => { const at = data.snapshot()?.observedAt; if (!at) return 'Waiting for an observation'; const age = Math.max(0, Math.floor((now() - Date.parse(at)) / 1000)); return age < 10 ? 'Just now' : age < 60 ? `${age}s ago` : `${Math.floor(age / 60)}m ago`; });
  const connected = () => mode() === 'live' && display().coverage === 'verified';
  function openEditor() {
    if (!eligible() || editing()) return;
    setSelected(null);
    const url = new URL(location.href);
    if (!url.searchParams.getAll('view').includes('editor')) url.searchParams.append('view', 'editor');
    history.pushState(null, '', url);
    setEditorRequested(true);
  }
  function closeEditor() {
    if (!editing()) return;
    const url = new URL(location.href);
    url.searchParams.delete('view', 'editor');
    history.replaceState(history.state, '', url);
    setEditorRequested(false);
    queueMicrotask(() => editorEntry?.focus({ preventScroll: true }));
  }
  function setMode(source: 'live' | 'demo') {
    if (embedded || ambient()) return;
    setNormalSource(source);
    const url = new URL(location.href);
    if (source === 'demo') url.searchParams.set('source', 'demo'); else url.searchParams.delete('source');
    history.replaceState(history.state, '', url);
  }
  function switchAmbient(value: boolean) {
    if (embedded) return;
    const url = new URL(location.href);
    url.searchParams.delete('source');
    if (value) url.searchParams.set('view', 'ambient');
    else { url.searchParams.delete('view'); if (normalSource() === 'demo') url.searchParams.set('source', 'demo'); }
    history.pushState(null, '', url);
    setAmbient(value);
  }
  function switchTeam(value: CampusView) {
    setTeam(value); setSelected(null); setSearch(''); setOnlyWorking(false);
    if (!embedded) {
      try { localStorage.setItem('hermes-office-view-v2', value); } catch { /* Keep the current view in memory. */ }
      const url=new URL(location.href);url.searchParams.set('team',value);history.replaceState(null,'',url);
    }
  }
  function openPanel(value: Panel, opener?: HTMLElement) {
    if (embedded || editing()) return;
    if (!dialog.open) returnFocus = opener ?? (document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : stage.querySelector('canvas'));
    setPanel(value);
    queueMicrotask(() => {
      if (!dialog.open) dialog.showModal();
      const preferred = dialog.querySelector<HTMLElement>('[data-panel-focus]');
      const fallback = dialog.querySelector<HTMLElement>('button');
      (preferred ?? fallback)?.focus();
    });
  }
  function onClose() { setPanel(null); setSelected(null); const target = returnFocus; queueMicrotask(() => { if (target?.isConnected) target.focus(); }); }
  function chooseAgent(id: string | null) { if (!embedded && !editing()) { setSelected(id); if (id) openPanel('agent'); } }
  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (stage.requestFullscreen) await stage.requestFullscreen();
      else { setScreenNotice('Use your browser’s full-screen command for this device.'); openPanel('view'); }
    } catch { setScreenNotice('Full screen was not allowed. The scene still fills the window.'); openPanel('view'); }
  }
  onMount(() => {
    if (embedded) return;
    const changed = () => setFullscreen(Boolean(document.fullscreenElement));
    const restore = () => {
      const next = presentationFor(location.search, savedView, window.self !== window.top);
      if (next.embedded !== embedded) { location.reload(); return; }
      if (dialog.open) dialog.close();
      if (!next.ambient) setNormalSource(next.source);
      setTeam(next.team); setAmbient(next.ambient);
      setEditorRequested(!next.embedded && next.source === 'live' && editorRoute());
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || dialog.open || document.fullscreenElement || event.defaultPrevented || event.isComposing) return;
      if (editing()) {
        if ((event.target as Element | null)?.closest?.('input, select, textarea, [contenteditable="true"]')) return;
        event.preventDefault(); closeEditor();
      } else if (ambient()) {
        switchAmbient(false); viewToggle.focus();
      }
    };
    let clock: number | undefined;
    const visible = () => {
      window.clearInterval(clock);
      if (!document.hidden) { setNow(Date.now()); clock = window.setInterval(() => setNow(Date.now()), 5000); }
    };
    visible();
    document.addEventListener('visibilitychange', visible); document.addEventListener('fullscreenchange', changed);
    document.addEventListener('keydown', escape); window.addEventListener('popstate', restore);
    onCleanup(() => {
      window.clearInterval(clock); document.removeEventListener('visibilitychange', visible); document.removeEventListener('fullscreenchange', changed);
      document.removeEventListener('keydown', escape); window.removeEventListener('popstate', restore);
    });
  });

  return <main ref={stage} class={`experience ${night() ? 'evening' : ''} ${embedded ? 'embedded' : ''}`} data-presentation={embedded ? 'embedded' : editing() ? 'editor' : ambient() ? 'ambient' : 'standalone'} aria-label="Office Hours — a living office">
    <OfficeScene agents={sceneAgents()} rosterSource={rosterSource()} tape={sceneTape()} focus={team()} selected={selected()} night={night()} motion={motion()} interactive={!embedded} chromeless={embedded} ambient={ambient() && !editing()} onRooms={embedded ? undefined : setRoomLabels} onSelect={chooseAgent} onHandle={value => handle = value}/>
    <Show when={!embedded}><IconControls>
      <h1 class="sr-only">Office Hours</h1>
      <Show when={!editing()}>
      <div class="display-strip" aria-hidden={panel() ? true : undefined} inert={Boolean(panel())}>
        <Show when={ambient()}><span class="ambient-status" data-coverage={display().coverage} data-testid="source-indicator" role="status"><i aria-hidden="true"/>{display().coverage === 'unknown' ? 'Activity unknown' : `Live · ${campusActivity()}`}</span></Show>
        <div class="display-actions" role="group" aria-label="Display controls">
          <Show when={eligible()}><button ref={editorEntry} type="button" class="display-toggle trace-open" aria-label="Open braindance editor" onClick={openEditor}>
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M2 5h16M2 10h5m3 0h8M2 15h9m3 0h4M8 2v16"/></svg><span>Editor</span>
          </button></Show>
          <button ref={viewToggle} type="button" class="display-toggle" onClick={() => switchAmbient(!ambient())}><Icon name={ambient() ? 'back' : 'compass'} size={15}/>{ambient() ? 'Exit ambient view' : 'Enter ambient view'}</button>
          <Show when={ambient()}>
            <IconControl icon={motion() ? 'pause' : 'motion'} label={motion() ? 'Pause animation' : 'Resume animation'} pressed={!motion()} onClick={() => setMotion(v => !v)}/>
            <IconControl icon={fullscreen() ? 'collapse' : 'expand'} label={fullscreen() ? 'Exit full screen' : 'Enter full screen'} tipAlign="end" onClick={toggleFullscreen}/>
          </Show>
        </div>
      </div>
      <Show when={!ambient()}>
      <div class="campus-heading" aria-hidden={panel() ? true : undefined}><span class="campus-kicker">OFFICE HOURS / SHARED SPACE</span><span class="campus-title">{team() === 'all' ? 'Swarm overview' : ROOM_TITLES[team() as Team]}</span><span class="campus-meta">Campus · {campusActivity()}<Show when={display().coverage === 'verified'}> · {agents().length} observed</Show></span></div>
      <div class="room-markers" aria-label="Swarm rooms" aria-hidden={panel() ? true : undefined} inert={Boolean(panel())}>
        <Index each={roomLabels()}>{room=><Show when={room().visible}><button class={`room-marker ${room().working ? 'has-work' : ''}`} style={{left:`${room().x}px`,top:`${room().y}px`}} title={`Focus ${TEAM_LABELS[room().team]}`} onClick={()=>switchTeam(room().team)}><span class="room-marker-title">{room().title}<Icon name="arrow" size={11}/></span>{' '}<span class="room-marker-meta"><i/>{activity(room().working)}<Show when={display().coverage === 'verified'}><span> / {room().total}</span></Show></span></button></Show>}</Index>
      </div>
      <div class="world-dock" role="toolbar" aria-label="Office controls" onKeyDown={moveToolbarFocus} aria-hidden={panel() ? true : undefined} inert={Boolean(panel())}>
        <span class={`mode-indicator ${connected() ? 'connected' : ''}`} data-testid="source-indicator"
          aria-label={mode() === 'demo' ? 'Demo — simulated activity' : bridgeConnected() ? 'Live — read-only connection' : 'Live connection unavailable'}
          title={mode() === 'demo' ? 'Simulated activity — no agent jobs' : notice() ?? 'Live, read-only observations'}><span/>{mode() === 'demo' ? 'DEMO' : bridgeConnected() ? 'LIVE' : data.loading() ? 'LINK' : 'OFF'}</span>
        <span class="dock-rule"/>
        <IconControl icon="grid" label="Show all rooms" pressed={team() === 'all'} onClick={()=>switchTeam('all')}/>
        <For each={PANEL_CONTROLS.slice(0,3)}>{item => <IconControl icon={item.icon} label={item.label} popup expanded={panel() === item.panel} active={panel() === item.panel} onClick={e => openPanel(item.panel,e.currentTarget)}/>}</For>
        <span class="dock-rule"/>
        <IconControl icon={fullscreen() ? 'collapse' : 'expand'} label={fullscreen() ? 'Exit full screen' : 'Enter full screen'} onClick={toggleFullscreen}/>
        <IconControl icon="info" label="About this space" popup expanded={panel() === 'help'} onClick={e => openPanel('help',e.currentTarget)}/>
      </div>
      </Show>
      </Show>
      <Show when={editing()}><TraceEditor player={player} liveCoverage={display().coverage} savedStatusMs={savedStatusMs()} onClose={closeEditor}/></Show>
      <dialog ref={dialog} id="office-panel" class="world-panel" data-panel={panel() ?? 'team'} aria-labelledby="panel-title" onClose={onClose} onClick={e => { if(e.target === dialog) dialog.close(); }}><div class="panel-content">
        <div class="panel-rail">
          <div class="panel-navigation" role="toolbar" aria-label="Panel navigation" onKeyDown={moveToolbarFocus}>
            <For each={PANEL_CONTROLS}>{item => <IconControl icon={item.icon} label={item.label} pressed={panel() === item.panel} tipSide="bottom" onClick={() => openPanel(item.panel)}/>}</For>
          </div>
          <IconControl icon="close" label="Close panel" class="panel-close" tipSide="bottom" tipAlign="end" onClick={() => dialog.close()}/>
        </div>
        <div class="panel-heading"><h2 id="panel-title">{TITLES[panel() ?? 'team']}</h2><span class="panel-context">{contextTitle()}</span></div>
        <Show when={panel() === 'team'}>
          <nav class="team-choices" aria-label="Teams"><IconControl icon="grid" label={`All swarms, ${rosterCount(agents().length)}`} badge={rosterBadge(agents().length)} pressed={team() === 'all'} tipAlign="start" onClick={()=>switchTeam('all')}/><For each={TEAMS}>{t => {
            const count = () => agents().filter(a => a.team === t).length;
            const summary = () => display().coverage === 'unknown' ? 'Activity unknown' : `${rosterCount(count())}, ${activity(agents().filter(a => a.team === t && a.state === 'working').length)}`;
            return <IconControl icon={TEAM_ICONS[t]} label={`${TEAM_LABELS[t]}, ${summary()}`} badge={rosterBadge(count())} pressed={team() === t} tipAlign={t === 'general' ? 'start' : t === 'science' ? 'end' : 'center'} onClick={() => switchTeam(t)}/>;
          }}</For></nav>
          <label class="search-field"><Icon name="search" size={17}/><input data-panel-focus aria-label="Find an agent" placeholder="Find an agent…" value={search()} onInput={e => setSearch(e.currentTarget.value)}/><Show when={search()}><button aria-label="Clear search" onClick={() => setSearch('')}><Icon name="close" size={16}/></button></Show></label>
          <div class="roster-filters" role="group" aria-label="Agent filter"><IconControl icon="users" label="Everyone" pressed={!onlyWorking()} tipAlign="start" onClick={() => setOnlyWorking(false)}/><IconControl icon="monitor" label={`Working, ${display().coverage === 'verified' ? rosterCount(working()) : activity(working())}`} pressed={onlyWorking()} badge={display().coverage === 'verified' ? working() : working() ? `${working()}+` : undefined} onClick={() => setOnlyWorking(true)}/></div>
          <div class="agent-list"><For each={filtered()} fallback={<p class="empty-message">{data.loading() ? 'Checking who’s here…' : display().coverage === 'unknown' ? 'Activity unknown. Open Status for the connection.' : search() || onlyWorking() ? (display().coverage === 'partial' ? 'No matching observed agents.' : 'No matching agents.') : 'No observations yet. Open Status for the connection.'}</p>}>{a => <button data-testid="agent-row" class="agent-row" onClick={() => chooseAgent(a.id)}><Avatar agent={a}/><span class="agent-copy"><span class="agent-name">{a.name}</span><span class="agent-state"><Dot state={a.state}/>{stateLabel(a)}</span><Show when={sessionCount(a.activeSessions)}>{label => <span class="session-count"><Icon name="message" size={11}/>{label()} active {a.activeSessions === 1 ? 'session' : 'sessions'}</span>}</Show></span><Icon name="arrow" size={16}/></button>}</For></div>
          <div class="panel-foot"><Show when={display().coverage === 'verified'} fallback={<span>{activity(working())}{display().coverage === 'partial' ? ' · Partial coverage' : ''}</span>}>
            <span class="summary-stat" title="At desks"><Icon name="monitor" size={14}/><span aria-hidden="true">{working()+attention()}</span><span class="sr-only">{working()+attention()} at desks</span></span>
            <span class="summary-stat" title="At rest"><Icon name="couch" size={14}/><span aria-hidden="true">{resting()}</span><span class="sr-only">{resting()} at rest</span></span>
            <span class="summary-stat" title="Agents in this room"><Icon name="users" size={14}/><span aria-hidden="true">{roomAgents().length}</span><span class="sr-only">{roomAgents().length} agents in this room</span></span>
          </Show></div>
        </Show>
        <Show when={panel() === 'agent'}><section class="agent-inspector" data-testid="agent-inspector">
          <Show when={chosen()} fallback={<p role="status">No longer observed in the current roster.</p>}>{agent => <>
            <div class="inspector-person"><Avatar agent={agent()} large/><div><h3>{agent().name}</h3><span class="agent-state"><Dot state={agent().state}/>{stateLabel(agent())}</span></div></div>
            <Show when={person()}>{facts => <dl class="status-facts">
              <div><dt>Participant</dt><dd>{facts().kind}</dd></div><div><dt>Profile</dt><dd>{facts().profile}</dd></div>
              <Show when={facts().parent}><div><dt>Parent</dt><dd>{facts().parent}</dd></div></Show>
              <Show when={facts().children > 0}><div><dt>Observed children</dt><dd>{facts().children}</dd></div></Show>
            </dl>}</Show>
            <Show when={agent().activeSessions !== undefined}><dl class="status-facts"><div><dt>{mode() === 'demo' ? 'Simulated active sessions' : 'Active general sessions'}</dt><dd>{sessionCount(agent().activeSessions) ?? 'Unverified'}</dd></div></dl></Show>
            <p>{mode() === 'demo' ? 'Simulated activity. This character is not a running agent.' : agent().activity}</p>
          </>}</Show>
          <div class="panel-actions"><IconControl icon="back" label="Back to your team" autoFocus tipAlign="start" onClick={() => openPanel('team')}/><span class="readonly-caption"><Icon name="lock" size={13}/>Read-only</span></div>
        </section></Show>
        <Show when={panel() === 'view'}>
          <div class="camera-controls" role="toolbar" aria-label="Camera controls" onKeyDown={moveToolbarFocus}>
            <IconControl icon="minus" label="Zoom out" autoFocus onClick={() => handle?.zoom(-1)}/>
            <IconControl icon="reset" label="Reset view" onClick={() => handle?.reset()}/>
            <IconControl icon="plus" label="Zoom in" onClick={() => handle?.zoom(1)}/>
          </div>
          <div class="environment-controls" role="group" aria-label="Environment controls">
            <IconControl icon={night() ? 'moon' : 'sun'} label={night() ? 'Switch to daylight' : 'Switch to evening'} active={night()} class="environment-control" tipAlign="start" onClick={() => setNight(v => !v)}/>
            <IconControl icon={motion() ? 'pause' : 'motion'} label={motion() ? 'Pause animation' : 'Resume animation'} pressed={!motion()} class="environment-control" onClick={() => setMotion(v => !v)}/>
            <IconControl icon={fullscreen() ? 'collapse' : 'expand'} label={fullscreen() ? 'Exit full screen' : 'Enter full screen'} class="environment-control" tipAlign="end" onClick={toggleFullscreen}/>
          </div>
          <Show when={screenNotice()}><p class="panel-notice" role="status">{screenNotice()}</p></Show>
          <p class="gesture-hint"><Icon name="compass" size={15}/><span>Drag to orbit · scroll to zoom</span></p>
        </Show>
        <Show when={panel() === 'status'}>
          <div class="status-source-bar"><div class="source-switch" role="group" aria-label="Data source">
            <IconControl icon="activity" label="Live" autoFocus={mode() === 'live'} pressed={mode() === 'live'} tipAlign="start" onClick={() => setMode('live')}/>
            <Show when={!ambient()}><IconControl icon="cube" label="Demo" autoFocus={mode() === 'demo'} pressed={mode() === 'demo'} onClick={() => setMode('demo')}/></Show>
          </div><span class="readonly-caption"><Icon name="lock" size={13}/>Read-only</span></div>
          <Show when={mode() === 'demo'} fallback={<>
            <div class="connection-line"><Dot state={bridgeConnected() ? 'working' : 'waiting'}/>{bridgeConnected() ? 'Local bridge connected' : data.loading() ? 'Connecting local bridge…' : 'Local bridge unavailable'}</div>
            <dl class="status-facts"><div><dt>Last observation</dt><dd>{observed()}</dd></div><div><dt>Refresh interval</dt><dd>30 seconds</dd></div><div><dt>Profiles observed</dt><dd>{bridgeConnected() && data.snapshot()?.sourceHealth !== 'unavailable' ? display().profiles.length : 'Unverified'}</dd></div><div><dt>Activity coverage</dt><dd>{connected() ? 'Verified' : display().coverage === 'partial' ? 'Partial' : 'Activity unknown'}</dd></div><div><dt>Default Hermes</dt><dd>{general() ? stateLabel(general()!) : 'Unobserved'}</dd></div><div><dt>Active general sessions</dt><dd>{sessionCount(general()?.activeSessions) ?? 'Unverified'}</dd></div></dl>
            <Show when={notice()}><p class="panel-notice" role="status">{notice()}</p></Show>
            <div class="panel-actions"><IconControl icon="refresh" label={data.loading() ? 'Refreshing status' : 'Refresh status'} disabled={data.loading()} class={data.loading() ? 'is-busy' : ''} tipAlign="start" onClick={data.refresh}/><span class="micro-note">Observation only</span></div>
          </>}>
            <p class="source-caption">Simulated activity</p><p class="compact-copy">Local simulation. No agents or jobs are started.</p>
            <div class="panel-actions"><IconControl icon="next" label="Next demo state" class="primary-icon" tipAlign="start" onClick={data.nextDemo}/><span class="micro-note">Preview the next state</span></div>
          </Show>
        </Show>
        <Show when={panel() === 'help'}>
          <p class="compact-copy">Hover or focus an icon for its label. Tap once to use it.</p>
          <div class="icon-legend"><For each={PANEL_CONTROLS}>{item => <span><Icon name={item.icon} size={17}/>{item.title}</span>}</For></div>
          <p>Every swarm shares this space. Room buttons focus the camera, never hide the other bots. Select a signal-being for its actual status.</p>
          <p>Off duty: the Atelier lounges, Systems bay recharges, Play lab unwinds, the Observatory levitates, and the Quiet core rests. These are stylized poses, not inferred tasks.</p>
          <p>Live status refreshes every 30 seconds. Uncertain activity stays offline. Embedded mode has no UI or private telemetry.</p>
          <p class="gesture-hint"><Icon name="keyboard" size={16}/><span>Arrows · + / − · Home on the canvas<br/>Arrow keys between toolbar controls · Esc to close</span></p>
          <div class="panel-actions"><IconControl icon="back" label="Back to the room" autoFocus tipAlign="start" onClick={() => dialog.close()}/><span class="readonly-caption"><Icon name="lock" size={13}/>Read-only</span></div>
        </Show>
      </div></dialog>
    </IconControls></Show>
  </main>;
}

