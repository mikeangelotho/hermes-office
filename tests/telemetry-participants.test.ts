import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateSnapshot } from '../server/office-api.ts';
import { parseSnapshot } from '../src/domain/snapshot.ts';

const observedAt = '2026-11-04T10:20:30.000Z';
const profile = {id: 'default', name: 'Hermes', role: 'General assistant', team: 'general',
  state: 'working', activity: 'Current turn lease or fresh running worker observed.', observedAt, activeSessions: 3};
function person(hex: string, kind: 'session' | 'subagent', parentId?: string) {
  const suffix = hex.padEnd(32, '0');
  return {id: `p-${suffix}`, kind, profileId: profile.id, team: profile.team, state: 'working', observedAt,
    name: `${kind === 'session' ? 'Session' : 'Subagent'} ${suffix.slice(0, 6).toUpperCase()}`,
    role: kind === 'session' ? 'Active session' : 'Delegated subagent', activity: 'Verified in-flight work.',
    ...(parentId ? {parentId} : {})};
}
function snapshot() {
  const root = person('a0b1c2', 'session');
  return {schemaVersion: 1, mode: 'live', source: 'Local Hermes status bridge', observedAt,
    pollIntervalMs: 30000, sourceHealth: 'connected', warnings: [], agents: [{...profile}],
    // Order is immaterial: parent references are checked after reading all rows.
    participants: [person('a1b2c3', 'subagent', root.id), root, person('a2b3c4', 'subagent', root.id)]};
}

for (const [boundary, project] of [['loopback API', validateSnapshot], ['browser', parseSnapshot]] as const) {
  test(`${boundary}: carries distinct working people without changing the legacy profile`, () => {
    const input = snapshot();
    const clean = project(input);
    assert.deepEqual(clean.agents, input.agents);
    assert.deepEqual(clean.participants, input.participants);
    assert.notEqual(clean.participants, input.participants);
    assert.notEqual(clean.participants![0], input.participants[0]);
    const {participants: _, ...legacy} = input;
    assert.ok(!Object.hasOwn(project(legacy), 'participants'));
  });

  test(`${boundary}: rejects private or unrecognized participant fields, not just unknown kinds`, () => {
    for (const changes of [{prompt: 'PRIVATE_TASK'}, {title: 'PRIVATE_LABEL'}, {activeSessions: 3},
      {id: '20261104_102030_PRIVATE'}, {name: 'PRIVATE_NAME'}, {role: 'PRIVATE_ROLE'}, {activity: 'PRIVATE_OUTPUT'},
      {name: 'Subagent FFFFFF'}, {kind: 'fork'}, {state: 'idle'}, {team: 'game'}, {observedAt: 'PRIVATE_TIMESTAMP'},
      {parentId: null}, {parentId: 42}, {lastActiveAt: 'PRIVATE_LAST_ACTIVE'}]) {
      const input = snapshot(); Object.assign(input.participants[0], changes);
      assert.throws(() => project(input), error => error instanceof Error && !error.message.includes('PRIVATE'),
        `must reject ${Object.keys(changes)[0]}`);
    }
    for (const stamp of [null, observedAt]) {
      const input = snapshot(); Object.assign(input.participants[0], {lastActiveAt: stamp});
      assert.deepEqual(project(input).participants![0].lastActiveAt, stamp);
    }
    const inherited = snapshot(); Object.setPrototypeOf(inherited.participants[0], {lastActiveAt: 'PRIVATE_METADATA'});
    assert.ok(!Object.hasOwn(project(inherited).participants![0], 'lastActiveAt'));
    inherited.participants[0] = Object.create(inherited.participants[0]);
    assert.throws(() => project(inherited), 'required telemetry must be a row’s own data');
  });

  test(`${boundary}: only observed, distinct participants in the same profile can form a parent chain`, () => {
    const secondProfile = {...profile, id: 'dev-team', name: 'Team', role: 'Team', team: 'development'};
    Reflect.deleteProperty(secondProfile, 'activeSessions');
    for (const [why, mutate] of [
      ['raw parent', (s) => Object.assign(s.participants[0], {parentId: 'PRIVATE_SESSION'})],
      ['unknown opaque parent', (s) => Object.assign(s.participants[0], {parentId: person('0', 'session').id})],
      ['aggregate as parent', (s) => Object.assign(s.participants[0], {parentId: profile.id})],
      ['self', (s) => Object.assign(s.participants[0], {parentId: s.participants[0].id})],
      ['cycle', (s) => {s.participants[0].parentId = s.participants[2].id; s.participants[2].parentId = s.participants[0].id;}],
      ['duplicate', (s) => {s.participants[2] = {...s.participants[0]};}],
      ['unknown profile', (s) => {s.participants[0].profileId = 'dev-absent';}],
      ['other profile', (s) => {s.agents.push(secondProfile); Object.assign(s.participants[0], {profileId: secondProfile.id, team: secondProfile.team});}],
    ] satisfies [string, (s: ReturnType<typeof snapshot>) => void][]) {
      const input = snapshot(); mutate(input);
      assert.throws(() => project(input), why);
    }
    const nested = snapshot(); nested.participants[2].parentId = nested.participants[0].id;
    assert.deepEqual(project(nested).participants, nested.participants);
    const orphan = snapshot(); orphan.participants = [person('a1b2c3', 'subagent')]; orphan.agents[0].activeSessions = 1;
    assert.deepEqual(project(orphan).participants, orphan.participants);
  });

  test(`${boundary}: requires current profile evidence and bounds the replacement roster`, () => {
    const tooMany = snapshot();
    tooMany.participants = Array.from({length: 129}, (_, i) => person((i + 1).toString(16).padStart(6, '0'), 'session'));
    tooMany.agents[0].activeSessions = 129;
    assert.throws(() => project(tooMany));
    const full = snapshot();
    for (let i = 0; i < 126; i++) {
      const extra = {...profile, id: `dev-team-${i}`, name: 'Team', role: 'Team', team: 'development'};
      Reflect.deleteProperty(extra, 'activeSessions'); full.agents.push(extra);
    }
    assert.throws(() => project(full), 'replacement roster would contain 129 workers');
    full.agents.pop(); assert.equal(project(full).participants!.length, 3, 'exactly 128 renderable rows are supported');
    for (const [why, mutate] of [
      ['aggregate lower than proven rows', s => {s.agents[0].activeSessions = 1;}],
      ['silent partial coverage', s => {s.agents[0].activeSessions = 4;}],
      ['profile not working', s => {s.agents[0].state = 'idle'; s.agents[0].activeSessions = 0;}],
      ['unavailable', s => {s.sourceHealth = 'unavailable';}],
    ] satisfies [string, (s: ReturnType<typeof snapshot>) => void][]) {
      const input = snapshot(); mutate(input); assert.throws(() => project(input), why);
    }
    const partial = snapshot(); partial.agents[0].activeSessions = 4; partial.sourceHealth = 'degraded';
    assert.deepEqual(project(partial).participants, partial.participants);
  });
}
