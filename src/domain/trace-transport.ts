import { TRACE_HOLD_MS,traceAt,type TraceFrame,type TraceWindow } from './trace.ts';

function sameObservation(a:TraceFrame,b:TraceFrame){
  return a.coverage===b.coverage && a.actors.length===b.actors.length && a.actors.every((actor,i)=>{
    const other=b.actors[i];
    return actor.id===other.id && actor.kind===other.kind && actor.team===other.team && actor.state===other.state &&
      actor.signal===other.signal && actor.parentId===other.parentId;
  });
}

/** A full read replaces membership; a delta retains only evidence inside the new bounds. */
function mergeHead(old:TraceWindow|null,next:TraceWindow,delta:boolean):TraceWindow {
  const {firstMs,lastMs}=next;
  if(!old?.frames.length || firstMs===null || lastMs===null)return next;
  const cached=new Map(old.frames.map(f=>[f.atMs,f]));
  const keyed=delta ? cached : new Map<number,TraceFrame>();
  for(const f of next.frames){
    const previous=cached.get(f.atMs);
    keyed.set(f.atMs,previous && sameObservation(previous,f) ? previous : f);
  }
  const frames=[...keyed.values()];
  if(!delta)return {...next,frames};
  const lo=Math.max(firstMs,next.startMs-TRACE_HOLD_MS),hi=Math.min(lastMs,next.endMs);
  const all=frames.filter(f=>f.atMs>=lo && f.atMs<=hi).sort((a,b)=>a.atMs-b.atMs);
  const first=all.findIndex(f=>f.atMs>=next.startMs);
  return {...next,frames:first<0?all.slice(-1):all.slice(Math.max(0,first-1))};
}

/** Owns time and frames, not the camera, renderer, network, or browser timers. */
export class TraceTransport {
  head:TraceWindow|null=null;
  protected page:TraceWindow|null=null;
  live=true; archived=false; rate=1; cursorMs:number;
  private mono:()=>number;private epochMs:number;private lastTick:number;private remainderMs=0;
  constructor(wall:()=>number=Date.now,mono:()=>number=()=>performance.now()){
    this.mono=mono;this.lastTick=mono();this.cursorMs=Math.round(wall());this.epochMs=this.cursorMs-this.lastTick;
  }
  get window(){return this.archived?this.page:this.head;}
  get frame(){return traceAt(this.window,this.cursorMs);}
  private now(current=this.mono()){return Math.round(this.epochMs+current);}
  acceptHead(value:TraceWindow,delta:boolean){
    if(this.head && value.endMs<this.head.endMs)return;
    if(!this.live && !this.archived && this.head && this.cursorMs<value.startMs){
      this.page=this.head;this.archived=true;
      // The live cursor can run beyond the last read, but that time isn't part of the pinned hour.
      if(this.cursorMs>this.page.endMs){this.cursorMs=this.page.endMs;this.resetTick();}
    }
    this.head=mergeHead(this.head,value,delta);
    // Response end is a lower bound on live time at receipt, not a new clock origin.
    const current=this.mono();this.epochMs=Math.max(this.epochMs,value.endMs-current);
    if(this.live)this.cursorMs=this.now(current);
  }
  acceptArchive(value:TraceWindow){
    this.page=value;this.archived=true;this.live=false;this.rate=0;
    this.cursorMs=traceAt(value,value.startMs)?value.startMs:(value.frames.find(f=>f.atMs>=value.startMs)?.atMs??value.startMs);
    this.resetTick();
  }
  resetTick(){this.lastTick=this.mono();this.remainderMs=0;}
  tick(){
    const current=this.mono(),dt=Math.max(0,current-this.lastTick);this.lastTick=current;
    if(this.live){this.cursorMs=this.now(current);return;}
    const w=this.window;if(!this.rate||!w)return;
    // Keep sub-ms progress between ticks, not a second fractional time for sample lookup.
    const elapsed=dt*this.rate+this.remainderMs,step=Math.round(elapsed);
    this.remainderMs=elapsed-step;
    const x=this.cursorMs+step, hi=this.archived?w.endMs:this.now(current);
    if(this.rate>0 && x>=hi){if(!this.archived){this.goLive();return;}this.cursorMs=hi;this.rate=0;}
    else if(this.rate<0 && x<=w.startMs){this.cursorMs=w.startMs;this.rate=0;}
    else this.cursorMs=x;
  }
  seek(atMs:number){const w=this.window;if(!w||!Number.isFinite(atMs))return;this.live=false;this.rate=0;this.cursorMs=Math.max(w.startMs,Math.min(this.archived?w.endMs:this.now(),Math.round(atMs)));this.resetTick();}
  play(rate:number){if(!this.window||!Number.isFinite(rate)||Math.abs(rate)>64)return;if(rate===0){this.pause();return;}this.tick();if(this.live && rate>0)return;this.live=false;this.rate=rate;this.resetTick();}
  pause(){if(!this.window)return;this.tick();this.live=false;this.rate=0;this.resetTick();}
  goLive(){this.live=true;this.archived=false;this.page=null;this.rate=1;this.cursorMs=this.now();this.resetTick();}
}
