import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Assets } from '../src/scene/room.ts';
import { Character } from '../src/scene/character.ts';
import type { OfficeAgent } from '../src/domain/types.ts';

const agent: OfficeAgent = { id: 'studio-engineer', name: 'Engineer', role: 'Engineer', team: 'studio', state: 'idle', observedAt: '2026-11-04T12:00:00Z', activity: 'Fixture only' };

test('memory figures are compact faceted signal shells, not human skeletons or toy heads', () => {
  const assets = new Assets(), texture = new THREE.Texture();
  try {
    for (let i = 0; i < 10; i++) {
      const c = new Character(assets, agent, i, texture);
      try {
        const meshes: THREE.Mesh[] = [];
        c.body.traverse(o => { if (o instanceof THREE.Mesh && o.visible) meshes.push(o); });
        assert.ok(meshes.length <= 11, `signal silhouette has ${meshes.length} parts; limit is 11`);
        assert.ok(meshes.every(m => !/shoe|foot|thigh|calf|skin|hair|neck|upper-arm|forearm/i.test(m.name)), 'no visible human anatomy');
        assert.ok(!('thighs' in c) && !('calves' in c) && !('elbows' in c), 'the rig must not retain a hidden human skeleton');
        const shell = c.body.getObjectByName('signal-shell');
        assert.ok(shell instanceof THREE.Mesh, 'a visible shell must replace the torso');
        assert.equal(shell.geometry.type, 'ConeGeometry', 'the shell has a faceted tapered silhouette');
        const housing = c.head.getObjectByName('lens-housing');
        assert.ok(housing instanceof THREE.Mesh, 'the head is a prismatic lens housing');
        assert.equal(housing.geometry.type, 'CylinderGeometry', 'no spherical humanoid head');
        assert.ok(meshes.every(m => m.geometry.type !== 'SphereGeometry'));
        c.root.updateMatrixWorld(true);
        const head = new THREE.Box3().setFromObject(c.head).getSize(new THREE.Vector3());
        const shellSize = new THREE.Box3().setFromObject(shell).getSize(new THREE.Vector3());
        assert.ok(head.x / shellSize.x < .72, 'the lens stays subordinate to the shell');
        assert.ok(head.y < .36, 'the lens is compact, not an oversized cube head');
        assert.equal(c.hands.length, 2);
        for (const hand of c.hands) {
          assert.equal(hand.parent, c.body, 'manipulators float independently, without arm bones');
          assert.equal(hand.geometry.type, 'IcosahedronGeometry');
          assert.ok(!new THREE.Box3().setFromObject(shell).intersectsBox(new THREE.Box3().setFromObject(hand)), 'manipulators must be visibly separated from the shell');
        }
        const fins = meshes.filter(m => m.name.startsWith('signal-fin'));
        assert.equal(fins.length, 2, 'restrained fin count');
        assert.ok(Math.abs(fins[0].scale.y - fins[1].scale.y) > .1, 'the fins break bilateral humanoid symmetry');
      } finally { c.dispose(); }
    }
  } finally { assets.dispose(); texture.dispose(); }
});
