import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
const feature = await import('../src/scene/data-trails.ts').catch(() => ({})) as Record<string, any>;

test('data trails follow actual movement in bounded world-space buffers and clear on pause', () => {
  assert.equal(typeof feature.createDataTrails,'function');
  const effect = feature.createDataTrails(10);
  const head = new THREE.Object3D();head.position.set(0,1.5,0);
  const subjects = [{head,hands:[]}];
  try {
    const buffer = effect.points.geometry.getAttribute('position').array;
    assert.ok(effect.points.geometry.getAttribute('position').count <= 1024);
    effect.update(0,subjects,false);
    head.position.x = 1;effect.update(.15,subjects,false);
    assert.ok(effect.active > 0,'moving agents should leave spatial data traces');
    assert.equal(effect.points.geometry.getAttribute('position').array,buffer,'motion must not rebuild geometry');
    effect.update(.3,subjects,true);
    assert.equal(effect.active,0,'pause clears detached movement trails');
    let geometries = 0, materials = 0;
    effect.points.geometry.addEventListener('dispose',()=>geometries++);
    effect.points.material.addEventListener('dispose',()=>materials++);
    effect.dispose();effect.dispose();
    assert.equal(geometries,1);assert.equal(materials,1);
  } finally {effect.dispose();}
});
