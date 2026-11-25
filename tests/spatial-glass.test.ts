import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Assets } from '../src/scene/room.ts';
import { PALETTE as P } from '../src/scene/palette.ts';
const feature = await import('../src/scene/spatial-glass.ts').catch(() => ({})) as Record<string, any>;

test('frosted backdrop resolution stays bounded at portrait, desktop and 4K sizes', () => {
  assert.equal(typeof feature.glassCaptureSize, 'function');
  for (const [width, height] of [[390,844],[1440,960],[3840,2160],[0,0],[NaN,Infinity]]) {
    const size = feature.glassCaptureSize(width,height);
    assert.ok(Number.isInteger(size.width) && size.width > 0);
    assert.ok(Number.isInteger(size.height) && size.height > 0);
    assert.ok(size.width * size.height <= 160000);
    assert.ok(Math.max(size.width,size.height) <= 640);
    if (width > 0 && height > 0) assert.ok(Math.abs(size.width / size.height - width / height) < .02);
  }
});

test('backdrop batches real world geometry and motion, excluding the glass itself', () => {
  assert.equal(typeof feature.createGlassProxy, 'function');
  const a = new Assets(), root = new THREE.Group();
  for (let i = 0; i < 100; i++) a.mesh(P.blue,[.5,.5,.5],[i,0,0],'box',root);
  const actor = a.mesh(P.ice,[.4,1,.4],[2,1,0],'box',root,'agent' as never);
  a.mesh(P.glass,[4,4,.1],[0,2,2],'box',root);
  const proxy = feature.createGlassProxy([root]);
  try {
    assert.equal(proxy.scene.children.length,1,'same geometry should have one instanced capture draw');
    const batch = proxy.scene.children[0] as THREE.InstancedMesh;
    assert.equal(batch.count,101,'glass must not occlude its own backdrop');
    actor.position.x = 7; proxy.sync();
    const matrix = new THREE.Matrix4(); batch.getMatrixAt(100,matrix);
    assert.equal(matrix.elements[12],7,'capture must use current world-space poses');
    let borrowedDisposed = 0;
    a.geometry().addEventListener('dispose',() => borrowedDisposed++);
    proxy.dispose(); assert.equal(borrowedDisposed,0,'capture does not own shared source geometry');
  } finally { proxy.dispose();a.dispose(); }
});
