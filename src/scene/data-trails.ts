import * as THREE from 'three';
import { PALETTE as P } from './palette.ts';
export interface TrailSubject { head: THREE.Object3D; hands: THREE.Object3D[]; }

/** One additive point draw: soft spatial signal halos and real movement afterimages.
 * Fixed buffers, no temporal screen smear or duplicated character meshes.
 */
export function createDataTrails(maxAgents = 10) {
  const halos = maxAgents * 2, capacity = halos + maxAgents * 48;
  const positions = new Float32Array(capacity * 3), born = new Float32Array(capacity), kinds = new Float32Array(capacity);
  born.fill(-10000); const previous = new Float32Array(maxAgents * 9);previous.fill(NaN);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.BufferAttribute(positions,3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('aBorn',new THREE.BufferAttribute(born,1).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('aKind',new THREE.BufferAttribute(kinds,1).setUsage(THREE.DynamicDrawUsage));
  const material = new THREE.ShaderMaterial({
    transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,
    uniforms:{uTime:{value:0},uPaused:{value:0},uPixelRatio:{value:1},uTowardCamera:{value:new THREE.Vector3(0,0,1)},uColor:{value:new THREE.Color(P.ice)}},
    vertexShader:`uniform float uTime;uniform float uPixelRatio;uniform vec3 uTowardCamera;attribute float aBorn;attribute float aKind;
      varying float vAge;varying float vKind;
      void main(){vAge=uTime-aBorn;vKind=aKind;vec3 p=position;
        if(aKind<.5){p.y+=max(0.0,vAge)*.045;}
        p+=uTowardCamera*(aKind>.5?.3:.1);
        gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.0);
        gl_PointSize=(aKind>1.5?58.0:aKind>.5?35.0:6.0)*uPixelRatio;
      }`,
    fragmentShader:`uniform float uPaused;uniform vec3 uColor;varying float vAge;varying float vKind;
      void main(){vec2 q=gl_PointCoord-.5;float d=length(q);if(d>.5||vAge<0.0)discard;
        float life=1.0-smoothstep(.0,1.1,vAge);
        float halo=exp(-d*d*24.0)*.06;
        float trail=(1.0-smoothstep(.05,.48,d))*life*.3*(1.0-uPaused);
        if(vKind<.5&&life<=0.0)discard;
        gl_FragColor=vec4(uColor,vKind>.5?halo:trail);
        #include <colorspace_fragment>
      }`,
  });
  const points = new THREE.Points(geometry,material);points.frustumCulled=false;points.renderOrder=5;
  const p = new THREE.Vector3();let cursor=halos,lastEmit=-Infinity,subjectsRef: readonly TrailSubject[]|undefined,paused=false,disposed=false,now=0;
  function clear() { for(let i=halos;i<capacity;i++)born[i]=-10000;previous.fill(NaN); }
  function write(index:number,x:number,y:number,z:number,kind:number,time:number) { const at=index*3;positions[at]=x;positions[at+1]=y;positions[at+2]=z;kinds[index]=kind;born[index]=time; }
  return {
    points,
    get active(){let n=0;for(let i=halos;i<capacity;i++)if(now-born[i]>=0&&now-born[i]<1.1)n++;return n;},
    update(time:number,subjects:readonly TrailSubject[],reduced:boolean) {
      if(disposed)return;now=Math.fround(time);
      if(subjectsRef!==subjects){clear();subjectsRef=subjects;born.fill(-10000,0,halos);}
      if(reduced&&!paused)clear();paused=reduced;material.uniforms.uPaused.value=reduced?1:0;material.uniforms.uTime.value=now;
      const emit=!reduced&&time-lastEmit>=1/12;
      for(let i=0;i<Math.min(maxAgents,subjects.length);i++){
        const s=subjects[i];s.head.getWorldPosition(p);
        write(i*2,p.x,p.y,p.z,1,0);write(i*2+1,p.x,p.y-.44,p.z,2,0);
        if(emit)for(let j=0;j<3;j++){
          const anchor=j===0?s.head:s.hands[j-1];if(!anchor)continue;anchor.getWorldPosition(p);
          const k=i*9+j*3,dx=p.x-previous[k],dy=p.y-previous[k+1],dz=p.z-previous[k+2];
          if(Number.isFinite(dx)&&dx*dx+dy*dy+dz*dz>.000064){write(cursor,p.x,p.y,p.z,0,time);cursor=halos+(cursor-halos+1)%(capacity-halos);}
          previous[k]=p.x;previous[k+1]=p.y;previous[k+2]=p.z;
        }
      }
      if(emit)lastEmit=time;
      geometry.attributes.position.needsUpdate=true;geometry.attributes.aBorn.needsUpdate=true;geometry.attributes.aKind.needsUpdate=true;
    },
    setView(direction:THREE.Vector3,ratio:number){material.uniforms.uTowardCamera.value.copy(direction);material.uniforms.uPixelRatio.value=Math.min(ratio,1.65);},
    dispose(){if(disposed)return;disposed=true;geometry.dispose();material.dispose();},
  };
}
