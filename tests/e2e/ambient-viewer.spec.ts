import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type Page } from '@playwright/test';

async function expectDecorativeFrame(page: Page) {
  const office = page.frameLocator('iframe');
  await expect(office.getByTestId('scene-status')).toHaveText('ready', { timeout: 20000 });
  await expect(office.locator('main')).toHaveAttribute('data-presentation', 'embedded');
  await expect(office.locator('button,input,a,dialog')).toHaveCount(0);
  await expect(office.getByTestId('scene-canvas')).toHaveAttribute('data-agents', '33');
}

test('ordinary same-origin frames and framed ambient cannot request live observations', async ({ page }) => {
  let privateRequests = 0;
  await page.route('**/api/office', route => { privateRequests++; return route.fulfill({ status: 503, body: '' }); });
  for (const query of ['?view=ambient&source=live', '?source=live']) {
    await page.route('**/viewer-frame-host', route => route.fulfill({ contentType: 'text/html', body: `<iframe title="Office" src="/${query}"></iframe>` }));
    await page.goto('/viewer-frame-host');
    await expectDecorativeFrame(page);
    expect(privateRequests, `live requests made by framed ${query}`).toBe(0);
    await page.unroute('**/viewer-frame-host');
  }
});

test('a separate loopback origin also receives only the decorative campus', async ({ page, baseURL }) => {
  const src = new URL('/?view=ambient&source=live', baseURL);
  // A real socket gives Edge a real loopback address space; a mocked host can be blocked before the frame loads.
  const host = createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(`<iframe title="Office" src="${src}"></iframe>`); });
  host.listen(0, '127.0.0.1'); await once(host, 'listening');
  try {
    let requests = 0; await page.route('**/api/office', route => { requests++; return route.abort(); });
    await page.goto(`http://127.0.0.1:${(host.address() as AddressInfo).port}/`);
    expect(new URL(page.url()).origin).not.toBe(src.origin);
    await expectDecorativeFrame(page);
    expect(requests).toBe(0);
  } finally { host.closeAllConnections(); await new Promise<void>(done => host.close(() => done())); }
});

function observation(state: 'working' | 'idle' = 'working') {
  const observedAt = new Date().toISOString();
  return { schemaVersion: 1, mode: 'live', source: 'Local Hermes status bridge', sourceHealth: 'connected', observedAt, pollIntervalMs: 30000, warnings: [],
    agents: [{ id: 'default', name: 'Hermes', role: 'General assistant', team: 'general', state, observedAt, activity: 'Current turn lease or fresh running worker observed.', activeSessions: state === 'working' ? 1 : 0 }] };
}

test('keyboard entry leaves the demo for a quiet live campus; fullscreen and exit keep the same canvas', async ({ page }) => {
  let requests = 0;
  await page.route('**/api/office', route => { requests++; return route.fulfill({ json: observation() }); });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/?source=demo&team=general');
  const canvas = page.getByTestId('scene-canvas');
  await expect(canvas).toHaveAttribute('data-agents', '33');
  const originalCanvas = await canvas.elementHandle();
  const enter = page.getByRole('button', { name: 'Enter ambient view' });
  await expect(enter).toBeVisible();
  await enter.focus(); await page.keyboard.press('Enter');
  await expect(page.locator('main')).toHaveAttribute('data-presentation', 'ambient');
  await expect(page).toHaveURL(/view=ambient/);
  await expect(page.getByTestId('source-indicator')).toContainText(/live.*1 working/i);
  await expect(canvas).toHaveAttribute('data-agents', '1');
  await expect(canvas).toHaveAttribute('data-focus', 'general');
  await expect(canvas).toHaveAccessibleName(/exit ambient view/i);
  await expect(page.getByRole('toolbar', { name: 'Office controls' })).toHaveCount(0);
  await expect(page.locator('.room-marker:visible')).toHaveCount(0);
  expect(requests).toBeGreaterThan(0);
  await page.bringToFront();
  await page.getByRole('button', { name: 'Enter full screen' }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.tagName)).toBe('MAIN');
  await page.getByRole('button', { name: 'Exit full screen' }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  await page.getByRole('button', { name: 'Exit ambient view' }).focus(); await page.keyboard.press('Enter');
  await expect(page.locator('main')).toHaveAttribute('data-presentation', 'standalone');
  await expect(page.getByTestId('source-indicator')).toHaveText('DEMO');
  await expect(canvas).toHaveAttribute('data-agents', '33');
  expect(await canvas.evaluate((el, original) => el === original, originalCanvas)).toBe(true);
  await expect(enter).toBeFocused();
  await page.goBack();
  await expect(page.locator('main')).toHaveAttribute('data-presentation', 'ambient');
  await canvas.focus(); await page.keyboard.press('Escape');
  await expect(enter).toBeFocused();
});

test('one fixture parent and two children become three pickable rows, not four; finishing one removes only that child', async ({ page }) => {
  const ids = ['a', 'b', 'c'].map(letter => `p-${letter.repeat(32)}`);
  let total = 3;
  await page.route('**/api/office', route => {
    const sample = observation(); sample.agents[0].activeSessions = total;
    const participants = ids.slice(0, total).map((id, i) => ({ id, profileId: 'default', kind: i ? 'subagent' : 'session',
      name: `${i ? 'Subagent' : 'Session'} ${id.slice(2,8).toUpperCase()}`, role: i ? 'Delegated subagent' : 'Active session', team: 'general', state: 'working',
      observedAt: sample.observedAt, activity: 'Verified in-flight work.', ...(i ? { parentId: ids[0] } : {}) }));
    return route.fulfill({ json: { ...sample, participants } });
  });
  await page.goto('/?team=general');
  const canvas = page.getByTestId('scene-canvas');
  // The room UI can be ready before the lazily imported WebGL engine allocates its first figures.
  await expect(page.getByTestId('scene-status')).toHaveText('ready', { timeout: 20000 });
  const assignments = () => canvas.evaluate(el => JSON.parse((el as HTMLElement).dataset.assignments ?? '[]').map((a: { id: string }) => a.id).sort());
  await expect.poll(assignments).toEqual(ids);
  await page.getByRole('button', { name: 'Open team', exact: true }).click();
  await expect(page.getByTestId('agent-row')).toHaveCount(3);
  await page.getByRole('textbox', { name: 'Find an agent' }).fill('subagent');
  await expect(page.getByTestId('agent-row')).toHaveCount(2);
  await page.getByTestId('agent-row').filter({ hasText: 'Subagent CCCCCC' }).click();
  const inspector = page.getByTestId('agent-inspector');
  await expect(inspector.getByText('Parent', { exact: true })).toBeVisible();
  await expect(inspector.getByText('Session AAAAAA', { exact: true })).toBeVisible();
  await expect(inspector).not.toContainText(ids[0]);
  total = 2;
  // Trigger the same immediate refresh used when a leave-on display becomes visible again.
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(assignments).toEqual(ids.slice(0, 2));
  await expect(page.getByRole('dialog')).toContainText('No longer observed');
  await page.getByRole('button', { name: 'Back to your team' }).click();
  await expect(page.getByTestId('agent-row')).toHaveCount(1);
  await expect(page.getByTestId('agent-row')).toContainText('Subagent BBBBBB');
  await page.getByRole('button', { name: 'Open status' }).click();
  await expect(page.locator('.status-facts > div').filter({ hasText: 'Profiles observed' }).locator('dd')).toHaveText('1');
  await expect(page.locator('.status-facts > div').filter({ hasText: 'Active general sessions' }).locator('dd')).toHaveText('2');
});

test('a hidden ambient tab does not poll; on return a failed feed shows unknown, never demo or zero workers', async ({ page }) => {
  let requests = 0, failed = false;
  await page.clock.install();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/api/office', route => { requests++; return failed ? route.fulfill({ status: 503, body: '' }) : route.fulfill({ json: observation() }); });
  await page.goto('/?view=ambient&source=demo');
  await expect(page.getByTestId('source-indicator')).toContainText('1 working');
  const canvas = page.getByTestId('scene-canvas');
  await expect(canvas).toHaveAttribute('data-agents', '1');
  await expect(canvas).toHaveAttribute('data-fiber-time', '0.000');
  const setHidden = (value: boolean) => page.evaluate(hidden => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: hidden });
    document.dispatchEvent(new Event('visibilitychange'));
  }, value);
  await setHidden(true);
  const before = requests;
  await page.clock.fastForward(95_000);
  expect(requests).toBe(before);
  failed = true; await setHidden(false);
  await expect.poll(() => requests).toBeGreaterThan(before);
  await expect(page.getByTestId('source-indicator')).toHaveText('Activity unknown');
  await expect(canvas).toHaveAttribute('data-agents', '1'); // only the previously known profile identity
  await expect(canvas).toHaveAttribute('data-fiber-time', '0.000');
  await page.getByRole('button', { name: 'Exit ambient view' }).click();
  await expect(page.locator('.campus-meta')).toContainText('Activity unknown');
  expect(new URL(page.url()).searchParams.has('source')).toBe(false); // a reload must stay live, too
  await expect(page.locator('.room-markers')).not.toContainText('0 working');
  await page.getByRole('button', { name: 'Open team', exact: true }).click();
  await expect(page.getByTestId('agent-row')).toContainText('Activity unknown');
  await expect(page.getByRole('button', { name: /Working, 0 agents|0 working/i })).toHaveCount(0);
  await expect(page.getByRole('dialog')).not.toContainText('0 at desks');
  await page.getByTestId('agent-row').click();
  await expect(page.getByTestId('agent-inspector')).not.toContainText('active sessions');
});

test('cold failure has no figures; partial and expired observations never turn into a definite zero', async ({ page }) => {
  let feed: 'unavailable' | 'partial' | 'stale' = 'unavailable';
  await page.route('**/api/office', route => {
    if (feed === 'unavailable') return route.fulfill({ status: 503, body: '' });
    const snapshot = observation();
    if (feed === 'stale') snapshot.observedAt = snapshot.agents[0].observedAt = new Date(Date.now() - 125_000).toISOString();
    return route.fulfill({ json: { ...snapshot, sourceHealth: 'degraded' } });
  });
  await page.goto('/?view=ambient');
  const indicator = page.getByTestId('source-indicator'), canvas = page.getByTestId('scene-canvas');
  await expect(indicator).toHaveText('Activity unknown');
  await expect(canvas).toHaveAttribute('data-agents', '0');
  const wake = () => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  feed = 'partial'; await wake();
  await expect(indicator).toHaveText('Live · At least 1 working');
  await expect(canvas).toHaveAttribute('data-agents', '1');
  feed = 'stale'; await wake();
  await expect(indicator).toHaveText('Activity unknown');
  await expect(canvas).toHaveAttribute('data-assignments', /"state":"offline"/);
});

test('partial aggregate session totals stay qualified in the roster, inspector and status', async ({ page }) => {
  let active = true;
  await page.route('**/api/office', route => route.fulfill({ json: { ...observation(active ? 'working' : 'idle'), sourceHealth: 'degraded' } }));
  await page.goto('/?team=general');
  await page.getByRole('button', { name: 'Open team', exact: true }).click();
  const row = page.getByTestId('agent-row');
  await expect(row).toContainText('At least 1 active session');
  await row.click();
  await expect(page.getByTestId('agent-inspector').locator('dd')).toHaveText('At least 1');
  await page.getByRole('button', { name: 'Open status', exact: true }).click();
  const total = page.locator('.status-facts > div').filter({ hasText: 'Active general sessions' }).locator('dd');
  await expect(total).toHaveText('At least 1');
  active = false;
  await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
  await expect(total).toHaveText('Unverified');
});

test('resuming just before an old poll deadline does not double-poll the local bridge', async ({ page }) => {
  const start = Date.now(); let requests = 0;
  await page.clock.install({ time: new Date(start) });
  await page.clock.pauseAt(new Date(start + 1000));
  await page.route('**/api/office', route => route.fulfill({ json: observation(++requests === 1 ? 'working' : 'idle') }));
  await page.goto('/?view=ambient');
  const indicator = page.getByTestId('source-indicator');
  await expect(indicator).toHaveText('Live · 1 working');
  const hidden = (value: boolean) => page.evaluate(hidden => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: hidden });
    document.dispatchEvent(new Event('visibilitychange'));
  }, value);
  await hidden(true); await page.clock.fastForward(29_900); await hidden(false);
  await expect(indicator).toHaveText('Live · 0 working');
  expect(requests).toBe(2);
  await page.clock.fastForward(1000);
  // Drain browser tasks so a fetch started by the old interval can reach the route.
  await page.evaluate(() => fetch('/viewer-clock-barrier').catch(() => {}));
  expect(requests).toBe(2);
});
