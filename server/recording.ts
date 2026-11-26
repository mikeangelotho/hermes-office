import { validateSnapshot } from './office-api.ts';
import type { HistoryArchive } from './history.ts';
import { TRACE_CADENCE_MS, TRACE_HOLD_MS, type TraceActor, type TraceFrame } from '../src/domain/trace.ts';

interface Options {
  archive: HistoryArchive;
  collect: (signal: AbortSignal) => Promise<unknown>;
  now?: () => number;
}
type Reading = {frame: TraceFrame; meters: Map<string,number>};
const unknownAt = (atMs:number): Reading => ({frame:{atMs, coverage:'unknown', actors:[]}, meters:new Map()});
function dictionary(value:unknown): value is Record<string,unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Only the frame goes to storage; native counters live in memory for one adjacent observation. */
function project(raw:unknown, now:number, previous:Reading|undefined, profileId:HistoryArchive['profileId']): Reading {
  if (!dictionary(raw) || Object.keys(raw).length !== 2 || !Object.hasOwn(raw,'snapshot') || !Object.hasOwn(raw,'meters') || !dictionary(raw.meters)) throw new Error('Invalid recording bundle');
  const s = validateSnapshot(raw.snapshot), atMs = Date.parse(s.observedAt);
  if (atMs < 0 || atMs > now || now-atMs >= TRACE_HOLD_MS) return unknownAt(now);
  const people = s.participants ?? [], ids = new Set(people.map(p=>p.id)), meters = new Map<string,number>();
  for (const [id,n] of Object.entries(raw.meters)) {
    if (!ids.has(id) || typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) throw new Error('Invalid recording meter');
    meters.set(id,n);
  }
  if (s.sourceHealth === 'unavailable') return unknownAt(atMs);
  const detailed = new Set(people.map(p=>p.profileId));
  const aggregates = s.agents.filter(a=>!detailed.has(a.id));
  const partial = s.sourceHealth==='degraded' || aggregates.some(a=>a.state==='offline');
  const actors:TraceActor[] = aggregates.filter(a=>a.state!=='offline').map(a=>({id:profileId(a.id),kind:'profile',team:a.team,state:a.state,signal:'presence'}));
  const adjacent = !partial && previous?.frame.coverage==='verified' && atMs > previous.frame.atMs && atMs-previous.frame.atMs < TRACE_HOLD_MS;
  for (const p of people) {
    const before = adjacent ? previous!.meters.get(p.id) : undefined, after = meters.get(p.id);
    actors.push({id:p.id, kind:p.kind, team:p.team, state:p.state, signal:before!==undefined && after!==undefined && after>before ? 'tool':'presence',
      ...(p.parentId ? {parentId:p.parentId}: {})});
  }
  if (partial && actors.length===0) return unknownAt(atMs);
  actors.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  return {frame:{atMs,coverage:partial?'partial':'verified',actors}, meters};
}

/** Driven by the desktop listener, not by reads. Missed timer ticks are never replayed. */
export function createRecorder({archive, collect, now=Date.now}: Options) {
  let previous:Reading|undefined, inflight:Promise<void>|undefined, timer:NodeJS.Timeout|undefined;
  const lifetime = new AbortController();
  function sample():Promise<void> {
    if (lifetime.signal.aborted) return Promise.resolve();
    if (inflight) return inflight;
    inflight = (async()=>{
      let reading:Reading;
      try { const raw=await collect(lifetime.signal); reading=project(raw,now(),previous,archive.profileId); }
      catch { reading=unknownAt(now()); }
      if (lifetime.signal.aborted) return;
      try {
        if (archive.append(reading.frame)) previous=reading;
        else if (previous) {
          // A repeated source clock is not a new frame or counter baseline. Contradictions break continuity.
          if (reading.frame.coverage!=='verified' || reading.frame.atMs!==previous.frame.atMs) previous=undefined;
          else for (const [id,n] of previous.meters) if (reading.meters.get(id)!==n) previous.meters.delete(id);
        }
      } catch { previous=undefined; } // A full or temporarily unavailable disk cannot take down the live bridge.
    })().finally(()=>{inflight=undefined;});
    return inflight;
  }
  function start() {
    if (timer || lifetime.signal.aborted) return;
    timer=setInterval(()=>void sample(),TRACE_CADENCE_MS);timer.unref();void sample();
  }
  function stop() {clearInterval(timer);lifetime.abort();previous=undefined;}
  return {sample,start,stop};
}
