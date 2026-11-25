import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Assets } from '../src/scene/room.ts';
import { Character } from '../src/scene/character.ts';
import type { OfficeAgent } from '../src/domain/types.ts';
const agent = (state: OfficeAgent['state']): OfficeAgent => ({ id: 'studio-engineer', name: 'Engineer', role: 'Engineer', team: 'studio', state, observedAt: new Date().toISOString(), activity: 'Fixture only' });
test('a character reaches its real destination without teleporting on status updates', () => {
  const assets = new Assets(); const texture = new THREE.Texture(); const c = new Character(assets, agent('idle'), 2, texture);
  try {
    c.update(agent('working'), 2, false);
    for (let i = 0; i < 1000 && c.path.length; i++) c.tick(i / 30, 1 / 30, false);
    assert.equal(c.path.length, 0); assert.equal(c.root.position.x, c.seat.x); assert.equal(c.root.position.z, c.seat.z);
    assert.equal(c.seat.kind, 'desk');
  } finally { c.dispose(); assets.dispose(); texture.dispose(); }
});
test('rapid state reversals preserve the actual aisle route with bounded waypoints', () => {
  const assets = new Assets(); const texture = new THREE.Texture(); const c = new Character(assets, agent('idle'), 2, texture);
  try {
    c.update(agent('working'), 2, false);
    for (let i = 0; i < 20; i++) c.tick(i / 10, .1, false);
    c.update(agent('idle'), 2, false);
    const next = c.path[0];
    assert.ok(Math.abs(next.x - c.root.position.x) < .001 || Math.abs(next.z - c.root.position.z) < .001, 'a reversal must not cut diagonally through furniture');
    for (let i = 0; i < 100; i++) c.update(agent(i % 2 ? 'working' : 'idle'), 2, false);
    assert.ok(c.path.length <= 14, 'rapid toggles must not accumulate unbounded travel');
  } finally { c.dispose(); assets.dispose(); texture.dispose(); }
});
