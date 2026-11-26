import { test, expect } from '@playwright/test';
import * as THREE from 'three';
import { planCampus } from '../../src/scene/campus.ts';
import { campusCamera } from '../../src/scene/campus-camera.ts';
import { demoSnapshot } from '../../src/domain/demo.ts';

test('the rendered crossing reads as quiet flooring between the signal rooms, not the void', async ({page}) => {
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.goto('/?view=embedded&team=all');
  const canvas=page.getByTestId('scene-canvas');
  await expect(canvas).toHaveAttribute('data-agents','33',{timeout:25000});
  await expect(canvas).toHaveAttribute('data-glass-ready','1');
  const size=await canvas.boundingBox();expect(size).not.toBeNull();
  const {width,height}=size!;
  const pose=campusCamera(planCampus(demoSnapshot().agents).bounds,width,height);
  const camera=new THREE.PerspectiveCamera(pose.fov,pose.aspect,.1,2000);
  camera.position.fromArray(pose.position);camera.lookAt(new THREE.Vector3(...pose.target));camera.updateMatrixWorld();
  const samples=[[0,0],[0,-3],[0,-7],[0,4],[-11,0],[-7,0],[7,0],[10,0]].map(([x,z])=>{
    const p=new THREE.Vector3(x,0,z).project(camera);return [(p.x+1)/2,(1-p.y)/2];
  });
  // Read the real composite (including opaque/transparent order and shader output).
  const png=(await canvas.screenshot()).toString('base64');
  const {aisle,voidLevel,signals,warmBack,warmFront,total}=await page.evaluate(async ({png,samples})=>{
    const image=new Image();image.src='data:image/png;base64,'+png;await image.decode();
    const c=document.createElement('canvas');c.width=image.naturalWidth;c.height=image.naturalHeight;
    const ctx=c.getContext('2d')!;ctx.drawImage(image,0,0);const data=ctx.getImageData(0,0,c.width,c.height).data;
    function median(x:number,y:number){const values:number[]=[];for(let j=-2;j<=2;j++)for(let i=-2;i<=2;i++){
      const k=((Math.round(y*c.height)+j)*c.width+Math.round(x*c.width)+i)*4;
      values.push(.2126*data[k]+.7152*data[k+1]+.0722*data[k+2]);
    }return values.sort((a,b)=>a-b)[12];}
    let signals=0,warmBack=0,warmFront=0;for(let i=0;i<data.length;i+=4){
      const [r,g,b]=[data[i],data[i+1],data[i+2]];
      if(b>100&&b>r*1.45)signals++;
      if(r>55&&r>g*1.16&&g>b*1.13){if(i/data.length<.49)warmBack++;else warmFront++;}
    }
    return {aisle:samples.map(([x,y])=>median(x,y)),voidLevel:median(.05,.1),signals,warmBack,warmFront,total:data.length/4};
  },{png,samples});
  expect(errors).toEqual([]);
  expect(signals,'positive control: real blue figures and screens are visible').toBeGreaterThan(150);
  expect(aisle.filter(value=>value>voidLevel+10&&value<72).length,`aisle medians: ${aisle}; void: ${voidLevel}`).toBeGreaterThanOrEqual(6);
  expect(warmBack,'a practical resolves at the rear service entrance').toBeGreaterThan(total*.00004);
  expect(warmFront,'a separate local task light is visible in the foreground').toBeGreaterThan(total*.000018);
  expect((warmFront+warmBack)/total,'localized spill, not a warm filter over the campus').toBeLessThan(.014);
});
