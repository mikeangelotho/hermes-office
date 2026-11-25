import { expect, test } from '@playwright/test';

test('the standalone canvas fills the viewport with UI only in floating panels', async ({ page }) => {
  await page.goto('/?source=demo');
  await expect(page.getByTestId('scene-status')).toHaveText('ready', { timeout: 20000 });
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const canvas = await page.getByTestId('scene-canvas').boundingBox();
  expect(canvas).toEqual({ x: 0, y: 0, width: viewport.width, height: viewport.height });
  await expect(page.locator('header.app-header, footer.app-footer, aside.sidebar')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Open team', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Team' })).toBeVisible();
  await expect(page.getByTestId('agent-row')).toHaveCount(33);
  await page.getByRole('navigation',{name:'Teams'}).getByRole('button', { name: /^Development,/ }).click();
  await expect(page.getByTestId('agent-row')).toHaveCount(10);
  await page.getByTestId('agent-row').first().click();
  await expect(page.getByTestId('agent-inspector')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open team', exact: true })).toBeFocused();
});

test('embedded mode has no UI, no private requests, and fills its viewport', async ({ page }) => {
  const privateRequests: string[] = [];
  page.on('request', r => { if (r.url().includes('/api/office')) privateRequests.push(r.url()); });
  await page.goto('/?embed=1&source=live');
  await expect(page.getByTestId('scene-status')).toHaveText('ready', { timeout: 20000 });
  await expect(page.locator('button,input,a,dialog')).toHaveCount(0);
  expect(await page.getByTestId('scene-canvas').boundingBox()).toEqual({ x: 0, y: 0, width: 1440, height: 960 });
  expect(privateRequests).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(960);
});
