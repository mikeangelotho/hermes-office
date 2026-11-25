import test from 'node:test';
import assert from 'node:assert/strict';
const camera=await import('../src/scene/camera.ts') as Record<string,any>;
test('the memory lens uses bounded perspective framing across desktop, portrait and short banners',()=>{
  assert.equal(typeof camera.memoryLens,'function');
  for(const [w,h] of [[1440,960],[390,844],[1200,420],[0,0]]){
    const lens=camera.memoryLens(w,h,25);
    assert.ok(Number.isFinite(lens.aspect)&&lens.aspect>0);assert.ok(lens.fov>=20&&lens.fov<=55);
  }
  assert.ok(camera.memoryLens(390,844,25).fov>camera.memoryLens(1440,960,25).fov,'portrait reveals vertical space rather than making a tiny diorama');
});
