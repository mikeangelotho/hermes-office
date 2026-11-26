import * as THREE from 'three';
import {PALETTE as P} from './palette.ts';
import {reconstructionDensity} from './reconstruction-density.ts';

/** Fine, square scan returns; animation changes uniforms, never surface buffers. */
export function scanMaterial(time:{value:number},strength=.5) {
  const material=new THREE.ShaderMaterial({transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,
    uniforms:{uTime:time,uPixelRatio:{value:1},uPointSize:{value:1.05},uStrength:{value:strength},uColor:{value:new THREE.Color(P.azure)}},
    vertexShader:`uniform float uTime;uniform float uPixelRatio;uniform float uPointSize;attribute float aSeed;varying float vSeed;varying float vFade;varying float vSignal;varying float vSparkle;
      void main(){vSeed=aSeed;vec4 world=modelMatrix*vec4(position,1.0);
        float scan=sin(world.y*5.7+world.x*.38+world.z*.21-uTime*.32);
        vSignal=.86+.14*scan;world.y+=pow(max(0.0,scan),28.0)*.035;
        vec3 voxel=floor(world.xyz*8.0);
        float colOffset=fract(sin(dot(voxel,vec3(12.9898,78.233,37.719)))*43758.5453);
        float phase=uTime*(.7+colOffset*1.1)+colOffset*17.3;
        float env=sin(fract(phase)*3.14159265);
        float pick=step(.935,fract(sin(dot(voxel+floor(phase),vec3(39.346,11.135,83.155)))*43758.5453));
        vSparkle=pick*env*env;
        vec4 view=viewMatrix*world;
        vFade=1.0/(1.0+dot(view.xyz,view.xyz)*.00006);
        gl_Position=projectionMatrix*view;gl_PointSize=(.65+aSeed*.35+vSparkle*.85)*uPointSize*uPixelRatio;
      }`,
    fragmentShader:`uniform float uStrength;uniform vec3 uColor;varying float vSeed;varying float vFade;varying float vSignal;varying float vSparkle;
      void main(){vec2 q=abs(gl_PointCoord-.5);float edge=1.0-smoothstep(.28,.5,max(q.x,q.y));
        vec3 color=uColor*(.7+.3*vSeed+vSparkle*.65);
        float alpha=edge*((.25+.75*vSeed)*vSignal*uStrength+vSparkle*(.42*uStrength+.28))*vFade;
        gl_FragColor=vec4(color,min(alpha,1.0));
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  material.userData.captureMemory=true;return material;
}

/** Area-weighted reconstruction of actual static furniture/floor surfaces. */
export function createMemoryField(roots:THREE.Object3D[],requested=26000) {
  const capacity=Math.max(0,Math.min(30000,Number.isFinite(requested)?Math.floor(requested):26000));
  const triangles:number[]=[],weights:number[]=[];let area=0;
  const a=new THREE.Vector3(),b=new THREE.Vector3(),c=new THREE.Vector3(),ab=new THREE.Vector3(),ac=new THREE.Vector3();
  const world=new THREE.Matrix4(),instance=new THREE.Matrix4();
  for(const root of roots){root.updateWorldMatrix(true,true);root.traverse(object=>{
    if(!(object instanceof THREE.Mesh)||!object.visible)return;
    const m=Array.isArray(object.material)?object.material[0]:object.material;
    if(!m.visible||m.userData.hologramRole!=='environment')return;
    const g=object.geometry,p=g.getAttribute('position'),index=g.index;if(!p)return;
    const count=object instanceof THREE.InstancedMesh?object.count:1;
    for(let k=0;k<count;k++){
      if(object instanceof THREE.InstancedMesh){object.getMatrixAt(k,instance);world.multiplyMatrices(object.matrixWorld,instance);}else world.copy(object.matrixWorld);
      const size=index?index.count:p.count;
      for(let i=0;i+2<size;i+=3){
        a.fromBufferAttribute(p,index?index.getX(i):i).applyMatrix4(world);
        b.fromBufferAttribute(p,index?index.getX(i+1):i+1).applyMatrix4(world);
        c.fromBufferAttribute(p,index?index.getX(i+2):i+2).applyMatrix4(world);
        ab.subVectors(b,a);ac.subVectors(c,a);const cross=ab.cross(ac),weight=cross.length()*.5;
        if(weight<.00001||(a.y+b.y+c.y)/3<-.01)continue;
        cross.normalize();
        if(cross.y<-.5&&(a.y+b.y+c.y)/3<.08)continue;
        triangles.push(a.x,a.y,a.z,b.x,b.y,b.z,c.x,c.y,c.z,cross.x,cross.y,cross.z);
        area+=weight;weights.push(area);
      }
    }
  });}
  let seed=39173;const random=()=>{seed=(Math.imul(seed,1664525)+0x3c6ef35f)>>>0;return seed/4294967296;};
  const positionBuffer=new Float32Array(capacity*3),seedBuffer=new Float32Array(capacity);
  let count=0;
  // Proposals remain area-weighted; only spatial confidence changes acceptance.
  // A lost object may stay lost: never fill a rejected patch with uniform fallback.
  const attempts=area>0?capacity*32:0;
  for(let attempt=0;attempt<attempts&&count<capacity;attempt++){
    const choice=random()*area;let low=0,high=weights.length-1;
    while(low<high){const middle=(low+high)>>>1;if(weights[middle]<choice)low=middle+1;else high=middle;}
    const at=low*12,u=Math.sqrt(random()),v=random();
    a.set(0,0,0);
    for(let axis=0;axis<3;axis++)a.setComponent(axis,triangles[at+axis]*(1-u)+triangles[at+3+axis]*u*(1-v)+triangles[at+6+axis]*u*v);
    if(random()>=reconstructionDensity(a.x,a.y,a.z))continue;
    for(let axis=0;axis<3;axis++)positionBuffer[count*3+axis]=a.getComponent(axis)+triangles[at+9+axis]*.003;
    seedBuffer[count]=random();count++;
  }
  const positions=positionBuffer.slice(0,count*3),seeds=seedBuffer.slice(0,count);
  const group=new THREE.Group();group.name='memory-surface-reconstruction';const time={value:0};
  const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.BufferAttribute(positions,3));geometry.setAttribute('aSeed',new THREE.BufferAttribute(seeds,1));geometry.computeBoundingSphere();
  const material=scanMaterial(time,.38),points=new THREE.Points(geometry,material);group.add(points);
  const streaks:number[]=[];
  for(let i=0;i<count;i+=47){const at=i*3,height=.04+Math.pow(seeds[i],5)*.85;streaks.push(positions[at],positions[at+1],positions[at+2],positions[at],positions[at+1]+height,positions[at+2]);}
  const linesGeometry=new THREE.BufferGeometry();linesGeometry.setAttribute('position',new THREE.Float32BufferAttribute(streaks,3));
  const linesMaterial=new THREE.LineBasicMaterial({color:P.azure,transparent:true,opacity:.055,depthWrite:false,blending:THREE.AdditiveBlending});linesMaterial.userData.captureMemory=true;
  group.add(new THREE.LineSegments(linesGeometry,linesMaterial));let disposed=false;
  return {group,pointCount:count,tick(value:number,reduced:boolean){if(!disposed&&!reduced)time.value=value;},setPixelRatio(value:number){material.uniforms.uPixelRatio.value=THREE.MathUtils.clamp(value,1,1.65);},dispose(){if(disposed)return;disposed=true;geometry.dispose();material.dispose();linesGeometry.dispose();linesMaterial.dispose();}};
}
