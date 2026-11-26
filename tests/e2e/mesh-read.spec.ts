import type { IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { build, preview, type PreviewServer } from 'vite';
import solid from 'vite-plugin-solid';

// Plain HTTP, but never a real private host. Only this browser maps the test name to loopback.
const host = 'office-reader.test';
const paths = ['/api/office', '/api/office/history'];
const received: { path: string; headers: IncomingHttpHeaders }[] = [];
type Probe = typeof window & { officeReads: { path: string; [key: string]: string | null }[] };
let server: PreviewServer, origin: string;

test.use({ reducedMotion: 'reduce', launchOptions: { args: [
  '--no-proxy-server', `--host-resolver-rules=MAP ${host} 127.0.0.1, MAP * ~NOTFOUND`,
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
] } });

test.beforeAll(async ({}, info) => {
  // Do not load the desktop Vite plugin, environment files, collector or archive.
  const config = { root: fileURLToPath(new URL('../..', import.meta.url)), configFile: false, envFile: false,
    logLevel: 'error', cacheDir: info.outputPath('vite-cache'), build: { outDir: info.outputPath('ui') } } as const;
  await build({ ...config, plugins: [solid()] });
  server = await preview({ ...config, preview: { host: '127.0.0.1', port: 0, strictPort: true, allowedHosts: [host] },
    plugins: [{ name: 'synthetic-office', configurePreviewServer(s) {
      s.middlewares.use((req, res, next) => {
        const path = req.url?.split('?')[0];
        if (!path || !paths.includes(path)) return next();
        received.push({ path, headers: req.headers });
        const endMs = Date.now(), observedAt = new Date(endMs).toISOString();
        const data = path === '/api/office'
          ? { schemaVersion: 1, mode: 'live', source: 'Fixture', sourceHealth: 'connected', observedAt, pollIntervalMs: 30_000,
              warnings: [], agents: [{ id: 'fixture', name: 'Fixture', role: 'Fixture', team: 'general', state: 'working', activity: 'Fixture', observedAt }] }
          : { version: 1, startMs: endMs - 3_600_000, endMs, cadenceMs: 15_000, frames: [], firstMs: null, lastMs: null };
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(data));
      });
    } }],
  });
  origin = `http://${host}:${(server.httpServer.address() as AddressInfo).port}`;
});
test.afterAll(async () => { await server?.close(); });

test.beforeEach(async ({ page }) => {
  received.length = 0;
  await page.context().route(url => url.origin !== origin, route => route.abort());
  await page.addInitScript(() => {
    const w = window as Probe;
    w.officeReads = [];
    const original = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const request = new Request(input, init), url = new URL(request.url);
      if (/^\/api\/office(?:\/|$)/.test(url.pathname)) w.officeReads.push({ path: url.pathname, origin: url.origin,
        method: request.method, mode: request.mode, credentials: request.credentials, redirect: request.redirect, cache: request.cache,
        marker: request.headers.get('X-Office-Read'), accept: request.headers.get('Accept') });
      return original(input, init);
    };
  });
});

test('live status and recorded hours make marked, credentialless same-origin GETs on plain HTTP', async ({ page, context }) => {
  await context.addCookies([{ url: origin, name: 'office_probe', value: 'must-not-travel' }]);
  await page.goto(`${origin}/?view=ambient`);
  expect(await page.evaluate(() => isSecureContext)).toBe(false);
  expect(await page.evaluate(() => document.cookie)).toContain('office_probe=must-not-travel');
  await expect(page.getByTestId('source-indicator')).toHaveText('Live · 1 working');
  await page.getByRole('button', { name: 'Open braindance editor' }).click();
  await expect(page.getByTestId('trace-sample')).toHaveText('No recordings yet');

  const reads = await page.evaluate(() => (window as Probe).officeReads);
  expect([...new Set(reads.map(r => r.path))].sort()).toEqual(paths);
  for (const r of reads) expect.soft(r, r.path).toMatchObject({ origin, method: 'GET', mode: 'same-origin',
    credentials: 'omit', redirect: 'error', cache: 'no-store', marker: '1', accept: 'application/json' });
  expect([...new Set(received.map(r => r.path))].sort()).toEqual(paths);
  for (const { path, headers } of received) {
    expect.soft(headers, path).toMatchObject({ 'x-office-read': '1', accept: 'application/json' });
    expect.soft(headers.cookie, path).toBeUndefined();
  }
});

test('an explicitly decorative page and an ordinary iframe never start a private fetch', async ({ page }) => {
  await page.clock.install();
  await page.goto(`${origin}/?embed=1&view=editor&source=live`);
  await expect(page.locator('main')).toHaveAttribute('data-presentation', 'embedded');
  await page.evaluate(() => {
    const frame = document.createElement('iframe'); frame.src = '/?view=editor&source=live'; document.body.append(frame);
  });
  await expect(page.frameLocator('iframe').locator('main')).toHaveAttribute('data-presentation', 'embedded');
  for (const frame of page.frames()) await frame.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.clock.fastForward(60_000); // Past both the snapshot and history poll deadlines.
  for (const frame of page.frames()) expect(await frame.evaluate(() => (window as Probe).officeReads)).toEqual([]);
  expect(received).toEqual([]);
});
