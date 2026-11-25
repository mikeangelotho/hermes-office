import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {Assets} from '../src/scene/room.ts';
import {createCourtyard} from '../src/scene/courtyard.ts';
test('the surrounding world is a bounded scanned void, not a park of cone trees',()=>{
  const assets=new Assets(),world=createCourtyard(assets);
  try{
    let cones=0,points=0;
    world.group.traverse(o=>{if(o instanceof THREE.Mesh&&o.geometry.type==='ConeGeometry')cones++;if(o instanceof THREE.Points)points+=o.geometry.getAttribute('position').count;});
    assert.equal(cones,0,'toy trees must be removed rather than recolored');
    assert.ok(points>=10000&&points<=24000,'scan-space needs a bounded fine reconstruction field');
  }finally{world.dispose();assets.dispose();}
});
