import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Assets } from '../src/scene/room.ts';
import { Character } from '../src/scene/character.ts';
import { ROOM } from '../src/scene/layout.ts';
import type { AgentState, OfficeAgent, Team } from '../src/domain/types.ts';
const teams: Team[] = ['studio', 'development', 'game', 'science', 'general'];
const agent = (state: AgentState, team: Team = 'studio'): OfficeAgent => ({ id: `${team}-fixture`, name: 'Signal', role: 'Fixture', team, state, observedAt: '2026-11-04T12:00:00Z', activity: 'Fixture only' });
const bounds = (o: THREE.Object3D) => new THREE.Box3().setFromObject(o);
const position = (o: THREE.Object3D) => o.getWorldPosition(new THREE.Vector3());

test('inactive teams have real lounge, dock, controller, meditation and resting transforms', () => {
  const assets = new Assets(), texture = new THREE.Texture();
  const figures = teams.map(team => new Character(assets, agent('idle', team), 2, texture));
  try {
    const [studio, development, game, science, general] = figures;
    figures.forEach(c => { c.tick(0, 0, true); c.root.updateMatrixWorld(true); });
    assert.ok(studio.body.rotation.x < -.3, 'studio visibly reclines, not just a different diagnostic label');
    assert.ok(Math.abs(development.body.rotation.x) < .06, 'development docks upright');
    assert.ok(game.body.rotation.x > .18, 'game leans into the controller gesture');
    const span = (c: Character) => position(c.hands[0]).distanceTo(position(c.hands[1]));
    assert.ok(span(game) < .23, 'game manipulators meet around an implied controller');
    assert.ok(span(development) < span(general) * .6, 'development manipulators fold toward the dock');
    assert.ok(span(science) > .6, 'science has an open meditative gesture');
    assert.ok(science.body.position.y > general.body.position.y + .3, 'science visibly levitates');
    assert.ok(Math.abs(general.body.rotation.x) < .1 && span(general) > .5, 'general quietly rests');
    const dockFin = development.body.getObjectByName('signal-fin-left')!;
    const restFin = general.body.getObjectByName('signal-fin-left')!;
    assert.ok(Math.abs(dockFin.position.x) < Math.abs(restFin.position.x) - .07, 'docked fins actually fold in');
    const matrices = figures.map(c => JSON.stringify([c.body.matrix.elements, ...c.hands.map(h => h.matrix.elements)]));
    assert.equal(new Set(matrices).size, teams.length, 'every team has a distinct rendered pose');
    assert.deepEqual(figures.map(c => c.root.userData.inactivePose), ['lounge', 'docked', 'controller', 'meditative', 'resting']);
    studio.update(agent('idle', 'science'), 2, true); studio.tick(0, 0, true);
    assert.equal(studio.root.userData.inactivePose, 'meditative');
    assert.equal(studio.body.position.y, science.body.position.y, 'team updates must change the actual pose without changing seats');
    studio.update(agent('working', 'science'), 2, false); studio.tick(1, .02, false);
    assert.equal(studio.root.userData.inactivePose, null, 'a travelling agent must not claim an inactive pose');
  } finally { figures.forEach(c => c.dispose()); assets.dispose(); texture.dispose(); }
});

test('every inactive team, state and slot floats clear of support surfaces and the floor', () => {
  const assets = new Assets(), texture = new THREE.Texture();
  const box = (x: number, y: number, z: number, sx: number, sy: number, sz: number) => new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(x, y, z), new THREE.Vector3(sx, sy, sz));
  // Existing room solids, plus .80m clearance for the room-specific docking surfaces.
  const supports: THREE.Box3[] = [];
  for (const side of [-1, 1]) {
    const x = side * 3.7;
    supports.push(box(x, .25, 3.56, 5.1, .13, 1.05), box(x, .75, 3.12, 5.35, .61, .19));
    for (const dx of [-2.6, 2.6]) supports.push(box(x + dx, .63, 3.58, .15, .53, 1.1));
    for (let i = 0; i < 5; i++) supports.push(box(x - 2 + i, .49, 3.66, .96, .25, .88));
  }
  try {
    for (const team of teams) for (const state of ['idle', 'paused', 'offline'] as const) for (let i = 0; i < ROOM.capacity; i++) {
      const c = new Character(assets, agent(state, team), i, texture);
      try {
        for (const reduced of [true, false]) for (const time of [0, .4, 2, 9]) {
          c.tick(time, 1 / 30, reduced); c.root.updateMatrixWorld(true);
          const whole = bounds(c.body), label = `${team}/${state}/${i}/${time}`;
          assert.ok(whole.min.y >= .80, `${label}: fragment clips supporting surface (${whole.min.y})`);
          assert.ok(whole.min.x >= c.seat.x - .5 && whole.max.x <= c.seat.x + .5, `${label}: silhouette leaves its local seat slot`);
          c.body.traverse(o => {
            if (!(o instanceof THREE.Mesh) || !o.visible) return;
            assert.ok(bounds(o).min.y > .035, `${label}: ${o.name} clips floor`);
            assert.ok(supports.every(surface => !bounds(o).intersectsBox(surface)), `${label}: ${o.name} clips furniture`);
          });
          assert.equal(c.root.position.x, c.seat.x); assert.equal(c.root.position.z, c.seat.z);
        }
      } finally { c.dispose(); }
    }
  } finally { assets.dispose(); texture.dispose(); }
});

test('desk shells clear chairs and separated manipulators reach above real keyboards', () => {
  const assets = new Assets(), texture = new THREE.Texture();
  try {
    for (const team of teams) for (let i = 0; i < ROOM.capacity; i++) {
      const c = new Character(assets, agent('working', team), i, texture);
      try {
        for (const reduced of [true, false]) for (const time of [0, .2, 1, 8]) {
          c.tick(time, 1 / 30, reduced); c.root.updateMatrixWorld(true);
          assert.ok(bounds(c.body).min.y > .595, 'the floating shell must clear the chair seat');
          assert.equal(c.root.rotation.y, Math.PI, 'the lens and manipulators face the screen');
          assert.equal(c.root.userData.inactivePose, null);
          assert.equal(c.hands.length, 2, 'typing needs two separated manipulators');
          for (const hand of c.hands) {
            const at = position(hand), extent = bounds(hand);
            assert.ok(at.y >= 1.12 && at.y <= 1.25, `typing manipulator is not at keyboard height (${at.y})`);
            assert.ok(extent.min.y > 1.174, `typing manipulator penetrates the keyboard (${extent.min.y})`);
            assert.ok(Math.abs(at.z - (c.seat.z - .75)) < .12, 'typing must reach the keyboard, not float over the lap');
            assert.ok(Math.abs(at.x - c.seat.x) < .335, 'typing stays within keyboard width');
          }
        }
      } finally { c.dispose(); }
    }
  } finally { assets.dispose(); texture.dispose(); }
});
