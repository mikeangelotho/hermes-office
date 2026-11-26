import { expect, test } from '@playwright/test';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { OfficeAgent, Team } from '../../src/domain/types.ts';
import type { OfficeEngine } from '../../src/scene/engine.ts';
import { boundsFor, planCampus, type CampusView } from '../../src/scene/campus.ts';
import { campusCamera } from '../../src/scene/campus-camera.ts';

type Pose = { position: number[]; target: number[]; zoom: number; aspect: number };
declare global {
  interface Window { cameraTest: { canvas: HTMLCanvasElement; office: OfficeEngine; controls: OrbitControls; pose(): Pose }; }
}
function worker(id: string, team: Team = 'general'): OfficeAgent {
  return { id, name: id, role: 'Test worker', team, state: 'working', activity: 'Fixture', observedAt: '2026-01-01T00:00:00Z' };
}
function fitted(agents: OfficeAgent[], view: CampusView, width = 400, height = 260): Pose {
  const rooms = planCampus(agents).rooms.filter(room => view === 'all' || room.team === view);
  const { position, target, aspect } = campusCamera(boundsFor(rooms), width, height);
  return { position, target, aspect, zoom: 1 };
}
function expectPose(actual: Pose, wanted: Pose, reason: string) {
  expect(actual, reason).toEqual({ zoom: wanted.zoom, aspect: expect.closeTo(wanted.aspect, 9),
    position: wanted.position.map(n => expect.closeTo(n, 8)), target: wanted.target.map(n => expect.closeTo(n, 8)) });
}

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/tests/fixtures/engine-camera.html');
  await page.waitForFunction(() => Boolean(window.cameraTest));
});

test('one-for-one turnover in the same room preserves the actual zoom, orbit, and pan target', async ({ page }) => {
  const { framed, manual, after, ids } = await page.evaluate(([leaving, joining]) => {
    const { office, controls, canvas, pose } = window.cameraTest;
    office.setMotion(false);
    office.update([leaving]);
    const framed = pose();
    // The UI disables pointer panning; the public pan method seeds a non-default target without changing that policy.
    controls.rotateLeft(.35); controls.dollyIn(.9); controls.pan(23, -9); office.zoom(1);
    const manual = pose();
    office.update([joining]);
    return { framed, manual, after: pose(), ids: JSON.parse(canvas.dataset.assignments!).map((a: { id: string }) => a.id) };
  }, [worker('outgoing'), worker('incoming')]);

  expect(ids).toEqual(['incoming']);
  expect(manual.position).not.toEqual(framed.position);
  expect(manual.target).not.toEqual(framed.target);
  expect(manual.zoom).toBe(1.16);
  expect(after.zoom).toBe(manual.zoom);
  expect(after).toEqual(manual);
});

test('opening an annex for another team does not reframe a manually focused room', async ({ page }) => {
  const general = worker('one'), studio = Array.from({ length: 11 }, (_, i) => worker(`studio-${i}`, 'studio'));
  const result = await page.evaluate(({ general, studio }) => {
    const { office, controls, canvas, pose } = window.cameraTest;
    office.setMotion(false); office.update([general]); office.focus('general');
    controls.rotateLeft(.32); controls.pan(18, 12); office.zoom(1);
    const manual = pose();
    office.update([general, ...studio]);
    return { manual, after: pose(), rooms: canvas.dataset.rooms, focus: canvas.dataset.focus };
  }, { general, studio });
  expect([result.focus, result.rooms]).toEqual(['general', '6']);
  expect(result.after).toEqual(result.manual);
});

test('turnover during a damped gesture follows the same next camera frames as uninterrupted input', async ({ page }) => {
  const { uninterrupted, turnover } = await page.evaluate(async ([outgoing, incoming]) => {
    const { office, controls, pose } = window.cameraTest;
    async function trace(replace: boolean) {
      office.setMotion(false); controls.update(); // Drain residual input before replaying the identical gesture.
      office.update([outgoing]); office.reset(); office.setMotion(true);
      controls.rotateLeft(.4); controls.pan(20, 12);
      const samples = [pose()];
      if (replace) office.update([incoming]);
      samples.push(pose());
      await new Promise<void>(resolve => {
        const changed = () => {
          samples.push(pose());
          if (samples.length === 6) { controls.removeEventListener('change', changed); resolve(); }
        };
        controls.addEventListener('change', changed);
      });
      return samples;
    }
    return { uninterrupted: await trace(false), turnover: await trace(true) };
  }, [worker('leaving'), worker('joining')]);
  expect(uninterrupted[2].target).not.toEqual(uninterrupted[1].target); // Damping really moved the pan target.
  for (const [i, sample] of uninterrupted.entries()) expectPose(turnover[i], sample, `damped sample ${i}`);
});

test('turnover leaves an existing focus flight and its mid-flight zoom intact', async ({ page }) => {
  const roster = [worker('outgoing'), worker('incoming')];
  const result = await page.evaluate(async ([a, b]) => {
    const { office, controls, pose } = window.cameraTest;
    office.update([a]); const start = pose();
    office.focus('general');
    await new Promise<void>(resolve => {
      const moved = () => { controls.removeEventListener('change', moved); resolve(); };
      controls.addEventListener('change', moved);
    });
    office.zoom(1); const mid = pose();
    office.update([b]); const after = pose();
    office.setMotion(false); // Only a still-active flight settles at its destination on pause.
    return { start, mid, after, settled: pose() };
  }, roster);
  const destination = fitted(roster.slice(1), 'general');
  expect(result.mid.target[2]).toBeGreaterThan(result.start.target[2]);
  expect(result.mid.target[2]).toBeLessThan(destination.target[2]);
  expect(result.after).toEqual(result.mid);
  expectPose(result.settled, { ...destination, zoom: 1.16 }, 'original flight destination');
});

test('first layout, explicit focus, reset, and canvas resize still frame the requested view', async ({ page }) => {
  const agents = [worker('one')];
  const result = await page.evaluate(agents => {
    const { office, controls, canvas, pose } = window.cameraTest;
    // One worker has the same bounds as the empty startup campus. Even so, the first layout must fit instantly.
    office.setMotion(false); controls.pan(20, 6); office.zoom(1); office.setMotion(true);
    office.update(agents); const first = pose();
    office.setMotion(false); office.zoom(1); office.focus('general'); const focus = pose();
    controls.rotateLeft(.3); controls.pan(14, 6); office.zoom(1); office.reset(); const reset = pose();
    controls.pan(-11, 7); office.zoom(1);
    canvas.style.width = '220px'; canvas.style.height = '400px'; // Real ResizeObserver, no roster update.
    return { first, focus, reset };
  }, agents);
  expectPose(result.first, fitted(agents, 'all'), 'first layout');
  expectPose(result.focus, fitted(agents, 'general'), 'explicit focus');
  expectPose(result.reset, fitted(agents, 'general'), 'reset within focused room');
  const portrait = fitted(agents, 'general', 220, 400);
  await expect.poll(() => page.evaluate(() => window.cameraTest.pose().aspect)).toBe(portrait.aspect);
  expectPose(await page.evaluate(() => window.cameraTest.pose()), portrait, 'portrait resize');
});

test('layout-driven fits follow the viewed bounds rather than every room footprint', async ({ page }) => {
  const general = Array.from({ length: 5 }, (_, i) => worker(`general-${i}`));
  const studio = Array.from({ length: 11 }, (_, i) => worker(`studio-${i}`, 'studio'));
  const result = await page.evaluate(({ general, studio }) => {
    const { office, controls, pose } = window.cameraTest;
    office.setMotion(false); office.update(general.slice(0, 1));
    controls.pan(10, 12); office.zoom(1); const manual = pose();
    office.update(general); const unchanged = pose(); // Wider center room, same outer campus bounds.
    office.focus('general'); office.zoom(1);
    office.update(general.slice(0, 1)); const room = pose(); // Same campus, smaller viewed room.
    office.focus('all'); office.zoom(1);
    office.update([...general, ...studio]); const all = pose(); // New annex extends the viewed campus.
    return { manual, unchanged, room, all };
  }, { general, studio });
  expect(result.unchanged).toEqual(result.manual);
  expectPose(result.room, fitted(general.slice(0, 1), 'general'), 'changed focused footprint');
  expectPose(result.all, fitted([...general, ...studio], 'all'), 'changed overview footprint');
});
