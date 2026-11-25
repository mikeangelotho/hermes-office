import test from 'node:test';
import assert from 'node:assert/strict';
const feature = await import('../src/scene/layout.ts').catch(() => ({})) as Record<string, (...args: any[]) => any>;
test('every room seat has a unique stable position and stays inside the room', () => {
  assert.equal(typeof feature.seatFor, 'function', 'seat allocator not implemented');
  const desks = Array.from({ length: 10 }, (_, i) => feature.seatFor(i, 'working'));
  const couches = Array.from({ length: 10 }, (_, i) => feature.seatFor(i, 'idle'));
  assert.equal(new Set(desks.map(p => `${p.x},${p.z}`)).size, 10);
  assert.equal(new Set(couches.map(p => `${p.x},${p.z}`)).size, 10);
  for (const p of [...desks, ...couches]) { assert.ok(Math.abs(p.x) < 7.3); assert.ok(Math.abs(p.z) < 5.6); }
  assert.deepEqual(feature.seatFor(0, 'waiting'), feature.seatFor(0, 'working'));
  assert.deepEqual(feature.seatFor(0, 'paused'), feature.seatFor(0, 'idle'));
});
test('small rooms center their stations and idle places instead of leaving everyone on one edge', () => {
  for(const count of [1,2,3,4]) {
    const desks=Array.from({length:count},(_,i)=>feature.seatFor(i,'working',count));
    const seats=Array.from({length:count},(_,i)=>feature.seatFor(i,'idle',count));
    assert.ok(Math.abs(desks.reduce((sum,p)=>sum+p.x,0))<.00001);
    assert.ok(Math.abs(seats.reduce((sum,p)=>sum+p.x,0))<.00001);
  }
});
test('desk-to-couch travel uses the walking aisles rather than crossing desks', () => {
  assert.equal(typeof feature.routeFor, 'function', 'walking routes not implemented');
  const start = feature.seatFor(2, 'idle'); const end = feature.seatFor(2, 'working');
  const path = feature.routeFor(start, end);
  assert.deepEqual(path[0], { x: start.x, z: start.z });
  assert.deepEqual(path.at(-1), { x: end.x, z: end.z });
  assert.ok(path.some((p: any) => p.z >= 4.5));
  assert.ok(path.some((p: any) => p.x >= 6.5));
  assert.throws(() => feature.seatFor(10, 'idle'), RangeError);
});
