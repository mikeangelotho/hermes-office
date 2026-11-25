import { test, expect } from '@playwright/test';

test('spatial glass uses a bounded real scene capture and preserves the render budget', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', e => { if (e.type() === 'error') errors.push(e.text()); });
  await page.goto('/?source=demo&team=development');
  const canvas = page.getByTestId('scene-canvas');
  await expect(page.getByTestId('scene-status')).toHaveText('ready', { timeout: 20000 });
  await expect(canvas).toHaveAttribute('data-glass-ready','1');
  await expect.poll(async () => Number(await canvas.getAttribute('data-glass-pixels'))).toBeGreaterThan(0);
  expect(Number(await canvas.getAttribute('data-glass-pixels'))).toBeLessThanOrEqual(160000);
  await expect.poll(async () => Number(await canvas.getAttribute('data-draw-calls'))).toBeGreaterThan(0);
  expect(Number(await canvas.getAttribute('data-draw-calls'))).toBeLessThan(360);
  expect(Number(await canvas.getAttribute('data-total-triangles'))).toBeLessThan(34000);
  await page.getByRole('button',{name:'Open team',exact:true}).click();
  const glass = await page.getByRole('dialog').evaluate(el => ({ filter:getComputedStyle(el).backdropFilter, background:getComputedStyle(el).backgroundColor }));
  expect(glass.filter).toContain('blur(');
  expect(glass.background).toMatch(/^rgba/);
  expect(errors).toEqual([]);
});

test('scene glass measurably blurs the actual geometry behind it', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/tests/fixtures/spatial-glass.html');
  await page.waitForFunction(() => Boolean((window as any).__glassContrast));
  const result = await page.evaluate(() => (window as any).__glassContrast());
  expect(result.clear).toBeGreaterThan(20);
  expect(result.frosted).toBeLessThan(result.clear * .5);
  expect(result.frostedMean).toBeGreaterThan(20);
  expect(errors).toEqual([]);
});
