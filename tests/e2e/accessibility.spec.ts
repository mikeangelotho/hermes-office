import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
test('the office meets WCAG AA automated accessibility checks', async ({ page }) => {
  await page.goto('/?source=demo');
  await expect(page.getByTestId('scene-status')).toHaveText('ready', { timeout: 20000 });
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  expect(result.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => ({ target: n.target, summary: n.failureSummary })) }))).toEqual([]);
});
