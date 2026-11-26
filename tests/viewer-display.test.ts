import test from 'node:test';
import assert from 'node:assert/strict';
import { officeDisplay, participantFacts, workingLabel } from '../src/domain/display.ts';
import type { OfficeAgent, OfficeSnapshot } from '../src/domain/types.ts';

// Structural fixture so collector and viewer changes can be developed independently.
const at = '2026-11-25T18:30:00.000Z', now = Date.parse(at);
const profile: OfficeAgent = { id: 'default', name: 'Hermes', role: 'General assistant', team: 'general', state: 'working', activity: 'Current turn observed.', observedAt: at, activeSessions: 3 };
const other: OfficeAgent = { ...profile, id: 'dev-lead', name: 'Development lead', team: 'development', state: 'idle', activeSessions: undefined };
function person(id: string, name: string, kind: 'session' | 'subagent', parentId?: string) {
  return { id, name, kind, profileId: profile.id, parentId, role: 'Runtime worker', team: profile.team, state: profile.state, activity: 'Current turn observed.', observedAt: at };
}
const parent = person('p-739647', 'Session A', 'session');
const first = person('p-293204', 'Subagent B', 'subagent', parent.id);
const second = person('p-195204', 'Subagent C', 'subagent', parent.id);
const snapshot = { schemaVersion: 1, mode: 'live', source: 'Local Hermes status bridge', observedAt: at, pollIntervalMs: 30000, sourceHealth: 'connected', agents: [profile, other], warnings: [] } satisfies OfficeSnapshot;


test('live scene and roster replace only represented profiles; a finished child disappears on the next observation', () => {

  for (const participants of [[parent, first, second], [parent, first], []]) {
    const shown = officeDisplay({ ...snapshot, participants }, 'live', now, false);
    assert.deepEqual(shown.agents.map((a: OfficeAgent) => a.id), [...(participants.length ? participants : [profile]), other].map(a => a.id));
    assert.deepEqual(shown.profiles.map((a: OfficeAgent) => a.id), [profile.id, other.id], 'Status still counts profiles, not people');
  }
});

test('failed, expired, unavailable, or wrong-source observations never show current work or session counts', () => {
  const live = { ...snapshot, participants: [parent, first] };
  for (const [input, clock, failed] of [
    [null, now, false], [live, now, true], [live, now + 120001, false], [live, now - 60001, false],
    [{ ...live, sourceHealth: 'unavailable' }, now, false], [{ ...live, mode: 'demo' }, now, false],
  ] as const) {
    const shown = officeDisplay(input, 'live', clock, failed);
    assert.equal(shown.coverage, 'unknown');
    assert.ok(shown.agents.every((a: OfficeAgent) => a.state === 'offline' && a.activeSessions === undefined && a.activity === 'Activity unknown.'));
    assert.ok(!shown.agents.some((a: OfficeAgent) => a.id === parent.id || a.id === first.id), 'expired workers are not current participants');
    if (input?.mode === 'demo') assert.deepEqual(shown.agents, [], 'never borrow demo identities');
  }
});

test('partial evidence reports a lower bound when work was seen, not zero when none can be verified', () => {
  const complete = officeDisplay(snapshot, 'live', now, false);
  assert.equal(complete.coverage, 'verified');
  assert.equal(workingLabel(complete.coverage, 0), '0 working');
  for (const input of [{ ...snapshot, sourceHealth: 'degraded' },
    { ...snapshot, agents: [profile, { ...other, state: 'offline' }] },
    { ...snapshot, agents: [profile, { ...other, observedAt: '2000-01-01T00:00:00Z' }] }] satisfies OfficeSnapshot[]) {
    const shown = officeDisplay(input, 'live', now, false);
    assert.equal(shown.coverage, 'partial');
    assert.equal(workingLabel(shown.coverage, 1), 'At least 1 working');
    assert.equal(workingLabel(shown.coverage, 0), 'Activity unknown');
  }
  assert.equal(officeDisplay({ ...snapshot, agents: [] }, 'live', now, false).coverage, 'unknown');
  assert.equal(workingLabel('unknown', 3), 'Activity unknown');
});

test('inspector relationships show a known neutral display name, never an opaque key as fallback', () => {
  const people = [parent, first, second];
  assert.deepEqual(participantFacts(first.id, people, [profile]), { kind: 'Subagent', profile: 'Hermes', parent: parent.name, children: 0 });
  assert.deepEqual(participantFacts(parent.id, people, [profile]), { kind: 'Session', profile: 'Hermes', parent: null, children: 2 });
  assert.equal(participantFacts(first.id, [first], [])?.parent, 'Not observed');
  assert.equal(participantFacts(first.id, [first], [])?.profile, 'Not observed');
  assert.equal(participantFacts(profile.id, people, [profile]), null);
});
