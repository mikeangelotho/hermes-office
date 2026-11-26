import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { planCampus } from '../src/scene/campus.ts';
import { demoSnapshot } from '../src/domain/demo.ts';
import { campusCamera } from '../src/scene/campus-camera.ts';
import { seatFor } from '../src/scene/layout.ts';
import { Assets, createRoom } from '../src/scene/room.ts';
import { PALETTE } from '../src/scene/palette.ts';
import { createGlassProxy } from '../src/scene/spatial-glass.ts';

import { createCampusInterior } from '../src/scene/campus-interior.ts';

// Read the room's actual lower face as the reference, not a duplicate floor-height constant.
function roomUnderside() {
  const assets=new Assets(),texture=new THREE.Texture();assets.textures.add(texture);
  // Node needs no screen atlas; all source furniture and floor geometry are unchanged.
  assets.material(PALETTE.azure,'plane','screen').map=texture;
  const room=createRoom(assets,{count:1});
  try {
    room.group.updateMatrixWorld(true);
    const ray=new THREE.Raycaster(new THREE.Vector3(1,-1,1),new THREE.Vector3(0,1,0));
    const hit=ray.intersectObject(room.group,true)[0];
    assert.ok(hit?.object instanceof THREE.Mesh&&hit.object.material===assets.material(PALETTE.floor));
    return hit.point.y;
  } finally {room.dispose();assets.dispose();}
}

function surfaceAt(group: THREE.Group, x: number, z: number) {
  const ray = new THREE.Raycaster(new THREE.Vector3(x, .04, z), new THREE.Vector3(0, -1, 0), 0, .065);
  return ray.intersectObject(group, true)[0];
}

test('a continuous supporting surface touches room floors and crosses their aisles, including annexes', () => {
  const underside=roomUnderside(),demo = demoSnapshot().agents;
  const annex = Array.from({length: 26}, (_, i) => ({...demo[0], id: `annex-${i}`, team: 'development' as const}));
  for (const roster of [[], demo, annex]) {
    const {rooms} = planCampus(roster), interior = createCampusInterior(rooms);
    try {
      interior.group.updateMatrixWorld(true);
      for (const room of rooms) {
        for (const x of [-.499, 0, .499]) for (const z of [-.499, 0, .499]) {
          const hit = surfaceAt(interior.group, room.x + x*room.width, room.z + z*room.depth);
          assert.ok(hit, `unsupported ${room.id} at ${x}, ${z}`);
          assert.ok(Math.abs(hit.point.y - underside) < .002, 'deck meets the underside of the translucent room, not its walking surface');
        }
        // Walk from each room to its nearest neighbour on the next (or same) row.
        const nearest = rooms.filter(r => r !== room).sort((a,b) => Math.hypot(a.x-room.x,a.z-room.z) - Math.hypot(b.x-room.x,b.z-room.z))[0];
        for (let step=0;step<=24;step++) {
          const t=step/24;
          assert.ok(surfaceAt(interior.group,room.x+(nearest.x-room.x)*t,room.z+(nearest.z-room.z)*t), `gap beyond ${room.id}`);
        }
      }
      for (let z = -13; z <= 26; z += .25) assert.ok(surfaceAt(interior.group,0,z), `disconnected central aisle at z=${z}`);
    } finally {interior.dispose();}
  }
});

test('service walls retain both back axes but leave camera-to-seat sightlines open', () => {
  const demo=demoSnapshot().agents;
  for(const roster of [demo, [...demo,...Array.from({length:18},(_,i)=>({...demo[0],id:`rear-${i}`,team:'development' as const}))]]) {
    const {rooms,bounds}=planCampus(roster),interior=createCampusInterior(rooms),ray=new THREE.Raycaster();
    try {
      interior.group.updateMatrixWorld(true);
      const rear=rooms.filter(r=>Math.abs(r.z-r.depth/2-bounds.minZ)<.001);
      for(const room of rear) {
        for(const t of [-.38,0,.38]) {
          ray.set(new THREE.Vector3(room.x+t*room.width,1.6,bounds.minZ-.03),new THREE.Vector3(0,0,-1));ray.far=2.55;
          assert.ok(ray.intersectObject(interior.group,true).length,`missing rear wall behind ${room.id}`);
        }
      }
      const west=rear.reduce((a,b)=>a.x-a.width/2<b.x-b.width/2?a:b);
      ray.set(new THREE.Vector3(west.x-west.width/2-.05,1,west.z-west.depth/2+2),new THREE.Vector3(-1,0,0));ray.far=2.1;
      assert.ok(ray.intersectObject(interior.group,true).length,'rear wall needs a grounded side return');
      for(const room of rooms) for(const cameraBounds of [bounds,{minX:room.x-room.width/2,maxX:room.x+room.width/2,minZ:room.z-room.depth/2,maxZ:room.z+room.depth/2}]) {
        const eye=new THREE.Vector3().fromArray(campusCamera(cameraBounds,1100,720).position);
        for(let i=0;i<room.capacity;i++) for(const state of ['working','idle'] as const) {
          const seat=seatFor(i,state,room.capacity),direction=new THREE.Vector3(room.x+seat.x,1.25,room.z+seat.z).sub(eye);
          ray.far=direction.length()-.01;ray.set(eye,direction.normalize());
          assert.equal(ray.intersectObject(interior.group,true).length,0,`architecture hides ${state} seat ${i} in ${room.id}`);
        }
      }
    } finally {interior.dispose();}
  }
});

test('room finish lets the resolved slab show through; glazing captures the slab, not a black substitute', () => {
  const assets=new Assets(),finish=assets.material(PALETTE.floor),testRoom=new THREE.Group();
  const layer=new THREE.Mesh(assets.geometry(),finish);testRoom.add(layer);
  const interior=createCampusInterior(planCampus(demoSnapshot().agents).rooms);
  const proxy=createGlassProxy([testRoom,interior.group]);
  try {
    assert.ok(finish.opacity<.35,'an eroded opaque overcoat turns the darker room floor into salt and pepper');
    const deck=interior.group.getObjectByName('contact-deck') as THREE.Mesh;
    assert.ok(proxy.scene.children.some(o=>o instanceof THREE.Mesh&&o.geometry===deck.geometry&&o.material===deck.material), 'frosted glass must see the physical floor finish');
    assert.ok(!proxy.scene.children.some(o=>o instanceof THREE.Mesh&&o.geometry===layer.geometry),'do not replace a thin finish with an opaque proxy floor');
  } finally {proxy.dispose();interior.dispose();assets.dispose();}
});

test('interior geometry fits the existing frustum and budget even with a long annex', () => {
  const demo=demoSnapshot().agents;
  const annex=Array.from({length:128},(_,i)=>({...demo[0],team:'development' as const,id:`long-${i}`}));
  for(const roster of [[],demo,annex]) {
    const {rooms,bounds}=planCampus(roster),interior=createCampusInterior(rooms);
    try {
      const meshes=interior.group.children.filter((o):o is THREE.Mesh=>o instanceof THREE.Mesh);
      const triangles=meshes.reduce((sum,m)=>sum+(m.geometry.index?.count??m.geometry.attributes.position.count)/3,0);
      assert.ok(meshes.length>0&&meshes.length<=3&&triangles<3000,`environment: ${meshes.length} draws, ${triangles} triangles`);
      for(const [w,h] of [[1100,720],[390,844],[1200,360]]) {
        const pose=campusCamera(bounds,w,h),c=new THREE.PerspectiveCamera(pose.fov,pose.aspect,.1,2000);
        c.position.fromArray(pose.position);c.lookAt(new THREE.Vector3(...pose.target));c.updateMatrixWorld();
        for(const mesh of meshes) {
          assert.equal(mesh.castShadow,false);const pos=mesh.geometry.attributes.position,pt=new THREE.Vector3();
          for(let i=0;i<pos.count;i++) {
            pt.fromBufferAttribute(pos,i).project(c);
            assert.ok(Math.abs(pt.x)<1&&Math.abs(pt.y)<1&&pt.z<1,`clipped ${mesh.name} at ${w}x${h}`);
          }
        }
      }
    } finally {interior.dispose();}
  }
});

test('the static capture borrows cullable geometry; a roster rebuild detaches and disposes it once', () => {
  const scene=new THREE.Scene(),interior=createCampusInterior(planCampus([]).rooms);scene.add(interior.group);
  const proxy=createGlassProxy([interior.group]);
  const meshes=interior.group.children.filter((o):o is THREE.Mesh=>o instanceof THREE.Mesh);
  const owned=new Set(meshes.flatMap(m=>[m.geometry,...(Array.isArray(m.material)?m.material:[m.material])]));
  const releases=new Map<object,number>();
  for(const resource of owned)resource.addEventListener('dispose',()=>releases.set(resource,(releases.get(resource)??0)+1));
  try {
    for(const source of meshes) {
      const copy=proxy.scene.children.find(o=>o instanceof THREE.Mesh&&o.geometry===source.geometry);
      assert.ok(copy?.frustumCulled,'an offscreen architectural batch should not force a glass draw');
    }
    proxy.dispose();assert.equal(releases.size,0);
    interior.dispose();interior.dispose();
    assert.equal(interior.group.parent,null);assert.equal(interior.group.children.length,0);
    assert.equal(releases.size,owned.size);for(const count of releases.values())assert.equal(count,1);
  } finally {proxy.dispose();interior.dispose();}
});
