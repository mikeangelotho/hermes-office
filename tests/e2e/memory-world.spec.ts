import {test,expect} from '@playwright/test';
test('memory reconstruction renders real scan geometry without shader errors and freezes on pause',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.goto('/?source=demo&team=development');
  await expect(page.getByTestId('scene-status')).toHaveText('ready',{timeout:20000});
  const canvas=page.getByTestId('scene-canvas');
  await expect.poll(async()=>Number(await canvas.getAttribute('data-memory-points'))).toBeGreaterThan(30000);
  expect(Number(await canvas.getAttribute('data-memory-points'))).toBeLessThanOrEqual(50000);
  await expect.poll(async()=>Number(await canvas.getAttribute('data-draw-calls'))).toBeGreaterThan(0);
  expect(Number(await canvas.getAttribute('data-draw-calls'))).toBeLessThan(360);
  expect(Number(await canvas.getAttribute('data-triangles'))).toBeLessThan(18000);
  await page.getByRole('button',{name:'Open view controls',exact:true}).click();
  await page.getByRole('button',{name:'Pause animation',exact:true}).click();
  await page.waitForTimeout(200);const frozen=await canvas.getAttribute('data-memory-time');
  await page.waitForTimeout(500);expect(await canvas.getAttribute('data-memory-time')).toBe(frozen);
  expect(errors).toEqual([]);
});
