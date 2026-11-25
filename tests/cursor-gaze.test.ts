import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Assets } from '../src/scene/room.ts';
import { Character } from '../src/scene/character.ts';
import type { OfficeAgent } from '../src/domain/types.ts';
const agent=(state:OfficeAgent['state']):OfficeAgent=>({id:'studio-engineer',name:'Engineer',role:'Engineer',team:'studio',state,observedAt:new Date().toISOString(),activity:'Fixture only'});
function setup(state:OfficeAgent['state']='idle'){
  const assets=new Assets(),texture=new THREE.Texture(),c=new Character(assets,agent(state),2,texture);
  const camera=new THREE.OrthographicCamera(-10,10,7.5,-7.5,.1,100);camera.position.set(16,13,19);camera.lookAt(0,.7,0);camera.updateMatrixWorld(true);
  return {c,camera,dispose(){c.dispose();assets.dispose();texture.dispose();}};
}
const aim=(c:Character,p:THREE.Vector2|null,camera:THREE.Camera)=>(c as Character & {lookAtCursor:(p:THREE.Vector2|null,camera:THREE.Camera)=>void}).lookAtCursor(p,camera);

test('seated couch heads follow the projected cursor smoothly with bounded yaw and pitch',()=>{
  const {c,camera,dispose}=setup();
  try{
    assert.equal(typeof (c as any).lookAtCursor,'function');
    const body=c.root.rotation.y;
    aim(c,new THREE.Vector2(-.9,-.6),camera);
    for(let i=0;i<60;i++)c.tick(i/30,1/30,false);
    const left=c.head.rotation.y,low=c.head.rotation.x;
    aim(c,new THREE.Vector2(.9,.8),camera);
    const before=c.head.rotation.y;c.tick(2,1/30,false);
    assert.ok(c.head.rotation.y>before&&c.head.rotation.y-before<.25,'head turns must ease rather than snap');
    for(let i=0;i<60;i++)c.tick(2+i/30,1/30,false);
    assert.ok(c.head.rotation.y>left+.1);assert.ok(c.head.rotation.x<low-.05);
    assert.ok(Math.abs(c.head.rotation.y)<=.751);assert.ok(Math.abs(c.head.rotation.x)<=.321);
    assert.equal(c.root.rotation.y,body,'cursor tracking must not rotate the seated body');
    aim(c,null,camera);for(let i=0;i<90;i++)c.tick(4+i/30,1/30,false);
    assert.ok(Math.abs(c.head.rotation.y)<.01,'a previously tracking head returns to neutral');
  }finally{dispose();}
});

test('working, walking and reduced-motion poses do not follow the cursor',()=>{
  const {c,camera,dispose}=setup('working');
  try{
    assert.equal(typeof (c as any).lookAtCursor,'function');
    aim(c,new THREE.Vector2(1,1),camera);c.tick(1,1/30,false);assert.equal(c.head.rotation.y,0);
    c.update(agent('idle'),2,false);assert.ok(c.path.length>0);
    aim(c,new THREE.Vector2(1,1),camera);c.tick(2,1/30,false);assert.equal(c.head.rotation.y,0);
    c.update(agent('idle'),2,true);c.path=[];c.root.position.set(c.seat.x,0,c.seat.z);
    aim(c,new THREE.Vector2(1,1),camera);c.tick(3,1/30,true);assert.equal(c.head.rotation.y,0);
    aim(c,null,camera);for(let i=0;i<90;i++)c.tick(3+i/30,1/30,false);
    assert.ok(Math.abs(c.head.rotation.y)<.01,'leaving the scene returns the head to neutral');
  }finally{dispose();}
});
