import test from 'node:test';
import assert from 'node:assert/strict';
const feature = await import('../src/domain/snapshot.ts').catch(() => ({})) as Record<string, (...args: any[]) => any>;
const valid = () => ({ schemaVersion: 1, mode: 'live', source: 'hermes-local', sourceHealth: 'connected', observedAt: new Date().toISOString(), pollIntervalMs: 30000, warnings: [], agents: [{ id: 'studio-lead', name: 'Studio lead', role: 'Coordinator', team: 'studio', state: 'working', observedAt: new Date().toISOString(), activity: 'Executing a turn', privateTranscript: 'must not survive' }], secret: 'must not survive' });
test('the status boundary validates the schema and projects only allowlisted fields', () => {
  assert.equal(typeof feature.parseSnapshot, 'function', 'snapshot boundary not implemented');
  const result = feature.parseSnapshot(valid());
  assert.equal(result.agents.length, 1);
  assert.equal(result.secret, undefined);
  assert.equal(result.agents[0].privateTranscript, undefined);
  for (const mutate of [(x: any) => x.agents[0].state = 'pretend-working', (x: any) => x.agents.push(x.agents[0]), (x: any) => x.schemaVersion = 2, (x: any) => x.observedAt = 'never']) {
    const payload = valid(); mutate(payload); assert.throws(() => feature.parseSnapshot(payload));
  }
});
