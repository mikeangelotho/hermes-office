import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

test('Explorer PATH with a Store alias finds the installed Hermes Python without a pinned version', async t => {
  const base = mkdtempSync(join(tmpdir(), 'office-python-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const appData = join(base,'Local');
  const aliasDir = join(appData,'Microsoft','WindowsApps');
  function place(path: string) { mkdirSync(dirname(path), {recursive:true}); writeFileSync(path,'test fixture, not executed'); return path; }
  const alias = place(join(aliasDir,'python3.exe'));
  const installed = place(join(appData,'hermes','tools','python-3.16.2+test-win32-x64','python.exe'));
  const mod = await import('./python-runtime.ts').catch(() => null);
  assert.ok(mod?.resolveOfficePython, 'a desktop launcher must resolve Hermes Python when PATH only has the Store alias');
  const probed: string[] = [];
  const actual = await mod.resolveOfficePython({platform:'win32',env:{LOCALAPPDATA:appData,PATH:aliasDir},probe: async file => {probed.push(file);return file === installed;}});
  assert.equal(actual,installed); assert.ok(!probed.includes(alias));
});

test('a broken explicit override is never silently replaced by another environment', async t=>{
  const base=mkdtempSync(join(tmpdir(),'office-override-'));
  t.after(()=>rmSync(base,{recursive:true,force:true}));
  const bundled=join(base,'hermes','tools','python-3.12.3-test-win32-x64','python.exe');
  mkdirSync(dirname(bundled),{recursive:true});writeFileSync(bundled,'not executed');
  const {resolveOfficePython}=await import('./python-runtime.ts');
  const candidates:string[]=[];
  await assert.rejects(resolveOfficePython({platform:'win32',env:{LOCALAPPDATA:base,PYTHON_BIN:join(base,'missing.exe')},probe:async f=>{candidates.push(f);return true;}}),/PYTHON_BIN/);
  assert.deepEqual(candidates,[]);
});
