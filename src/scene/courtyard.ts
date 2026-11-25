import * as THREE from 'three';
import {Assets} from './room.ts';
import {PALETTE as P} from './palette.ts';
import {scanMaterial} from './memory-field.ts';
import {reconstructionDensity} from './reconstruction-density.ts';

/** Centered campus footprint; omitted bounds retain the original office clearance. */
export interface CourtyardBounds {width:number;depth:number;}

/** The residual architecture of a memory, not a landscaped miniature. */
export function createCourtyard(assets:Assets,bounds:CourtyardBounds={width:15.8,depth:12.8}){
  if(!Number.isFinite(bounds.width)||!Number.isFinite(bounds.depth)||bounds.width<=0||bounds.depth<=0)throw new RangeError('Courtyard bounds must be finite positive dimensions');
  const group=new THREE.Group();group.name='memory-void';const time={value:0};
  const halfWidth=bounds.width/2,halfDepth=bounds.depth/2,capacity=10000;
  // Five interrupted members share primitives, but neither align nor enclose a room.
  const members=[
    [-halfWidth-3.3,1.4,-halfDepth-2.8,.022,2.8,.03,.13],
    [-halfWidth-2.9,2.6,-halfDepth-2.8,.025,1.05,.03,Math.PI/2+.08],
    [-halfWidth*.3,.85,-halfDepth-5.9,.018,1.7,.028,-.18],
    [halfWidth+4.2,1.05,halfDepth*.1,.02,2.1,.025,.21],
    [halfWidth+4.1,2.2,halfDepth*.1,.018,.75,.025,-.61],
  ];
  const transform=new THREE.Object3D(),ribs=new THREE.InstancedMesh(assets.geometry(),assets.material(P.frame),members.length);
  for(let i=0;i<members.length;i++){
    const [x,y,z,sx,sy,sz,tilt]=members[i];
    transform.position.set(x,y,z);transform.scale.set(sx,sy,sz);transform.rotation.z=tilt;transform.updateMatrix();ribs.setMatrixAt(i,transform.matrix);
  }ribs.computeBoundingSphere();group.add(ribs);
  let seed=81751;const random=()=>{seed=(Math.imul(seed,1664525)+0x3c6ef35f)>>>0;return seed/4294967296;};
  const clusters=[
    [-halfWidth-3,-halfDepth-3,4.8,2.3,.48],
    [-halfWidth*.35,-halfDepth-6.5,4.5,1.7,-.24],
    [halfWidth+5,halfDepth*.25,2.2,5.2,.28],
    [halfWidth*.5,halfDepth+4.8,3.4,1.5,-.35],
  ];
  const positionBuffer=new Float32Array(capacity*3),seedBuffer=new Float32Array(capacity);
  let count=0;
  for(let attempt=0;attempt<capacity*32&&count<capacity;attempt++){
    const mode=random();let x:number,z:number,y=-.025+random()*.018;
    if(mode<.73){
      const pick=random(),cluster=clusters[pick<.4?0:pick<.68?1:pick<.9?2:3];
      const radius=Math.sqrt(random()),angle=random()*Math.PI*2;
      const dx=Math.cos(angle)*radius*cluster[2],dz=Math.sin(angle)*radius*cluster[3];
      x=cluster[0]+dx*Math.cos(cluster[4])-dz*Math.sin(cluster[4]);
      z=cluster[1]+dx*Math.sin(cluster[4])+dz*Math.cos(cluster[4]);
    }else if(mode<.91){
      // Short surviving ribbons, not three full walls of uniformly spaced dots.
      const cluster=clusters[Math.floor(random()*3)],along=(random()-.5)*cluster[2]*1.4;
      x=cluster[0]+along*Math.cos(cluster[4]);
      z=cluster[1]+along*Math.sin(cluster[4])+Math.sin(along*.9)*.12+(random()-.5)*.05;
      y=Math.pow(random(),1.7)*5.2;
    }else{
      // Incomplete ground-level sweeps with wide angular gaps between them.
      const segment=random(),angle=segment<.6?3.2+random()*.7:segment<.86?4.6+random()*.36:.15+random()*.25;
      const drift=Math.sin(angle*7)*.25+(random()-.5)*.24;
      x=Math.cos(angle)*(halfWidth+6.5+drift);z=Math.sin(angle)*(halfDepth+5.2+drift);
    }
    if(Math.abs(x)<halfWidth+.4&&Math.abs(z)<halfDepth+.4)continue;
    if(random()>=reconstructionDensity(x,y,z))continue;
    positionBuffer.set([x,y,z],count*3);seedBuffer[count]=random();count++;
  }
  const positions=positionBuffer.slice(0,count*3),seeds=seedBuffer.slice(0,count);
  const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.BufferAttribute(positions,3));geometry.setAttribute('aSeed',new THREE.BufferAttribute(seeds,1));geometry.computeBoundingSphere();
  const material=scanMaterial(time,.15);group.add(new THREE.Points(geometry,material));
  const streaks:number[]=[];
  for(let i=0;i<count;i+=37){const at=i*3;if(positions[at+1]<.1)continue;streaks.push(positions[at],positions[at+1],positions[at+2],positions[at]+.025,positions[at+1]+.12+seeds[i]*.64,positions[at+2]);}
  const lineGeometry=new THREE.BufferGeometry();lineGeometry.setAttribute('position',new THREE.Float32BufferAttribute(streaks,3));
  const lineMaterial=new THREE.LineBasicMaterial({color:P.azure,transparent:true,opacity:.035,depthWrite:false,blending:THREE.AdditiveBlending});lineMaterial.userData.captureMemory=true;
  group.add(new THREE.LineSegments(lineGeometry,lineMaterial));let disposed=false;
  return {group,pointCount:count,tick(value:number,reduced:boolean){if(!disposed&&!reduced)time.value=value;},setPixelRatio(value:number){material.uniforms.uPixelRatio.value=THREE.MathUtils.clamp(value,1,1.65);},dispose(){if(disposed)return;disposed=true;ribs.dispose();geometry.dispose();material.dispose();lineGeometry.dispose();lineMaterial.dispose();}};
}

