# Office Hours

A standalone, local-first, full-screen SolidJS + Three.js experience for observing all Hermes swarms in one campus. The scene is the entire surface, not a website or dashboard; controls live in floating pop-ups. This project is independent of `mikeangeloart`; it does not change the portfolio or use port 3002.

## Run

```sh
npm ci
npm run dev
```

Open `http://127.0.0.1:3010`.

- `/` — live, read-only profile observations; first visit opens the whole campus. Later visits remember the selected focus.
- `/?source=demo` — explicitly simulated activity. Open **Status → Next demo state** to exercise desk/couch transitions without starting agents.
- `/?embed=1` — scene only: no dock, panels, branding, visible loaders/error controls, keyboard focus or private telemetry requests. It always selects demo data, even if `source=live` is also supplied.
- `/?view=embedded` and the older `/?view=hero` are aliases of the same UI-free embedded scene.
- `?team=general` opens **General sessions**, with your default **Hermes** instance. The character aggregates verified in-flight general sessions; it does not count retained chats or expose titles/content. The Status panel distinguishes the local bridge connection from runtime-evidence coverage.
- `?team=all` restores the overview. `?team=development` (also `studio`, `game`, `science`) focuses a specialist room without removing the other swarms. An explicit URL choice takes precedence over saved focus.

The existing development instance is on port **5000**; package scripts default to 3010. To test that running instance, use `OFFICE_BASE_URL=http://127.0.0.1:5000 npm run test:e2e`.

The Node server needs Python 3.12+ with standard-library SQLite. Set `PYTHON_BIN` to an executable path if `python3` is not on PATH. Python 3.14.9 and Node 25.1.0 were used locally. `HERMES_HOME` selects the existing Hermes home; the bridge also understands the standard Windows and POSIX locations. No additional Python packages are required.

```sh
npm run build
npm run preview
```

`dist/` is the production frontend. Vite preview includes the same local bridge; a static-only deployment has **no live API**. This is not yet an authenticated Mesh deployment or a public assistant.

## Architecture

- `src/Experience.tsx` — full-viewport composition and standalone-only native-dialog panels. `App.tsx` is the entry export.
- `src/domain/` — typed status contract, staleness policy, deterministic fixtures and the explicit embedded/private-data presentation boundary.
- `src/scene/` — framework-independent Three.js renderer, capacity-aware campus planning and camera, instanced rooms, shared primitive/material ownership, signal-being rigs and aisle routes.
- `src/components/OfficeScene.tsx` — Solid lifecycle boundary; lazy-loads and disposes the renderer. No Hermes/file/network access in the scene.
- `src/lib/status.ts` — same-origin client, 30-second polling, abort/timeout, visibility recovery and explicit source modes.
- `bridge/collect.py` — fixed local collector; SQLite URI `mode=ro`, `query_only`, restricted column authorizer, bounded reads, safe metadata projection. It never imports or starts Hermes.
- `server/office-api.ts` — Node-only plugin for development/preview; bounded fixed subprocess, shared five-second cache, inflight deduplication and strict payload validation. GET only; local host/origin checks; no CORS.

## Interaction and performance

The world fills the browser viewport at every size. The compact dock is icon-first: **grid** restores all rooms, **people** opens Team, **sliders** opens View, **pulse** opens Status, **four corners** toggles full screen, and **information** opens About. Hover or keyboard-focus an icon to read its label. The small `DEMO`/`LIVE` badge remains visible intentionally so simulated activity cannot be mistaken for native work. Room markers show actual working/total counts; the heading explicitly labels campus-wide activity.

Panels have the same four-symbol navigation rail plus Close. Room selectors use distinct conversation/pen/code/gamepad/flask glyphs with count badges; camera, lighting, animation, source selection, refresh and demo-step actions use icon controls. Agent names, actual state values, connection facts and help remain text where clarity matters. Controls have at least 44px touch targets and activate on the first tap. Tab focuses controls; Left/Right/Home/End move within an icon toolbar. Escape dismisses tooltips or closes the native dialog and restores its opener. Embedded mode mounts none of these controls or tooltip listeners.

`src/ui/controls.ts` is the shared icon/label vocabulary. `src/components/IconControl.tsx` supplies accessible names, a single tooltip owner, pointer/keyboard labeling and dismissal. Badged controls include their visible counts in their accessible names. The dock is explicitly inert/hidden from the accessibility tree while a modal panel is open. The full-screen button uses a trusted click; a denied request explains the fallback inside View. No site header, sidebar, footer or marketing layout is added.

Drag to orbit; scroll/pinch to zoom. With the canvas focused, use arrow keys, +/− and Home. Inactive signal beings follow the mouse with eased, bounded lens yaw/pitch relative to each lens's screen position. Their bodies keep the room-specific resting pose; desk and travelling poses ignore it. Leaving the canvas or dragging releases the gaze. Pause and reduced-motion disable tracking, and pointer-inert embedded scenes do not register these listeners. Cursor movement uses the existing 30Hz loop without forcing extra glass captures. The perspective camera fits actual campus or room bounds on desktop, portrait and short embeds. Use a room marker to move closer on small screens.

All observed agents remain in the scene: the current roster has 33 across five swarm rooms. Focusing changes the camera and roster filter, not membership. Each room has up to ten seats, with overflow rooms rather than silent truncation. Small rooms have centered seats. Geometry/materials are shared; static furniture is instanced. The renderer caps DPR and the **main** framebuffer at three million pixels, targets 30 deliberate frames per second, pauses offscreen/when the document is hidden, respects reduced motion, and releases its WebGL resources on unmount. The shared frost capture has its own additional bounded budget below. The roster remains usable if WebGL is unavailable. No external models, textures, fonts, analytics or inference calls are required.

| Swarm | Room | Inactive representation |
|---|---|---|
| Creative Studio | Atelier | Reclined lounge shell |
| Development | Systems bay | Upright dock, folded manipulators/fins |
| Game Development | Play lab | Forward lean and controller gesture |
| Science channel | Observatory | Elevated, open meditation pose |
| General sessions | Quiet core | Quiet resting hover |

These are stylized representations, not inferred real tasks. Working, waiting and blocked observations occupy desks; idle, paused and offline observations use the relevant rest area. Names and actual states remain readable in the inspector.

### Reconstructed memory-space

The environment is an incomplete spatial recording, not a miniature game park. Agents are nonhuman faceted shells with compact lenses, asymmetric fins and detached manipulators: nine shared-primitive visible parts per agent. Their silhouettes remain solid enough to read at overview scale while the environment breaks apart.

- `memory-field.ts` area-samples up to **28,000 points from actual static room surfaces** in the integrated campus, with fine vertical reconstruction streaks. `reconstruction-density.ts` creates coherent islands, multi-meter voids and directional tears instead of uniform scatter. `courtyard.ts` supplies up to **10,000 asymmetric residual returns** outside the campus footprint and five broken structural members. These are procedural scene geometry, not native process memory, agent content or invented telemetry.
- Environment shaders have fine world-space column dropouts and thin scan gaps. Signal-being shells and screens remain legible, while glass keeps its filtered capture. Dark gaps and saturated blue signals replace the pastel/toy treatment.
- `campus-camera.ts` fits actual room bounds for desktop, portrait and short banners. `fibers.ts` emits interrupted vertical scan traces and registration fragments instead of decorative orbital rings and a tiled grid.
- Surface/space buffers are deterministic and fixed after construction; animation changes uniforms. Both fields freeze for pause/reduced motion and dispose their owned geometry/materials. Frosted capture also includes explicitly opted-in scan points/lines, borrowing their buffers/materials without disposing them.
- The pre-campus source is preserved in `artifacts/versions/before-campus-20261104-135117.zip`. Campus screenshots are under `artifacts/screenshots/campus-*`; browser test receipts are under `artifacts/verification/`.

### Blue signal palette

`src/scene/palette.ts` uses the portfolio's actual `#3366ff` accent (from `mikeangeloart/src/three/SceneManager.tsx`) with near-black/deep-blue materials. Shared materials have explicit signal roles: agents are brightest, active screens are secondary, and environment objects retain a faint edge/rim/fragment glow over quieter bodies. `fibers.ts` interprets Edgar's connected-contour/travelling-highlight language as a deterministic 3D field. The reference projects are not modified.

### Cyber glass and spatial depth

- The floating dock/dialogs use translucent blue-black glazing, 24–26px backdrop blur, fine illuminated borders and subtle registration/scan textures. Native focus/Escape behavior, readable text, 44px controls and an opaque fallback remain intact.
- `spatial-glass.ts` supplies real background filtering to glass walls/windows and desk surfaces. A simplified-lighting capture of **actual world geometry and current poses** is instanced by primitive; glass is excluded from its own capture. A single mipmapped target uses at most 160,000 base pixels (plus mip levels), refreshes up to 12 Hz, and refreshes immediately for camera changes. The shader samples blurred mip levels with slight normal-based refraction/dispersion. This is stylized **screen-space** refraction, not ray-traced multilayer glass or physical transmission. No full-frame bloom is used.
- `data-trails.ts` adds one bounded point draw for soft signal halos and short movement afterimages anchored to real head/hand positions. It does not invent work, duplicate characters, or smear the entire screen. Pause clears detached trails and freezes effects; buffers/materials/capture targets are disposed with the engine.
- Renderer counters include capture draw calls. `data-triangles` is the main pass; `data-total-triangles` includes the extra capture when present. Browser regression budgets for the 33-agent campus are below 500 combined overview draw calls, 18,000 main-pass triangles and 34,000 capture-inclusive triangles. Focused-room tests retain the 360-draw budget. Initial cached-shadow/upload work is separate from steady state. Main framebuffer and capture pixels are both bounded.
- The isolated `/tests/fixtures/spatial-glass.html` development fixture measures high-frequency pixel contrast **and nonblack brightness**, preventing a dark overlay from passing as blurred transmission. It is not part of the production bundle.

World-space geometry tests cover distinct resting transforms, every slot, furniture clearance, keyboard reach, translated-room gaze, aisle routes, reduced-motion settling and shared-resource disposal. Nonhuman shells have no hidden human armature.

## Local embedding preview

Use `http://127.0.0.1:3010/?embed=1` as an iframe source for local integration previews. The iframe must have an explicit width and height; its own viewport is filled edge-to-edge. For a decorative background, set the host iframe to `tabindex="-1"` and `pointer-events:none` so it does not intercept page scrolling. Remote deployment must use an approved hosted scene URL, not localhost or the private telemetry endpoint. No changes were made to the portfolio.

The prior page layout is preserved under `.local/baseline-v0.1/` for reference.

## What "live" means

Live mode reads the **real roster and available local runtime evidence**, not simulated activity:

- Working requires an unexpired turn lease held by a live process, or a fresh matching current-generation worker execution. The default profile is read from the native root home, not a `profiles/default` directory.
- Idle means the native runtime tables were readable and contained no active or uncertain work claims. This means **inactive**, not that a model or permanent per-profile process is running. Fresh multiplexer metadata supplies separate backend-availability evidence; it is never treated as proof of work.
- ESTOP is reported as paused for new work; a genuinely active existing turn remains working.
- Missing/incompatible status storage, uncertain claims, and stale known backend evidence remain **offline/uncertain**, not invented activity.
- The default Hermes character aggregates verified in-flight sessions. Retained chats, old messages, window counts and fleet-wide `active_agents` are not session counts. Ambiguous compression lineage omits the total instead of guessing or double-counting.
- Client observations and their active-session counts expire after two minutes without successful updates.

Input-waiting and blocked states are demonstrated in demo mode, but the SQL collector does **not** infer these from conversation content. Native runtime event integration and an explicitly authorized real-job transition test remain future work. Current paused/unloaded teams may therefore appear offline; the app does not resume them to manufacture activity.

No task titles, prompt/message bodies, private paths, credentials or model outputs are included. Read-only means SQL reads with writes denied, not filesystem-immutable access: SQLite may create or update WAL/SHM sidecar files while reading a WAL-mode store, even though the main database is not modified. A strict zero-filesystem-write guarantee is not provided. The endpoint is intentionally loopback-only, not a public API. Before Mesh/public hosting, add a separately reviewed authenticated deployment and explicit public-data projection. A hostname, UI toggle or new Hermes profile is not a security sandbox.

## Checks

```sh
npm test
npm run test:bridge
npm run test:e2e
npm run build
```

Browser tests use installed Google Chrome through Playwright (no automatic browser download), software WebGL for CI reproducibility, and a single worker to avoid competing software-renderer contexts. Start the dev server first. They cover desktop/mobile interaction, contrast/accessibility, live read-only API behavior and full-viewport canvas coverage, panel focus/keyboard behavior, rendering budgets and absence of all UI/private requests in embedded mode. Browser/mobile emulation is not physical-device testing.

## Deliberately not included

No bot jobs, profile changes, gateway restart, portfolio edits, remote deployment, public chat/model access or credentials. Future work: richer original models, broader runtime events, Mesh authentication/always-on hosting and an isolated public guide backed only by approved personal facts.
