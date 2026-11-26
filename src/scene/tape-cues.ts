import * as THREE from 'three';
import type { SceneTape, TraceActor } from '../domain/trace.ts';
import type { Character } from './character.ts';
import type { CampusView } from './campus.ts';
import type { Assets } from './room.ts';

const WIDTH = 94, HEIGHT = 29, MAX_LABELS = 3;
const TOOL = 'Tool pulse', LINK = 'Link active';

/** This is a short illustration of a sample, not a claim about the timing or content of a tool call. */
export function inCueWindow(tape: SceneTape, atMs: number) {
  if (tape.sampleAtMs === undefined) return false; // Presence without a dated sample cannot date an event.
  const age = atMs - tape.sampleAtMs;
  return age >= 0 && age < 4800;
}

function captionMaterial(assets: Assets, caption: typeof TOOL | typeof LINK) {
  const pulse = caption === TOOL, ink = pulse ? '#79efda' : '#ccbdff';
  const map = assets.texture(256, 80, ctx => {
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    // A cut-corner instrument tag and pointer rather than a dialogue balloon.
    ctx.beginPath(); ctx.moveTo(12,75); ctx.lineTo(26,57); ctx.lineTo(40,57);
    ctx.strokeStyle = ink; ctx.lineWidth = 3; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(20,4); ctx.lineTo(242,4); ctx.lineTo(251,13); ctx.lineTo(251,51);
    ctx.lineTo(244,57); ctx.lineTo(20,57); ctx.closePath();
    ctx.fillStyle = pulse ? '#0a1d30' : '#191a34'; ctx.fill(); ctx.lineWidth = 2.5; ctx.strokeStyle = pulse ? '#51a99f' : '#9b8bc4'; ctx.stroke();
    ctx.strokeStyle = ink; ctx.lineWidth = 4; ctx.beginPath();
    if (pulse) { ctx.moveTo(30,33); ctx.lineTo(38,33); ctx.lineTo(43,19); ctx.lineTo(48,42); ctx.lineTo(53,29); ctx.lineTo(59,29); }
    else { ctx.moveTo(30,30); ctx.lineTo(38,21); ctx.lineTo(46,30); ctx.lineTo(38,39); ctx.closePath(); ctx.moveTo(44,30); ctx.lineTo(52,21); ctx.lineTo(60,30); ctx.lineTo(52,39); ctx.closePath(); }
    ctx.stroke(); ctx.font = '600 28px system-ui, sans-serif'; ctx.textBaseline = 'middle'; ctx.fillStyle = pulse ? '#e0fbf6' : '#eee9ff'; ctx.fillText(caption,71,29);
  });
  map.name = caption; map.magFilter = THREE.LinearFilter;
  return new THREE.SpriteMaterial({ map, transparent: true, depthWrite: false, depthTest: false, toneMapped: false, fog: false });
}

/** Lazily allocated only for observed cues. A fixed pool, not a DOM overlay or a texture per person. */
export function createTapeCues(assets: Assets) {
  const group = new THREE.Group(); group.name = 'sample-annotations'; group.visible = false;
  const tool = captionMaterial(assets, TOOL), link = captionMaterial(assets, LINK);
  const labels = Array.from({length: MAX_LABELS}, () => {
    const sprite = new THREE.Sprite(tool); sprite.center.set(.05, -.12); sprite.renderOrder = 10; sprite.visible = false;
    group.add(sprite); return {sprite, screen: new THREE.Vector2()};
  });
  const world = new THREE.Vector3(), screen = new THREE.Vector3();
  const dashes = 8, ends = new THREE.BufferAttribute(new Float32Array(dashes*2*3),3).setUsage(THREE.DynamicDrawUsage);
  const geometry = new THREE.BufferGeometry().setAttribute('position',ends);
  const stroke = new THREE.LineBasicMaterial({color:'#c3b6fb', transparent:true, opacity:.85, depthWrite:false, toneMapped:false});
  const wire = new THREE.LineSegments(geometry,stroke); wire.name = 'observed-link'; wire.frustumCulled = false; wire.visible = false; group.add(wire);
  const from = new THREE.Vector3(), to = new THREE.Vector3();
  type Pair = readonly [Character, Character];
  let tools: Character[] = [], pairs: Pair[] = [], used = 0;
  function join([child,parent]: Pair) {
    child.head.getWorldPosition(from); parent.head.getWorldPosition(to); from.y += .22; to.y += .22;
    const arch = Math.min(.65, from.distanceTo(to) * .16);
    for (let i=0; i<dashes*2; i++) {
      const u = i === dashes*2-1 ? 1 : (Math.floor(i/2) + (i%2)*.68) / dashes;
      world.lerpVectors(from,to,u); ends.setXYZ(i,world.x,world.y + 4*u*(1-u)*arch,world.z);
    }
    ends.needsUpdate = true; wire.visible = true;
  }
  function label(c: Character, material: THREE.SpriteMaterial, camera: THREE.PerspectiveCamera, width: number, height: number) {
    if (used === labels.length) return;
    c.head.getWorldPosition(world); world.y += .25;
    screen.copy(world).project(camera);
    const x = (screen.x + 1) * width / 2, y = (1 - screen.y) * height / 2;
    if (screen.z < -1 || screen.z > 1 || x < 5 || x > width - WIDTH || y < HEIGHT + 6 || y > height) return;
    for (let i = 0; i < used; i++) if (Math.abs(x - labels[i].screen.x) < WIDTH && Math.abs(y - labels[i].screen.y) < HEIGHT) return;
    const {sprite, screen: anchor} = labels[used++]; anchor.set(x,y);
    const depth = -screen.copy(world).applyMatrix4(camera.matrixWorldInverse).z;
    const unit = 2 * depth / (height * camera.projectionMatrix.elements[5]);
    sprite.material = material; sprite.position.copy(world); sprite.scale.set(WIDTH * unit, HEIGHT * unit, 1); sprite.visible = true;
  }
  return {
    group,
    bind(actors: readonly TraceActor[], figures: ReadonlyMap<string, Character>) {
      tools = []; pairs = [];
      const seen = new Map<string, Character>();
      // Never use a name, activity string, counter value or unknown signal as a gesture or a caption.
      for (const a of actors) {
        const c = figures.get(a.id);
        if (!c || (a.kind !== 'session' && a.kind !== 'subagent') || a.state !== 'working' || c.agent.state !== a.state || c.agent.team !== a.team || (a.signal !== 'presence' && a.signal !== 'tool')) continue;
        seen.set(a.id,c); if (a.signal === 'tool') tools.push(c);
      }
      tools.sort((a,b) => a.agent.id.localeCompare(b.agent.id));
      const paired = new Set<Character>();
      // At a busy hub one rig cannot face several partners at once. Prefer a stable direct edge.
      for (const a of actors.filter(a => a.parentId).sort((a,b) => a.id.localeCompare(b.id))) {
        const child = seen.get(a.id), parent = seen.get(a.parentId!);
        if (!child || !parent || child === parent || child.agent.team !== parent.agent.team || paired.has(child) || paired.has(parent)) continue;
        paired.add(child); paired.add(parent); pairs.push([child,parent]);
      }
    },
    draw(active: boolean, atMs: number, reduced: boolean, camera: THREE.PerspectiveCamera, width: number, height: number, focus: CampusView) {
      used = 0; wire.visible = false; group.visible = active && (tools.length > 0 || pairs.length > 0);
      if (!group.visible) return;
      camera.updateMatrixWorld();
      for (const c of tools) c.toolPose(atMs,reduced);
      for (const pair of pairs) {
        const [child,parent] = pair;
        child.acknowledge(parent); parent.acknowledge(child);
        if (!wire.visible && (focus === 'all' || focus === child.agent.team)) { join(pair); label(child,link,camera,width,height); }
      }
      for (const c of tools) if (focus === 'all' || focus === c.agent.team) label(c,tool,camera,width,height);
      for (let i = used; i < labels.length; i++) labels[i].sprite.visible = false;
    },
    dispose() { group.removeFromParent(); group.clear(); tool.dispose(); link.dispose(); stroke.dispose(); geometry.dispose(); tools = []; pairs = []; }, // Textures are Assets-owned.
  };
}
