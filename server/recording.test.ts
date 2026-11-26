import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openHistory } from './history.ts';
import { TRACE_CADENCE_MS as tick, TRACE_HOLD_MS as hold } from '../src/domain/trace.ts';

const t0 = Date.UTC(2026, 10, 4, 9), parent = 'p-'+'a'.repeat(32), child = 'p-'+'b'.repeat(32);
function bundle(atMs:number, count?: number, withChild = false) {
  const observedAt = new Date(atMs).toISOString();
  const profile = {id:'dev-privatealias', name:'PRIVATE_NAME', role:'PRIVATE_ROLE', team:'development', state:'working',
    activity:'Current turn lease or fresh running worker observed.', observedAt};
  const participant = (id:string, kind:'session'|'subagent') => ({id, kind, profileId:profile.id, name:`${kind==='session'?'Session':'Subagent'} ${id.slice(2,8).toUpperCase()}`,
    role:kind==='session'?'Active session':'Delegated subagent', team:profile.team, state:'working', activity:'Verified in-flight work.',observedAt,
    ...(kind==='subagent'?{parentId:parent}:{})});
  return {snapshot:{schemaVersion:1, mode:'live', source:'Local Hermes status bridge', observedAt, pollIntervalMs:30000, sourceHealth:'connected', warnings:[],
    agents:[profile, {...profile,id:'game-privateaggregate',team:'game',state:'idle',activity:'Native profile readable; no verified in-flight work.'}],
    participants:withChild?[participant(child,'subagent'),participant(parent,'session')]:[participant(parent,'session')]},
    meters:count===undefined?{}:{[parent]:count}};
}
async function setup(t: TestContext) {
  assert.ok(existsSync(new URL('./recording.ts',import.meta.url)), 'missing autonomous recording sampler');
  const {createRecorder} = await import('./recording.ts');
  const scratch = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'office-sampler-')), dir = join(scratch,'archive');

  let clock=t0, source:unknown=bundle(clock,5);
  const archive = openHistory(dir,[process.cwd()]);
  const recorder = createRecorder({archive, now:()=>clock, collect:async()=>{if(source instanceof Error) throw source;return source;}});
  t.after(()=>{recorder.stop();archive.close();rmSync(scratch,{recursive:true,force:true,maxRetries:3});});
  const advance = async(at:number,input:unknown)=>{clock=at;source=input;await recorder.sample();};
  const frames=()=>archive.read({},clock).frames;
  return {advance,frames,dir,archive,recorder};
}

test('saves only the roster replacement, numeric increase and exact observed edges; disk contains no names or raw meters', async t=>{
  const {advance,frames,dir}=await setup(t);
  await advance(t0,bundle(t0,5)); await advance(t0+tick,bundle(t0+tick,6));
  await advance(t0+2*tick,bundle(t0+2*tick,6,true)); await advance(t0+3*tick,bundle(t0+3*tick,6));
  const actual=frames(), profile=actual[0].actors.find(a=>a.kind==='profile')!;
  assert.match(profile.id,/^r-[0-9a-f]{32}$/); assert.deepEqual(profile,{id:profile.id,kind:'profile',team:'game',state:'idle',signal:'presence'});
  assert.deepEqual(actual.map(f=>[f.atMs,f.coverage,f.actors.length,f.actors.find(a=>a.id===parent)?.signal]),[
    [t0,'verified',2,'presence'],[t0+tick,'verified',2,'tool'],[t0+2*tick,'verified',3,'presence'],[t0+3*tick,'verified',2,'presence']]);
  assert.deepEqual(actual[2].actors.find(a=>a.id===child),{id:child,kind:'subagent',team:'development',state:'working',signal:'presence',parentId:parent});
  assert.ok(!actual[3].actors.some(a=>a.id===child));
  for(const text of [JSON.stringify(actual), ...readdirSync(dir).map(f=>readFileSync(join(dir,f)).toString('latin1'))]) {
    assert.doesNotMatch(text,/PRIVATE_|dev-privatealias|game-privateaggregate|Verified in-flight work|tool_call_count|"meters"|profileId|observedAt/);
  }
});

test('an outage does not hide recorded observations; partial, reset, missing meter, stale and restart cannot manufacture pulses',async t=>{
  const {advance,frames,archive,recorder}=await setup(t);
  await advance(t0,bundle(t0,3));
  const partial=bundle(t0+tick,5);partial.snapshot.sourceHealth='degraded';await advance(t0+tick,partial);
  await advance(t0+2*tick,bundle(t0+2*tick,12));await advance(t0+3*tick,bundle(t0+3*tick,1));
  await advance(t0+4*tick,bundle(t0+4*tick));await advance(t0+5*tick,bundle(t0+5*tick,18));
  await advance(t0+6*tick,new Error('PRIVATE_READER_ERROR'));
  assert.equal(frames()[0].coverage,'verified');assert.equal(frames().at(-1)?.coverage,'unknown');
  await advance(t0+7*tick,bundle(t0+7*tick,21));await advance(t0+8*tick,bundle(t0+8*tick,22));
  await advance(t0+9*tick,bundle(t0+9*tick-hold,200)); // Do not timestamp stale data as fresh.
  await advance(t0+10*tick,bundle(t0+10*tick+60000,225));
  const resumed=t0+10*tick+120000;await advance(resumed,bundle(resumed,300));
  await advance(resumed+tick,bundle(resumed,301)); // Same source observation in another invocation.
  assert.deepEqual(frames().map(f=>[f.coverage,f.actors.find(a=>a.id===parent)?.signal]),[
    ['verified','presence'],['partial','presence'],['verified','presence'],['verified','presence'],['verified','presence'],['verified','presence'],['unknown',undefined],
    ['verified','presence'],['verified','tool'],['unknown',undefined],['unknown',undefined],['verified','presence']]);
  assert.equal(frames().at(-1)?.atMs,resumed);
  recorder.stop();const {createRecorder}=await import('./recording.ts');
  const next=createRecorder({archive,now:()=>resumed+tick,collect:async()=>bundle(resumed+tick,500)});
  try {await next.sample();assert.equal(archive.read({},resumed+tick).frames.at(-1)?.actors.find(a=>a.id===parent)?.signal,'presence');}finally{next.stop();}
});

test('a nonverified repeat severs meter continuity without rewriting the original sample; sleep is not tool activity',async t=>{
  const {advance,frames}=await setup(t);await advance(t0,bundle(t0,1));
  const repeated=bundle(t0,1);repeated.snapshot.sourceHealth='degraded';await advance(t0+tick,repeated);
  await advance(t0+2*tick,bundle(t0+2*tick,9));await advance(t0+2*tick+120000,bundle(t0+2*tick+120000,12));
  assert.deepEqual(frames().map(f=>[f.atMs,f.coverage,f.actors.find(a=>a.id===parent)?.signal]),[
    [t0,'verified','presence'],[t0+2*tick,'verified','presence'],[t0+2*tick+120000,'verified','presence']]);
});

test('reject raw collector text, unqualified counters, extra fields and broken relationships before disk',async t=>{
  const {advance,frames,dir,archive}=await setup(t);
  const changes:Array<(b:ReturnType<typeof bundle>)=>void>=[
    b=>Object.assign(b,{note:'PRIVATE_HELPER_OUTPUT'}), b=>Object.assign(b.snapshot,{transcript:'PRIVATE_TRANSCRIPT'}),
    b=>Object.assign(b.snapshot.participants[0],{command:'PRIVATE_COMMAND'}), b=>Object.assign(b.snapshot.participants[0],{parentId:child}),
    b=>Object.assign(b.meters,{'PRIVATE_SESSION_ID':11}),b=>Object.assign(b.meters,{[child]:4}),
    ...['PRIVATE_TOOL_RESULT',null,-1,1.4,Number.MAX_SAFE_INTEGER+1].map(v=>(b:ReturnType<typeof bundle>)=>Object.assign(b.meters,{[parent]:v})),
  ];
  for(const [i,change] of changes.entries()){const at=t0+i*tick,b=bundle(at,9);change(b);await advance(at,b);}
  assert.deepEqual(frames(),changes.map((_,i)=>({atMs:t0+i*tick,coverage:'unknown',actors:[]})));
  const unsafe={atMs:t0+changes.length*tick,coverage:'verified' as const,actors:[{id:parent,kind:'session' as const,team:'general' as const,state:'working' as const,signal:'presence' as const,command:'PRIVATE_DIRECT_BIND'}]};
  assert.throws(()=>archive.append(unsafe),'a typed frame cannot bypass the pre-SQL allowlist');
  for(const f of readdirSync(dir))assert.doesNotMatch(readFileSync(join(dir,f)).toString('latin1'),/PRIVATE_|dev-privatealias|game-privateaggregate/);
});

test('autonomous single-flight interval skips missed ticks and stops without committing a late response',async t=>{
  const {archive}=await setup(t),{createRecorder}=await import('./recording.ts');
  t.mock.timers.enable({apis:['setInterval']});
  let now=t0,calls=0,unblock!:(v:unknown)=>void,signal:AbortSignal|undefined;
  const r=createRecorder({archive,now:()=>now,collect:s=>{calls++;signal=s;return new Promise(resolve=>{unblock=resolve;});}});
  try {
    r.start();r.start();assert.equal(calls,1,'starts without any reader');
    const pending=r.sample();t.mock.timers.tick(3*tick);assert.equal(calls,1);
    now+=3*tick;unblock(bundle(now,5));await pending;
    assert.deepEqual(archive.read({},now).frames.map(f=>f.atMs),[now]);
    now+=tick;t.mock.timers.tick(tick);assert.equal(calls,2);
    const late=r.sample();r.stop();assert.equal(signal?.aborted,true);unblock(bundle(now,6));await late;
    t.mock.timers.tick(3*tick);assert.equal(calls,2);assert.equal(archive.read({},now).frames.length,1);
  } finally {r.stop();t.mock.timers.reset();}
});
