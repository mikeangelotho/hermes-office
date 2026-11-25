import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
for (const name of ['Open team','Open view controls','Open status','About this space']) {
  test(`${name}: floating panel accessibility and label-in-name`,async({page})=>{
    await page.goto('/?source=demo');
    await expect(page.getByTestId('scene-status')).toHaveText('ready',{timeout:20000});
    await page.getByRole('button',{name,exact:true}).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    const report=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']).analyze();
    expect(report.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))}))).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button',{name,exact:true})).toBeFocused();
  });
}

