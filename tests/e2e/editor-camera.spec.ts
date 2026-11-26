import { expect, test } from '@playwright/test';
import type { PerspectiveCamera, Scene } from 'three';
import type { OfficeAgent } from '../../src/domain/types.ts';
import { planCampus } from '../../src/scene/campus.ts';
import { campusCamera } from '../../src/scene/campus-camera.ts';

type Pose = { position: number[]; zoom: number };
declare global { interface Window { editorCameraDraw: { agents: number; rooms: number; pose: Pose } } }
const viewport = { width: 900, height: 600 };
test.use({ viewport, reducedMotion: 'reduce' });

test('an empty recording preserves orbit and zoom on entry and exit; subsequent live bounds still fit', async ({ page }) => {
  const endMs = Date.now(), observedAt = new Date(endMs).toISOString();
  const profiles: OfficeAgent[] = Array.from({ length: 11 }, (_, i) => ({ id: `studio-a${i}`, name: `Fixture ${i}`,
    role: 'Operator', team: 'studio', state: 'idle', observedAt, activity: 'Native profile readable; no verified in-flight work.' }));
  let live = profiles;
  await page.route('**/api/office', r => r.fulfill({ json: { schemaVersion: 1, mode: 'live', source: 'Local Hermes status bridge',
    sourceHealth: 'connected', observedAt, pollIntervalMs: 30000, warnings: [], agents: live } }));
  await page.route('**/api/office/history*', r => r.fulfill({ json: { version: 1, startMs: endMs - 3_600_000,
    endMs, cadenceMs: 15000, firstMs: null, lastMs: null, frames: [] } }));

  // Observe only finished main-canvas draws; a roster attribute can change before the camera is drawn.
  await page.addInitScript(() => {
    const events = new EventTarget(); Object.assign(window, { __THREE_DEVTOOLS__: events });
    events.addEventListener('observe', event => {
      const scene = (event as CustomEvent<Scene>).detail;
      if (!scene.isScene) return;
      const after = scene.onAfterRender;
      scene.onAfterRender = function (...args) {
        after.apply(this, args);
        const [renderer, , camera] = args;
        if (renderer.getRenderTarget()) return;
        const { agents, rooms } = renderer.domElement.dataset;
        window.editorCameraDraw = { agents: Number(agents), rooms: Number(rooms),
          pose: { position: camera.position.toArray(), zoom: (camera as PerspectiveCamera).zoom } };
      };
    });
  });
  await page.goto('/?team=all');
  const canvas = page.getByTestId('scene-canvas'), draw = () => page.evaluate(() => window.editorCameraDraw);
  async function poseAt(agents: number, rooms: number) {
    await expect.poll(draw).toMatchObject({ agents, rooms });
    return (await draw()).pose;
  }
  async function orbitAndZoom() {
    const before = (await draw()).pose;
    await canvas.press('ArrowRight'); await canvas.press('=');
    await expect.poll(async () => (await draw()).pose.zoom).toBeGreaterThan(before.zoom);
    const pose = (await draw()).pose;
    expect(Math.hypot(...pose.position.map((n, i) => n - before.position[i]))).toBeGreaterThan(1);
    return pose;
  }
  function fitted() {
    const { position } = campusCamera(planCampus(live).bounds, viewport.width, viewport.height);
    return { position: position.map(n => expect.closeTo(n, 8)), zoom: 1 };
  }
  expect(await poseAt(11, 6), 'initial live annex is framed').toEqual(fitted());
  const fromLive = await orbitAndZoom();
  await page.getByRole('button', { name: 'Open braindance editor' }).click();
  await expect(page.getByTestId('trace-sample')).toHaveText('No recordings yet');
  expect.soft(await poseAt(0, 5), 'opening the empty hour').toEqual(fromLive);
  const fromEditor = await orbitAndZoom(); // The user can change their mind inside the editor, too.
  await page.getByRole('button', { name: 'Close editor' }).click();
  expect.soft(await poseAt(11, 6), 'closing the empty hour').toEqual(fromEditor);

  live = profiles.slice(0, 1);
  await page.getByRole('button', { name: 'Open status' }).click();
  await page.getByRole('button', { name: 'Refresh status' }).click();
  expect(await poseAt(1, 5), 'a genuine live footprint change still fits').toEqual(fitted());
});
