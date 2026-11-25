import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {Assets} from '../src/scene/room.ts';
import {PALETTE as P} from '../src/scene/palette.ts';
const api=await import('../src/scene/memory-field.ts').catch(()=>({})) as Record<string,any>;
test('memory reconstruction samples real surfaces deterministically in fixed buffers and freezes cleanly',()=>{
  assert.equal(typeof api.createMemoryField,'function','memory surface reconstruction is not implemented');
  const assets=new Assets(),root=new THREE.Group();assets.mesh(P.frame,[2,2,2],[2,1,3],'box',root);
  const a=api.createMemoryField([root],512),b=api.createMemoryField([root],512);
  try{
    assert.equal(a.pointCount,512);assert.equal(a.group.children.length,2);
    const points=a.group.children.find((o:THREE.Object3D)=>o instanceof THREE.Points) as THREE.Points;
    const geometry=points.geometry,positions=geometry.getAttribute('position');
    for(let i=0;i<positions.count;i++){
      assert.ok(positions.getX(i)>=.99&&positions.getX(i)<=3.01);
      assert.ok(positions.getY(i)>=-.01&&positions.getY(i)<=2.01);
      assert.ok(positions.getZ(i)>=1.99&&positions.getZ(i)<=4.01,'points must be on the source object, not a random overlay');
    }
    const before=Array.from(positions.array);
    assert.deepEqual(before,Array.from((b.group.children[0] as THREE.Points).geometry.getAttribute('position').array));
    a.tick(2,false);a.tick(9,true);
    assert.equal((points.material as THREE.ShaderMaterial).uniforms.uTime.value,2);
    assert.deepEqual(Array.from(positions.array),before);
    assert.equal((points.material as THREE.ShaderMaterial).userData.captureMemory,true);
    let disposed=0;a.group.children.forEach((o:any)=>o.geometry.addEventListener('dispose',()=>disposed++));
    a.dispose();assert.equal(disposed,2);
  }finally{a.dispose();b.dispose();assets.dispose();}
});
