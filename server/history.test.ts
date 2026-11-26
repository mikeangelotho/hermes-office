import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, mkdirSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TRACE_CADENCE_MS as tick, TRACE_WINDOW_MS as hour, type TraceFrame } from '../src/domain/trace.ts';

const t0 = Date.UTC(2026, 10, 4, 9);
const sample = (atMs: number): TraceFrame => ({atMs, coverage: 'verified', actors: []});
function temporary(t: TestContext) {
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'office-history-'));
  t.after(() => rmSync(dir, {recursive: true, force: true, maxRetries: 3}));
  return dir;
}
const archiveDir = (t: TestContext) => join(temporary(t), 'archive');
async function history() {
  assert.ok(existsSync(new URL('./history.ts', import.meta.url)), 'missing durable Office archive');
  return import('./history.ts');
}

test('cold start, repeated observations, sleep and restart preserve actual sample times and older hours', async t => {
  const {openHistory} = await history(), dir = archiveDir(t), roots = [process.cwd()];
  let archive = openHistory(dir, roots);
  try {
    const empty = {version: 1, startMs: t0-hour, endMs: t0, cadenceMs: tick, firstMs: null, lastMs: null, frames: []};
    assert.deepEqual(archive.read({}, t0), empty);
    assert.equal(archive.append(sample(t0)), true);
    assert.equal(archive.append(sample(t0)), false, 'same observation, not a new sample');
    archive.append(sample(t0+tick)); archive.append(sample(t0+hour*2));
    assert.deepEqual(archive.read({}, t0+hour*2).frames, [sample(t0+hour*2)], 'no backfill in a sleeping hour');
    archive.close(); archive = openHistory(dir, roots);
    assert.deepEqual(archive.read({end:t0+tick}, t0+hour*2), {...empty, startMs:t0+tick-hour, endMs:t0+tick,
      firstMs:t0, lastMs:t0+hour*2, frames:[sample(t0), sample(t0+tick)]});
    assert.deepEqual(archive.read({end:t0-1}, t0+hour*2).frames, [], 'nothing before the first capture');
  } finally { archive.close(); }
});

test('a second writer cannot claim this archive; identities survive restart but cannot link two installations', async t => {
  const {openHistory} = await history(), dir = archiveDir(t), roots = [process.cwd()];
  const a=openHistory(dir,roots);
  let id:string;
  try { assert.throws(()=>openHistory(dir,roots)); id=a.profileId('dev-alias'); assert.match(id,/^r-[a-f0-9]{32}$/); }
  finally { a.close(); }
  const b=openHistory(dir,roots), c=openHistory(archiveDir(t),roots);
  try { assert.equal(b.profileId('dev-alias'),id); assert.notEqual(c.profileId('dev-alias'),id); }
  finally { b.close(); c.close(); }
});

test('archive refuses file aliases or destinations in a static tree even before creating nested directories', async t => {
  const {openHistory}=await history(),dir=temporary(t),served=join(dir,'web'),alias=join(dir,'redirect');
  mkdirSync(served); symlinkSync(served,alias,'junction');
  for(const path of [join(served,'public','new'),join(alias,'new')]) assert.throws(()=>openHistory(path,[served]));
  assert.deepEqual([existsSync(join(served,'public')),existsSync(join(served,'new'))],[false,false]);
  const outside=join(dir,'outside'); mkdirSync(outside,{mode:0o700});
  const sentinel=join(served,'fixture-file'); writeFileSync(sentinel,'not a recording');
  const {linkSync}=await import('node:fs'); linkSync(sentinel,join(outside,'recordings.sqlite3'));
  assert.throws(()=>openHistory(outside,[served]),/Invalid recording file/); assert.equal(readFileSync(sentinel,'utf8'),'not a recording');
});

test('a Vite fs.allow entry may name just the future SQLite file or journal rather than its directory', async t=>{
  const {openHistory}=await history(),dir=join(temporary(t),'not-created');
  for(const suffix of ['', '-journal','-wal','-shm']) {
    assert.throws(()=>{const accidental=openHistory(dir,[join(dir,'recordings.sqlite3'+suffix)]);accidental.close();});
    assert.equal(existsSync(dir),false);
  }
});

test('alternate desktop listeners require an isolated archive, not the canonical default or a junction to it', async t=>{
  const {desktopDirectory}=await history();const scratch=temporary(t),env={LOCALAPPDATA:scratch,XDG_DATA_HOME:scratch};
  const normal=desktopDirectory(3002,env)!;
  assert.equal(desktopDirectory(4100,env),null);assert.throws(()=>desktopDirectory(4100,{...env,OFFICE_HISTORY_DIR:'relative'}));
  if(process.platform==='darwin')return; // The macOS default does not use the scratch environment above.
  assert.equal(normal,join(scratch,'Hermes Office'));mkdirSync(normal,{mode:0o700});
  const alias=join(scratch,'alias');symlinkSync(normal,alias,'junction');
  for(const dir of [normal,alias,join(alias,'other')])assert.equal(desktopDirectory(4100,{...env,OFFICE_HISTORY_DIR:dir}),null);
  const distinct=join(scratch,'distinct');assert.equal(desktopDirectory(4100,{...env,OFFICE_HISTORY_DIR:distinct}),distinct);
});

test('hour and delta share whole-archive extrema and return at most one recent predecessor', async t => {
  const {openHistory}=await history(),dir=archiveDir(t),a=openHistory(dir,[process.cwd()]);
  try {
    for(const at of [t0-90000,t0-30000,t0-15000,t0+1000,t0+20000,t0+36000,t0+hour]) a.append(sample(at));
    const full=a.read({},t0+hour); assert.deepEqual(full.frames.map(f=>f.atMs),[t0-15000,t0+1000,t0+20000,t0+36000,t0+hour]);
    const delta=a.read({after:t0+25000},t0+hour);
    assert.equal(delta.startMs,t0);assert.equal(delta.firstMs,t0-90000);assert.equal(delta.lastMs,t0+hour);
    assert.deepEqual(delta.frames.map(f=>f.atMs),[t0+20000,t0+36000,t0+hour]);
    assert.deepEqual(a.read({after:t0+20000},t0+hour).frames,delta.frames);
    assert.deepEqual(a.read({after:t0+100000},t0+hour).frames,[sample(t0+hour)]);
    assert.deepEqual(a.read({end:t0+hour*10},t0+hour),full);
  } finally {a.close();}
  const db=new DatabaseSync(join(dir,'recordings.sqlite3'),{readOnly:true});
  try {
    assert.equal(db.prepare('SELECT count(*) n FROM samples').get()?.n,7,'sample clocks remain queryable');
    assert.equal(db.prepare('SELECT count(*) n FROM states').get()?.n,1,'repeated actors are not duplicated');
  } finally {db.close();}
});
