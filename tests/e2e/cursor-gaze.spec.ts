import {test,expect} from '@playwright/test';

test('couch heads respond to real mouse movement in both axes',async({page})=>{
  await page.goto('/?source=demo');
  const canvas=page.getByTestId('scene-canvas');
  await expect(page.getByTestId('scene-status')).toHaveText('ready',{timeout:20000});
  await page.mouse.move(80,720);
  await expect.poll(async()=>Number(await canvas.getAttribute('data-gaze-tracking'))).toBeGreaterThan(0);
  // In the campus camera a left-hand cursor may align with a head's neutral yaw.
  // Verify the real angular change between pointer positions, not a nonzero baseline.
  await page.waitForTimeout(250);
  const left=Number(await canvas.getAttribute('data-gaze-yaw')),low=Number(await canvas.getAttribute('data-gaze-pitch'));
  await page.mouse.move(1360,180);
  await expect.poll(async()=>Number(await canvas.getAttribute('data-gaze-yaw')),{timeout:10000}).toBeGreaterThan(left+.1);
  await expect.poll(async()=>Number(await canvas.getAttribute('data-gaze-pitch')),{timeout:10000}).toBeLessThan(low-.04);
  expect(Math.abs(Number(await canvas.getAttribute('data-gaze-yaw')))).toBeLessThanOrEqual(.751);
  await page.getByRole('toolbar',{name:'Office controls'}).hover();
  await expect(canvas).toHaveAttribute('data-gaze-tracking','0');
  await expect.poll(async()=>Math.abs(Number(await canvas.getAttribute('data-gaze-yaw'))),{timeout:10000}).toBeLessThan(.02);
});

for(const mode of ['paused','reduced-motion','embedded'] as const){
  test(`${mode} view ignores cursor tracking`,async({page})=>{
    // Each independent mode gets its own page deadline; shader startup from
    // three navigations must not consume a shared thirty-second test budget.
    if(mode==='reduced-motion')await page.emulateMedia({reducedMotion:'reduce'});
    await page.goto(mode==='embedded'?'/?embed=1':'/?source=demo');
    const canvas=page.getByTestId('scene-canvas');
    await expect(page.getByTestId('scene-status')).toHaveText('ready',{timeout:20000});
    if(mode==='paused'){
      await page.getByRole('button',{name:'Open view controls',exact:true}).click();
      await page.getByRole('button',{name:'Pause animation',exact:true}).click();
      await page.keyboard.press('Escape');
    }
    await page.mouse.move(80,720);await page.mouse.move(1360,180);
    await expect(canvas).toHaveAttribute('data-gaze-tracking','0');
    if(mode==='embedded')await expect(page.locator('button,input,dialog')).toHaveCount(0);
  });
}

