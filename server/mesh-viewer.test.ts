import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import http from 'node:http';
import { connect } from 'node:net';
import { Readable } from 'node:stream';
import test, { type TestContext } from 'node:test';
import { createMeshViewer } from './mesh-viewer.ts';

const host = '100.101.22.17', authority = `${host}:3002`;
const assets = new Map([
  ['/', {body: Buffer.from('<title>Fixture</title>'), type: 'text/html; charset=utf-8'}],
  ['/assets/ui-test.js', {body: Buffer.from('/* fixture */'), type: 'text/javascript'}],
  ['/assets/ui-test.css', {body: Buffer.from('body{}'), type: 'text/css'}],
  ['/favicon.svg', {body: Buffer.from('<svg/>'), type: 'image/svg+xml'}],
]);
const config = {host, assets, interfacePresent: () => true};

// Offline request records only. No listener or Mesh/desktop socket is opened here.
interface Sample {
  method?: string; localAddress?: string; localPort?: number; remoteAddress?: string;
  headers?: Record<string, string | string[] | undefined>;
}
function dispatch(server: http.Server, url: string, sample: Sample = {}) {
  const fields = Object.entries({host: authority, ...sample.headers}).filter(([,v]) => v !== undefined);
  const headersDistinct = Object.fromEntries(fields.map(([k,v]) => [k, Array.isArray(v) ? v : [v]]));
  const req = {url, method: 'GET', ...sample, headersDistinct,
    headers: Object.fromEntries(fields.map(([k,v]) => [k, Array.isArray(v) ? v[0] : v])),
    socket: {localAddress: host, localPort: 3002, remoteAddress: '100.108.9.81', ...sample}};
  const headers: Record<string,string> = {};
  return new Promise<{status: number; headers: typeof headers; body: string}>(resolve => {
    const res = Object.assign(new EventEmitter(), {statusCode: 200, destroyed: false,
      setHeader(k: string, v: string | number) {headers[k.toLowerCase()] = String(v);},
      end(data?: Buffer | string) {resolve({status: this.statusCode, headers, body: data?.toString() ?? ''});},
    });
    assert.ok(server.emit('request', req, res), 'No request handler installed');
  });
}
function noDesktop(t: TestContext) {
  const spy = t.mock.method(http, 'request', () => {throw Error('Offline test attempted a desktop read');});
  t.after(() => assert.equal(spy.mock.callCount(), 0, 'no upstream reads'));
}

test('creates an unbound HTTP server only for a unicast Mesh device address', () => {
  for (const bad of ['0.0.0.0', '127.0.0.1', '100.80.2.4', '100.96.0.0', '100.111.255.255', '::1']) {
    assert.throws(() => createMeshViewer({...config, host: bad}), /mesh/i, bad);
  }
  const server = createMeshViewer(config);
  assert.ok(server instanceof http.Server);
  assert.equal(server.address(), null);
  assert.equal(server.maxHeadersCount, 0, 'inspect every header within the byte limit, without silent truncation');
});

test('socket, interface and exact authority admit every route by the configured pool, not by laptop identity', async t => {
  noDesktop(t);
  let present = true;
  const server = createMeshViewer({...config, interfacePresent: () => present});
  for (const remoteAddress of ['100.96.0.1', '100.103.25.12', '100.104.0.0', '100.111.255.254']) {
    assert.equal((await dispatch(server, '/', {remoteAddress})).status, 200, remoteAddress);
  }
  const invalid: Sample[] = [
    ...['100.96.0.0', '100.111.255.255', '100.95.255.254', '100.112.0.1', '10.1.2.3', '::1', undefined].map(remoteAddress => ({remoteAddress})),
    {localAddress: '100.104.5.6'}, {localAddress: undefined}, {localPort: 3010},
    {headers: {host}}, {headers: {host: undefined}}, {headers: {host: `${host}:3010`}}, {headers: {host: [authority, authority]}},
    {remoteAddress: '192.0.2.42', headers: {'x-forwarded-for': '100.100.1.2'}},
  ];
  for (const url of ['/', '/assets/ui-test.js', '/api/office', '/api/office/history']) {
    for (const sample of invalid) {
      const r = await dispatch(server, url, {...sample, headers: {'x-office-read': '1', ...sample.headers}});
      assert.equal(r.status, 403, `${url}: ${JSON.stringify(sample)}`);
      assert.equal(r.headers['x-hermes-office-mesh'], undefined);
    }
  }
  present = false;
  assert.equal((await dispatch(server, '/')).status, 403);
  const unavailable = createMeshViewer({...config, interfacePresent: () => {throw Error('fixture');}});
  assert.equal((await dispatch(unavailable, '/')).status, 403);
});

test('serves just the preloaded UI, including decorative frames, readiness HEAD and bounded UI queries', async t => {
  noDesktop(t);
  const source = new Map(assets), body = Buffer.from(assets.get('/')!.body);
  source.set('/', {body, type: 'text/html; charset=utf-8'});
  const server = createMeshViewer({...config, assets: source});
  body.fill(32); source.clear(); // The serving manifest is a snapshot, not a mutable directory.
  for (const url of ['/', '/?view=ambient&view=editor&team=science', '/?embed=1&view=hero&source=live', '/?view=embedded']) {
    const html = await dispatch(server, url, {headers: {'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'iframe'}});
    assert.equal(html.status, 200); assert.equal(html.body, assets.get('/')!.body.toString());
    assert.equal(html.headers['x-hermes-office-mesh'], 'office-mesh-v1');
    assert.equal(html.headers['x-frame-options'], undefined);
  }
  for (const [url, asset] of assets) {
    const r = await dispatch(server, url, {method: 'HEAD'});
    assert.equal(r.status, 200); assert.equal(r.body, '');
    assert.equal(r.headers['content-length'], String(asset.body.length)); assert.equal(r.headers['content-type'], asset.type);
    assert.equal(r.headers['x-hermes-office-mesh'], url === '/' ? 'office-mesh-v1' : undefined);
    assert.equal(r.headers['cache-control'], 'no-store'); assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['cross-origin-resource-policy'], 'same-origin'); assert.equal(r.headers['access-control-allow-origin'], undefined);
    assert.equal((await dispatch(server, url)).body, asset.body.toString());
  }
  for (const url of ['/missing', '/assets/other.js', '/assets/ui-test.js?other', '/favicon.svg?x']) {
    assert.equal((await dispatch(server, url)).status, 404, url);
  }
  assert.equal((await dispatch(server, '/?team='+'a'.repeat(300))).status, 400);
  assert.equal((await dispatch(server, '/', {method:'POST'})).status, 405);
  assert.throws(() => createMeshViewer({...config, assets: new Map([['/unexpected', assets.get('/')!]])}), /asset/i);
});

const readHeaders = {accept: 'application/json', 'x-office-read': '1'};
test('private reads reject other methods, origins, contexts and noncanonical range inputs offline', async t => {
  noDesktop(t);
  const server = createMeshViewer(config);
  for (const path of ['/api/office', '/api/office/history']) {
    for (const method of ['HEAD', 'POST', 'OPTIONS']) {
      const r = await dispatch(server, path, {method, headers: readHeaders});
      assert.equal(r.status, 405); assert.equal(r.headers.allow, 'GET'); assert.equal(r.headers['access-control-allow-origin'], undefined);
    }
    for (const overrides of [
      {'x-office-read': undefined}, {'x-office-read': '0'}, {'x-office-read': ['1','1']},
      {origin: 'null'}, {origin: `http://${host}:3010`}, {origin: `https://${authority}`}, {origin: [`http://${authority}`, `http://${authority}`]},
      {'sec-fetch-site': 'same-site'}, {'sec-fetch-site': 'cross-site'}, {'sec-fetch-dest': 'iframe'}, {'sec-fetch-mode': 'navigate'},
    ]) {
      const r = await dispatch(server, path, {headers: {...readHeaders, ...overrides}});
      assert.equal(r.status, 403, JSON.stringify(overrides)); assert.equal(r.headers['access-control-allow-origin'], undefined);
    }
  }
  for (const path of ['/api/office?end=1', ...['?', '?end=-1', '?end=01', '?after=1.5', '?end=8640000000000001',
    '?after=1&end=2', '?end=1&end=2', '?other=1'].map(q => '/api/office/history'+q)]) {
    assert.equal((await dispatch(server, path, {headers: readHeaders})).status, 400, path);
  }
  for (const path of ['/api', '/api/office/', '/api/office/history/other']) {
    assert.equal((await dispatch(server, path, {headers: readHeaders})).status, 404, path);
  }
});

const snapshot = {schemaVersion:1, mode:'live', source:'Local Hermes status bridge', observedAt:'2025-01-01T00:00:00.000Z',
  pollIntervalMs:30_000, sourceHealth:'connected', warnings:[], agents:[]};
function recording(endMs: number) {
  return {version:1, startMs:Math.max(0, endMs-3_600_000), endMs, cadenceMs:15_000, firstMs:endMs, lastMs:endMs,
    frames:[{atMs:endMs, coverage:'verified', actors:[{id:'r-'+'a'.repeat(32), kind:'profile', team:'studio', state:'idle', signal:'presence'}]}]};
}
function signed(res: http.ServerResponse) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Hermes-Office-Desktop', 'office-hours-desktop-v1');
  res.end();
}

// Only the test transport dials an ephemeral, owned loopback fixture. The production
// requests, Host, HTTP parser, streaming body, signature and validators are unmodified.
async function desktopFixture(t: TestContext, respond: http.RequestListener) {
  const calls: {method?: string; path?: string; headers: http.IncomingHttpHeaders; socket: unknown}[] = [];
  const fixture = http.createServer((req, res) => {
    calls.push({method:req.method, path:req.url, headers:req.headers, socket:req.socket});
    respond(req, res);
  });
  fixture.listen(0, '127.0.0.1'); await once(fixture, 'listening');
  t.after(async () => {
    const closed = once(fixture, 'close'); fixture.close(); fixture.closeAllConnections(); await closed;
  });
  const addr = fixture.address(); assert.ok(addr && typeof addr !== 'string' && addr.address === '127.0.0.1' && addr.port !== 3002);
  t.mock.method(http.Agent.prototype, 'createConnection', (options: http.ClientRequestArgs) => {
    assert.equal(options.host, '127.0.0.1'); assert.equal(Number(options.port), 3002);
    return connect({host:'127.0.0.1', port:addr.port});
  });
  return calls;
}

test('ordinary first-party reads project live data, full hours and each bounded cursor from the signed desktop', async t => {
  const cases = [
    {path:'/api/office', expected:snapshot, metadata:{}}, // Insecure HTTP browser: no Origin or Sec-Fetch-*.
    {path:'/api/office/history', expected:recording(7_200_000), metadata:{origin:`http://${authority}`, 'sec-fetch-site':'same-origin', 'sec-fetch-dest':'empty', 'sec-fetch-mode':'same-origin'}},
    {path:'/api/office/history?end=3600000', expected:recording(3_600_000), metadata:{'sec-fetch-site':'none'}},
    {path:'/api/office/history?after=0', expected:recording(7_200_000), metadata:{}},
  ];
  const calls = await desktopFixture(t, (req, res) => {
    if (req.method === 'HEAD' && req.url === '/') return signed(res);
    const data = cases.find(c => c.path === req.url)?.expected;
    res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('X-Fixture-Internal', 'not-for-relay');
    res.end(JSON.stringify(data)); // No desktop signature on the data routes.
  });
  const server = createMeshViewer(config);
  for (const {path, expected, metadata} of cases) {
    const count = calls.length;
    const r = await dispatch(server, path, {headers:{...readHeaders, ...metadata, 'x-fixture-inbound':'not-for-relay'}});
    assert.equal(r.status, 200, `${path}: fixture received ${calls.slice(count).map(c => `${c.method} ${c.path}`).join(', ')}`);
    assert.deepEqual(JSON.parse(r.body), expected);
    assert.equal(r.headers['cache-control'], 'no-store'); assert.equal(r.headers['cross-origin-resource-policy'], 'same-origin');
    assert.equal(r.headers['x-content-type-options'], 'nosniff'); assert.match(r.headers['content-type'], /^application\/json/);
    assert.equal(r.headers['x-fixture-internal'], undefined); assert.equal(r.headers['access-control-allow-origin'], undefined);
    const pair = calls.slice(count);
    assert.deepEqual(pair.map(c => [c.method, c.path, c.headers.accept]), [['HEAD','/','text/html'], ['GET',path,'application/json']]);
    assert.equal(pair[0].socket, pair[1].socket, 'identity check covers the very connection used for the read');
    for (const c of pair) {
      assert.equal(c.headers.host, '127.0.0.1:3002');
      assert.ok(Object.keys(c.headers).every(k => ['host','connection','accept','accept-encoding'].includes(k)), 'no inbound headers forwarded');
    }
  }
});

// For negative desktop responses, exercise the real projection on in-memory streams,
// not crafted traffic. The only network integration above is the ordinary signed read.
type Reply = {status?: number; headers?: Record<string,string>; chunks?: Buffer[]};
const signedPage = {headers:{'content-type':'text/html', 'x-hermes-office-desktop':'office-hours-desktop-v1'}};
const dataReply = (value: unknown): Reply => ({headers:{'content-type':'application/json'}, chunks:[Buffer.from(JSON.stringify(value))]});
function memoryDesktop(t: TestContext, answer: (call: http.ClientRequestArgs) => Reply | 'closed' | Error) {
  const socket = {destroyed:false}, sent: http.ClientRequestArgs[] = [];
  t.mock.method(http, 'request', (call: http.ClientRequestArgs, receive: (response: unknown) => void) => {
    const req = Object.assign(new EventEmitter(), {shouldKeepAlive:true,
      end() {
        sent.push(call);
        const reply = answer(call);
        if (reply === 'closed') return req.emit('close');
        if (reply instanceof Error) return req.emit('error', reply);
        const headers = reply.headers ?? {};
        receive(Object.assign(Readable.from(reply.chunks ?? []), {socket, httpVersion:'1.1', statusCode:reply.status ?? 200,
          headers, headersDistinct:Object.fromEntries(Object.entries(headers).map(([k,v]) => [k,[v]]))}));
      },
    });
    queueMicrotask(() => req.emit('socket', socket));
    return req;
  });
  return sent;
}

test('unrecognized, absent or redirecting desktops are unavailable before any data read (offline)', async t => {
  let page: Reply | Error = {};
  const sent = memoryDesktop(t, () => page);
  const server = createMeshViewer(config);
  for (page of [new Error('fixture-only detail'), {headers:{'content-type':'text/html'}},
    {headers:{...signedPage.headers, 'content-type':'application/json'}}, {status:302, headers:{...signedPage.headers, location:'/elsewhere'}}]) {
    const before = sent.length;
    const r = await dispatch(server, '/api/office', {headers:readHeaders});
    assert.equal(r.status, 503); assert.deepEqual(JSON.parse(r.body), {error:'Service Unavailable'});
    assert.deepEqual(sent.slice(before).map(c => [c.method,c.path]), [['HEAD','/']]);
  }
});

test('a closed exchange without response headers produces a bounded generic failure (offline)', async t => {
  memoryDesktop(t, () => 'closed');
  const response = dispatch(createMeshViewer(config), '/api/office/history', {headers:readHeaders});
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {timer = setTimeout(() => reject(Error('Closed exchange never settled')), 150);});
  try { assert.equal((await Promise.race([response, deadline])).status, 503); } finally { clearTimeout(timer!); }
});

test('only bounded, validated JSON leaves the desktop connection; interface is rechecked before delivery (offline)', async t => {
  let reply: Reply = {}, present = true, detach = false;
  const timeouts = t.mock.method(AbortSignal, 'timeout');
  const sent = memoryDesktop(t, call => {
    if (call.method === 'HEAD') return signedPage;
    if (detach) present = false;
    return reply;
  });
  const viewer = createMeshViewer({...config, interfacePresent:() => present});
  const cases: [string, Reply][] = [
    ['/api/office', dataReply({...snapshot, fixtureOnly:'not-for-relay'})],
    ['/api/office/history', dataReply({...recording(123), fixtureOnly:'not-for-relay'})],
    ['/api/office', {...dataReply(snapshot), headers:{'content-type':'text/plain'}}],
    ['/api/office', {headers:{'content-type':'application/json'}, chunks:[...dataReply(snapshot).chunks!, Buffer.alloc(256*1024, 32)]}],
    ['/api/office/history', {...dataReply(recording(123)), headers:{'content-type':'application/json', 'content-length':String(12*1024*1024+1)}}],
    ['/api/office', {status:301, headers:{'content-type':'application/json', location:'/elsewhere'}}],
  ];
  for (const [path, value] of cases) {
    reply = value;
    const before = sent.length;
    const r = await dispatch(viewer, path, {headers:readHeaders});
    assert.equal(r.status, 503); assert.deepEqual(JSON.parse(r.body), {error:'Service Unavailable'});
    assert.deepEqual(sent.slice(before).map(c => c.path), ['/',path]);
    assert.ok(sent[before].signal instanceof AbortSignal); assert.equal(sent[before].signal, sent[before+1].signal);
  }
  assert.ok(timeouts.mock.calls.every(c => c.arguments[0] > 0 && c.arguments[0] <= 10_000));
  assert.equal(timeouts.mock.callCount(), cases.length, 'one total deadline spans proof, headers and body');
  detach = true; reply = dataReply(snapshot);
  assert.equal((await dispatch(viewer, '/api/office', {headers:readHeaders})).status, 403);
});
