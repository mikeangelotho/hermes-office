import { batch,createEffect,createMemo,createSignal,onCleanup,untrack,type Accessor } from 'solid-js';
import { parseTraceWindow,TRACE_CADENCE_MS,TRACE_HOLD_MS,TRACE_WINDOW_MS,type SceneTape,type TraceFrame,type TraceWindow } from '../domain/trace.ts';
import { TraceTransport } from '../domain/trace-transport.ts';
import { officeReadOptions } from './office-read.ts';

const maxBytes=12*1024*1024;
async function readWindow(query:string,signal:AbortSignal):Promise<TraceWindow>{
  const res=await fetch('/api/office/history'+query,officeReadOptions(signal));
  if(!res.ok || !res.headers.get('Content-Type')?.includes('application/json') || !res.body || Number(res.headers.get('Content-Length'))>maxBytes){await res.body?.cancel();throw new Error('No recording');}
  const reader=res.body.getReader();const decoder=new TextDecoder('utf-8',{fatal:true});let text='',bytes=0;
  try{for(;;){const {value,done}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>maxBytes){await reader.cancel();throw new Error('Recording too large');}text+=decoder.decode(value,{stream:true});}text+=decoder.decode();}
  finally{reader.releaseLock();}
  return parseTraceWindow(JSON.parse(text));
}

/** Only an append to the same archive can carry a cached prefix into a delta. */
function continuesArchive(previous:TraceWindow,next:TraceWindow,after:number){
  if(next.firstMs===null)return true; // Authoritatively empty; the merge retains no frames.
  if(previous.lastMs===null)return next.firstMs>=after || next.frames[0]?.atMs===next.firstMs;
  return next.firstMs===previous.firstMs && next.lastMs!==null && next.lastMs>=previous.lastMs;
}

export type TracePlayer=ReturnType<typeof createTracePlayer>;
/** A live head and an archive selection have independent lifetimes. Going live never waits for a fetch. */
export function createTracePlayer(eligible:Accessor<boolean>, opened:Accessor<boolean>){
  let clock=new TraceTransport();let active=false,wide=false,lastFull=0;
  let headRequest:AbortController|undefined,oldRequest:AbortController|undefined;
  const [windowValue,setWindow]=createSignal<TraceWindow|null>(null),[frame,setFrame]=createSignal<TraceFrame|null>(null),[cursorMs,setCursor]=createSignal(clock.cursorMs);
  const [live,setLive]=createSignal(true),[rate,setRate]=createSignal(1),[archived,setArchived]=createSignal(false);
  const [headError,setHeadError]=createSignal<string|null>(null),[oldError,setOldError]=createSignal<string|null>(null);
  const [gettingHead,setGettingHead]=createSignal(false),[gettingOld,setGettingOld]=createSignal(false);
  const error=()=>oldError()??(archived()?null:headError());const loading=()=>gettingOld()||(!archived()&&gettingHead());
  // A pinned window keeps its own provenance, even while a different head is loading.
  const complete=new WeakSet<TraceWindow>();
  const fullWindow=()=>{const selected=windowValue();return selected && opened() && complete.has(selected) ? selected : null;};
  const completeHour=()=>!!fullWindow() && !loading() && !error();
  const tape=createMemo<SceneTape|undefined>(()=>{
    const f=frame();
    if(!f || f.coverage==='unknown')return !eligible() || !opened() || live()?undefined:{atMs:cursorMs(),rate:rate(),actors:[]};
    return {atMs:cursorMs(),rate:rate(),actors:f.actors,sampleAtMs:f.atMs};
  });
  function publish(){batch(()=>{setWindow(clock.window);setFrame(clock.frame);setCursor(clock.cursorMs);setRate(clock.rate);setLive(clock.live);setArchived(clock.archived);});}
  function cancelHead(){const former=headRequest;headRequest=undefined;former?.abort();setGettingHead(false);}
  function cancelOld(){const former=oldRequest;oldRequest=undefined;former?.abort();setGettingOld(false);}
  async function refresh(needsFull=false){
    if(!active||document.hidden||headRequest)return;
    const previous=clock.head;
    const full=wide&&(needsFull||!previous||!complete.has(previous)||Date.now()-lastFull>TRACE_WINDOW_MS);
    // The last successful read, even an empty one, covers up to its end. Failed reads don't advance it.
    const acquired=previous?.frames.at(-1)?.atMs ?? previous?.endMs ?? 0;
    const after=wide ? acquired : Math.max(acquired, Date.now()-TRACE_HOLD_MS);
    const ctrl=new AbortController();headRequest=ctrl;setGettingHead(true);const timeout=setTimeout(()=>ctrl.abort(),10_000);
    try{const value=await readWindow(full?'':`?after=${Math.trunc(after)}`,ctrl.signal);
      if(headRequest!==ctrl || !active)return;
      const extending=!full && previous!==null && continuesArchive(previous,value,after);
      clock.acceptHead(value,extending);
      const head=clock.head;
      if(!head || head===previous)return; // An older response was ignored, not acquired.
      if(full){complete.add(head);lastFull=Date.now();}
      else if(extending && complete.has(previous) && after<=previous.endMs)complete.add(head);
      setHeadError(null);publish();
    }catch{if(headRequest===ctrl && active)setHeadError('Recorder unavailable. No activity has been inferred.');}
    finally{clearTimeout(timeout);if(headRequest===ctrl){headRequest=undefined;setGettingHead(false);}}
  }
  async function openArchive(endMs:number){
    if(!active||!wide||document.hidden||!Number.isSafeInteger(endMs)||endMs<0)return;
    cancelOld();const ctrl=new AbortController();oldRequest=ctrl;setGettingOld(true);setOldError(null);
    const timeout=setTimeout(()=>ctrl.abort(),10_000);
    try{const value=await readWindow(`?end=${endMs}`,ctrl.signal);if(oldRequest!==ctrl||!active||!wide)return;clock.acceptArchive(value);complete.add(value);publish();}
    catch{if(oldRequest===ctrl && active)setOldError('That saved hour could not be opened.');}
    finally{clearTimeout(timeout);if(oldRequest===ctrl){oldRequest=undefined;setGettingOld(false);}}
  }
  function goLive(){if(!active)return;cancelOld();setOldError(null);clock.goLive();publish();void refresh();}
  createEffect(()=>{
    const allowed=eligible(),expanded=allowed&&opened();
    untrack(()=>{
      active=allowed;wide=expanded;
      if(!allowed){cancelHead();cancelOld();lastFull=0;clock=new TraceTransport();setOldError(null);setHeadError(null);publish();return;}
      if(!expanded){clock.goLive();setOldError(null);publish();}
      let timer:number|undefined,ticker:number|undefined;
      const halt=()=>{window.clearInterval(timer);window.clearInterval(ticker);cancelHead();cancelOld();};
      const resume=()=>{
        halt();if(document.hidden)return;clock.resetTick();clock.tick();publish();void refresh(expanded);
        timer=window.setInterval(()=>void refresh(),TRACE_CADENCE_MS);
        ticker=window.setInterval(()=>{clock.tick();publish();},expanded?100:1000);
      };
      resume();document.addEventListener('visibilitychange',resume);
      onCleanup(()=>{halt();active=false;document.removeEventListener('visibilitychange',resume);});
    });
  });
  return {window:windowValue,fullWindow,frame,cursorMs,rate,live,archived,tape,loading,error,completeHour,
    seek(ms:number){if(!active||!wide)return;cancelOld();setOldError(null);clock.seek(ms);publish();},
    play(r:number){if(!active||!wide)return;cancelOld();setOldError(null);clock.play(r);publish();},
    pause(){if(!active||!wide)return;cancelOld();setOldError(null);clock.pause();publish();},
    goLive,openArchive,refresh:()=>refresh()};
}
