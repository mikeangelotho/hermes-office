import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Assets } from '../src/scene/room.ts';
const theme = await import('../src/scene/palette.ts').catch(() => ({})) as Record<string, any>;
const field = await import('../src/scene/fibers.ts').catch(() => ({})) as Record<string, any>;

test('hologram palette uses the portfolio royal blue on a near-black canvas', () => {
  assert.equal(theme.PALETTE?.blue, '#3366ff');
  const background = new THREE.Color(theme.PALETTE?.void);
  assert.ok(background.r < .015 && background.g < .015 && background.b < .025);
  const a = new Assets();
  try {
    const m = a.material(theme.PALETTE.blue);
    assert.equal(m.transparent, true);
    assert.ok(m.opacity > .3 && m.opacity < 1);
    assert.ok(m.emissiveIntensity > 0, 'hologram materials need restrained self-illumination');
    assert.equal(typeof m.customProgramCacheKey, 'function');
  } finally { a.dispose(); }
});

test('fiber/vector field is bounded, deterministic and updates without rebuilding geometry', () => {
  assert.equal(typeof field.createFiberField, 'function');
  const a = field.createFiberField(), b = field.createFiberField();
  try {
    let draws = 0, vertices = 0;
    const geometries: THREE.BufferGeometry[] = [];
    a.group.traverse((object: THREE.Object3D) => {
      if (object instanceof THREE.LineSegments || object instanceof THREE.Points) {
        draws++; vertices += object.geometry.getAttribute('position').count; geometries.push(object.geometry);
      }
    });
    assert.ok(draws > 0 && draws <= 4, `fiber field draw budget: ${draws}`);
    assert.ok(vertices <= 12000, `fiber field vertex budget: ${vertices}`);
    const initial = geometries.map(g => Array.from(g.getAttribute('position').array));
    a.tick(10, false); a.tick(20, true);
    assert.deepEqual(geometries.map(g => Array.from(g.getAttribute('position').array)), initial, 'animate uniforms, not buffers');
    assert.deepEqual(a.group.children.map((x: THREE.Object3D) => x.type), b.group.children.map((x: THREE.Object3D) => x.type));
    const material = (a.group.children.find((x: THREE.Object3D) => x instanceof THREE.LineSegments) as THREE.LineSegments).material as THREE.ShaderMaterial;
    const frozen = material.uniforms.uTime.value;
    a.tick(40, true); assert.equal(material.uniforms.uTime.value, frozen, 'reduced-motion field must freeze');
    let disposed = 0; geometries.forEach(g => g.addEventListener('dispose', () => disposed++));
    a.dispose(); assert.equal(disposed, geometries.length, 'field must dispose every geometry');
  } finally { a.dispose(); b.dispose(); }
});
