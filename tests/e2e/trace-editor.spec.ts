import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { TraceActor, TraceFrame, TraceWindow } from '../../src/domain/trace.ts';

const hour = 3_600_000, cadence = 15_000;
const parent: TraceActor = { id: `p-${'a'.repeat(32)}`, kind: 'session', team: 'general', state: 'working', signal: 'presence' };
const child: TraceActor = { id: `p-${'b'.repeat(32)}`, kind: 'subagent', team: 'general', state: 'working', signal: 'presence', parentId: parent.id };
function officeStatus(ms: number) {
  const observedAt = new Date(ms).toISOString();
  return { schemaVersion: 1, mode: 'live', source: 'Local Hermes status bridge', sourceHealth: 'connected', observedAt, pollIntervalMs: 30000, warnings: [], agents: [
    { id: 'default', name: 'Hermes', role: 'General assistant', team: 'general', state: 'working', activity: 'Current observation.', observedAt },
  ] };
}
async function exportJson(page: Page) {
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save hour as JSON', exact: true }).click()]);
  expect(download.url()).toMatch(/^blob:/); expect(download.suggestedFilename()).toMatch(/^office-hour-.*\.json$/);
  const stream = await download.createReadStream(), chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Network boundary only. The real player, transport and 3D engine run in the browser. */
async function recording(page: Page) {
  const end = Math.floor(Date.now() / 1000) * 1000;
  const frame = (offset: number, actors: TraceActor[], coverage: TraceFrame['coverage'] = 'verified'): TraceFrame => ({ atMs: end + offset, coverage, actors });
  const frames = [frame(-180_000, [parent]), frame(-165_000, [{ ...parent, signal: 'tool' }]),
    frame(-150_000, [parent, child]), frame(-135_000, [parent]), frame(-15_000, [parent], 'partial'), frame(0, [parent])];
  const window: TraceWindow = { version: 1, startMs: end-hour, endMs: end, cadenceMs: cadence, firstMs: end-180_000, lastMs: end, frames };
  await page.route('**/api/office', route => route.fulfill({ json: officeStatus(end) }));
  await page.route('**/api/office/history*', route => route.fulfill({ json: window }));
  return { end, frames, window };
}

for (const [view, query] of [['ambient','?view=ambient'], ['standalone','?team=general']] as const) {
  test(`keyboard opens the editor over the same ${view} office and close restores focus`, async ({ page }) => {
    await recording(page); await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`/${query}`);
    const canvas = page.getByTestId('scene-canvas');
    await expect(page.getByTestId('source-indicator')).toContainText(/live/i);
    // Existing positive control on the same UI before testing the new entry.
    await expect(page.getByRole('button', { name: view === 'ambient' ? 'Exit ambient view' : 'Enter ambient view' })).toBeVisible();
    const original = await canvas.elementHandle();
    const entry = page.getByRole('button', { name: 'Open braindance editor', exact: true });
    if (view === 'ambient') {
      const controls = page.getByRole('group', { name: 'Display controls' });
      await expect(controls.getByRole('button')).toHaveCount(4);
      for (const name of ['Open braindance editor','Exit ambient view','Pause animation','Enter full screen']) await expect(controls.getByRole('button', {name, exact:true})).toBeVisible();
    }
    await expect(entry).toBeVisible(); await entry.focus(); await page.keyboard.press('Enter');
    const editor = page.getByRole('region', { name: 'Braindance editor', exact: true });
    await expect(editor).toBeVisible();
    await expect(page.getByTestId('source-indicator')).toHaveCount(0);
    await expect(page.locator('.room-marker:visible, .campus-heading:visible, .world-dock:visible')).toHaveCount(0);
    await editor.getByRole('button', { name: 'Close editor', exact: true }).click();
    await expect(editor).toHaveCount(0); await expect(entry).toBeFocused();
    await expect(page.getByTestId('source-indicator')).toContainText(/live/i);
    expect(await canvas.evaluate((el, old) => el === old, original)).toBe(true);
  });
}

test('scrubbing reads sampled bands and gaps; playback moves the cursor without redrawing the lanes', async ({ page }) => {
  const { end } = await recording(page); await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/?view=editor&team=general');
  const editor = page.getByRole('region', { name: 'Braindance editor' });
  await expect(editor).toBeVisible();
  const range = editor.getByRole('slider', { name: 'Recording time', exact: true });
  await expect(range).toBeEnabled();
  const canvas = page.getByTestId('scene-canvas'), sample = editor.getByTestId('trace-sample');
  await expect(page.getByTestId('scene-status')).toHaveText('ready', { timeout: 20000 });
  await range.fill(String(end-150_000));
  await expect(editor.getByTestId('trace-mode')).toHaveText('Replay');
  await expect(sample).toContainText('2 present'); await expect(sample).toContainText('1 link');
  await expect(canvas).toHaveAttribute('data-agents', '2');
  await expect(editor.getByTestId('trace-clock')).toHaveAttribute('datetime', new Date(end-150_000).toISOString());
  const lanes = editor.getByTestId('trace-lanes');
  for (const channel of ['presence','tools','links']) {
    await expect(lanes.getByTestId(`trace-lane-${channel}`).locator('[data-signal]')).toHaveAttribute('d', /\d/);
  }
  const ink = await lanes.evaluate((node, hour) => {
    const path = (lane: string) => node.querySelector<SVGPathElement>(`[data-testid="trace-lane-${lane}"] [data-signal]`)!;
    const contains = (lane: string, offset: number) => path(lane).isPointInFill(new DOMPoint((1+offset/hour)*1000,5));
    return { linked:contains('links',-145_000), afterChild:contains('links',-120_000), parent:contains('presence',-120_000),
      gap:contains('presence',-70_000), before:contains('presence',-240_000), pulseX:path('tools').getPointAtLength(0).x };
  },hour);
  expect(ink).toMatchObject({ linked:true, afterChild:false, parent:true, gap:false, before:false });
  expect(ink.pulseX).toBeCloseTo((1-165_000/hour)*1000,2);
  await range.fill(String(end-165_000)); await expect(sample).toContainText('1 tool pulse');
  await range.fill(String(end-70_000)); await expect(sample).toContainText('Recording gap');
  await expect(canvas).toHaveAttribute('data-agents', '0');
  await range.fill(String(end-240_000)); await expect(sample).toContainText('Before first capture');
  await range.fill(String(end-15_000)); await expect(sample).toContainText('Partial sample');
  await range.fill(String(end-150_000)); await expect(canvas).toHaveAttribute('data-agents', '2');
  await lanes.evaluate(node => {
    const host = window as Window & { laneObserver?: MutationObserver };
    host.laneObserver = new MutationObserver(() => { node.setAttribute('data-test-mutated', 'yes'); });
    host.laneObserver.observe(node, { subtree: true, attributes: true, attributeFilter: ['d','style','class'], childList: true, characterData: true });
  });
  await editor.getByLabel('Playback speed').selectOption('4');
  await editor.getByRole('button', { name: 'Play reverse', exact: true }).click();
  await expect(editor.getByTestId('trace-shuttle-state')).toHaveText(/Reverse.*4×/);
  await expect.poll(async () => Number(await range.inputValue())).toBeLessThan(end-150_000);
  await editor.getByRole('button', { name: 'Pause playback', exact: true }).click();
  const paused = Number(await range.inputValue());
  await editor.focus(); await page.keyboard.press('l');
  await expect(editor.getByTestId('trace-shuttle-state')).toHaveText(/Forward.*4×/);
  await expect.poll(async () => Number(await range.inputValue())).toBeGreaterThan(paused);
  await page.keyboard.press('k'); await expect(editor.getByTestId('trace-shuttle-state')).toHaveText('Paused');
  expect(await lanes.getAttribute('data-test-mutated')).toBeNull();
  await editor.getByRole('button', { name: 'Return to live', exact: true }).click();
  await expect(editor.getByTestId('trace-mode')).toHaveText('Live head');
  await expect(canvas).toHaveAttribute('data-agents', '1');
});

test('an archive hour uses local date/time, leaves camera keys alone, and closes back to the current roster', async ({ page }) => {
  const { end, window } = await recording(page);
  const oldEnd = Math.floor((end-3*hour)/60000)*60000, firstMs = oldEnd-hour;
  const old: TraceWindow = { ...window, startMs: firstMs, endMs: oldEnd, firstMs, frames: [{ atMs: firstMs, actors: [parent, child], coverage: 'verified' }] };
  let requestedEnd: string | null = null, requests = 0;
  await page.route('**/api/office/history*', route => {
    requests++;
    const selected = new URL(route.request().url()).searchParams.get('end');
    if (selected !== null) requestedEnd = selected;
    return route.fulfill({ json: selected === null ? { ...window, firstMs } : old });
  });
  await page.emulateMedia({ reducedMotion: 'reduce' }); await page.goto('/?view=editor&team=general');
  await page.getByRole('slider', { name: 'Recording time' }).fill(String(end-150_000));
  const browse = page.getByRole('button', { name: 'Browse archive' });
  await expect(browse).toBeVisible(); await browse.click();
  const field = page.getByLabel('Hour ending (local time)', { exact: true });
  await expect(field).toBeFocused();
  await field.press('j'); await expect(page.getByTestId('trace-shuttle-state')).toHaveText('Paused');
  const localValue = await page.evaluate(ms => { const d = new Date(ms); return new Date(ms-d.getTimezoneOffset()*60000).toISOString().slice(0,16); }, oldEnd);
  await field.fill(localValue); await page.getByRole('button', { name: 'Load hour', exact: true }).click();
  await expect(page.getByTestId('trace-mode')).toHaveText('Archive'); expect(requestedEnd).toBe(String(oldEnd));
  await expect(page.getByTestId('trace-clock')).toHaveAttribute('datetime', new Date(firstMs).toISOString());
  const canvas = page.getByTestId('scene-canvas');
  await expect(canvas).toHaveAttribute('data-agents', '2');
  await expect(page.getByTestId('source-indicator')).toHaveCount(0);
  await browse.click();
  const before = requests;
  expect(await exportJson(page)).toEqual(old); expect(requests).toBe(before);
  await browse.click();
  await canvas.focus(); await canvas.press('ArrowLeft'); await canvas.press('l');
  await expect(page.getByTestId('trace-shuttle-state')).toHaveText('Paused');
  await page.getByRole('button', { name: 'Close editor', exact: true }).click();
  await expect(canvas).toHaveAttribute('data-assignments', /"id":"default"/);
  await page.getByRole('button', { name: 'Open braindance editor' }).click();
  await expect(page.getByTestId('trace-mode')).toHaveText('Live head');
});

test('only a deliberately requested, validated full hour can be exported', async ({ page }) => {
  const { window } = await recording(page);
  let release!: () => void, calls = 0, downloads = 0;
  const full = new Promise<void>(resolve => { release = resolve; });
  page.on('download', () => { downloads++; });
  await page.route('**/api/office/history*', async route => {
    const tail = new URL(route.request().url()).searchParams.has('after'); calls++;
    if (!tail) await full;
    await route.fulfill({ json: tail ? { ...window, frames: window.frames.slice(-1) } : window });
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await Promise.all([page.waitForResponse(r => r.url().includes('history?after=')), page.goto('/?view=ambient')]);
  await page.getByRole('button', { name: 'Open braindance editor' }).click();
  await page.getByRole('button', { name: 'Browse archive' }).click();
  const save = page.getByRole('button', { name: 'Save hour as JSON', exact: true });
  await expect(save).toBeDisabled(); expect(downloads).toBe(0);
  await expect(page.getByRole('slider', { name: 'Recording time' })).toBeDisabled();
  await expect(page.getByTestId('trace-sample')).toContainText('Loading full hour');
  release(); await expect(save).toBeEnabled(); expect(downloads).toBe(0);
  const before = calls;
  expect(await exportJson(page)).toEqual(window);
  expect(calls).toBe(before); expect(downloads).toBe(1);
});

test('a replacement archive cannot borrow the previous hour’s ruler while its prefix is missing', async ({ page }) => {
  const { window: first, end } = await recording(page);
  const start = end - hour + 10_000;
  const sample = (atMs: number): TraceFrame => ({atMs, actors: [parent], coverage: 'verified'});
  const replacement: TraceWindow = {...first, startMs: end+cadence-hour, endMs: end+cadence,
    firstMs: start, lastMs: end+cadence, frames: [sample(end+cadence)]};
  const restored: TraceWindow = {...replacement, startMs: end+2*cadence-hour, endMs: end+2*cadence,
    lastMs: end+2*cadence, frames: [sample(start+60_000),sample(end+cadence),sample(end+2*cadence)]};
  let reads = 0, release!: () => void;
  const held = new Promise<void>(done => { release = done; });
  await page.route('**/api/office/history*', async route => {
    reads++;
    if (new URL(route.request().url()).searchParams.has('after')) { await held; return route.fulfill({json: replacement}); }
    return route.fulfill({json: reads === 1 ? first : restored});
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.install({time: new Date(end)}); await page.clock.pauseAt(end+1000);
  await page.goto('/?view=editor');
  const range = page.getByRole('slider', {name:'Recording time'});
  await expect(range).toBeEnabled(); await page.getByRole('button',{name:'Browse archive'}).click();
  const save = page.getByRole('button',{name:'Save hour as JSON'});
  await expect(save).toBeEnabled(); await page.clock.fastForward(cadence);
  await expect.poll(() => reads).toBe(2); await expect(save).toBeDisabled();
  await expect(range).toBeEnabled(); // In-flight poll: the old full window is still on screen.
  const received = page.waitForResponse(r => r.url().includes('history?after=')); release(); await received;
  await expect(range, 'an incomplete replacement window is not a scrubbable hour').toBeDisabled();
  await expect(page.getByTestId('trace-lanes')).toHaveAttribute('data-loaded','false');
  await expect(save).toBeDisabled();
  await page.clock.fastForward(cadence); await expect(range).toBeEnabled(); await expect(save).toBeEnabled();
  await range.fill(String(start+60_000)); await expect(page.getByTestId('trace-sample')).toContainText('1 present');
  expect(await exportJson(page)).toEqual(restored);
});

test('an old head stays labeled recorded, and native seeking can land exactly on a sample', async ({ page }) => {
  const { window, end } = await recording(page), oldEnd = end-3*hour, odd = oldEnd-14_712;
  await page.route('**/api/office', r => r.fulfill({ json: officeStatus(oldEnd) }));
  await page.route('**/api/office/history*', route => route.fulfill({ json: { ...window, startMs: oldEnd-hour, endMs: oldEnd, firstMs: odd-15_000, lastMs: oldEnd,
    frames: [{ atMs: odd-15_000, coverage: 'verified', actors: [parent] }, { atMs: odd, coverage: 'verified', actors: [parent, child] }, { atMs: oldEnd, coverage: 'verified', actors: [parent] }] } }));
  await page.emulateMedia({ reducedMotion: 'reduce' }); await page.goto('/?view=editor');
  await expect(page.getByTestId('trace-mode')).toHaveText('Recorded head');
  await expect(page.getByTestId('trace-sample')).toContainText('Last recorded');
  await expect(page.getByTestId('source-indicator')).toHaveCount(0);
  const range = page.getByRole('slider', { name: 'Recording time' });
  await range.fill(String(odd)); await expect(page.getByTestId('trace-sample')).toContainText('2 present');
  expect(Number(await range.inputValue())).toBe(odd);
  await range.press('ArrowLeft'); expect(Number(await range.inputValue())).toBe(odd-1000);
  await expect(page.getByTestId('trace-sample')).toContainText('1 present');
  await range.press('ArrowRight'); expect(Number(await range.inputValue())).toBe(odd);
});

test('recorder failure with only an old status labels the retained office as saved, never live', async ({ page }) => {
  const { end } = await recording(page);
  await page.route('**/api/office', r => r.fulfill({ json: officeStatus(end-3*hour) }));
  await page.route('**/api/office/history*', r => r.fulfill({ status: 503, body: '' }));
  await page.goto('/?view=editor');
  await expect(page.getByTestId('trace-mode')).toHaveText('Saved status');
  await expect(page.getByTestId('trace-clock')).toHaveAttribute('datetime', new Date(end-3*hour).toISOString());
  await expect(page.getByTestId('trace-sample')).toContainText('Current activity unknown');
  await expect(page.getByTestId('trace-sample')).not.toContainText('Current office shown');
  await expect(page.getByTestId('source-indicator')).toHaveCount(0);
  await page.getByRole('button', { name: 'Browse archive' }).click();
  await expect(page.getByRole('button', { name: 'Save hour as JSON' })).toBeDisabled();
  await page.getByRole('button', { name: 'Close editor' }).click();
  await expect(page.getByTestId('source-indicator')).not.toHaveText('LIVE');
});

test('empty and unavailable recording are distinct, and no past roster is substituted', async ({ page }) => {
  const { window } = await recording(page);
  let unavailable = false;
  await page.route('**/api/office/history*', route => unavailable ? route.fulfill({ status: 503, body: '' }) : route.fulfill({ json: { ...window, firstMs: null, lastMs: null, frames: [] } }));
  await page.emulateMedia({ reducedMotion: 'reduce' }); await page.goto('/?view=editor');
  await expect(page.getByTestId('trace-sample')).toHaveText('No recordings yet');
  await expect(page.getByTestId('trace-mode')).toHaveText('No recording');
  await expect(page.getByTestId('scene-canvas')).toHaveAttribute('data-agents','0');
  await expect(page.getByRole('slider', { name: 'Recording time' })).toBeDisabled();
  unavailable = true; await page.reload();
  await expect(page.getByTestId('trace-sample')).toContainText('Recorder unavailable');
  await expect(page.getByTestId('trace-sample')).toContainText('Current office shown');
  await expect(page.getByTestId('scene-canvas')).toHaveAttribute('data-assignments', /"id":"default"/);
  await page.getByRole('button', { name: 'Close editor' }).click();
  await expect(page.getByTestId('source-indicator')).toContainText(/live/i);
});

test('3D failure keeps the editor operable without promising a live roster in replay', async ({ page }) => {
  const { end } = await recording(page);
  await page.route(/\/(?:src\/scene\/engine\.ts|assets\/engine-[^/]+\.js)(?:[?#]|$)/, route => route.abort());
  await page.goto('/?view=editor');
  await expect(page.getByTestId('scene-status')).toHaveText('error');
  await page.getByRole('slider', { name: 'Recording time' }).fill(String(end-150_000));
  await expect(page.getByTestId('scene-canvas')).toHaveAccessibleName(/recording|recorded|replay/i);
  const message = page.locator('.scene-error');
  await expect(message).toBeVisible(); await expect(message).not.toContainText(/roster|live status/i, {useInnerText:true});
  await expect(page.getByText('3D view unavailable. The recording controls still work.')).toBeVisible();
  await expect(message.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(page.getByTestId('trace-sample')).toContainText('1 link');
});

test('editor queries in a demo, legacy hero or real frame never attempt either private endpoint', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', r => { if (/^\/api\/office(?:\/|$)/.test(new URL(r.url()).pathname)) requests.push(r.url()); });
  await page.route('**/api/**', r => r.abort());
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const url of ['/?view=editor&source=demo','/?view=editor&view=hero&source=live']) {
    await page.goto(url);
    await expect(page.getByTestId('scene-status')).toHaveText('ready', { timeout: 20000 });
    await expect(page.getByTestId('scene-canvas')).toHaveAttribute('data-agents','33');
    await expect(page.getByTestId('trace-editor')).toHaveCount(0); await expect(page.getByRole('button', { name: 'Open braindance editor' })).toHaveCount(0);
  }
  await page.route('**/trace-editor-frame-host', r => r.fulfill({ contentType: 'text/html', body:'<iframe title="Office" src="/?view=editor&source=live"></iframe>' }));
  await page.goto('/trace-editor-frame-host'); const frame = page.frameLocator('iframe');
  await expect(frame.getByTestId('scene-status')).toHaveText('ready', { timeout: 20000 });
  await expect(frame.locator('main')).toHaveAttribute('data-presentation','embedded');
  await expect(frame.locator('button,input,dialog')).toHaveCount(0);
  expect(requests).toEqual([]);
});

test.describe('portrait editor', () => {
  test.use({ viewport:{ width:390,height:844 },isMobile:true,hasTouch:true });
  test('the archive leaves the canvas reachable and every control remains a full-size touch target', async ({ page }) => {
    const { end } = await recording(page); await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/?view=editor&team=general');
    const editor = page.getByTestId('trace-editor');
    await editor.getByRole('slider', { name: 'Recording time' }).fill(String(end-150_000));
    await editor.getByRole('button', { name: 'Browse archive' }).tap();
    await expect(editor.getByRole('button', { name: 'Save hour as JSON' })).toBeVisible();
    for (const box of [{width:390,height:844}, {width:320,height:568}]) {
      await page.setViewportSize(box);
      expect(await editor.locator('button,input,select').evaluateAll(nodes => nodes.filter(el => {
        const r=el.getBoundingClientRect(), hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
        return r.width<44 || r.height<44 || r.x<0 || r.y<0 || r.right>innerWidth || r.bottom>innerHeight || (hit!==el && !el.contains(hit));
      }).map(el => el.getAttribute('aria-label') || el.tagName))).toEqual([]);
      expect(await page.evaluate(() => document.elementFromPoint(innerWidth/2,innerHeight/2)?.tagName)).toBe('CANVAS');
    }
    const result = await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']).analyze();
    expect(result.violations.map(v=>({id:v.id,targets:v.nodes.map(n=>n.target)}))).toEqual([]);
  });
});
