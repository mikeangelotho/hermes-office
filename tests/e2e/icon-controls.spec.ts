import { test,expect } from '@playwright/test';

test('dock uses icons with hover/focus labels, Escape dismissal and keyboard navigation',async({page})=>{
  await page.goto('/?source=demo');
  const dock=page.getByRole('toolbar',{name:'Office controls'});
  await expect(dock.getByRole('button')).toHaveCount(6);
  const visibleText=await dock.getByRole('button').evaluateAll(buttons=>buttons.map(b=>(b as HTMLElement).innerText.trim()));
  expect(visibleText).toEqual(['','','','','','']);
  const team=dock.getByRole('button',{name:'Open team',exact:true});
  await team.hover();
  await expect(page.getByRole('tooltip',{name:'Open team',exact:true})).toBeVisible();
  await page.keyboard.press('Escape');await expect(page.getByRole('tooltip')).toHaveCount(0);
  await team.focus();await page.keyboard.press('ArrowRight');
  await expect(dock.getByRole('button',{name:'Open view controls',exact:true})).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog',{name:'View',exact:true})).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dock.getByRole('button',{name:'Open view controls',exact:true})).toBeFocused();
});

test('icon panel navigation preserves team selection, controls and source safety',async({page})=>{
  await page.goto('/?source=demo');
  await page.getByRole('button',{name:'Open team',exact:true}).click();
  const panel=page.getByRole('dialog');
  await expect(panel.getByRole('navigation',{name:'Teams'}).getByRole('button')).toHaveCount(6);
  await panel.getByRole('navigation',{name:'Teams'}).getByRole('button',{name:/^Development,/}).click();
  await expect(page.getByTestId('agent-row')).toHaveCount(10);
  const teamText=await panel.getByRole('navigation',{name:'Teams'}).getByRole('button').evaluateAll(bs=>bs.map(b=>(b as HTMLElement).innerText.replace(/\d/g,'').trim()));
  expect(teamText).toEqual(['','','','','','']);
  await panel.getByRole('button',{name:'Open view controls',exact:true}).click();
  await panel.getByRole('button',{name:'Switch to evening',exact:true}).click();
  await expect(page.locator('main')).toHaveClass(/evening/);
  await panel.getByRole('button',{name:'Pause animation',exact:true}).click();
  await expect(panel.getByRole('button',{name:'Resume animation',exact:true})).toBeVisible();
  await panel.getByRole('button',{name:'Open status',exact:true}).click();
  await expect(panel.getByRole('button',{name:'Demo',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect(panel.getByText('Simulated activity',{exact:true})).toBeVisible();
  await panel.getByRole('button',{name:'Next demo state',exact:true}).click();
  await panel.getByRole('button',{name:'Close panel',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test.describe('portrait touch controls',()=>{
  test.use({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  test('icon controls retain touch targets and fit a portrait viewport',async({page})=>{
    await page.goto('/?source=demo');
    await page.getByRole('button',{name:'Open view controls',exact:true}).tap();
    await page.getByRole('dialog').getByRole('button',{name:'Switch to evening',exact:true}).tap();
    await expect(page.locator('main')).toHaveClass(/evening/);
    const small=await page.locator('.icon-control:visible').evaluateAll(bs=>bs.filter(b=>{const r=b.getBoundingClientRect();return r.width<44||r.height<44}).map(b=>b.getAttribute('aria-label')));
    expect(small).toEqual([]);
    const r=await page.getByRole('dialog').boundingBox();expect(r!.y).toBeGreaterThanOrEqual(0);expect(r!.y+r!.height).toBeLessThanOrEqual(844);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth&&document.documentElement.scrollHeight<=innerHeight)).toBe(true);
  });
});
test('the 3D failure fallback keeps the roster and a full-size recovery control',async({page})=>{
  await page.route('**/src/scene/engine.ts*',route=>route.abort());
  await page.goto('/?source=demo');
  await expect(page.getByTestId('scene-status')).toHaveText('error');
  await page.getByRole('button',{name:'Open team',exact:true}).click();
  await expect(page.getByTestId('agent-row')).toHaveCount(33);
  await page.getByRole('button',{name:'Close panel',exact:true}).click();
  const retry=page.getByRole('button',{name:'Try again',exact:true});
  const rect=await retry.boundingBox();expect(rect!.width).toBeGreaterThanOrEqual(44);expect(rect!.height).toBeGreaterThanOrEqual(44);
  await page.unroute('**/src/scene/engine.ts*');await retry.click();
  await expect(page.getByTestId('scene-status')).toHaveText('ready',{timeout:20000});
});

