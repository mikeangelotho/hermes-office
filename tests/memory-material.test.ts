import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {Assets} from '../src/scene/room.ts';
import {PALETTE as P} from '../src/scene/palette.ts';
import {createGlassProxy} from '../src/scene/spatial-glass.ts';
test('memory reconstruction erodes environment fill while keeping signal beings, screens and glass legible',()=>{
  const assets=new Assets();
  try{for(const [color,role,expected] of [[P.blue,'agent',0],[P.frame,'environment',1],[P.azure,'screen',0],[P.glass,'environment',0]] as const){
    const m=assets.material(color,'box',role),shader={uniforms:{} as any,vertexShader:'#include <begin_vertex>',fragmentShader:'#include <tonemapping_fragment>\n#include <dithering_fragment>'};
    m.onBeforeCompile(shader as any,{} as any);
    assert.equal(shader.uniforms.uHoloReconstruction?.value,expected);
    assert.ok(shader.fragmentShader.includes('memoryColumn')&&shader.fragmentShader.includes('discard'));
  }}finally{assets.dispose();}
});
test('glass captures memory scan points without owning or disposing their buffers',()=>{
  const root=new THREE.Group(),geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute([1,2,3],3));
  const material=new THREE.PointsMaterial();material.userData.captureMemory=true;
  const points=new THREE.Points(geometry,material);points.position.set(2,0,0);root.add(points);
  const proxy=createGlassProxy([root]);let disposed=0;geometry.addEventListener('dispose',()=>disposed++);
  try{
    const clone=proxy.scene.children.find(o=>o instanceof THREE.Points) as THREE.Points;
    assert.ok(clone,'scan particles must be present behind glass');assert.equal(clone.geometry,geometry);
    points.position.x=5;proxy.sync();assert.equal(clone.matrix.elements[12],5);
    proxy.dispose();assert.equal(disposed,0);
  }finally{proxy.dispose();geometry.dispose();material.dispose();}
});
