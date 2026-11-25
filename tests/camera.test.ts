import test from 'node:test';
import assert from 'node:assert/strict';
const feature = await import('../src/scene/camera.ts').catch(() => ({})) as Record<string, (...args: any[]) => any>;
test('immersive framing fills wide and portrait viewports instead of shrinking the whole room to fit', () => {
  assert.equal(typeof feature.framingFor, 'function', 'immersive camera framing not implemented');
  const desktop = feature.framingFor(1440,960), portrait=feature.framingFor(390,844), banner=feature.framingFor(1200,440);
  assert.ok(desktop.width <= 21); assert.ok(desktop.height < 15);
  assert.ok(portrait.width < 12); assert.ok(portrait.height <= 19);
  for (const frame of [desktop,portrait,banner,feature.framingFor(0,0)]) {
    assert.ok(Number.isFinite(frame.width) && frame.width > 0);
    assert.ok(Number.isFinite(frame.height) && frame.height > 0);
  }
});
test('full-screen rendering caps pixel work even on high-DPI and 4K screens', () => {
  assert.equal(typeof feature.pixelRatioFor, 'function', 'pixel budget not implemented');
  for (const [width,height,dpr] of [[1440,960,2],[3840,2160,2],[390,844,3]]) {
    const ratio=feature.pixelRatioFor(width,height,dpr);
    assert.ok(ratio>0 && ratio<=dpr);
    assert.ok(width*height*ratio*ratio<=3000001);
  }
});
