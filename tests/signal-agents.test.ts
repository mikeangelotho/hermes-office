import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Character } from '../src/scene/character.ts';
import { Assets } from '../src/scene/room.ts';
import { seatFor } from '../src/scene/layout.ts';
import type { OfficeAgent, Team } from '../src/domain/types.ts';

const teams: Team[] = ['studio', 'development', 'game', 'science', 'general'];
const agent = (team: Team = 'general', state: OfficeAgent['state'] = 'idle', id = `${team}-fixture`): OfficeAgent => ({ id, team, state, name: 'Signal', role: 'Fixture', observedAt: '2026-11-04T12:00:00Z', activity: 'Fixture only' });

const poseSnapshot = (c: Character) => {
  c.root.updateMatrixWorld(true);
  const matrices: number[][] = [];
  c.root.traverse(o => matrices.push([...o.matrix.elements]));
  return { matrices, path: c.path.map(p => ({ ...p })), diagnostic: c.root.userData.inactivePose, selected: c.ring.visible };
};

test('33 signal beings share low-poly assets within the draw-part budget and retain blue signal hierarchy', t => {
  const assets = new Assets(), texture = new THREE.Texture();
  const figures = Array.from({ length: 33 }, (_, i) => new Character(assets, agent(teams[i % teams.length], 'idle', `signal-${i}`), i % 10, texture));
  const geometries = new Set(assets.geometries.values()), materials = new Set(assets.materials.values());
  let parts = 0, triangles = 0;
  try {
    for (const c of figures) {
      const meshes: THREE.Mesh[] = [];
      c.root.traverse(o => { if (o instanceof THREE.Mesh && o.visible && ![c.pick, c.ring, c.shadow].includes(o)) meshes.push(o); });
      assert.ok(meshes.length > 0 && meshes.length <= 11, 'visible parts must remain bounded, including non-body siblings');
      parts += meshes.length;
      let figureTriangles = 0;
      for (const mesh of meshes) {
        assert.ok(geometries.has(mesh.geometry), `${mesh.name} creates per-agent geometry`);
        assert.ok(materials.has(mesh.material as THREE.MeshLambertMaterial), `${mesh.name} creates per-agent material`);
        assert.ok(mesh.geometry.getAttribute('position').count <= 100, `${mesh.name} is not a low-poly primitive`);
        figureTriangles += (mesh.geometry.index?.count ?? mesh.geometry.getAttribute('position').count) / 3;
        const material = mesh.material as THREE.MeshLambertMaterial;
        assert.equal(material.userData.hologramRole, 'agent');
        assert.equal(material.flatShading, true); assert.equal(material.map, null); assert.equal(material.emissiveMap, null);
        assert.ok(material.emissive.b > material.emissive.g && material.emissive.g > material.emissive.r, 'no skin tones or unrelated rainbow colors');
        assert.equal(mesh.castShadow, false, 'fragments must not introduce shadow passes');
      }
      assert.ok(figureTriangles <= 300, `signal geometry exceeds budget: ${figureTriangles} triangles`);
      triangles += figureTriangles;
      const light = (name: string) => {
        const m = (c.body.getObjectByName(name) as THREE.Mesh).material as THREE.MeshLambertMaterial;
        return (.2126 * m.emissive.r + .7152 * m.emissive.g + .0722 * m.emissive.b) * m.emissiveIntensity;
      };
      assert.ok(light('lens-highlight') > light('signal-aperture'), 'tiny lens highlight is brightest');
      assert.ok(light('signal-aperture') > light('signal-shell'), 'the aperture leads the shell in the signal hierarchy');
      assert.ok(light('signal-shell') > light('signal-fin-left'), 'fins stay visually subordinate');
      const resources = meshes.map(m => [m.geometry, m.material]);
      c.tick(4, .05, false); c.tick(20, .05, false); c.tick(0, 0, true);
      const frozen = poseSnapshot(c); c.tick(30, .05, true);
      assert.deepEqual(poseSnapshot(c), frozen);
      meshes.forEach((m, i) => { assert.equal(m.geometry, resources[i][0]); assert.equal(m.material, resources[i][1]); });
    }
    assert.equal(assets.geometries.size, geometries.size); assert.equal(assets.materials.size, materials.size);
    assert.ok(geometries.size <= 4); assert.ok(materials.size <= 16);
    assert.equal(assets.textures.size, 0, 'no new per-agent textures');
    t.diagnostic(`${figures.length} agents: ${parts} visible parts, ${triangles} triangles, ${geometries.size} shared geometries, ${materials.size} shared materials`);
  } finally { figures.forEach(c => c.dispose()); assets.dispose(); texture.dispose(); }
});

test('all inactive teams track gaze inside translated rooms while desk states and travel refuse it', () => {
  const assets = new Assets(), texture = new THREE.Texture();
  const camera = new THREE.PerspectiveCamera(50, 1.6, .1, 200); camera.position.set(28, 19, 30); camera.lookAt(10, 1, -6); camera.updateMatrixWorld(true);
  const room = new THREE.Group(); room.position.set(12, 0, -8); room.rotation.y = .4;
  try {
    for (const team of teams) {
      const c = new Character(assets, agent(team), 2, texture); room.add(c.root);
      try {
        room.updateMatrixWorld(true);
        const screen = c.head.getWorldPosition(new THREE.Vector3()).project(camera);
        const bodyPitch = c.body.rotation.x, rootYaw = c.root.rotation.y;
        assert.equal(c.lookAtCursor(new THREE.Vector2(screen.x - .5, screen.y - .3), camera), true);
        for (let i = 0; i < 60; i++) c.tick(i / 30, 1 / 30, false);
        const left = c.head.rotation.y, low = c.head.rotation.x;
        c.lookAtCursor(new THREE.Vector2(screen.x + .5, screen.y + .3), camera);
        for (let i = 0; i < 60; i++) c.tick(2 + i / 30, 1 / 30, false);
        assert.ok(c.head.rotation.y > left + .1 && c.head.rotation.x < low - .05, `${team}: lens must follow both axes`);
        assert.ok(Math.abs(c.head.rotation.y) <= .751 && Math.abs(c.head.rotation.x) <= .321);
        assert.equal(c.body.rotation.x, bodyPitch); assert.equal(c.root.rotation.y, rootYaw, 'gaze does not turn the room-local pose');
        for (const state of ['working', 'waiting', 'blocked'] as const) {
          c.update(agent(team, state), 2, false);
          assert.equal(c.lookAtCursor(new THREE.Vector2(1, 1), camera), false);
          for (let i = 0; i < 1000 && c.path.length; i++) {
            c.tick(i / 30, 1 / 30, false);
            assert.ok(new THREE.Box3().setFromObject(c.body).min.y > .035, 'travel never clips below the floor');
          }
          assert.equal(c.path.length, 0); c.tick(40, 1 / 30, false);
          assert.equal(c.lookAtCursor(new THREE.Vector2(1, 1), camera), false);
          assert.equal(c.head.rotation.y, 0);
          assert.equal(c.agent.state, state, 'visual poses must not invent status changes');
        }
      } finally { c.dispose(); }
    }
  } finally { assets.dispose(); texture.dispose(); }
});

test('reduced motion settles queued travel and freezes every fragment instead of continuing to glide', () => {
  const assets = new Assets(), texture = new THREE.Texture();
  const c = new Character(assets, agent('science'), 2, texture);
  const camera = new THREE.PerspectiveCamera(); camera.position.set(16, 13, 19); camera.lookAt(0, 1, 0);
  try {
    c.update(agent('science', 'working'), 2, false);
    c.tick(1, .05, false); assert.ok(c.path.length > 0);
    c.tick(2, .05, true);
    assert.equal(c.path.length, 0, 'reduced motion must settle travel, not keep gliding');
    assert.equal(c.root.position.x, c.seat.x); assert.equal(c.root.position.z, c.seat.z);
    const desk = poseSnapshot(c);
    for (const time of [4, 20, 100]) { c.tick(time, .05, true); assert.deepEqual(poseSnapshot(c), desk); }
    c.update(agent('science'), 2, false); assert.ok(c.path.length > 0);
    c.update(agent('science'), 2, true);
    assert.equal(c.path.length, 0, 'a repeated status update must also settle an already queued route');
    c.tick(0, 0, true);
    const resting = poseSnapshot(c);
    for (const time of [1, 20, 100]) {
      c.lookAtCursor(new THREE.Vector2(1, -1), camera); c.tick(time, .05, true);
      assert.deepEqual(poseSnapshot(c), resting, 'reduced motion freezes pose, hover, manipulators and gaze');
    }
    c.lookAtCursor(null, camera);
    c.tick(2, .05, false);
    assert.notDeepEqual(poseSnapshot(c), resting, 'unpaused idle hover can resume');
  } finally { c.dispose(); assets.dispose(); texture.dispose(); }
});

test('disposal releases owned resources exactly once, leaves shared assets alive and makes updates inert', () => {
  const assets = new Assets(), texture = new THREE.Texture();
  const c = new Character(assets, agent(), 0, texture);
  const scene = new THREE.Group(); scene.add(c.root);
  const owned = [c.pick.geometry, c.pick.material as THREE.Material, c.ring.geometry, c.ring.material as THREE.Material, c.shadow.geometry, c.shadow.material as THREE.Material];
  const shared = [...assets.geometries.values(), ...assets.materials.values(), texture];
  const releases = new Map([...owned, ...shared].map(resource => [resource, 0]));
  for (const resource of releases.keys()) resource.addEventListener('dispose', () => releases.set(resource, releases.get(resource)! + 1));
  try {
    c.select(true); c.update(agent('general', 'working'), 0, false);
    assert.ok(c.path.length > 0);
    c.dispose(); c.dispose();
    for (const resource of owned) assert.equal(releases.get(resource), 1, 'owned GPU resource disposed more than once');
    for (const resource of shared) assert.equal(releases.get(resource), 0, 'a character must not dispose shared geometry, material or shadow texture');
    assert.equal(c.root.parent, null, 'disposed renderables must detach from their room');
    assert.equal(c.path.length, 0);
    const disposed = poseSnapshot(c), previousAgent = c.agent;
    c.tick(40, .1, false); c.select(false); c.update(agent('studio'), 0, false);
    assert.equal(c.lookAtCursor(new THREE.Vector2(.5, .5), new THREE.PerspectiveCamera()), false);
    assert.equal(c.agent, previousAgent, 'disposed status must remain inert');
    assert.deepEqual(poseSnapshot(c), disposed, 'disposed transforms and selection must not animate');
  } finally { c.dispose(); assets.dispose(); texture.dispose(); }
});

test('optional capacity centers a one-slot signal being and preserves its aisle route on updates', () => {
  const assets = new Assets(), texture = new THREE.Texture();
  const c = new Character(assets, agent(), 0, texture, 1);
  try {
    assert.equal(c.root.position.x, 0, 'one-slot inactive room is centered, not a ten-slot corner');
    assert.deepEqual(c.seat, seatFor(0, 'idle', 1));
    c.update(agent('general', 'working'), 0, false);
    assert.deepEqual(c.seat, seatFor(0, 'working', 1));
    assert.equal(c.root.position.z, 3.86, 'status updates must not teleport');
    assert.ok(c.path.length > 0);
    assert.ok(c.path.every(p => Math.abs(p.x) <= 2.5), 'the route must use the small-room aisle');
    for (let i = 0; i < 1000 && c.path.length; i++) c.tick(i / 30, 1 / 30, false);
    assert.equal(c.path.length, 0); assert.equal(c.root.position.x, 0); assert.equal(c.root.position.z, -2.15);
    c.update(agent(), 0, true); c.tick(0, 0, true);
    assert.equal(c.path.length, 0); assert.equal(c.root.position.x, 0); assert.equal(c.root.position.z, 3.86);
    assert.equal(c.root.userData.inactivePose, 'resting');
  } finally { c.dispose(); assets.dispose(); texture.dispose(); }
});
