import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { OfficeAgent, Team } from '../domain/types.ts';
import { Assets, createRoom, type RoomModel } from './room.ts';
import { Character } from './character.ts';
import { createCourtyard } from './courtyard.ts';
import { pixelRatioFor } from './camera.ts';
import { planCampus, boundsFor, ROOM_TITLES, type CampusView } from './campus.ts';
import { campusCamera } from './campus-camera.ts';
import { PALETTE as P } from './palette.ts';
import { createMemoryField } from './memory-field.ts';
import { createFiberField } from './fibers.ts';
import { createSpatialGlass } from './spatial-glass.ts';
import { createDataTrails, type TrailSubject } from './data-trails.ts';

export interface OfficeEngine {
  update(agents: OfficeAgent[]): void;
  focus(view: CampusView): void;
  select(id: string | null): void;
  setNight(value: boolean): void;
  setMotion(value: boolean): void;
  zoom(direction: number): void;
  reset(): void;
  dispose(): void;
}
export interface RoomProjection { id: string; team: Team; title: string; total: number; working: number; x: number; y: number; visible: boolean; }
export function createOffice(canvas: HTMLCanvasElement, options: { onSelect: (id: string | null) => void; onError: (message: string) => void; interactive: boolean; onRooms?: (rooms: RoomProjection[]) => void }): OfficeEngine {
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power' });
  renderer.info.autoReset = false;
  renderer.setClearColor(0, 0); renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.1;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap; renderer.shadowMap.autoUpdate = false;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(P.void);
  scene.fog = new THREE.Fog(P.void,70,180);
  const camera = new THREE.PerspectiveCamera(34, 16/9, .1, 2000);
  const initialPosition = new THREE.Vector3(32, 55, 65); const target = new THREE.Vector3(0, 1.2, 6);
  camera.position.copy(initialPosition); camera.lookAt(target);
  const controls = new OrbitControls(camera, canvas);
  controls.target.copy(target); controls.enablePan = false; controls.enableDamping = true; controls.dampingFactor = .12;
  controls.minPolarAngle = .55; controls.maxPolarAngle = 1.32;
  const angle = Math.atan2(32, 65); controls.minAzimuthAngle = angle - 1.1; controls.maxAzimuthAngle = angle + 1.1;
  controls.minZoom = .7; controls.maxZoom = 2.4; controls.minDistance = 8; controls.maxDistance = 250; controls.zoomSpeed = .65; controls.enabled = options.interactive; controls.update();
  const ambient = new THREE.HemisphereLight(P.ice, P.metal, .78); scene.add(ambient);
  const sun = new THREE.DirectionalLight(P.azure, 1.05); sun.position.set(-1, 11, 1); sun.castShadow = true;
  sun.shadow.mapSize.set(1536, 1536); sun.shadow.camera.left = -12; sun.shadow.camera.right = 12; sun.shadow.camera.top = 10; sun.shadow.camera.bottom = -10;
  sun.shadow.camera.near = .1; sun.shadow.camera.far = 35; sun.shadow.normalBias = .045; sun.shadow.bias = -.00025; sun.shadow.radius = 3; scene.add(sun);
  const a = new Assets(); let courtyard = createCourtyard(a); scene.add(courtyard.group);
  let plan = planCampus([]), rosterSignature = '', focused: CampusView = 'all';
  const rooms = new Map<string,RoomModel>();
  let memory = createMemoryField([]); scene.add(memory.group);
  const fibers = createFiberField(); scene.add(fibers.group);
  const glass = createSpatialGlass(renderer,camera,[courtyard.group,memory.group],a.glass);
  const trails = createDataTrails(128);scene.add(trails.points);
  let trailSubjects: TrailSubject[] = [];const towardCamera = new THREE.Vector3();
  const shadowTexture = a.texture(64, 64, ctx => { const gradient = ctx.createRadialGradient(32, 32, 2, 32, 32, 32); gradient.addColorStop(0, 'rgba(0,3,15,.85)'); gradient.addColorStop(1, 'rgba(0,3,15,0)'); ctx.fillStyle = gradient; ctx.fillRect(0, 0, 64, 64); });
  // A single soft shadow anchors the diorama without another render target.
  const groundMaterial = new THREE.MeshBasicMaterial({ map: shadowTexture, transparent: true, opacity: .05, depthWrite: false });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(42, 49), groundMaterial); ground.rotation.x = -Math.PI / 2; ground.position.set(0,-.43,6); scene.add(ground);
  const characters = new Map<string, Character>();
  let selected: string | null = null, disposed = false, motion = true, intersecting = true, dirty = true;
  const media = window.matchMedia('(prefers-reduced-motion: reduce)');
  const reduced = () => media.matches || !motion;
  const desiredPosition = new THREE.Vector3(), desiredTarget = new THREE.Vector3();
  let flying = false, firstLayout = true, labelsAt = -Infinity;
  function settleFlight() {
    if(!flying)return;
    flying=false;
    camera.position.copy(desiredPosition);controls.target.copy(desiredTarget);
    controls.update();dirty=true;projectRooms();
  }
  function fitView(instant = false) {
    const rect=canvas.getBoundingClientRect();
    const visible=focused==='all'?plan.rooms:plan.rooms.filter(r=>r.team===focused);
    const pose=campusCamera(boundsFor(visible),rect.width,rect.height);
    desiredPosition.fromArray(pose.position);desiredTarget.fromArray(pose.target);
    camera.fov=pose.fov;camera.aspect=pose.aspect;camera.zoom=1;camera.updateProjectionMatrix();
    controls.minDistance=Math.max(6,pose.distance*.35);controls.maxDistance=Math.max(250,pose.distance*2);
    (scene.fog as THREE.Fog).near=pose.distance*.85;(scene.fog as THREE.Fog).far=pose.distance+100;
    flying=!(instant||reduced());
    if(!flying){camera.position.copy(desiredPosition);controls.target.copy(desiredTarget);controls.update();}
    dirty=true;
  }
  controls.addEventListener('start',()=>{flying=false;});
  const labelPoint=new THREE.Vector3();
  function projectRooms() {
    const assignments=JSON.stringify([...characters.values()].map(c=>({id:c.agent.id,team:c.agent.team,state:c.agent.state,seat:c.seat.kind,pose:c.root.userData.inactivePose??null,x:c.root.position.x,z:c.root.position.z})));
    if(canvas.dataset.assignments!==assignments)canvas.dataset.assignments=assignments;
    if(!options.onRooms)return;
    const rect=canvas.getBoundingClientRect();camera.updateMatrixWorld();
    options.onRooms(plan.rooms.map(room=>{
      labelPoint.set(room.x,0,room.z+5.8).project(camera);
      return {id:room.id,team:room.team,title:ROOM_TITLES[room.team],total:room.agents.length,working:room.agents.filter(a=>a.state==='working').length,
        x:(labelPoint.x+1)*rect.width/2,y:(1-labelPoint.y)*rect.height/2,
        visible:labelPoint.z<1&&Math.abs(labelPoint.x)<.92&&Math.abs(labelPoint.y)<.89&&(focused==='all'||room.team===focused)};
    }));
  }
  const raycaster = new THREE.Raycaster(); const pointer = new THREE.Vector2();
  const cursor = new THREE.Vector2(); let cursorActive = false;
  let visualTime = 0;
  let pointerDown = { x: 0, y: 0 }; let lastFrame = 0; let frames = 0; let statsAt = performance.now();
  function resize() {
    if (disposed) return; const rect = canvas.getBoundingClientRect(); if (rect.width <= 0 || rect.height <= 0) return;
    cursorActive = false;
    fitView(true);
    renderer.setPixelRatio(pixelRatioFor(rect.width, rect.height, window.devicePixelRatio || 1)); renderer.setSize(rect.width, rect.height, false);glass.resize(rect.width,rect.height); memory.setPixelRatio(renderer.getPixelRatio()); courtyard.setPixelRatio(renderer.getPixelRatio()); dirty = true;
  }
  const resizeObserver = new ResizeObserver(resize); resizeObserver.observe(canvas);
  const intersectionObserver = new IntersectionObserver(entries => { intersecting = entries[0].isIntersecting; schedule(); }, { threshold: .01 }); intersectionObserver.observe(canvas);
  function frame(now: number) {
    if (disposed) return;
    // Thirty deliberate frames per second suits the retro art and halves background work.
    if (now - lastFrame < 1000 / 30 - 1) return;
    const dt = Math.min((now - lastFrame) / 1000 || 0, .06); lastFrame = now;
    if(flying){const mix=1-Math.exp(-dt*5);camera.position.lerp(desiredPosition,mix);controls.target.lerp(desiredTarget,mix);if(camera.position.distanceTo(desiredPosition)<.03){camera.position.copy(desiredPosition);controls.target.copy(desiredTarget);flying=false;}}
    const cameraChanged = controls.update() || flying; const moving = [...characters.values()].some(c => c.path.length > 0);
    if (reduced() && !dirty && !cameraChanged && !moving) return;
    if (!reduced()) visualTime += dt;
    memory.tick(visualTime,reduced()); courtyard.tick(visualTime,reduced());
    canvas.dataset.memoryPoints = String(memory.pointCount+courtyard.pointCount); canvas.dataset.memoryTime = visualTime.toFixed(3); canvas.dataset.projection = 'perspective';
    fibers.tick(visualTime, reduced()); a.tickHolograms(visualTime, reduced());
    canvas.dataset.fiberTime = visualTime.toFixed(3);
    let firstCouch: Character | undefined; let following = 0;
    const activeCursor = cursorActive && !reduced() ? cursor : null;
    characters.forEach(c => {
      const tracking = c.lookAtCursor(activeCursor, camera);
      c.tick(visualTime, dt, reduced());
      if (c.seat.kind === 'couch' && !c.path.length) firstCouch ??= c;
      if (tracking) following++;
    });
    canvas.dataset.gazeTracking = String(following);
    canvas.dataset.gazeYaw = (firstCouch?.head.rotation.y ?? 0).toFixed(4);
    canvas.dataset.gazePitch = (firstCouch?.head.rotation.x ?? 0).toFixed(4);
    camera.getWorldDirection(towardCamera).negate();trails.setView(towardCamera,renderer.getPixelRatio());
    trails.update(visualTime,trailSubjects,reduced());
    renderer.info.reset();
    const capture = glass.render(visualTime,dirty || cameraChanged);
    renderer.render(scene, camera); dirty = false; frames++;
    if(reduced()||now-labelsAt>=140){projectRooms();labelsAt=now;}
    canvas.dataset.glassReady = String(a.glass.ready.value);canvas.dataset.glassPixels = String(capture.pixels);
    canvas.dataset.dataTrails = String(trails.active);canvas.dataset.glassDrawCalls = String(capture.calls);
    if (now - statsAt >= 1000) { canvas.dataset.fps = String(Math.round(frames * 1000 / (now - statsAt))); canvas.dataset.drawCalls = String(renderer.info.render.calls); canvas.dataset.triangles = String(renderer.info.render.triangles-capture.triangles);canvas.dataset.totalTriangles = String(renderer.info.render.triangles); frames = 0; statsAt = now; }
  }
  function schedule() { if (disposed) return; lastFrame = 0; dirty = true; renderer.setAnimationLoop(!document.hidden && intersecting ? frame : null); }
  function onVisibility() { if (document.hidden) cursorActive = false; schedule(); }
  function onMediaChange() { controls.enableDamping = !reduced(); if (reduced()) { cursorActive = false; settleFlight(); } dirty = true; }
  function onLeave() { cursorActive = false; }
  function onMove(e: PointerEvent) {
    if (reduced() || e.pointerType === 'touch' || e.buttons) { onLeave(); return; }
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) { onLeave(); return; }
    cursor.set((e.clientX - rect.left) / rect.width * 2 - 1, -(e.clientY - rect.top) / rect.height * 2 + 1);
    cursorActive = true;
    // Normal animation already renders at 30Hz. Do not mark glass capture dirty on pointer movement.
  }
  function onDown(e: PointerEvent) { onLeave(); pointerDown = { x: e.clientX, y: e.clientY }; }
  function onUp(e: PointerEvent) {
    if (!options.interactive || Math.hypot(e.clientX - pointerDown.x, e.clientY - pointerDown.y) > 7) return;
    const rect = canvas.getBoundingClientRect(); pointer.set((e.clientX - rect.left) / rect.width * 2 - 1, -(e.clientY - rect.top) / rect.height * 2 + 1);
    raycaster.setFromCamera(pointer, camera); const hit = raycaster.intersectObjects([...characters.values()].map(c => c.pick), false)[0];
    options.onSelect(hit ? String(hit.object.userData.agentId) : null);
  }
  function onKey(e: KeyboardEvent) {
    if (!options.interactive) return;
    if (e.key === '+' || e.key === '=') { api.zoom(1); e.preventDefault(); }
    if (e.key === '-') { api.zoom(-1); e.preventDefault(); }
    if (e.key === 'Home') { api.reset(); e.preventDefault(); }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { const spherical = new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target)); spherical.theta += e.key === 'ArrowLeft' ? -.1 : .1; camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(spherical)); dirty = true; e.preventDefault(); }
  }
  function onContextLost(e: Event) { e.preventDefault(); renderer.setAnimationLoop(null); options.onError('The 3D view was interrupted. Reload to restore it; your roster is still available.'); }
  controls.addEventListener('change', () => { dirty = true; });
  canvas.addEventListener('pointerdown', onDown); canvas.addEventListener('pointerup', onUp); canvas.addEventListener('keydown', onKey); canvas.addEventListener('webglcontextlost', onContextLost);
  if (options.interactive) { canvas.addEventListener('pointermove', onMove, { passive: true }); canvas.addEventListener('pointerleave', onLeave); canvas.addEventListener('pointercancel', onLeave); }
  document.addEventListener('visibilitychange', onVisibility); media.addEventListener('change', onMediaChange);
  const api: OfficeEngine = {
    update(agents) {
      plan=planCampus(agents);
      const signature=plan.assignments.map(x=>`${x.roomId}:${x.agent.id}:${x.slot}`).join('|');
      const rosterChanged=signature!==rosterSignature||!rooms.size;
      if(rosterChanged){
        characters.forEach(c=>{c.root.removeFromParent();c.dispose();});characters.clear();
        rooms.forEach(room=>{scene.remove(room.group);room.dispose();});rooms.clear();
        for(const spec of plan.rooms){const room=createRoom(a,{team:spec.team,count:spec.agents.length});room.group.position.set(spec.x,0,spec.z);rooms.set(spec.id,room);scene.add(room.group);}
        scene.remove(courtyard.group);courtyard.dispose();
        const bounds=plan.bounds;
        courtyard=createCourtyard(a,{width:bounds.maxX-bounds.minX,depth:bounds.maxZ-bounds.minZ});
        courtyard.group.position.set((bounds.minX+bounds.maxX)/2,0,(bounds.minZ+bounds.maxZ)/2);scene.add(courtyard.group);
        scene.remove(memory.group);memory.dispose();memory=createMemoryField([...rooms.values()].map(r=>r.group),28000);scene.add(memory.group);
        memory.setPixelRatio(renderer.getPixelRatio());courtyard.setPixelRatio(renderer.getPixelRatio());
        rosterSignature=signature;
      }
      for(const assignment of plan.assignments){
        const {agent,slot,roomId}=assignment,room=rooms.get(roomId)!;
        const existing=characters.get(agent.id);
        if(existing)existing.update(agent,slot,reduced());
        else{const c=new Character(a,agent,slot,shadowTexture,room.screens.length);characters.set(agent.id,c);room.group.add(c.root);}
        room.screens[slot].material=['working','waiting','blocked'].includes(agent.state)?room.screenOn:room.screenOff;
      }
      if(rosterChanged){glass.setSources([...rooms.values()].map(r=>r.group).concat([courtyard.group,memory.group]));trailSubjects=[...characters.values()].map(c=>({head:c.head,hands:c.hands}));fitView(firstLayout);firstLayout=false;}
      api.select(selected); dirty = true; canvas.dataset.agents = String(characters.size);
      canvas.dataset.rooms=String(rooms.size);canvas.dataset.focus=focused;
      projectRooms();
    },
    focus(view){if(focused===view)return;focused=view;canvas.dataset.focus=view;cursorActive=false;fitView();projectRooms();},
    select(id) { selected = id; characters.forEach(c => c.select(c.agent.id === id)); dirty = true; },
    setNight(value) {
      const sky = value ? P.night : P.void;
      (scene.background as THREE.Color).set(sky);
      (scene.fog as THREE.Fog).color.set(sky);
      ambient.color.set(value ? P.azure : P.ice); ambient.intensity = value ? .5 : .78; sun.color.set(P.azure); sun.intensity = value ? .65 : 1.05; renderer.toneMappingExposure = value ? .9 : 1.1; renderer.shadowMap.needsUpdate = true; dirty = true; },
    setMotion(value) { motion = value; controls.enableDamping = !reduced(); if (reduced()) { cursorActive = false; settleFlight(); characters.forEach(c => { c.path = []; c.root.position.set(c.seat.x, 0, c.seat.z); c.tick(0, 0, true); }); } dirty = true; },
    zoom(direction) { camera.zoom = THREE.MathUtils.clamp(camera.zoom * (direction > 0 ? 1.16 : 1 / 1.16), .7, 2.1); camera.updateProjectionMatrix(); dirty = true; },
    reset() { fitView(); },
    dispose() {
      disposed = true; renderer.setAnimationLoop(null); resizeObserver.disconnect(); intersectionObserver.disconnect(); controls.dispose();
      document.removeEventListener('visibilitychange', onVisibility); media.removeEventListener('change', onMediaChange);
      canvas.removeEventListener('pointermove', onMove); canvas.removeEventListener('pointerleave', onLeave); canvas.removeEventListener('pointercancel', onLeave);
      canvas.removeEventListener('pointerdown', onDown); canvas.removeEventListener('pointerup', onUp); canvas.removeEventListener('keydown', onKey); canvas.removeEventListener('webglcontextlost', onContextLost);
      characters.forEach(c => c.dispose()); characters.clear(); glass.dispose();trails.dispose();memory.dispose();rooms.forEach(room=>room.dispose());rooms.clear(); courtyard.dispose(); fibers.dispose(); ground.geometry.dispose(); groundMaterial.dispose(); a.dispose(); renderer.dispose(); renderer.forceContextLoss();
    },
  };
  resize(); renderer.shadowMap.needsUpdate = true; schedule(); return api;
}
