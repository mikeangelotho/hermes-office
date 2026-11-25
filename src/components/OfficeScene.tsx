import { createEffect, createSignal, onCleanup, onMount, Show } from 'solid-js';
import type { OfficeAgent } from '../domain/types.ts';
import type { OfficeEngine, RoomProjection } from '../scene/engine.ts';
import type { CampusView } from '../scene/campus.ts';

export interface SceneHandle { zoom: (n: number) => void; reset: () => void; }
export function OfficeScene(props: { agents: OfficeAgent[]; focus?: CampusView; selected: string | null; night: boolean; motion: boolean; interactive?: boolean; chromeless?: boolean; onRooms?: (rooms: RoomProjection[]) => void; onSelect: (id: string | null) => void; onHandle: (handle: SceneHandle) => void }) {
  let canvas!: HTMLCanvasElement; let engine: OfficeEngine | undefined; let disposed = false;
  const [ready, setReady] = createSignal(false); const [error, setError] = createSignal<string | null>(null);
  onMount(async () => {
    try {
      const { createOffice } = await import('../scene/engine.ts'); if (disposed) return;
      engine = createOffice(canvas, { onSelect: props.onSelect, interactive: props.interactive !== false, onError: setError, onRooms: props.onRooms });
      engine.update(props.agents); engine.focus(props.focus ?? 'all'); engine.select(props.selected); engine.setNight(props.night); engine.setMotion(props.motion);
      props.onHandle({ zoom: n => engine?.zoom(n), reset: () => engine?.reset() }); setReady(true);
    } catch { setError('Your browser could not open the 3D office. The agent roster and live status still work.'); }
  });
  createEffect(() => { const agents = props.agents; if (ready()) engine?.update(agents); });
  createEffect(() => { const focus = props.focus ?? 'all'; if (ready()) engine?.focus(focus); });
  createEffect(() => { const selected = props.selected; if (ready()) engine?.select(selected); });
  createEffect(() => { const value = props.night; if (ready()) engine?.setNight(value); });
  createEffect(() => { const value = props.motion; if (ready()) engine?.setMotion(value); });
  onCleanup(() => { disposed = true; engine?.dispose(); });
  return <div class="scene-mount">
    <canvas ref={canvas} data-testid="scene-canvas" tabindex={props.interactive === false ? undefined : 0} aria-label={props.chromeless ? "Ambient low-poly office scene" : "Interactive low-poly office. Open Team to find an agent; drag to orbit, plus and minus to zoom, Home to reset."} />
    <span class="sr-only" data-testid="scene-status">{error() ? 'error' : ready() ? 'ready' : 'loading'}</span>
    <Show when={!props.chromeless && !ready() && !error()}><div class="scene-message"><span class="loading-squares"><i /><i /><i /></span><p>Resolving the office…</p><small>Connecting geometry, light, and motion.</small></div></Show>
    <Show when={!props.chromeless && error()}><div class="scene-message scene-error" role="status"><strong>The office is taking a breather.</strong><p>{error()}</p><button class="text-button" onClick={() => location.reload()}>Try again</button></div></Show>
  </div>;
}
