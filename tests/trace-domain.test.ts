import test from 'node:test';
import assert from 'node:assert/strict';

// UTC milliseconds; a certified sample is held only until freshness expires, never through gaps.
const edge=1_800_000_000_000, id='p-'+ '1'.repeat(32);
const frame=(atMs:number,signal='presence')=>({atMs,coverage:'verified',actors:[{id,kind:'session',team:'general',state:'working',signal}]});
const payload=()=>({version:1,startMs:edge-3_600_000,endMs:edge,cadenceMs:15_000,firstMs:edge-3_000_000,lastMs:edge-10_000,frames:[frame(edge-3_000_000),frame(edge-10_000,'tool')]});
async function contract(){ const {existsSync}=await import('node:fs');assert.ok(existsSync(new URL('../src/domain/trace.ts',import.meta.url)),'missing safe trace reader and time lookup');return import('../src/domain/trace.ts'); }

test('a rewind before capture or into a recording gap cannot borrow a later worker',async()=>{
  const {parseTraceWindow,traceAt,traceAgents}=await contract();const reel=parseTraceWindow(payload());
  assert.equal(traceAt(reel,reel.startMs), null);assert.equal(traceAt(reel,edge-2_960_000),null);
  assert.equal(traceAt(reel,edge-2_995_000)?.actors[0].signal,'presence');assert.equal(traceAt(reel,edge)?.actors[0].signal,'tool');
  const row=traceAgents(traceAt(reel,edge))[0];assert.equal(row.id,id);assert.equal(row.name,'Session 111111');assert.equal(row.team,'general');
});

test('rejects extra text, invalid aliases, fabricated parent edges and impossible coverage at the client boundary',async()=>{
  const {parseTraceWindow}=await contract();
  const changes:Array<(w:any)=>void>=[w=>w.note='private',w=>w.frames[0].actors[0].name='private',w=>w.frames[0].actors[0].id='native-session',w=>w.frames[0].actors[0].parentId=id,w=>w.frames[0].actors[0].parentId='p-'+'7'.repeat(32),w=>w.frames[0].actors.push(w.frames[0].actors[0]),w=>w.frames[0].coverage='unknown',w=>w.frames.reverse(),w=>w.endMs+=60_000,w=>w.frames.push(frame(w.endMs+1)),w=>w.frames[0].actors[0].signal='read some/path',w=>w.frames[0].actors[0].kind='profile'];
  for(const change of changes){const candidate=payload();change(candidate);assert.throws(()=>parseTraceWindow(candidate),/recording/i,String(change));}
  const good=payload();const original=JSON.stringify(good);const parsed=parseTraceWindow(good);assert.deepEqual(parsed,good);good.frames[0].actors[0].state='blocked';assert.equal(JSON.stringify(parsed),original,'input is not retained by reference');
});

test('the checked hour cannot be confused with 60 minutes of observed activity',async()=>{
  const {parseTraceWindow,traceAt}=await contract();const end=1800000000000;
  const blank={version:1,startMs:end-3600000,endMs:end,cadenceMs:15000,firstMs:null,lastMs:null,frames:[]};const w=parseTraceWindow(blank);
  assert.equal(traceAt(w,end),null);assert.equal(traceAt(w,end-3_599_999),null);
  const current=frame(end-2000);const short=parseTraceWindow({...blank,firstMs:current.atMs,lastMs:current.atMs,frames:[current]});assert.equal(traceAt(short,end-5000),null);assert.equal(traceAt(short,end)?.actors.length,1);
});

test('partial coverage, verified quiet, missing tape and outage are distinct',async()=>{
  const {parseTraceWindow,traceAt,traceLabel}=await contract();const input=payload();
  const child='p-'+'2'.repeat(32),r='r-'+'3'.repeat(32);(input.frames as any)=[{atMs:edge-24_000,coverage:'partial',actors:[...frame(0).actors,{id:child,kind:'subagent',team:'general',signal:'presence',state:'working',parentId:id}]},{atMs:edge-19_000,coverage:'verified',actors:[{id:r,kind:'profile',team:'studio',signal:'presence',state:'idle'}]},{atMs:edge-10_000,coverage:'unknown',actors:[]}];
  const w=parseTraceWindow(input);assert.equal(traceAt(w,edge-25_000),null);assert.equal(traceAt(w,edge-22_000)?.actors.length,2);assert.equal(traceAt(w,edge-14_000)?.actors[0].state,'idle');assert.equal(traceAt(w,edge-1)?.coverage,'unknown');assert.equal(traceLabel(w.frames[1].actors[0]),'Profile 333333');
});
