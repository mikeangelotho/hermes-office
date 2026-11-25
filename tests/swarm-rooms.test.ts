import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {Assets,createRoom} from '../src/scene/room.ts';
import type {Team} from '../src/domain/types.ts';

test('swarm rooms contain only their own stations and distinct inactive furniture',()=>{
  const assets=new Assets();assets.texture=()=>{const t=new THREE.CanvasTexture({width:128,height:80} as HTMLCanvasElement);assets.textures.add(t);return t;};
  const create=createRoom as (...args:any[])=>ReturnType<typeof createRoom>;
  const types=new Set<string>();
  try{for(const [team,count] of [['general',1],['studio',8],['development',10],['game',10],['science',4]] as [Team,number][]){
    const room=create(assets,{team,count});
    try{assert.equal(room.screens.length,count,`${team} must not have a fixed ten workstations`);assert.equal(room.group.userData.team,team);assert.equal(typeof room.group.userData.restArea,'string');types.add(room.group.userData.restArea);}finally{room.dispose();}
  }assert.equal(types.size,5,'idle environments must reflect the different rooms');}finally{assets.dispose();}
});
