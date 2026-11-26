import { createEffect, createSignal, onCleanup, type Accessor } from 'solid-js';
import { demoSnapshot } from '../domain/demo.ts';
import { parseSnapshot } from '../domain/snapshot.ts';
import type { OfficeSnapshot } from '../domain/types.ts';
import { officeReadOptions } from './office-read.ts';

export function createOfficeStatus(mode: Accessor<'live' | 'demo'>) {
  const [snapshot, setSnapshot] = createSignal<OfficeSnapshot | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [step, setStep] = createSignal(0);
  let refreshCurrent = () => {};
  createEffect(() => {
    const selectedMode = mode();
    if (selectedMode === 'demo') { setSnapshot(demoSnapshot(step())); setError(null); setLoading(false); refreshCurrent = () => setStep(s => s + 1); return; }
    let disposed = false, inflight = false; let controller: AbortController | undefined;
    const refresh = async () => {
      if (inflight || disposed || document.hidden) return;
      inflight = true; setLoading(true); controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 10_000);
      try {
        const response = await fetch('/api/office', officeReadOptions(controller.signal));
        if (!response.ok) throw new Error('Bridge unavailable');
        const next = parseSnapshot(await response.json());
        if (next.mode !== 'live') throw new Error('Unexpected source');
        if (!disposed) { setSnapshot(next); setError(null); }
      } catch { if (!disposed) setError('The local bridge is unavailable. Activity is unknown until a fresh observation arrives.'); }
      finally { clearTimeout(timeout); inflight = false; if (!disposed) setLoading(false); }
    };
    setSnapshot(null); refreshCurrent = () => { void refresh(); };
    let timer: number | undefined;
    const onVisible = () => {
      window.clearInterval(timer);
      if (document.hidden) return;
      void refresh();
      timer = window.setInterval(() => { void refresh(); }, 30_000);
    };
    onVisible();
    document.addEventListener('visibilitychange', onVisible);
    onCleanup(() => { disposed = true; window.clearInterval(timer); controller?.abort(); document.removeEventListener('visibilitychange', onVisible); });
  });
  return { snapshot, loading, error, refresh: () => refreshCurrent(), nextDemo: () => setStep(s => s + 1) };
}
