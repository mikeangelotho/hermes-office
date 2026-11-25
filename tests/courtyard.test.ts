import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Assets } from '../src/scene/room.ts';
const feature = await import('../src/scene/courtyard.ts').catch(() => ({})) as Record<string, (...args: any[]) => any>;
test('the decorative world is instanced and adds fewer than 4000 triangles', () => {
  assert.equal(typeof feature.createCourtyard, 'function', 'courtyard not implemented');
  const assets = new Assets(); const world = feature.createCourtyard(assets);
  try {
    let triangles=0, draws=0;
    world.group.traverse((node: THREE.Object3D) => {
      if (node instanceof THREE.Mesh) { draws++; const geometry=node.geometry; triangles += (geometry.index ? geometry.index.count : geometry.attributes.position.count) / 3 * (node instanceof THREE.InstancedMesh ? node.count : 1); }
    });
    assert.ok(draws <= 24, 'decorations must be batched, not hundreds of individual draw calls');
    assert.ok(triangles > 0 && triangles < 4000, `decoration budget exceeded: ${triangles}`);
  } finally { world.dispose(); assets.dispose(); }
});
