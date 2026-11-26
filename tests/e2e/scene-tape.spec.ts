import { expect, test, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import type { SceneTape, TraceActor } from '../../src/domain/trace.ts';

const start = Date.UTC(2026, 10, 24, 16, 13, 56, 700);
const parent: TraceActor = { id: `p-${'1'.repeat(32)}`, kind: 'session', team: 'general', state: 'working', signal: 'presence' };
const point = (atMs: number, actors: TraceActor[] = [parent], rate = 0, sampleAtMs = atMs): SceneTape => ({ atMs, actors, rate, sampleAtMs });
type View = { figures: Record<string, { parts: Array<Array<string | number>>; x: number; y: number; head: number[] }>; captions: string[]; link: number[][]; camera: number[]; persistent: boolean; time: number; trails: number; draws: number; calls: number; triangles: number };
declare global { interface Window { sceneTape: { ready: boolean; draws: number; view(): View; show(t: SceneTape, updateRoster?: boolean): void; off(actors?:TraceActor[]): void; motion(v: boolean): void; zoom(): void; canvas: HTMLCanvasElement } } }
async function nextDraw(page: Page, previous: number) {
  await page.waitForFunction(n => window.sceneTape.draws > n, previous);
}
async function show(page: Page, tape: SceneTape, updateRoster = true) {
  const n = await page.evaluate(({tape, updateRoster}) => { const f = window.sceneTape, n = f.draws; f.show(tape, updateRoster); return n; }, {tape, updateRoster});
  await nextDraw(page, n);
  return page.evaluate(() => window.sceneTape.view());
}
const errors = new WeakMap<Page, string[]>();
test.beforeEach(async ({page,baseURL}) => {
  const failures: string[] = []; errors.set(page, failures);
  page.on('pageerror', e => failures.push(e.message));
  page.on('console', m => { if (m.type() === 'error') failures.push(m.text()); });
  await page.route('**/*', route => {
    const u=new URL(route.request().url());
    if (u.origin === new URL(baseURL!).origin && !u.pathname.startsWith('/api/')) return route.continue();
    failures.push('Unexpected private or external request'); return route.abort();
  });
  await page.goto('/tests/fixtures/scene-tape.html');
  await expect(page).toHaveTitle('Campus signal tape fixture');
  await page.waitForFunction(() => window.sceneTape?.ready);
});

test.afterEach(({page}) => { expect(errors.get(page)).toEqual([]); });

test('the real campus freezes at a UTC cursor and independently sampled working poses rewind exactly', async ({page}) => {
  const a = await show(page, point(start)); // Same real person and camera in every frame.
  expect(Object.keys(a.figures)).toEqual([parent.id]);
  await page.evaluate(() => window.sceneTape.motion(true));
  const first = await show(page, point(start + 610), false);
  await page.waitForTimeout(350);
  const held = await page.evaluate(() => window.sceneTape.view());
  expect(held.figures[parent.id].parts, 'pausing the editor freezes the actual rendered fragments').toEqual(first.figures[parent.id].parts);
  expect(held.time).toBe(first.time);
  const other = await show(page, point(start + 1330), false);
  expect(other.figures[parent.id].parts).not.toEqual(first.figures[parent.id].parts);
  const again = await show(page, point(start + 610), false);
  expect(again.figures[parent.id].parts).toEqual(first.figures[parent.id].parts);
  expect(again.camera).toEqual(first.camera); expect(again.persistent).toBe(true);
});

test('a measured pulse changes the figure and draws a local cue at its desk; ordinary presence does neither', async ({page}, info) => {
  const at = start + 1800, pulse = {...parent, signal: 'tool' as const};
  await show(page, point(start));
  await page.evaluate(() => { window.sceneTape.zoom(); window.sceneTape.zoom(); window.sceneTape.motion(true); });
  const base = await show(page, point(at, [parent], 0, start), false);
  const canvas = page.getByTestId('scene-canvas');
  const working = await canvas.screenshot({path: info.outputPath('working.png')});
  const tool = await show(page, point(at, [pulse], 0, start), false);
  const altered = await canvas.screenshot({path: info.outputPath('tool-pulse.png')});
  expect(tool.figures[parent.id].parts, 'a counter pulse changes the actual manipulators, not just a label').not.toEqual(base.figures[parent.id].parts);
  expect(tool.captions).toEqual(['Tool pulse']); expect(base.captions).toEqual([]);
  const {x,y} = base.figures[parent.id];
  const diff = await page.evaluate(async ({before,after,x,y}) => {
    async function pixels(b64:string) {
      const image = new Image(); image.src = 'data:image/png;base64,' + b64; await image.decode();
      const c = document.createElement('canvas'); c.width = image.width; c.height = image.height;
      const ctx = c.getContext('2d')!; ctx.drawImage(image,0,0); return ctx.getImageData(0,0,c.width,c.height);
    }
    const a = await pixels(before), b = await pixels(after);
    let changedRig=0, toolInk=0, strayInk=0;
    for (let i=0;i<a.data.length;i+=4) {
      const px=(i/4)%a.width, py=Math.floor(i/4/a.width), dx=px-x, dy=py-y;
      const delta=Math.max(...[0,1,2].map(k=>Math.abs(a.data[i+k]-b.data[i+k])));
      if (delta>22 && Math.abs(dx)<24 && dy>=0 && dy<33) changedRig++;
      // Mint ink is unique to the tool glyph; its marker must be above and beside THIS lens.
      const mint = (d:Uint8ClampedArray)=>d[i+1]>150 && d[i+1]-d[i]>35 && d[i+2]>125 && d[i+2]<=d[i+1]+12;
      if (mint(b.data) && !mint(a.data)) { if(Math.abs(dx)<110 && dy<3 && dy>-80) toolInk++; else strayInk++; }
    }
    return {changedRig, toolInk, strayInk};
  }, {before:working.toString('base64'),after:altered.toString('base64'),x,y});
  expect(diff.changedRig, 'visible change on the rig, below the caption').toBeGreaterThan(35);
  expect(diff.toolInk, 'visible marker anchored near the observed worker').toBeGreaterThan(12);
  expect(diff.strayInk).toBe(0);
  const evidence = info.outputPath('pulse-pixels.json'); await writeFile(evidence,JSON.stringify(diff));
  await info.attach('pulse-pixel-evidence', {path:evidence,contentType:'application/json'});
  await show(page, point(at, [parent], 0, start), false);
  expect((await canvas.screenshot()).equals(working), 'identical composite after removing the counter evidence at the same time').toBe(true);
  expect((await show(page, point(start+10_000,[pulse],0,start), false)).captions, 'a discrete reading is not permanent').toEqual([]);
});

test('only the two ends of a current observed direct link acknowledge one another', async ({page}, info) => {
  const child: TraceActor = {...parent, kind:'subagent', id:`p-${'2'.repeat(32)}`};
  const bystander: TraceActor = {...parent, id:`p-${'3'.repeat(32)}`};
  const linked = {...child,parentId:parent.id}, t = start + 1000;
  const base = await show(page, point(t,[parent,child,bystander],0,start));
  expect(base.captions).toEqual([]);
  const canvas=page.getByTestId('scene-canvas'); await canvas.screenshot({path: info.outputPath('no-link.png')});
  const pair = await show(page, point(t,[bystander,linked,parent],0,start),false);
  expect(pair.figures[child.id].parts, 'the observed child turns its actual rig').not.toEqual(base.figures[child.id].parts);
  expect(pair.figures[parent.id].parts, 'its verified parent acknowledges it').not.toEqual(base.figures[parent.id].parts);
  expect(pair.figures[bystander.id]).toEqual(base.figures[bystander.id]);
  expect(pair.captions).toEqual(['Link active']); expect(pair.link.length).toBe(2);
  // The physical line terminates at each lens, not at a room centroid or an unrelated coworker.
  const distance = (a:number[],b:number[])=>Math.hypot(...a.map((n,i)=>n-b[i]));
  for (const id of [parent.id,child.id]) expect(Math.min(...pair.link.map(end=>distance(end,pair.figures[id].head)))).toBeLessThan(.55);
  await canvas.screenshot({path:info.outputPath('link-active.png')});
  for (const [caseName, sample] of [
    ['unobserved parent, even though its figure remains on screen', point(t,[linked,bystander],0,start)],
    ['partner is in the tape but not on this live roster', point(t,[{...parent,id:`p-${'4'.repeat(32)}`},{...child,parentId:`p-${'4'.repeat(32)}`}],0,start)],
    ['non-enum signal cannot become a gesture or caption',point(t,[{...parent,signal:'not a caption' as TraceActor['signal']},linked],0,start)],
    ['self edge',point(t,[parent,{...child,parentId:child.id},bystander],0,start)],
    ['future sample',point(start-1,[parent,linked,bystander],0,start)],
    ['expired sample',point(start+10_000,[parent,linked,bystander],0,start)],
    ['no sample origin',{atMs:t,rate:0,actors:[parent,linked,{...bystander,signal:'tool'}]}],
  ] as const) {
    const hidden = await show(page,sample,false);
    expect(hidden.captions,caseName).toEqual([]); expect(hidden.link,caseName).toEqual([]);
  }
});

test('the paused camera can orbit and zoom; scrubbing through a linked arrival and removal never owns the camera', async ({page}) => {
  const child: TraceActor = {...parent,id:`p-${'2'.repeat(32)}`,kind:'subagent',parentId:parent.id};
  await show(page,point(start)); await page.evaluate(() => window.sceneTape.motion(true));
  const a = await show(page,point(start+900));
  const canvas = page.getByTestId('scene-canvas');
  await canvas.press('ArrowLeft'); await canvas.press('+');
  await expect.poll(async()=> (await page.evaluate(()=>window.sceneTape.view())).camera.at(-1)).toBeGreaterThan(1);
  // Zoom changes on keydown; matrixWorld records the orbit only on a subsequent real draw.
  await expect.poll(async()=> (await page.evaluate(()=>window.sceneTape.view())).camera.slice(0,16)).not.toEqual(a.camera.slice(0,16));
  const manual = await page.evaluate(()=>window.sceneTape.view());
  expect(manual.camera.slice(0,16)).not.toEqual(a.camera.slice(0,16));
  expect(manual.figures[parent.id].parts).toEqual(a.figures[parent.id].parts);
  const pixels = await canvas.screenshot();
  const future = await show(page,point(start+31_000,[parent,child],0,start+30_000));
  expect(future.captions).toEqual(['Link active']); expect(future.camera,'a changed recorded footprint is not a request to fit').toEqual(manual.camera);
  const departed = await show(page,point(start+45_700,[parent],0,start+45_000));
  expect(Object.keys(departed.figures)).toEqual([parent.id]); expect(departed.captions).toEqual([]);
  const reversing = await show(page,point(start+31_000,[parent,child],-1,start+30_000));
  expect(reversing.captions).toEqual(['Link active']); expect(reversing.camera).toEqual(manual.camera);
  const back = await show(page,point(start+900));
  expect(back.camera).toEqual(manual.camera); expect(back.figures).toEqual(manual.figures);
  expect(back.trails).toBe(0); expect(back.persistent).toBe(true);
  expect((await canvas.screenshot()).equals(pixels),'A→B→A reproduces the actual room composite with no future trails').toBe(true);
  const n = await page.evaluate(roster=>{const f=window.sceneTape,n=f.draws; f.off(roster); return n;},[parent,child]);
  await nextDraw(page,n); const fallback = await page.evaluate(()=>window.sceneTape.view());
  expect(Object.keys(fallback.figures)).toHaveLength(2); expect(fallback.captions).toEqual([]);
  expect(fallback.camera,'returning to a differently sized live roster without a recording also preserves the orbit').toEqual(manual.camera);
  const reentered = await show(page,point(start+900));
  expect(reentered.camera,'an incoming tape and its roster are applied together, even when the roster signal arrived first').toEqual(manual.camera);
});

test('reverse and a new live head both continue between deliveries and reproduce the paused pose at the same instant', async ({page}) => {
  await show(page, point(start)); await page.evaluate(()=>window.sceneTape.motion(true));
  // Independently calibrate the actual bounded shader clock against two supplied UTC frames.
  const ref = await show(page,point(start+45_000),false), delta = await show(page,point(start+45_100),false);
  const sign = Math.sign(delta.time-ref.time); expect(Math.abs(delta.time-ref.time)).toBeCloseTo(.1,8);
  for (const [rate,offset] of [[-2,38000],[1,45000]]) {
    const anchor = await show(page,point(start+offset),false);
    const playing = await show(page,point(start+offset,[parent],rate),false);
    await page.waitForFunction(n=>window.sceneTape.draws>=n+2,playing.draws);
    const seen = await page.evaluate(()=>window.sceneTape.view());
    expect(sign * (seen.time-playing.time) * Math.sign(rate)).toBeGreaterThan(0);
    const actualMs = start+offset + Math.round((seen.time-anchor.time)*1000*sign);
    const exact = await show(page,point(actualMs),false);
    expect(exact.figures[parent.id].parts,'interpolation samples the same real pose as a direct seek').toEqual(seen.figures[parent.id].parts);
    expect(exact.camera).toEqual(ref.camera); expect(exact.persistent).toBe(true);
    expect(exact.time).toBeLessThan(4096);
  }
  await show(page,point(start,[{...parent,signal:'tool'}]),false);
  const n = await page.evaluate(()=>{const f=window.sceneTape,n=f.draws; f.off(); return n;});
  await nextDraw(page,n); const plain = await page.evaluate(()=>window.sceneTape.view());
  expect(plain.captions).toEqual([]); expect(plain.link).toEqual([]); expect(plain.persistent).toBe(true);
});

test('a partially matched live tape does not take cursor gaze away from unrecorded lounge occupants', async ({page}) => {
  const resting: TraceActor = {...parent, id:`r-${'3'.repeat(32)}`, kind:'profile', state:'idle'};
  await show(page,point(start,[parent,resting]));
  await page.evaluate(()=>window.sceneTape.motion(true));
  await show(page,point(start+1000,[parent],1,start),false);
  await page.mouse.move(620,170);
  await expect(page.getByTestId('scene-canvas')).toHaveAttribute('data-gaze-tracking','1');
  const replay=await show(page,point(start+3000,[parent,resting],0,start));
  await page.mouse.move(200,420);
  expect((await page.evaluate(()=>window.sceneTape.view())).figures).toEqual(replay.figures);
});

test('OS reduced motion keeps the tool illustration readable without any between-time motion', async ({page}) => {
  await page.emulateMedia({reducedMotion:'reduce'}); await page.evaluate(()=>window.sceneTape.motion(true));
  const pulse: TraceActor = {...parent,signal:'tool'};
  const a = await show(page,point(start+200,[pulse],0,start));
  const canvas=page.getByTestId('scene-canvas'), still=await canvas.screenshot();
  const b = await show(page,point(start+4200,[pulse],0,start),false);
  expect(b.captions).toEqual(['Tool pulse']); expect(b.figures).toEqual(a.figures); expect(b.time).toBe(a.time);
  expect((await canvas.screenshot()).equals(still)).toBe(true);
  const faded=await show(page,point(start+4800,[pulse],0,start),false);
  expect(faded.captions).toEqual([]); expect(faded.figures[parent.id].parts).not.toEqual(b.figures[parent.id].parts);
});

test('a busy recorded room uses a bounded pool of readable cues and one verified connector', async ({page},info) => {
  const people:TraceActor[] = Array.from({length:10},(_,i)=>({...parent,id:`p-${i.toString(16).padStart(32,'0')}`}));
  const plain=await show(page,point(start+1000,people,0,start));
  const busy=await show(page,point(start+1000,people.map((a,i)=>i===1?{...a,kind:'subagent',parentId:people[0].id}:i>1?{...a,signal:'tool'}:a),0,start),false);
  expect(busy.captions).toContain('Link active'); expect(busy.captions).toContain('Tool pulse'); expect(busy.captions.length).toBeLessThanOrEqual(3);
  expect(busy.link).toHaveLength(2); expect(busy.calls-plain.calls).toBeLessThanOrEqual(4); expect(busy.triangles-plain.triangles).toBeLessThanOrEqual(6);
  const evidence={plain:{calls:plain.calls,triangles:plain.triangles},active:{calls:busy.calls,triangles:busy.triangles},labels:busy.captions};
  await writeFile(info.outputPath('cue-budget.json'),JSON.stringify(evidence));
});
