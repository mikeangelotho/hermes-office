import { test, expect } from '@playwright/test';

test('live mode returns real profile observations and rejects writes', async ({ page, request }) => {
  const [response] = await Promise.all([
    page.waitForResponse(r => new URL(r.url()).pathname === '/api/office'),
    page.goto('/?team=all'),
  ]);
  expect(response.status()).toBe(200);
  const snapshot = await response.json();
  expect(snapshot.schemaVersion).toBe(1);
  expect(snapshot.mode).toBe('live');
  expect(snapshot.agents.length).toBeGreaterThan(0);
  expect(response.headers()['cache-control']).toBe('no-store');
  const denied = await request.post('/api/office', { data: { command: 'start' } });
  expect(denied.status()).toBe(405);

  await page.getByRole('button', {name:'Open status',exact:true}).click();
  await expect(page.getByRole('button', { name: 'Live', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await page.getByRole('button', {name:'Open team',exact:true}).click();
  // Check the actual response this page rendered, independently of the UI projection.
  const participants: { id: string; profileId: string }[] = snapshot.participants ?? [];
  const covered = new Set(participants.map(person => person.profileId));
  const expectedIds = [...participants, ...snapshot.agents.filter((profile: { id: string }) => !covered.has(profile.id))]
    .map(row => row.id);
  expect(new Set(expectedIds).size).toBe(expectedIds.length);
  await expect(page.getByTestId('agent-row')).toHaveCount(expectedIds.length);
  await expect(page.getByTestId('scene-canvas')).toHaveAttribute('data-agents', String(expectedIds.length));
  await expect(page.getByText('Simulated activity', { exact: true })).toHaveCount(0);
});

test('focusing the ten-agent room keeps the campus present within its view render budget', async ({ page }) => {
  await page.goto('/?source=demo');
  await expect(page.getByTestId('scene-status')).toHaveText('ready', { timeout: 20000 });
  await page.getByRole('button', {name:'Open team',exact:true}).click();
  await page.getByRole('navigation',{name:'Teams'}).getByRole('button', { name: /^Development,/ }).click();
  await page.keyboard.press('Escape');
  const canvas = page.getByTestId('scene-canvas');
  await expect(canvas).toHaveAttribute('data-agents', '33');
  await expect.poll(async () => Number(await canvas.getAttribute('data-triangles'))).toBeGreaterThan(0);
  expect(Number(await canvas.getAttribute('data-triangles'))).toBeLessThan(18000);
  // Room focus eases from the overview; measure the settled view, not its previous one-second counter.
  await expect.poll(async()=>Number(await canvas.getAttribute('data-draw-calls')),{timeout:10000}).toBeLessThan(360);
  await page.getByRole('button', {name:'Open view controls'}).click();
  await page.getByRole('button', { name: 'Pause animation' }).click();
  await expect(page.getByRole('button', { name: 'Resume animation' })).toBeVisible();
});
