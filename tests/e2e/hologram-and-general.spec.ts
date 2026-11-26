import { test, expect } from '@playwright/test';

test('blue hologram world retains its budget and freezes the complete effect when paused', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/?source=demo&team=development');
  const canvas = page.getByTestId('scene-canvas');
  await expect(page.getByTestId('scene-status')).toHaveText('ready', { timeout: 20000 });
  await expect(canvas).toHaveAttribute('data-agents', '33');
  await expect.poll(async () => Number(await canvas.getAttribute('data-fiber-time'))).toBeGreaterThan(0);
  expect(await page.locator('main').evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgb(2, 4, 11)');
  await expect.poll(async () => Number(await canvas.getAttribute('data-draw-calls'))).toBeGreaterThan(0);
  expect(Number(await canvas.getAttribute('data-draw-calls'))).toBeLessThan(360);
  expect(Number(await canvas.getAttribute('data-triangles'))).toBeLessThan(18000);
  await page.getByRole('button', { name: 'Open view controls' }).click();
  await page.getByRole('button', { name: 'Pause animation' }).click();
  const frozen = await canvas.getAttribute('data-fiber-time');
  await page.waitForTimeout(300);
  expect(await canvas.getAttribute('data-fiber-time')).toBe(frozen);
  await page.getByRole('button', { name: 'Resume animation' }).click();
  await expect.poll(async () => Number(await canvas.getAttribute('data-fiber-time'))).toBeGreaterThan(Number(frozen));
  expect(errors).toEqual([]);
});

test('general sessions exposes the default Hermes identity and a bounded aggregate, never content', async ({ page }) => {
  const [response] = await Promise.all([page.waitForResponse(r => new URL(r.url()).pathname === '/api/office'), page.goto('/?team=general')]);
  expect(response.status()).toBe(200);
  const snapshot = await response.json();
  const general = snapshot.agents.find((a: { id: string }) => a.id === 'default');
  expect(general).toBeDefined(); expect(general.team).toBe('general');
  expect(general.name).toBe('Hermes');
  expect(Object.keys(general)).not.toContain('sessions');
  expect(Object.keys(general)).not.toContain('messages');
  if (general.activeSessions !== undefined) { expect(Number.isSafeInteger(general.activeSessions)).toBe(true); expect(general.activeSessions).toBeGreaterThanOrEqual(0); }
  await page.getByRole('button', { name: 'Open team', exact: true }).click();
  const people: { name: string; profileId: string }[] = (snapshot.participants ?? []).filter((p: { profileId: string }) => p.profileId === general.id);
  const rows = page.getByTestId('agent-row');
  await expect(rows).toHaveCount(people.length || 1);
  const target = people[0] ?? general;
  await rows.filter({ has: page.getByText(target.name, { exact: true }) }).click();
  await expect(page.getByRole('heading', { name: target.name, exact: true })).toBeVisible();
  if (people.length) await expect(page.getByTestId('agent-inspector').getByText('Hermes', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Open status', exact: true }).click();
  await expect(page.getByText('Local bridge connected', { exact: true })).toBeVisible();
  await expect(page.getByText('Active general sessions', { exact: true })).toBeVisible();
  const partial = snapshot.sourceHealth === 'degraded' || snapshot.agents.some((a: {state:string}) => a.state === 'offline');
  const expected = general.state === 'offline' || general.activeSessions === undefined || (partial && !general.activeSessions)
    ? 'Unverified' : `${partial ? 'At least ' : ''}${general.activeSessions}`;
  await expect(page.locator('.status-facts > div').filter({ hasText: 'Active general sessions' }).locator('dd')).toHaveText(expected);
});

test('all embedded aliases remain UI-free and cannot acquire the live default-session feed', async ({ page }) => {
  const privateRequests: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) privateRequests.push(request.url()); });
  for (const query of ['?embed=1&source=live', '?view=embedded&source=live', '?view=hero&source=live&team=general']) {
    await page.goto('/' + query);
    await expect(page.getByTestId('scene-status')).toHaveText('ready', { timeout: 20000 });
    await expect(page.locator('button,input,a,dialog')).toHaveCount(0);
    expect(await page.getByTestId('scene-canvas').getAttribute('tabindex')).not.toBe('0');
  }
  expect(privateRequests).toEqual([]);
});
