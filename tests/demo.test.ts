import test from 'node:test';
import assert from 'node:assert/strict';
const feature = await import('../src/domain/demo.ts').catch(() => ({})) as Record<string, (...args: any[]) => any>;
test('demo fixtures are explicit, deterministic, and distinct from live telemetry', () => {
  assert.equal(typeof feature.demoSnapshot, 'function', 'demo not implemented');
  const a = feature.demoSnapshot(0); const b = feature.demoSnapshot(1);
  assert.equal(a.mode, 'demo'); assert.equal(a.agents.length, 33);
  assert.equal(new Set(a.agents.map((x: any) => x.id)).size, 33);
  assert.ok(a.agents.some((x: any) => x.state === 'working'));
  assert.ok(a.agents.some((x: any) => x.state === 'idle'));
  assert.ok(a.agents.some((x: any) => x.state === 'blocked'), 'the demo must exercise blocked states');
  assert.notDeepEqual(a.agents.map((x: any) => x.state), b.agents.map((x: any) => x.state));
});
