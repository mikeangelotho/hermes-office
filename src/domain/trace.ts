import type { AgentState, OfficeAgent, Team } from './types.ts';
import type { Coverage } from './display.ts';

export const TRACE_WINDOW_MS = 3_600_000;
export const TRACE_CADENCE_MS = 15_000;
export const TRACE_HOLD_MS = 35_000;
export interface TraceActor { id:string; kind:'profile'|'session'|'subagent'; team:Team; state:AgentState; signal:'presence'|'tool'; parentId?:string }
export interface TraceFrame { atMs:number; coverage:Coverage; actors:TraceActor[] }
export interface TraceWindow { version:1; startMs:number; endMs:number; cadenceMs:number; firstMs:number|null; lastMs:number|null; frames:TraceFrame[] }
/** atMs is the cursor at delivery; the scene can interpolate locally at rate between player ticks. */
export interface SceneTape { atMs:number; rate:number; actors:readonly TraceActor[]; sampleAtMs?:number }

function check(ok:unknown):asserts ok { if(!ok) throw new Error('Invalid recording'); }
const stamp=(v:unknown):v is number=>typeof v==='number' && Number.isSafeInteger(v) && v>=0 && v<=8_640_000_000_000_000;
const states=new Set<AgentState>(['working','idle','waiting','blocked','paused','offline']);
const teams=new Set<Team>(['general','studio','development','game','science']);
function fields(value:unknown,required:string[],optional:string[]=[]):Record<string,unknown> {
  check(value && typeof value==='object' && !Array.isArray(value));
  check(required.every(k=>Object.hasOwn(value,k)) && Object.keys(value).every(k=>required.includes(k)||optional.includes(k)));
  return value as Record<string,unknown>;
}
function readFrame(input:unknown):TraceFrame {
  const f=fields(input,['atMs','coverage','actors']);check(stamp(f.atMs) && (f.coverage==='verified'||f.coverage==='partial'||f.coverage==='unknown'));
  check(Array.isArray(f.actors) && f.actors.length<=128 && (f.coverage!=='unknown'||!f.actors.length));
  const byId=new Map<string,TraceActor>();
  for(const raw of f.actors){
    const a=fields(raw,['id','kind','team','state','signal'],['parentId']);
    check(typeof a.id==='string' && (a.kind==='profile'?/^r-[0-9a-f]{32}$/.test(a.id):/^p-[0-9a-f]{32}$/.test(a.id)) && !byId.has(a.id));
    check(a.kind==='profile'||a.kind==='session'||a.kind==='subagent');
    check(teams.has(a.team as Team) && states.has(a.state as AgentState) && (a.signal==='presence'||a.signal==='tool'));
    check(a.signal!=='tool' || (a.kind!=='profile' && a.state==='working'));
    check(a.parentId===undefined || (typeof a.parentId==='string' && a.kind!=='profile' && /^p-[0-9a-f]{32}$/.test(a.parentId)));
    byId.set(a.id,{id:a.id,kind:a.kind,team:a.team as Team,state:a.state as AgentState,signal:a.signal,...(a.parentId?{parentId:a.parentId as string}:{})});
  }
  const checked=new Set<string>();
  for(const a of byId.values()){
    const path=new Set<string>();let row=a;
    while(row.parentId && !checked.has(row.id)){
      const parent=byId.get(row.parentId);check(parent && parent.team===row.team && !path.has(row.id));
      path.add(row.id);row=parent;
    }
    for(const item of path)checked.add(item);
  }
  return {atMs:f.atMs,coverage:f.coverage,actors:[...byId.values()]};
}
export function parseTraceWindow(input:unknown):TraceWindow {
  const w=fields(input,['version','startMs','endMs','cadenceMs','firstMs','lastMs','frames']);
  check(w.version===1 && stamp(w.startMs) && stamp(w.endMs) && w.startMs===Math.max(0,w.endMs-TRACE_WINDOW_MS) && w.cadenceMs===TRACE_CADENCE_MS);
  const first=w.firstMs,last=w.lastMs;
  check((first===null && last===null)||(stamp(first)&&stamp(last)&&first<=last));
  check(Array.isArray(w.frames) && w.frames.length<=512 && (first!==null || w.frames.length===0));
  const frames:TraceFrame[]=[];let prev=-1;
  for(const raw of w.frames){const f=readFrame(raw);check(f.atMs>prev && f.atMs<=w.endMs && first!==null && last!==null && f.atMs>=first && f.atMs<=last && (f.atMs>=w.startMs || (prev<0 && w.startMs-f.atMs<=TRACE_HOLD_MS)));frames.push(f);prev=f.atMs;}
  return {version:1,startMs:w.startMs,endMs:w.endMs,cadenceMs:w.cadenceMs,firstMs:first,lastMs:last,frames};
}
/** Latest observation at or before time; never interpolate identities or fill sleep with the previous shift. */
export function traceAt(window:TraceWindow|null, atMs:number):TraceFrame|null {
  if(!window || !Number.isFinite(atMs) || atMs<window.startMs) return null;
  const frames=window.frames; let lo=0,hi=frames.length;
  while(lo<hi){const mid=(lo+hi)>>>1;if(frames[mid].atMs<=atMs)lo=mid+1;else hi=mid;}
  const frame=frames[lo-1];return frame && atMs-frame.atMs<TRACE_HOLD_MS ? frame : null;
}
export function traceLabel(actor:TraceActor):string {
  const kind=actor.kind==='subagent'?'Subagent':actor.kind==='session'?'Session':'Profile';
  return `${kind} ${actor.id.slice(2,8).toUpperCase()}`;
}
export function traceAgents(frame:TraceFrame|null):OfficeAgent[] {
  if(!frame || frame.coverage==='unknown')return [];
  const observedAt=new Date(frame.atMs).toISOString();
  return frame.actors.map(actor=>({id:actor.id,name:traceLabel(actor),role:actor.kind==='subagent'?'Delegated subagent':actor.kind==='session'?'Session':'Profile',team:actor.team,state:actor.state,observedAt,activity:actor.signal==='tool'?'Tool activity observed.':'Recorded state observation.'}));
}
