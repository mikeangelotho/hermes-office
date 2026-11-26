import {test,expect,type Page} from '@playwright/test';
const hour=3_600_000, every=15_000;
const parent={id:'p-'+'1'.repeat(32),kind:'session',state:'working',team:'general',signal:'presence'};
const child={...parent,id:'p-'+'2'.repeat(32),kind:'subagent',parentId:parent.id};
function sample(atMs:number,withChild=false){return {atMs,coverage:'verified',actors:withChild?[parent,child]:[parent]};}
function reel(endMs:number,frames:ReturnType<typeof sample>[],firstMs:number,lastMs:number){return {version:1,startMs:endMs-hour,endMs,cadenceMs:every,firstMs,lastMs,frames};}
const click=(page:Page,name:string)=>page.getByRole('button',{name,exact:true}).click();

test('eligibility, tail/full/delta, archive and slow-response cancellation in a real reactive client',async({page})=>{
  const now=Date.now(),older=now-hour*3,first=older-hour+60_000;let head=now,withChild=false,release=()=>{};
  let hold=false;const calls:string[]=[];const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/office/history*',async route=>{
    const url=new URL(route.request().url());calls.push(url.search);let data;
    if(url.searchParams.has('end')){const t=Number(url.searchParams.get('end'));data=reel(t,[sample(t-120_000,true)],first,head-1000);if(hold)await new Promise<void>(r=>{release=r;});}
    else if(url.searchParams.has('after'))data=reel(head,[sample(head-1000,withChild)],first,head-1000);
    else data=reel(head,[sample(head-120_000,true),sample(head-1000,withChild)],first,head-1000);
    await route.fulfill({json:data}).catch(()=>{});
  });
  await page.goto('/tests/fixtures/tape-player.html');const state=page.locator('#state');
  await expect(state,'transport implementation is not available').toHaveText('ready');expect(calls).toEqual([]);
  await click(page,'Toggle eligible');await expect(state).toHaveAttribute('data-count','1');expect(calls).toHaveLength(1);expect(calls[0]).toContain('after=');
  await click(page,'Toggle editor');await expect(state).toHaveAttribute('data-frames','2');await expect(state).toHaveAttribute('data-export','yes');expect(calls).toContain('');
  await page.getByLabel('Target time').fill(String(now-119_000));await click(page,'Seek');await expect(state).toHaveAttribute('data-count','2');
  const stamp=await state.getAttribute('data-cursor');await page.waitForTimeout(250);await expect(state).toHaveAttribute('data-cursor',stamp!);
  head=now+15_000;withChild=false;await click(page,'Refresh head');await expect(state).toHaveAttribute('data-frames','3');expect(calls.at(-1)).toContain('after=');await expect(state).toHaveAttribute('data-cursor',stamp!);
  await page.getByLabel('Target time').fill(String(older));await click(page,'Old hour');await expect(state).toHaveAttribute('data-mode','archive');await expect(state).toHaveAttribute('data-count','2');
  hold=true;await page.getByLabel('Target time').fill(String(older-1000));await click(page,'Old hour');await expect.poll(()=>calls.at(-1)).toBe('?end='+String(older-1000));
  await click(page,'Live head');await expect(state).toHaveAttribute('data-mode','live');await expect(state).toHaveAttribute('data-count','1');release();await page.waitForTimeout(100);await expect(state).toHaveAttribute('data-mode','live');
  await click(page,'Toggle eligible');await expect(state).toHaveAttribute('data-frames','0');const count=calls.length;await click(page,'Refresh head');await click(page,'Old hour');await page.waitForTimeout(150);expect(calls.length).toBe(count);expect(errors).toEqual([]);
});

test('a gap pauses the scene clock too; history error never invents activity',async({page})=>{
  const end=Date.now();let broken=false;
  await page.route('**/api/office/history*',route=>broken?route.fulfill({status:503,json:{error:'unavailable'}}):route.fulfill({json:reel(end,[sample(end-61_000),sample(end-1000,true)],end-61_000,end-1000)}));
  await page.goto('/tests/fixtures/tape-player.html');const state=page.locator('#state');await click(page,'Toggle eligible');await click(page,'Toggle editor');
  await expect(state).toHaveAttribute('data-count','2');await page.getByLabel('Target time').fill(String(end-180_000));await click(page,'Seek');
  await expect(state).toHaveAttribute('data-coverage','gap');await expect(state).toHaveAttribute('data-tape-state','empty');
  await expect(state).toHaveAttribute('data-speed','0');broken=true;await click(page,'Refresh head');await expect(state).toHaveAttribute('data-error',/unavailable/i);
  await expect(state).toHaveAttribute('data-count','-1');await click(page,'Live head');await expect(state).toHaveAttribute('data-mode','live');
});
