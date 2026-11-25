import test from 'node:test';
import assert from 'node:assert/strict';
import * as feature from './office-api.ts';
test('the bridge is available in both Vite development and preview servers', () => {
  const factory = (feature as Record<string, unknown>).officeApiPlugin;
  assert.equal(typeof factory, 'function', 'Vite bridge plugin is missing');
  const plugin = (factory as () => Record<string, unknown>)();
  assert.equal(typeof plugin.configureServer, 'function');
  assert.equal(typeof plugin.configurePreviewServer, 'function');
});
