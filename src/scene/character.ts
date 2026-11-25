import * as THREE from 'three';
import type { OfficeAgent, Team } from '../domain/types.ts';
import { agentColor, routeFor, seatFor, type Point, type Seat } from './layout.ts';
import { Assets } from './room.ts';
import { PALETTE as P } from './palette.ts';

// All transforms are room-local. Keep the lowest fragment above .80m so
// lounge cushions, charging perches and rest platforms fit below the rig.
const INACTIVE_POSES = {
  studio:      { name: 'lounge',     height: 1.21, pitch: -.42, forward: .02, hand: [.36, -.07, .36] },
  development: { name: 'docked',     height: 1.17, pitch: 0,    forward: 0,   hand: [.13, -.07, .37] },
  game:        { name: 'controller', height: 1.26, pitch: .24,  forward: .07, hand: [.09, -.04, .46] },
  science:     { name: 'meditative', height: 1.58, pitch: 0,    forward: 0,   hand: [.36, -.14, .32] },
  general:     { name: 'resting',    height: 1.20, pitch: .025, forward: 0,   hand: [.30, -.12, .35] },
} as const satisfies Record<Team, { name: string; height: number; pitch: number; forward: number; hand: readonly [number, number, number] }>;

/** Nine shared-primitive fragments: no armature, skin or grounded feet. */

export class Character {
  root = new THREE.Group(); body = new THREE.Group(); head = new THREE.Group();
  hands: THREE.Mesh[] = [];
  pick: THREE.Mesh; ring: THREE.Mesh; shadow: THREE.Mesh;
  seat: Seat; path: Point[] = []; phase: number; agent: OfficeAgent;
  private capacity: number;
  private disposed = false;
  private ringMaterial: THREE.MeshBasicMaterial;
  private shadowMaterial: THREE.MeshBasicMaterial;
  private fins: THREE.Mesh[] = [];
  private gazeYaw: number | null = null;
  private gazePitch: number | null = null;
  private gazePosition = new THREE.Vector3();
  private gazeCamera = new THREE.Vector3();
  constructor(a: Assets, agent: OfficeAgent, index: number, shadowTexture: THREE.Texture, capacity = 10) {
    this.capacity = capacity;
    this.agent = agent; this.seat = seatFor(index, agent.state, this.capacity); this.phase = index * 1.73;
    this.root.position.set(this.seat.x, 0, this.seat.z); this.root.rotation.y = this.seat.rotation;
    this.root.name = 'signal-being'; this.body.name = 'signal-fragments'; this.head.name = 'signal-lens';
    this.root.add(this.body);
    const part = (name: string, color: string, size: number[], at: number[], kind = 'box', parent: THREE.Object3D = this.body) => {
      const mesh = a.mesh(color, size, at, kind, parent, 'agent'); mesh.name = name; return mesh;
    };
    const shell = part('signal-shell', agentColor(agent.id), [.64, .64, .46], [0, 0, 0], 'cone');
    shell.rotation.z = Math.PI;
    part('signal-core', P.azure, [.055, .20, .035], [.065, .12, .21]).rotation.z = -.17;
    this.head.position.set(0, .49, .025); this.body.add(this.head);
    part('lens-housing', P.metal, [.38, .26, .24], [0, 0, 0], 'cylinder', this.head).rotation.x = Math.PI / 2;
    part('signal-aperture', P.azure, [.29, .024, .155], [0, 0, .143], 'cylinder', this.head).rotation.x = Math.PI / 2;
    part('lens-highlight', P.ice, [.065, .032, .012], [.035, .012, .163], 'box', this.head);
    const left = part('signal-fin-left', P.frame, [.095, .35, .15], [-.35, .13, -.05], 'cone');
    const right = part('signal-fin-right', P.frame, [.085, .19, .12], [.32, .015, -.07], 'cone');
    left.rotation.z = -.35; right.rotation.z = .45; this.fins.push(left, right);
    for (const [i, sign] of [-1, 1].entries()) {
      this.hands.push(part(`manipulator-${i ? 'right' : 'left'}`, P.azure, [.13, .08, .17], [sign * .30, -.12, .35], 'hand'));
    }
    this.pick = new THREE.Mesh(new THREE.BoxGeometry(.94, 2.25, 1.12), new THREE.MeshBasicMaterial({ visible: false }));
    this.pick.position.set(0, 1.16, .15); this.pick.userData.agentId = agent.id; this.root.add(this.pick);
    this.ringMaterial = new THREE.MeshBasicMaterial({ color: P.azure, side: THREE.DoubleSide, transparent: true, opacity: .95, depthWrite: false });
    this.ring = new THREE.Mesh(new THREE.RingGeometry(.52, .59, 24), this.ringMaterial); this.ring.rotation.x = -Math.PI / 2; this.ring.position.y = .125; this.ring.visible = false; this.root.add(this.ring);
    this.shadowMaterial = new THREE.MeshBasicMaterial({ map: shadowTexture, transparent: true, opacity: .3, depthWrite: false });
    this.shadow = new THREE.Mesh(new THREE.PlaneGeometry(1.25, 1.25), this.shadowMaterial); this.shadow.rotation.x = -Math.PI / 2; this.shadow.position.y = .12; this.root.add(this.shadow);
    this.root.traverse(o => { if (o instanceof THREE.Mesh) o.castShadow = false; });
    this.tick(0, 0, true);
  }
  update(agent: OfficeAgent, index: number, reduced: boolean) {
    if (this.disposed) return;
    const next = seatFor(index, agent.state, this.capacity); this.agent = agent;
    if (reduced) { this.seat = next; this.settleAtSeat(); return; }
    if (next.kind !== this.seat.kind) {
      // Preserve the route from the actual position. Rapid toggles can reuse a
      // destination already on that route instead of cutting through furniture.
      const alreadyOnRoute = this.path.findIndex(p => p.x === next.x && p.z === next.z);
      const route = routeFor(this.seat, next).slice(1);
      this.path = alreadyOnRoute >= 0 ? this.path.slice(0, alreadyOnRoute + 1) : [...this.path, ...route];
      this.seat = next;
    }
  }
  private settleAtSeat() {
    this.path = [];
    this.root.position.set(this.seat.x, 0, this.seat.z);
    this.root.rotation.y = this.seat.rotation;
  }
  /** Aim relative to this head's screen position, not the center of the window. */
  lookAtCursor(pointer: THREE.Vector2 | null, camera: THREE.Camera) {
    this.gazeYaw = this.gazePitch = null;
    if (this.disposed || !pointer || this.seat.kind !== 'couch' || this.path.length || !Number.isFinite(pointer.x) || !Number.isFinite(pointer.y)) return false;
    camera.updateWorldMatrix(true, false);
    this.head.getWorldPosition(this.gazePosition).project(camera);
    camera.getWorldPosition(this.gazeCamera); this.root.worldToLocal(this.gazeCamera);
    if (!Number.isFinite(this.gazePosition.x) || !Number.isFinite(this.gazePosition.y)) return false;
    // A small viewer-facing bias makes screen-space tracking read naturally in isometric views.
    const facing = Math.atan2(this.gazeCamera.x, this.gazeCamera.z);
    this.gazeYaw = THREE.MathUtils.clamp(facing * .45 + (pointer.x - this.gazePosition.x) * .45, -.75, .75);
    this.gazePitch = THREE.MathUtils.clamp(.025 - (pointer.y - this.gazePosition.y) * .32, -.32, .32);
    return true;
  }
  tick(time: number, dt: number, reduced: boolean) {
    if (this.disposed) return;
    if (reduced && this.path.length) this.settleAtSeat();
    let walking = this.path.length > 0;
    if (walking) {
      const next = this.path[0]; const dx = next.x - this.root.position.x; const dz = next.z - this.root.position.z; const distance = Math.hypot(dx, dz); const step = dt * 3.1;
      if (distance <= step + .025) { this.root.position.x = next.x; this.root.position.z = next.z; this.path.shift(); walking = this.path.length > 0; }
      else { this.root.position.x += dx / distance * step; this.root.position.z += dz / distance * step; this.root.rotation.y = Math.atan2(dx, dz); }
    }
    if (!walking) this.root.rotation.y = this.seat.rotation;
    const t = reduced ? 0 : time + this.phase; const working = this.agent.state === 'working';
    const inactive = !walking && this.seat.kind === 'couch';
    const pose = INACTIVE_POSES[this.agent.team];
    this.root.userData.inactivePose = inactive ? pose.name : null;
    const hover = !reduced && this.agent.state === 'idle' ? Math.sin(t * 1.5) * (this.agent.team === 'science' ? .024 : .012) : 0;
    this.body.position.set(0, walking ? 1.35 + Math.sin(t * 3) * .025 : inactive ? pose.height + hover : 1.23, inactive ? pose.forward : 0);
    this.body.rotation.set(inactive ? pose.pitch : walking ? .08 : 0, 0, 0);
    const docked = inactive && this.agent.team === 'development';
    const meditative = inactive && this.agent.team === 'science';
    this.fins[0].position.x = docked ? -.24 : meditative ? -.33 : -.35;
    this.fins[1].position.x = docked ? .24 : .32;
    this.fins[0].rotation.z = docked ? -.05 : meditative ? -.65 : -.35;
    this.fins[1].rotation.z = docked ? .06 : meditative ? .55 : .45;
    const restPitch = working ? -.035 : this.seat.kind === 'couch' ? .025 : 0;
    if (!inactive || reduced) { this.head.rotation.y = 0; this.head.rotation.x = restPitch; }
    else {
      const seconds = Number.isFinite(dt) ? THREE.MathUtils.clamp(dt, 0, .1) : 0;
      this.head.rotation.y = THREE.MathUtils.damp(this.head.rotation.y, this.gazeYaw ?? 0, 9, seconds);
      this.head.rotation.x = THREE.MathUtils.damp(this.head.rotation.x, this.gazePitch ?? restPitch, 9, seconds);
    }
    this.hands.forEach((hand, i) => {
      const sign = i ? 1 : -1;
      if (inactive) {
        hand.position.set(sign * pose.hand[0], pose.hand[1], pose.hand[2]);
        hand.rotation.set(0, sign * (this.agent.team === 'game' ? -.25 : .15), sign * (meditative ? .32 : 0));
      } else {
        hand.position.set(sign * (working && !walking ? .19 : .30), working && !walking ? -.01 + (reduced ? 0 : Math.sin(t * (9 + i * 2)) * .008) : -.12, working && !walking ? .75 : .35);
        hand.rotation.set(0, 0, 0);
      }
    });
    this.shadowMaterial.opacity = this.agent.state === 'offline' ? .14 : .28;
  }
  select(selected: boolean) { if (!this.disposed) this.ring.visible = selected; }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.path = []; this.gazeYaw = this.gazePitch = null;
    this.root.removeFromParent();
    // The body uses Assets-owned primitives/materials; the atlas is shared too.
    this.pick.geometry.dispose(); (this.pick.material as THREE.Material).dispose();
    this.ring.geometry.dispose(); this.ringMaterial.dispose();
    this.shadow.geometry.dispose(); this.shadowMaterial.dispose();
  }
}
