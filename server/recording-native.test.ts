import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { preview } from 'vite';
import { resolveOfficePython } from './python-runtime.ts';
import { officeApiPlugin } from './office-api.ts';
import { desktopHistory } from './history-desktop.ts';
import { openHistory } from './history.ts';
import { parseTraceWindow, TRACE_CADENCE_MS } from '../src/domain/trace.ts';

// The collector is unmodified. Its entire native database and the tape live in separate scratch directories.
test('tabless desktop observes an actual Python/SQLite counter increase and linked child at the next autonomous tick', {timeout:45_000}, async t=>{
  let python:string;try {python=await resolveOfficePython();}catch{t.skip('Native Python 3.12+ unavailable');return;}
  const root=fileURLToPath(new URL('../',import.meta.url)), scratch=mkdtempSync(join(process.env.TMPDIR||tmpdir(),'office-native-tape-'));
  const web=join(scratch,'app'), home=join(scratch,'native'), dir=join(scratch,'tape');
  mkdirSync(join(web,'dist'),{recursive:true});writeFileSync(join(web,'dist','index.html'),'<title>Private test fixture</title>');
  symlinkSync(join(root,'bridge'),join(web,'bridge'),'junction');
  const values={PYTHON_BIN:python,HERMES_HOME:home,OFFICE_HISTORY_DIR:dir,LOCALAPPDATA:join(scratch,'appdata'),XDG_DATA_HOME:join(scratch,'appdata')};
  const before=Object.fromEntries(Object.keys(values).map(k=>[k,process.env[k]]));Object.assign(process.env,values);
  t.after(()=>{for(const [k,v] of Object.entries(before)){if(v===undefined)delete process.env[k];else process.env[k]=v;}rmSync(scratch,{recursive:true,force:true,maxRetries:3});});
  await promisify(execFile)(python,['-I','-B','-c',
    'import sys,pathlib;sys.path.insert(0,sys.argv[1]);from bridge.tests.test_collect import CollectorTests;CollectorTests().create_store(pathlib.Path(sys.argv[2]))',root,home],{timeout:6000,windowsHide:true});
  const db=new DatabaseSync(join(home,'state.db'));
  const now=Date.now()/1000, pidns=process.platform==='linux'?':pidns='+readlinkSync('/proc/self/ns/pid').slice(5,-1):'';
  function add(id:string,source:string,parent:string|null,count:number){
    db.prepare('INSERT INTO sessions(id,source,profile_name,parent_session_id,last_activity_at,title,tool_call_count) VALUES (?,?,?,?,?,?,?)')
      .run(id,source,'default',parent,now,'PRIVATE_TITLE',count);
    db.prepare('INSERT INTO session_turn_leases VALUES (?,?,?,?)').run(id,`pid=${process.pid}${pidns}:turn=PRIVATE_FIXTURE`,now-1,now+120);
  }
  const reservation=createServer().listen(0,'127.0.0.1'); await once(reservation,'listening');
  const bound=reservation.address();assert.ok(bound && typeof bound!=='string' && bound.port!==3002);
  const port=bound.port;await new Promise<void>(done=>reservation.close(()=>done()));
  const history=desktopHistory(port),server=await preview({root:web,configFile:false,logLevel:'silent',plugins:[history.plugin,officeApiPlugin()],preview:{host:'127.0.0.1',port,strictPort:true,open:false}});
  const endpoint=`http://127.0.0.1:${port}/api/office/history`;
  const read=async()=>{const res=await fetch(endpoint,{signal:AbortSignal.timeout(2000)});assert.equal(res.status,200);return parseTraceWindow(await res.json());};
  let at:number,latest:number;
  try {
    db.exec('ALTER TABLE sessions ADD COLUMN tool_call_count INTEGER');add('PRIVATE_PARENT','desktop',null,7);
    assert.equal(await history.start(server),true);
    let first=await read();const deadline=Date.now()+6000;
    while(!first.frames.length && Date.now()<deadline){await delay(40);first=await read();}
    const a=first.frames[0];assert.ok(a);assert.equal(a.coverage,'verified');assert.equal(a.actors.length,1);
    assert.deepEqual([a.actors[0].kind,a.actors[0].signal],['session','presence']);at=a.atMs;
    db.prepare('UPDATE sessions SET tool_call_count=? WHERE id=?').run(8,'PRIVATE_PARENT');add('PRIVATE_CHILD','subagent','PRIVATE_PARENT',0);
    // No open browser, no live/history requests and no manual sampler call for an entire real interval.
    await delay(TRACE_CADENCE_MS+50);
    let next=await read();const finish=Date.now()+8500;
    while(next.lastMs===at && Date.now()<finish){await delay(80);next=await read();}
    const b=next.frames.at(-1)!; latest=b.atMs;
    assert.ok(latest>at);assert.equal(b.coverage,'verified');assert.equal(b.actors.length,2);
    assert.equal(b.actors.find(x=>x.id===a.actors[0].id)?.signal,'tool');
    assert.equal(b.actors.find(x=>x.kind==='subagent')?.parentId,a.actors[0].id);
    assert.doesNotMatch(JSON.stringify(next),/PRIVATE_|tool_call_count|meters|profileId|command/);
  } finally {db.close();await server.close();}
  const reopened=openHistory(dir,[web]);
  try {assert.deepEqual(reopened.read({end:latest!},latest!+7_200_000).frames.map(f=>f.atMs),[at!,latest!]);}
  finally {reopened.close();}
  assert.doesNotMatch(readFileSync(join(dir,'recordings.sqlite3')).toString('latin1'),/PRIVATE_|tool_call_count|Verified in-flight work/);
});
