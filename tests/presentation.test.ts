import test from 'node:test';
import assert from 'node:assert/strict';
const feature = await import('../src/domain/presentation.ts').catch(() => ({})) as Record<string, (...args: any[]) => any>;
test('embedded presentation disables private data and visible application UI', () => {
  assert.equal(typeof feature.presentationFor, 'function', 'presentation boundary not implemented');
  for (const query of ['?embed=1&source=live', '?view=embedded', '?view=hero']) {
    const presentation = feature.presentationFor(query);
    assert.equal(presentation.embedded, true); assert.equal(presentation.source, 'demo');
  }
  assert.deepEqual(feature.presentationFor(''), { embedded: false, ambient: false, source: 'live', team: 'all' });
  assert.equal(feature.presentationFor('?source=demo').source, 'demo');
  assert.equal(feature.presentationFor('?team=development').team, 'development');
  assert.equal(feature.presentationFor('?team=invalid').team, 'all');
  assert.equal(feature.presentationFor('', 'development').team, 'development');
  assert.equal(feature.presentationFor('?team=science', 'development').team, 'science');
  assert.equal(feature.presentationFor('?embed=1', 'development').team, 'all');
});

test('ambient is a live top-level view; a frame or any decorative alias always wins', () => {
  assert.deepEqual(feature.presentationFor('?view=ambient&source=demo&team=general'),
    { embedded: false, ambient: true, source: 'live', team: 'general' });
  for (const query of ['', '?source=live', '?view=ambient', '?view=ambient&source=live']) {
    assert.deepEqual(feature.presentationFor(query, 'studio', true),
      { embedded: true, ambient: false, source: 'demo', team: 'all' }, `framed ${query}`);
  }
  for (const query of ['?embed=1&view=ambient', '?view=ambient&view=hero', '?embed=0&embed=1&source=live']) {
    assert.deepEqual(feature.presentationFor(query), { embedded: true, ambient: false, source: 'demo', team: 'all' });
  }
});
