import { expect, test } from '@playwright/test';

test('standalone pop-ups manage teams, search, selection and simulated transitions', async ({ page }) => {
  const errors: string[]=[]; page.on('pageerror', e=>errors.push(e.message));
  await page.goto('/?source=demo&team=studio');
  await expect(page.getByTestId('scene-status')).toHaveText('ready',{ timeout:20000 });
  await expect(page.getByTestId('source-indicator')).toHaveText('DEMO');
  await page.getByRole('button',{name:'Open team',exact:true}).click();
  await expect(page.getByTestId('agent-row')).toHaveCount(8);
  await page.getByRole('textbox',{name:'Find an agent'}).fill('engineer');
  await expect(page.getByTestId('agent-row')).toHaveCount(2);
  await page.getByRole('button',{name:'Clear search'}).click();
  await page.getByTestId('agent-row').first().click();
  await expect(page.getByTestId('agent-inspector')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Open status',exact:true}).click();
  await expect(page.getByText('Simulated activity',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Next demo state'}).click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('scene-status')).toHaveText('ready');
  expect(errors).toEqual([]);
});

test('mobile keeps the full-screen world and its panels inside the viewport', async ({ page }) => {
  await page.setViewportSize({width:390,height:844});
  await page.goto('/?source=demo');
  await expect(page.getByTestId('scene-status')).toHaveText('ready',{timeout:20000});
  expect(await page.getByTestId('scene-canvas').boundingBox()).toEqual({x:0,y:0,width:390,height:844});
  await page.getByRole('button',{name:'Open team',exact:true}).click();
  await page.getByRole('button',{name: /^Science channel\b/}).click();
  await expect(page.getByTestId('agent-row')).toHaveCount(4);
  const panel=await page.getByRole('dialog').boundingBox();
  expect(panel!.y).toBeGreaterThanOrEqual(0); expect(panel!.y+panel!.height).toBeLessThanOrEqual(844);
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Open view controls'}).click();
  await page.getByRole('button',{name:'Switch to evening'}).click();
  await expect(page.locator('.experience')).toHaveClass(/evening/);
  await page.getByRole('button',{name:'Pause animation'}).click();
  await expect(page.getByRole('button',{name:'Resume animation'})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth && document.documentElement.scrollHeight<=innerHeight)).toBe(true);
});

test('the legacy hero address is also a UI-free, public-safe scene', async ({ page }) => {
  const privateRequests:string[]=[];page.on('request',r=>{if(r.url().includes('/api/office'))privateRequests.push(r.url());});
  await page.goto('/?view=hero');
  await expect(page.getByTestId('scene-status')).toHaveText('ready',{timeout:20000});
  await expect(page.locator('button,input,a,dialog')).toHaveCount(0);
  expect(privateRequests).toEqual([]);
});

