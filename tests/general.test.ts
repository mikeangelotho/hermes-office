import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSnapshot } from '../src/domain/snapshot.ts';
import { demoSnapshot } from '../src/domain/demo.ts';
import { presentationFor } from '../src/domain/presentation.ts';

test('general room includes one explicitly simulated default Hermes instance', () => {
  const snapshot = demoSnapshot();
  const general = snapshot.agents.filter(a => String(a.team) === 'general');
  assert.equal(snapshot.agents.length, 33);
  assert.equal(general.length, 1);
  assert.equal(general[0].id, 'default');
  assert.equal(general[0].name, 'Hermes');
  assert.equal((general[0] as unknown as Record<string, unknown>).activeSessions, 1);
  assert.equal(presentationFor('?team=general').team, 'general');
  assert.equal(presentationFor('?team=general&embed=1&source=live').source, 'demo');
});

test('general-session projection permits only a bounded count, never session content', () => {
  const raw: any = demoSnapshot();
  raw.agents = [{ id: 'default', name: 'Hermes', role: 'General assistant', team: 'general', state: 'working', observedAt: new Date().toISOString(), activity: 'Executing a turn', activeSessions: 2, sessions: [{ title: 'private', prompt: 'private' }] }];
  const clean = parseSnapshot(raw);
  assert.equal((clean.agents[0] as unknown as Record<string, unknown>).activeSessions, 2);
  assert.equal((clean.agents[0] as unknown as Record<string, unknown>).sessions, undefined);
  for (const bad of [-1, 1.5, 10001, '2', Infinity, null]) {
    raw.agents[0].activeSessions = bad;
    assert.throws(() => parseSnapshot(raw));
  }
});
