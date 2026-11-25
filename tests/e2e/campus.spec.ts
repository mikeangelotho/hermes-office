import {test,expect} from '@playwright/test';

test('all swarms inhabit one campus and focusing a room never removes other agents',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/?source=demo');
  await expect(page.getByTestId('scene-status')).toHaveText('ready',{timeout:30000});
  const canvas=page.getByTestId('scene-canvas');
  await expect(canvas).toHaveAttribute('data-agents','33');
  await expect(canvas).toHaveAttribute('data-rooms','5');
  await expect(canvas).toHaveAttribute('data-focus','all');
  await expect.poll(async()=>Number(await canvas.getAttribute('data-draw-calls'))).toBeGreaterThan(0);
  expect(Number(await canvas.getAttribute('data-draw-calls'))).toBeLessThan(500);
  expect(Number(await canvas.getAttribute('data-triangles'))).toBeLessThan(18000);
  expect(Number(await canvas.getAttribute('data-total-triangles'))).toBeLessThan(34000);
  await page.getByRole('button',{name:'Open team',exact:true}).click();
  await expect(page.getByTestId('agent-row')).toHaveCount(33);
  await page.getByRole('button',{name:/^Development, 10 agents/}).click();
  await expect(page.getByTestId('agent-row')).toHaveCount(10);
  await page.keyboard.press('Escape');
  await expect(canvas).toHaveAttribute('data-agents','33');
  await expect(canvas).toHaveAttribute('data-focus','development');
  await page.reload();
  await expect(page.getByTestId('scene-status')).toHaveText('ready',{timeout:30000});
  await expect(canvas).toHaveAttribute('data-focus','development');
  await page.getByRole('button',{name:'Show all rooms',exact:true}).click();
  await expect(canvas).toHaveAttribute('data-focus','all');
  await expect(canvas).toHaveAttribute('data-agents','33');
  expect(errors).toEqual([]);
});

test('small rooms center every signal being and live refresh updates real desk and resting poses',async({page})=>{
  await page.emulateMedia({reducedMotion:'reduce'});
  let active=false;
  await page.route('**/api/office',async route=>{
    const observedAt=new Date().toISOString();
    const agents=['studio','development','game','science','general'].map(team=>({id:`${team}-fixture`,name:`${team} fixture`,role:'Test fixture',team,state:team==='development'&&active?'working':'idle',observedAt,activity:'Controlled test observation'}));
    await route.fulfill({json:{schemaVersion:1,mode:'live',source:'hermes-local',sourceHealth:'connected',observedAt,pollIntervalMs:30000,agents,warnings:[]}});
  });
  await page.goto('/?team=all');
  const canvas=page.getByTestId('scene-canvas');
  await expect(page.getByTestId('scene-status')).toHaveText('ready',{timeout:30000});
  await expect(canvas).toHaveAttribute('data-agents','5');
  const poses=async()=>JSON.parse(await canvas.getAttribute('data-assignments')??'[]');
  await expect.poll(async()=>(await poses()).every((a:any)=>a.x===0&&a.z===3.86)).toBe(true);
  const expected:Record<string,string>={studio:'lounge',development:'docked',game:'controller',science:'meditative',general:'resting'};
  for(const row of await poses())expect(row.pose).toBe(expected[row.team]);
  await page.getByRole('button',{name:'Open status',exact:true}).click();
  active=true;
  await page.getByRole('button',{name:'Refresh status',exact:true}).click();
  await expect.poll(async()=>{const dev=(await poses()).find((a:any)=>a.team==='development');return [dev.state,dev.seat,dev.pose,dev.x,dev.z]}).toEqual(['working','desk',null,0,-2.15]);
  active=false;
  await page.getByRole('button',{name:'Refresh status',exact:true}).click();
  await expect.poll(async()=>{const dev=(await poses()).find((a:any)=>a.team==='development');return [dev.state,dev.seat,dev.pose,dev.x,dev.z]}).toEqual(['idle','couch','docked',0,3.86]);
  await page.keyboard.press('Escape');
  await expect(page.getByTitle('Focus Development',{exact:true})).toContainText('0 working');
});
