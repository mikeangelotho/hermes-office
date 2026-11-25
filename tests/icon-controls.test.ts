import test from 'node:test';
import assert from 'node:assert/strict';
const ui = await import('../src/ui/controls.ts').catch(() => ({})) as Record<string,any>;

test('icon navigation has distinct consistent symbols and descriptive accessible labels', () => {
  assert.ok(ui.PANEL_CONTROLS,'icon navigation has not been implemented');
  assert.deepEqual(ui.PANEL_CONTROLS.map((x:any)=>x.panel),['team','view','status','help']);
  assert.equal(new Set(ui.PANEL_CONTROLS.map((x:any)=>x.icon)).size,4);
  assert.ok(ui.PANEL_CONTROLS.every((x:any)=>x.label.length>4&&x.title.length>0));
  assert.deepEqual(Object.keys(ui.TEAM_ICONS),['general','studio','development','game','science']);
  assert.equal(new Set(Object.values(ui.TEAM_ICONS)).size,5,'teams need recognizable distinct symbols');
});
