import { createMemo, createSignal, For, Index, onCleanup, onMount, Show } from 'solid-js';
import { Icon } from './components/Icon.tsx';
import { IconControl, IconControls, moveToolbarFocus } from './components/IconControl.tsx';
import { PANEL_CONTROLS, PANEL_TITLES, TEAM_ICONS } from './ui/controls.ts';
import { OfficeScene, type SceneHandle } from './components/OfficeScene.tsx';
import { createOfficeStatus } from './lib/status.ts';
import { effectiveAgent } from './domain/state.ts';
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
  const presentation = presentationFor(location.search, savedView), embedded = presentation.embedded;
  const [mode, setMode] = createSignal(presentation.source), [team, setTeam] = createSignal<CampusView>(presentation.team);
  const [roomLabels, setRoomLabels] = createSignal<RoomProjection[]>([]);
  const [search, setSearch] = createSignal(''), [onlyWorking, setOnlyWorking] = createSignal(false);
  const [selected, setSelected] = createSignal<string | null>(null), [panel, setPanel] = createSignal<Panel | null>(null);
  const [night, setNight] = createSignal(false), [motion, setMotion] = createSignal(true);
  const [fullscreen, setFullscreen] = createSignal(false), [screenNotice, setScreenNotice] = createSignal('');
  const [now, setNow] = createSignal(Date.now());
  const clock = embedded ? undefined : setInterval(() => setNow(Date.now()), 5000);
  onCleanup(() => { if (clock) clearInterval(clock); });
  const data = createOfficeStatus(mode);
  let stage!: HTMLElement, dialog!: HTMLDialogElement, handle: SceneHandle | undefined;
  let returnFocus: HTMLElement | null = null;
  const agents = createMemo(() => (data.snapshot()?.agents ?? []).map(a => mode() === 'demo' ? a : effectiveAgent(a, now())));
  const roomAgents = createMemo(() => agents().filter(a => team() === 'all' || a.team === team()));
  const filtered = createMemo(() => roomAgents().filter(a => (!onlyWorking() || a.state === 'working') && `${a.name} ${a.role}`.toLowerCase().includes(search().trim().toLowerCase())));
  const chosen = createMemo(() => agents().find(a => a.id === selected()));
  const contextTitle = () => team() === 'all' ? 'All swarms' : TEAM_LABELS[team() as Team];
  const working = createMemo(() => roomAgents().filter(a => a.state === 'working').length);
  const resting = createMemo(() => roomAgents().filter(a => ['idle', 'paused'].includes(a.state)).length);
  const attention = createMemo(() => roomAgents().filter(a => ['waiting', 'blocked'].includes(a.state)).length);
  const general = createMemo(() => agents().find(a => a.id === 'default'));
  const bridgeConnected = createMemo(() => mode() === 'live' && !data.error() && data.snapshot()?.mode === 'live' && now() - Date.parse(data.snapshot()!.observedAt) < 120000);
  const notice = createMemo(() => data.error() || (mode() === 'live' && data.snapshot() && data.snapshot()?.sourceHealth !== 'connected' ? data.snapshot()?.warnings[0] ?? 'Some runtime activity is unverified. Offline is not the same as idle.' : null));
  const observed = createMemo(() => { const at = data.snapshot()?.observedAt; if (!at) return 'Waiting for an observation'; const age = Math.max(0, Math.floor((now() - Date.parse(at)) / 1000)); return age < 10 ? 'Just now' : age < 60 ? `${age}s ago` : `${Math.floor(age / 60)}m ago`; });
  const connected = createMemo(() => mode() === 'live' && !notice() && data.snapshot()?.sourceHealth === 'connected' && now() - Date.parse(data.snapshot()!.observedAt) < 120000);
  function switchTeam(value: CampusView) {
    setTeam(value); setSelected(null); setSearch(''); setOnlyWorking(false);
    if (!embedded) {
      try { localStorage.setItem('hermes-office-view-v2', value); } catch { /* Keep the current view in memory. */ }
      const url=new URL(location.href);url.searchParams.set('team',value);history.replaceState(null,'',url);
    }
  }
  function openPanel(value: Panel, opener?: HTMLElement) {
    if (embedded) return;
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
  function chooseAgent(id: string | null) { if (!embedded) { setSelected(id); if (id) openPanel('agent'); } }
  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (stage.requestFullscreen) await stage.requestFullscreen();
      else { setScreenNotice('Use your browser’s full-screen command for this device.'); openPanel('view'); }
    } catch { setScreenNotice('Full screen was not allowed. The scene still fills the window.'); openPanel('view'); }
  }
  onMount(() => { if (embedded) return; const changed = () => setFullscreen(Boolean(document.fullscreenElement)); document.addEventListener('fullscreenchange', changed); onCleanup(() => document.removeEventListener('fullscreenchange', changed)); });

  return <main ref={stage} class={`experience ${night() ? 'evening' : ''} ${embedded ? 'embedded' : ''}`} data-presentation={embedded ? 'embedded' : 'standalone'} aria-label="Office Hours — a living office">
    <OfficeScene agents={agents()} focus={team()} selected={selected()} night={night()} motion={motion()} interactive={!embedded} chromeless={embedded} onRooms={embedded ? undefined : setRoomLabels} onSelect={chooseAgent} onHandle={value => handle = value}/>
    <Show when={!embedded}><IconControls>
      <h1 class="sr-only">Office Hours</h1>
      <div class="campus-heading" aria-hidden={panel() ? true : undefined}><span class="campus-kicker">OFFICE HOURS / SHARED SPACE</span><span class="campus-title">{team() === 'all' ? 'Swarm overview' : ROOM_TITLES[team() as Team]}</span><span class="campus-meta">Campus · {agents().filter(a=>a.state==='working').length} working · {agents().length} observed</span></div>
      <div class="room-markers" aria-label="Swarm rooms" aria-hidden={panel() ? true : undefined} inert={Boolean(panel())}>
        <Index each={roomLabels()}>{room=><Show when={room().visible}><button class={`room-marker ${room().working ? 'has-work' : ''}`} style={{left:`${room().x}px`,top:`${room().y}px`}} title={`Focus ${TEAM_LABELS[room().team]}`} onClick={()=>switchTeam(room().team)}><span class="room-marker-title">{room().title}<Icon name="arrow" size={11}/></span>{' '}<span class="room-marker-meta"><i/>{room().working} working <span> / {room().total}</span></span></button></Show>}</Index>
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
      <dialog ref={dialog} id="office-panel" class="world-panel" data-panel={panel() ?? 'team'} aria-labelledby="panel-title" onClose={onClose} onClick={e => { if(e.target === dialog) dialog.close(); }}><div class="panel-content">
        <div class="panel-rail">
          <div class="panel-navigation" role="toolbar" aria-label="Panel navigation" onKeyDown={moveToolbarFocus}>
            <For each={PANEL_CONTROLS}>{item => <IconControl icon={item.icon} label={item.label} pressed={panel() === item.panel} tipSide="bottom" onClick={() => openPanel(item.panel)}/>}</For>
          </div>
          <IconControl icon="close" label="Close panel" class="panel-close" tipSide="bottom" tipAlign="end" onClick={() => dialog.close()}/>
        </div>
        <div class="panel-heading"><h2 id="panel-title">{TITLES[panel() ?? 'team']}</h2><span class="panel-context">{contextTitle()}</span></div>
        <Show when={panel() === 'team'}>
          <nav class="team-choices" aria-label="Teams"><IconControl icon="grid" label={`All swarms, ${agents().length} agents`} badge={agents().length} pressed={team() === 'all'} tipAlign="start" onClick={()=>switchTeam('all')}/><For each={TEAMS}>{t => {
            const count = () => agents().filter(a => a.team === t).length;
            return <IconControl icon={TEAM_ICONS[t]} label={`${TEAM_LABELS[t]}, ${count()} ${count() === 1 ? 'agent' : 'agents'}, ${agents().filter(a=>a.team===t&&a.state==='working').length} working`} badge={count()} pressed={team() === t} tipAlign={t === 'general' ? 'start' : t === 'science' ? 'end' : 'center'} onClick={() => switchTeam(t)}/>;
          }}</For></nav>
          <label class="search-field"><Icon name="search" size={17}/><input data-panel-focus aria-label="Find an agent" placeholder="Find an agent…" value={search()} onInput={e => setSearch(e.currentTarget.value)}/><Show when={search()}><button aria-label="Clear search" onClick={() => setSearch('')}><Icon name="close" size={16}/></button></Show></label>
          <div class="roster-filters" role="group" aria-label="Agent filter"><IconControl icon="users" label="Everyone" pressed={!onlyWorking()} tipAlign="start" onClick={() => setOnlyWorking(false)}/><IconControl icon="monitor" label={`Working, ${working()} ${working() === 1 ? 'agent' : 'agents'}`} pressed={onlyWorking()} badge={working()} onClick={() => setOnlyWorking(true)}/></div>
          <div class="agent-list"><For each={filtered()} fallback={<p class="empty-message">{data.loading() ? 'Checking who’s here…' : search() || onlyWorking() ? 'No matching agents.' : 'No observations yet. Open Status for the connection.'}</p>}>{a => <button data-testid="agent-row" class="agent-row" onClick={() => chooseAgent(a.id)}><Avatar agent={a}/><span class="agent-copy"><span class="agent-name">{a.name}</span><span class="agent-state"><Dot state={a.state}/>{STATE_LABELS[a.state]}</span><Show when={a.activeSessions !== undefined}><span class="session-count"><Icon name="message" size={11}/>{a.activeSessions} active {a.activeSessions === 1 ? 'session' : 'sessions'}</span></Show></span><Icon name="arrow" size={16}/></button>}</For></div>
          <div class="panel-foot">
            <span class="summary-stat" title="At desks"><Icon name="monitor" size={14}/><span aria-hidden="true">{working()+attention()}</span><span class="sr-only">{working()+attention()} at desks</span></span>
            <span class="summary-stat" title="At rest"><Icon name="couch" size={14}/><span aria-hidden="true">{resting()}</span><span class="sr-only">{resting()} at rest</span></span>
            <span class="summary-stat" title="Agents in this room"><Icon name="users" size={14}/><span aria-hidden="true">{roomAgents().length}</span><span class="sr-only">{roomAgents().length} agents in this room</span></span>
          </div>
        </Show>
        <Show when={panel() === 'agent' && chosen()}><section class="agent-inspector" data-testid="agent-inspector">
          <div class="inspector-person"><Avatar agent={chosen()!} large/><div><h3>{chosen()!.name}</h3><span class="agent-state"><Dot state={chosen()!.state}/>{STATE_LABELS[chosen()!.state]}</span></div></div>
          <Show when={chosen()!.activeSessions !== undefined}><dl class="status-facts"><div><dt>{mode() === 'demo' ? 'Simulated active sessions' : 'Active general sessions'}</dt><dd>{chosen()!.activeSessions}</dd></div></dl></Show>
          <p>{mode() === 'demo' ? 'Simulated activity. This character is not a running agent.' : chosen()!.activity}</p>
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
            <IconControl icon="cube" label="Demo" autoFocus={mode() === 'demo'} pressed={mode() === 'demo'} onClick={() => setMode('demo')}/>
          </div><span class="readonly-caption"><Icon name="lock" size={13}/>Read-only</span></div>
          <Show when={mode() === 'demo'} fallback={<>
            <div class="connection-line"><Dot state={bridgeConnected() ? 'working' : 'waiting'}/>{bridgeConnected() ? 'Local bridge connected' : data.loading() ? 'Connecting local bridge…' : 'Local bridge unavailable'}</div>
            <dl class="status-facts"><div><dt>Last observation</dt><dd>{observed()}</dd></div><div><dt>Refresh interval</dt><dd>30 seconds</dd></div><div><dt>Profiles observed</dt><dd>{agents().length}</dd></div><div><dt>Activity coverage</dt><dd>{connected() ? 'Verified' : 'Partial / unverified'}</dd></div><div><dt>Default Hermes</dt><dd>{general() ? STATE_LABELS[general()!.state] : 'Unobserved'}</dd></div><div><dt>Active general sessions</dt><dd>{general()?.activeSessions ?? 'Unverified'}</dd></div></dl>
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

