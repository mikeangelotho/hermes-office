import test from 'node:test';
import assert from 'node:assert/strict';
import { Assets } from '../src/scene/room.ts';
import { PALETTE as P } from '../src/scene/palette.ts';

test('agents have distinct brighter materials than the same-colored environment', () => {
  const assets = new Assets();
  try {
    const material = assets.material.bind(assets) as (color: string, kind: string, role?: string) => ReturnType<Assets['material']>;
    const prop = material(P.blue, 'box', 'environment');
    const agent = material(P.blue, 'box', 'agent');
    assert.notEqual(agent, prop, 'a shared color must not collapse the signal hierarchy');
    assert.ok(agent.emissiveIntensity > prop.emissiveIntensity * 3, 'agents must be the primary light signals');
    assert.ok(agent.color.b > prop.color.b, 'environment bodies must be quieter than agent bodies');
    assert.equal(agent.userData.hologramRole, 'agent');
    assert.equal(prop.userData.hologramRole, 'environment');
    assert.ok(prop.emissiveIntensity > 0, 'even dull objects need a faint data glow');
    assert.equal(material(P.blue, 'box', 'agent'), agent, 'per-role materials remain shared');
  } finally { assets.dispose(); }
});

test('glass shader binds a shared blurred backdrop rather than alpha alone', () => {
  const assets = new Assets();
  try {
    const material = assets.material(P.glass);
    const shader: any = { uniforms: {}, vertexShader: '#include <begin_vertex>', fragmentShader: '#include <tonemapping_fragment>\n#include <dithering_fragment>' };
    material.onBeforeCompile(shader, {} as never);
    assert.ok(shader.uniforms.uHoloBackdrop, 'glass needs a real scene texture');
    assert.ok(shader.uniforms.uHoloViewport, 'refraction must be screen-space aligned');
    assert.match(shader.fragmentShader, /textureLod/,'frost needs filtered mip-level sampling');
    assert.match(shader.fragmentShader, /uHoloGlassReady/,'missing capture needs a safe fallback');
  } finally { assets.dispose(); }
});
