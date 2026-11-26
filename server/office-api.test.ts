import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { createOfficeMiddleware, validateSnapshot } from './office-api.ts';

const observedAt = '2026-11-04T00:00:00.000Z';
function snapshot() {
  return {
    schemaVersion: 1, mode: 'live', source: 'Local Hermes status bridge', observedAt,
    pollIntervalMs: 30000, sourceHealth: 'connected',
    agents: [{ id: 'dev-web', name: 'Web Engineer', role: 'Web', team: 'development',
      state: 'working', observedAt, lastActiveAt: observedAt,
      activity: 'Current turn lease or fresh running worker observed.' }], warnings: [] as string[],
  };
}

async function serve(middleware: ReturnType<typeof createOfficeMiddleware>) {
  const server = createServer((req, res) => middleware(req, res, () => {
    res.statusCode = 404; res.end('Not found');
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  return { server, url: `http://127.0.0.1:${address.port}/api/office` };
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

test('concurrent requests share a five-second cache including failures', async () => {
  let calls = 0, clock = 0, fail = false;
  const {server, url} = await serve(createOfficeMiddleware({now: () => clock, collect: async () => {
    calls++; await new Promise(resolve => setTimeout(resolve, 30));
    if (fail) throw new Error('PRIVATE_ERROR');
    return snapshot();
  }}));
  try {
    const first = await Promise.all(Array.from({length: 8}, () => fetch(url)));
    assert(first.every(response => response.status === 200));
    assert.equal(calls, 1);
    clock = 4999; assert.equal((await fetch(url)).status, 200); assert.equal(calls, 1);
    clock = 5000; assert.equal((await fetch(url)).status, 200); assert.equal(calls, 2);
    fail = true; clock = 10000;
    const failed = await Promise.all(Array.from({length: 8}, () => fetch(url)));
    assert(failed.every(response => response.status === 503));
    assert.equal(calls, 3);
    assert.equal((await fetch(url)).status, 503); assert.equal(calls, 3);
    fail = false; clock = 15000;
    assert.equal((await fetch(url)).status, 200); assert.equal(calls, 4);
  } finally { await close(server); }
});

test('source validation and collector errors fail closed without private output', async () => {
  let value: unknown = snapshot();
  const {server, url} = await serve(createOfficeMiddleware({collect: async () => {
    if (value instanceof Error) throw value;
    return value;
  }}));
  const mutations: Array<(payload: ReturnType<typeof snapshot>) => void> = [
    payload => { Object.assign(payload, {privatePath: 'PRIVATE_SECRET'}); },
    payload => { Object.assign(payload.agents[0], {title: 'PRIVATE_TASK'}); },
    payload => { payload.agents[0].state = 'invented'; },
    payload => { payload.agents[0].team = 'science'; },
    payload => { payload.agents[0].activity = 'PRIVATE_PROMPT'; },
    payload => { payload.agents[0].name = 'C:\\PRIVATE_SECRET'; },
    payload => { payload.observedAt = 'not-a-date'; },
    payload => { payload.pollIntervalMs = 1; },
    payload => { payload.mode = 'demo'; },
    payload => { payload.warnings = ['PRIVATE_ERROR']; },
    payload => { payload.agents = Array(129).fill(payload.agents[0]); },
    payload => { payload.agents.push({...payload.agents[0]}); },
  ];
  try {
    for (const mutate of mutations) {
      const payload = snapshot(); mutate(payload); value = payload;
      assert.throws(() => validateSnapshot(payload), 'each malformed payload must fail validation independently');
      const response = await fetch(url, {signal: AbortSignal.timeout(2000)});
      assert.equal(response.status, 503);
      const text = await response.text();
      const fallback = JSON.parse(text);
      assert.equal(fallback.sourceHealth, 'unavailable');
      assert.deepEqual(fallback.agents, []);
      assert.equal(fallback.mode, 'live');
      assert(!text.includes('PRIVATE_'));
    }
    value = new Error('C:\\PRIVATE_CREDENTIALS secret stderr');
    const response = await fetch(url, {signal: AbortSignal.timeout(2000)});
    assert.equal(response.status, 503);
    assert(!(await response.text()).includes('PRIVATE_'));
  } finally { await close(server); }
});

test('default Hermes and bounded verified general-session counts survive validation', () => {
  const payload = snapshot();
  payload.agents.push({id: 'default', name: 'Hermes', role: 'General assistant', team: 'general',
    state: 'working', observedAt, lastActiveAt: observedAt,
    activity: 'Current turn lease or fresh running worker observed.'});
  Object.assign(payload.agents[1], {activeSessions: 3});
  const validated = validateSnapshot(payload);
  assert.deepEqual(validated.agents[1], payload.agents[1]);
  for (const [activeSessions, state] of [[0, 'idle'], [10000, 'working']] as const) {
    Object.assign(payload.agents[1], {activeSessions, state});
    assert.equal((validateSnapshot(payload).agents[1] as unknown as {activeSessions: number}).activeSessions, activeSessions);
  }
  const withoutCount = snapshot();
  withoutCount.agents[0] = {id: 'default', name: 'Hermes', role: 'General assistant', team: 'general',
    state: 'offline', observedAt, lastActiveAt: observedAt,
    activity: 'Runtime status unavailable; activity unverified.'};
  assert(!Object.hasOwn(validateSnapshot(withoutCount).agents[0], 'activeSessions'));
});

test('default identity, count scope, types and private runtime metadata fail closed', () => {
  const base = snapshot();
  base.agents[0] = {id: 'default', name: 'Hermes', role: 'General assistant', team: 'general',
    state: 'working', observedAt, lastActiveAt: observedAt,
    activity: 'Current turn lease or fresh running worker observed.'};
  Object.assign(base.agents[0], {activeSessions: 1});
  for (const value of [-1, 1.5, 10001, NaN, Infinity, true, null, '1']) {
    const payload = structuredClone(base);
    Object.assign(payload.agents[0], {activeSessions: value});
    assert.throws(() => validateSnapshot(payload), `unsafe count ${String(value)}`);
  }
  for (const fields of [{name: 'Other'}, {role: 'Other'}, {team: 'science'}, {sessionIds: ['PRIVATE_ID']},
    {pid: 123}, {state: 'idle', activeSessions: 1}]) {
    const payload = structuredClone(base);
    Object.assign(payload.agents[0], fields);
    assert.throws(() => validateSnapshot(payload));
  }
  const specialist = snapshot();
  Object.assign(specialist.agents[0], {activeSessions: 1});
  assert.throws(() => validateSnapshot(specialist));
});

test('API rejects writes, nonlocal origins and query inputs before collection', async () => {
  let calls = 0;
  const {server, url} = await serve(createOfficeMiddleware({collect: async () => { calls++; return snapshot(); }}));
  try {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']) {
      const response = await fetch(url, {method});
      assert.equal(response.status, 405, method);
      assert.equal(response.headers.get('allow'), 'GET');
    }
    for (const origin of ['https://attacker.example', 'null', 'http://127.0.0.1.attacker.example', 'file://', 'http://user@localhost:3010']) {
      assert.equal((await fetch(url, {headers: {Origin: origin}})).status, 403, origin);
    }
    assert.equal((await fetch(`${url}?path=private&sql=DROP`)).status, 400);
    assert.equal((await fetch(url.replace('/api/office', '/elsewhere'))).status, 404);
    assert.equal(calls, 0);
    assert.equal((await fetch(url, {headers: {Origin: new URL(url).origin}})).status, 200);
  } finally { await close(server); }
});

test('GET returns only the validated snapshot with safe response headers', async () => {
  const {server, url} = await serve(createOfficeMiddleware({ collect: async () => snapshot() }));
  try {
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), snapshot());
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  } finally { await close(server); }
});
