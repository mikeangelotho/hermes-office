import test from 'node:test';
import assert from 'node:assert/strict';
const feature = await import('../src/domain/state.ts').catch(() => ({})) as Record<string, (...args: any[]) => any>;

test('stale observations must never make an agent appear available', () => {
  assert.equal(typeof feature.effectiveState, 'function', 'effectiveState has not been implemented');
  const now = Date.parse('2026-11-03T20:00:00Z');
  assert.equal(feature.effectiveState('working', '2026-11-03T19:55:00Z', now), 'offline');
  assert.equal(feature.effectiveState('idle', 'not a date', now), 'offline');
  assert.equal(feature.effectiveState('working', '2026-11-03T19:59:45Z', now), 'working');
});

test('session counts expire with the observation rather than suggesting stale activity', () => {
  assert.equal(typeof feature.effectiveAgent, 'function');
  const now = Date.parse('2026-11-03T20:00:00Z');
  const a = { id: 'default', name: 'Hermes', role: 'General assistant', team: 'general', state: 'working', observedAt: '2026-11-03T19:55:00Z', activity: 'Executing a turn', activeSessions: 2 };
  const stale = feature.effectiveAgent(a, now);
  assert.equal(stale.state, 'offline'); assert.equal(stale.activeSessions, undefined);
  const fresh = { ...a, observedAt: '2026-11-03T19:59:45Z' };
  assert.equal(feature.effectiveAgent(fresh, now), fresh);
});
