import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
const lens=await import('../src/scene/campus-camera.ts').catch(()=>({})) as Record<string,any>;
test('campus overview contains every room corner on desktop, portrait and short embeds',()=>{
  assert.equal(typeof lens.campusCamera,'function','campus fit is missing');
  const bounds={minX:-16.1,maxX:16.1,minZ:-13.3,maxZ:26.1};
  for(const [w,h] of [[1440,960],[390,844],[1200,360]]){
    const pose=lens.campusCamera(bounds,w,h),camera=new THREE.PerspectiveCamera(pose.fov,w/h,.1,1000);
    camera.position.fromArray(pose.position);camera.lookAt(new THREE.Vector3(...pose.target));camera.updateMatrixWorld(true);
    for(const x of [bounds.minX,bounds.maxX])for(const z of [bounds.minZ,bounds.maxZ])for(const y of [0,4]){
      const p=new THREE.Vector3(x,y,z).project(camera);
      assert.ok(Math.abs(p.x)<=.94&&Math.abs(p.y)<=.9,`${w}x${h} clipped ${x},${y},${z}: ${p.x},${p.y}`);
    }
  }
});
