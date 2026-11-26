import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, fork } from 'node:child_process';
import { createServer, type ServerResponse } from 'node:http';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import type { OfficeSnapshot } from '../src/domain/types.ts';

const file=fileURLToPath(new URL('../scripts/desktop.mjs',import.meta.url));
const run=promisify(execFile);

async function officeFixture(t: TestContext, feed: (res: ServerResponse) => void) {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.headers.authorization || req.headers.cookie) { res.writeHead(403).end(); return; }
    if (req.url === '/api/office') { feed(res); return; }
    if (req.url === '/' || req.url === '/?view=ambient') {
      res.writeHead(200, {'X-Hermes-Office-Desktop': 'office-hours-desktop-v1'}).end('Local Office fixture');
    } else res.writeHead(404).end();
  });
  await new Promise<void>((ready, fail) => server.once('error', fail).listen(0, '127.0.0.1', ready));
  t.after(() => new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); }));
  const {port} = server.address() as AddressInfo;
  const address = `http://127.0.0.1:${port}/?view=ambient`;
  const relaunch = () => run(process.execPath, [file, '--port', String(port)], {timeout: 25_000, windowsHide: true});
  return {requests, address, relaunch};
}

test('a recognized page with an unavailable feed is still offered, not reported as connected', async t => {
  const office = await officeFixture(t, res => res.writeHead(503).end());
  const {stdout} = await office.relaunch();
  assert.deepEqual(office.requests, ['HEAD /', 'GET /api/office']);
  assert.match(stdout, /Desktop observations: unavailable.*HTTP 503/i);
  assert.ok(stdout.includes(office.address));
  assert.doesNotMatch(stdout, /Desktop observations: connected|source=demo/i);
  assert.equal(await (await fetch(office.address)).text(), 'Local Office fixture');
});

const snapshot: OfficeSnapshot = {
  schemaVersion: 1, mode: 'live', source: 'Local Hermes status bridge', observedAt: new Date().toISOString(),
  pollIntervalMs: 30_000, sourceHealth: 'connected', agents: [], warnings: [],
};
for (const [description, body, expected] of [
  ['connected', JSON.stringify(snapshot), /^Desktop observations: connected\./m],
  ['partial', JSON.stringify({...snapshot, sourceHealth: 'degraded'}), /^Desktop observations: degraded.*partial/im],
  ['unavailable', JSON.stringify({...snapshot, sourceHealth: 'unavailable'}), /^Desktop observations: unavailable\./m],
  ['invalid JSON', 'not JSON', /^Desktop observations: unavailable.*malformed/im],
  ['incomplete snapshot', '{"mode":"live","sourceHealth":"connected"}', /^Desktop observations: unavailable.*malformed/im],
  ['demo snapshot', JSON.stringify({...snapshot, mode: 'demo'}), /^Desktop observations: unavailable.*non-live/im],
] as const) {
  test(`relaunch reports the live feed accurately: ${description}`, async t => {
    const office = await officeFixture(t, res => res.writeHead(200, {'Content-Type':'application/json'}).end(body));
    const {stdout} = await office.relaunch();
    assert.match(stdout, expected);
    assert.ok(stdout.includes(office.address));
    assert.doesNotMatch(stdout, /source=demo/);
  });
}

test('relaunch reports a feed request that disconnects without hiding the local page', async t => {
  const office = await officeFixture(t, res => res.destroy());
  const {stdout} = await office.relaunch();
  assert.match(stdout, /Desktop observations: unavailable.*request failed/i);
  assert.ok(stdout.includes(office.address));
});

test('relaunch times out even when the feed sent headers but never finished its snapshot', async t => {
  const office = await officeFixture(t, res => { res.writeHead(200, {'Content-Type':'application/json'}).write('{'); });
  const {stdout} = await office.relaunch();
  assert.match(stdout, /Desktop observations: unavailable.*timed out/i);
  assert.equal(await (await fetch(office.address)).text(), 'Local Office fixture');
});

test('a fresh page can still be opened and reused without a working collector', async t => {
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'office-launcher-'));
  const historyParent = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'office-launcher-history-')), historyDir = join(historyParent,'archive');
  t.after(() => rmSync(historyParent, {recursive:true,force:true,maxRetries:3}));
  t.after(() => rmSync(dir, {recursive: true, force: true, maxRetries: 3}));
  mkdirSync(join(dir, 'scripts')); mkdirSync(join(dir, 'node_modules'));
  const launcher = join(dir, 'scripts', 'desktop.mjs');
  copyFileSync(file, launcher);
  for (const name of ['server', 'src']) symlinkSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), join(dir, name), 'junction');
  symlinkSync(dirname(fileURLToPath(import.meta.resolve('vite/package.json'))), join(dir, 'node_modules', 'vite'), 'junction');
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Isolated Office fixture</title>');
  writeFileSync(join(dir, 'vite.config.ts'), `import {officeApiPlugin} from './server/office-api.ts';
    export default {plugins: [officeApiPlugin(), {name: 'fixture-lifetime', configurePreviewServer(server) {
      process.once('disconnect', () => server.close());
    }}]};`);

  const reservation = createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const {port} = reservation.address() as AddressInfo;
  await new Promise<void>(done => reservation.close(() => done()));
  const address = `http://127.0.0.1:${port}/?view=ambient`;
  const args = ['--port', String(port)];
  const env = {...process.env, LOCALAPPDATA:join(dir,'private-localdata'), XDG_DATA_HOME:join(dir,'private-localdata'), OFFICE_HISTORY_DIR: historyDir, HERMES_HOME: join(dir, 'unused-home'), PYTHON_BIN: join(dir, 'missing-python')};
  const child = fork(launcher, args, {cwd: dir, env, execArgv: [], silent: true, windowsHide: true, timeout: 30_000});
  const exited = once(child, 'exit');
  let stderr = '', startup = '';
  child.stderr!.on('data', chunk => { stderr += chunk; });
  try {
    for await (const line of createInterface({input: child.stdout!})) {
      startup += `${line}\n`;
      if (line.startsWith('Bound only to ')) break;
    }
    assert.match(startup, /Desktop observations: unavailable.*HTTP 503/i, stderr);
    assert.ok(startup.includes(`Bound only to 127.0.0.1:${port}.`));
    assert.ok(startup.includes(address));
    assert.match(stderr, /PYTHON_BIN/);
    assert.ok(existsSync(join(historyDir,'recordings.sqlite3')), 'the guarded launcher must start capture without an editor or history request');
    const response=await fetch(new URL('/api/office/history',address));
    assert.equal(response.status,200); const reel=await response.json();
    assert.ok(reel.frames.length>=1);assert.deepEqual(reel.frames.at(-1),{atMs:reel.lastMs,coverage:'unknown',actors:[]});
    const {stdout} = await run(process.execPath, [launcher, ...args], {cwd: dir, env, timeout: 10_000, windowsHide: true});
    assert.match(stdout, /already running/i);
    assert.match(stdout, /Desktop observations: unavailable.*HTTP 503/i);
    assert.match(await (await fetch(address)).text(), /Isolated Office fixture/);
  } finally {
    if (child.connected) child.disconnect();
    await exited;
  }
});

test('desktop relaunch identifies its own listener, not generic HTTP on the requested port', async t=>{
  assert.ok(existsSync(file),'desktop launcher missing: no double-launch protection or loopback preflight');
  const requests: string[] = [];
  const outside=createServer((req,res)=>{requests.push(`${req.method} ${req.url}`);res.writeHead(200,{'Content-Type':'text/html'});res.end('Unrelated local project');});
  outside.listen(0,'127.0.0.1'); await new Promise<void>(ready=>outside.once('listening',ready));
  t.after(()=>new Promise<void>(done=>outside.close(()=>done())));
  const port=(outside.address() as AddressInfo).port;
  await assert.rejects(run(process.execPath,[file,'--port',String(port)],{timeout:12_000,windowsHide:true}),err=>/in use by another service/i.test(String(err)));
  assert.deepEqual(requests, ['HEAD /']);
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), 'Unrelated local project');
});
