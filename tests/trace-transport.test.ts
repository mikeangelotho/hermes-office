import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { parseTraceWindow,traceAt,TRACE_WINDOW_MS,TRACE_CADENCE_MS,type TraceWindow,type TraceFrame,type TraceActor } from '../src/domain/trace.ts';
const base=1_800_000_000_000;
const mother='p-'+'a'.repeat(32),child='p-'+'c'.repeat(32);
const person:TraceActor={id:mother,kind:'session',signal:'presence',state:'working',team:'general'};
const worker:TraceActor={...person,id:child,kind:'subagent',parentId:mother};
const f=(atMs:number,actors:TraceActor[]=[person]):TraceFrame=>({atMs,actors,coverage:'verified'});
function win(endMs:number,frames:TraceFrame[],firstMs=base-4*TRACE_WINDOW_MS,lastMs=frames.at(-1)?.atMs??firstMs):TraceWindow{return {version:1,startMs:endMs-TRACE_WINDOW_MS,endMs,cadenceMs:TRACE_CADENCE_MS,frames,firstMs,lastMs};}
async function harness(){ assert.ok(existsSync(new URL('../src/domain/trace-transport.ts',import.meta.url)),'missing reversible playback transport');const {TraceTransport}=await import('../src/domain/trace-transport.ts'); let wall=base,mono=1000;const p=new TraceTransport(()=>wall,()=>mono);const pass=(n:number)=>{wall+=n;mono+=n;p.tick()};return {p,pass};}

test('rewind a linked worker out of the scene, pause poses, and snap to newer live work without moving recorded time',async()=>{
  const {p,pass}=await harness();p.acceptHead(win(base,[f(base-30_000),f(base-15_000,[{...person,signal:'tool'},worker]),f(base,[person,worker])]),false);
  assert.equal(p.live,true);assert.equal(p.frame?.actors.length,2);p.seek(base-14_000);assert.equal(p.rate,0);assert.equal(p.frame?.actors[0].signal,'tool');const frozen=p.cursorMs;pass(1000);assert.equal(p.cursorMs,frozen);
  p.play(-4);pass(500);assert.equal(p.cursorMs,base-16_000);assert.equal(p.frame?.actors.length,1);
  p.pause();const held=p.cursorMs;pass(15_000);const latest=f(base+15_000,[]);p.acceptHead(win(base+16_500,[latest]),true);assert.equal(p.cursorMs,held);assert.equal(p.frame?.actors.length,1);
  p.goLive();assert.equal(p.live,true);assert.equal(p.frame?.actors.length,0);assert.equal(p.cursorMs,base+16_500);
});

test('an older saved hour is independently navigable while the live head continues recording',async()=>{
  const {p,pass}=await harness();p.acceptHead(win(base,[f(base)]),false);const old=base-2*TRACE_WINDOW_MS;
  assert.equal(typeof (p as any).acceptArchive,'function','older hour cannot be opened');p.acceptArchive(win(old,[f(old-120_000,[person,worker]),f(old-105_000,[])],old-120_000,base));
  assert.equal(p.archived,true);assert.equal(p.live,false);assert.equal(p.rate,0);assert.equal(p.cursorMs,old-120_000);assert.equal(p.frame?.actors.length,2);
  p.seek(old-1000);p.play(4);pass(1000);assert.equal(p.cursorMs,old);assert.equal(p.rate,0);assert.equal(p.archived,true);
  p.acceptHead(win(base+1000,[f(base+1000,[person,worker])]),true);assert.equal(p.window?.endMs,old);p.goLive();assert.equal(p.frame?.actors.length,2);
});

test('rolling deltas keep just a single usable predecessor, do not replace history with a sparse tail, and ignore old arrivals',async()=>{
  const {p}=await harness();const initial=win(base,[f(base-TRACE_WINDOW_MS),f(base-TRACE_WINDOW_MS+15_000),f(base-15_000)]);p.acceptHead(initial,false);
  p.acceptHead(win(base+20_000,[f(base-15_000),f(base+15_000,[person,worker])]),true);
  assert.deepEqual(p.head?.frames.map(x=>x.atMs),[base-TRACE_WINDOW_MS+15_000,base-15_000,base+15_000]);p.acceptHead(initial,false);assert.equal(p.head?.endMs,base+20_000);
});

test('reverse stops at the left edge, skips no samples and fast forward catches the rolling head',async()=>{
  const {p,pass}=await harness();p.acceptHead(win(base,[f(base)]),false);p.seek(base-TRACE_WINDOW_MS+500);p.play(-8);pass(500);assert.equal(p.cursorMs,base-TRACE_WINDOW_MS);assert.equal(p.rate,0);
  p.seek(base-4_000);p.play(16);pass(600);assert.equal(p.live,true);assert.equal(p.cursorMs,base+1100);
});

test('a delayed response cannot rewind live time or revive an expired observation',async()=>{
  const {p,pass}=await harness();p.acceptHead(win(base,[f(base)]),false);
  pass(39_000);assert.equal(p.frame,null);
  p.acceptHead(win(base+30_000,[],base,base),true);
  assert.equal(p.cursorMs,base+39_000);assert.equal(p.frame,null);
  p.seek(base);pass(2000);p.acceptHead(win(base+32_000,[],base,base),true);
  p.goLive();assert.equal(p.cursorMs,base+41_000);assert.equal(p.frame,null);
  const fresh=f(base+42_000);p.acceptHead(win(fresh.atMs,[fresh]),true);
  assert.equal(p.cursorMs,fresh.atMs);assert.equal(p.frame,fresh);
});

test('empty delta with null archive extrema clears evidence; unchanged non-null extrema do not',async()=>{
  const {p}=await harness(), sample=f(base);p.acceptHead(win(base,[sample],base,base),false);
  p.acceptHead(win(base+1000,[],base,base),true);assert.equal(p.frame,sample);
  const empty={...win(base+2000,[]),firstMs:null,lastMs:null};p.acceptHead(empty,true);
  assert.equal(p.frame,null);assert.deepEqual(parseTraceWindow(p.window),empty);
});

test('cached observations cannot lie outside the current archive extrema',async()=>{
  const {p}=await harness(), middle=f(base-15_000);
  p.acceptHead(win(base,[f(base-30_000),middle,f(base)]),false);
  p.acceptHead(win(base+1000,[],middle.atMs,middle.atMs),true);
  assert.deepEqual(parseTraceWindow(p.window).frames,[middle]);
});

test('an unchanged observation keeps its render references; a correction at the same time replaces it',async()=>{
  const {p}=await harness(), sample=f(base,[person,worker]);
  p.acceptHead(win(base,[f(base-15_000),sample]),false);p.seek(base);
  const held=p.frame, actors=held?.actors;
  for(const delta of [true,false]){
    p.acceptHead(win(base+1000,[structuredClone(sample)]),delta);
    assert.equal(p.frame,held);assert.equal(p.frame?.actors,actors);
  }
  assert.deepEqual(p.head?.frames,[sample],'a full replacement must not retain omitted history');
  const corrected=f(base,[{...person,state:'idle'},worker]);p.acceptHead(win(base+2000,[corrected]),true);
  assert.notEqual(p.frame,held);assert.deepEqual(p.frame,corrected);
});

test('auto-pinning a paused live cursor yields a seekable time inside the saved hour',async()=>{
  const {p,pass}=await harness();p.acceptHead(win(base,[f(base)]),false);
  pass(10_000);p.pause();assert.equal(p.cursorMs,base+10_000);
  const next=base+TRACE_WINDOW_MS+20_000;p.acceptHead(win(next,[f(next)]),false);
  const selected=p.window!, held=p.cursorMs;assert.ok(p.archived);
  assert.ok(held>=selected.startMs && held<=selected.endMs);
  p.seek(held);assert.equal(p.cursorMs,held);
});

test('fractional ticks accumulate, but publish one integer for both cursor and sample lookup',async()=>{
  const {p,pass}=await harness();p.acceptHead(win(base,[f(base-1000),f(base)]),false);
  p.seek(base-1);p.play(1);
  for(const dt of [.2,.2,.4])pass(dt);
  assert.equal(p.cursorMs,base);assert.equal(p.frame,traceAt(p.window,p.cursorMs));
  p.seek(base);p.play(-1);pass(.2);pass(.4);
  assert.equal(p.cursorMs,base-1);assert.equal(p.frame,traceAt(p.window,p.cursorMs));
});
