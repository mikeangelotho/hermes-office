import * as THREE from 'three';
import { PALETTE as P } from './palette.ts';
import { hologramMaterial, type SurfaceRole } from './hologram.ts';
import type { GlassUniforms } from './spatial-glass.ts';
import type { Team } from '../domain/types.ts';
import { seatFor } from './layout.ts';
import { roomDimensions, ROOM_REST } from './campus.ts';

/** Shared primitives and instanced static geometry keep the room cheap to draw. */
export class Assets {
  geometries = new Map<string, THREE.BufferGeometry>();
  materials = new Map<string, THREE.MeshLambertMaterial>();
  textures = new Set<THREE.Texture>();
  private hologramTime = { value: 0 };
  readonly glass: GlassUniforms = { texture: { value: null }, viewport: { value: new THREE.Vector2(1,1) }, ready: { value: 0 } };
  tickHolograms(time: number, reduced: boolean) { if (!reduced) this.hologramTime.value = time; }
  geometry(kind = 'box') {
    if (!this.geometries.has(kind)) this.geometries.set(kind, kind === 'torso' ? new THREE.CylinderGeometry(.5, .36, 1, 8) : kind === 'limb' ? new THREE.CylinderGeometry(.5, .39, 1, 8) : kind === 'head' ? new THREE.SphereGeometry(.5, 8, 6) : kind === 'hand' ? new THREE.IcosahedronGeometry(.5, 0) : kind === 'cylinder' ? new THREE.CylinderGeometry(.5, .5, 1, 8) : kind === 'cone' ? new THREE.ConeGeometry(.5, 1, 6) : kind === 'leaf' ? new THREE.IcosahedronGeometry(.5, 0) : kind === 'sphere' ? new THREE.SphereGeometry(.5, 8, 6) : new THREE.BoxGeometry(1, 1, 1));
    return this.geometries.get(kind)!;
  }
  material(color: string, kind = 'box', role: SurfaceRole = 'environment') {
    const key = `${role}:${color}:${kind}`;
    if (!this.materials.has(key)) this.materials.set(key, hologramMaterial(color, kind, this.hologramTime, role, this.glass));
    return this.materials.get(key)!;
  }
  mesh(color: string, size: number[], position: number[], kind = 'box', parent?: THREE.Object3D, role: SurfaceRole = 'environment') {
    const mesh = new THREE.Mesh(this.geometry(kind), this.material(color, kind, role));
    mesh.scale.set(size[0], size[1], size[2]); mesh.position.set(position[0], position[1], position[2]);
    mesh.castShadow = true; mesh.receiveShadow = true; parent?.add(mesh); return mesh;
  }
  texture(width: number, height: number, paint: (ctx: CanvasRenderingContext2D) => void) {
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    paint(canvas.getContext('2d')!); const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace; texture.magFilter = THREE.NearestFilter; texture.minFilter = THREE.LinearFilter;
    this.textures.add(texture); return texture;
  }
  dispose() { this.geometries.forEach(g => g.dispose()); this.materials.forEach(m => m.dispose()); this.textures.forEach(t => t.dispose()); }
}
interface StaticPart { color: string; kind: string; matrix: THREE.Matrix4; }
export interface RoomModel { group: THREE.Group; screens: THREE.Mesh[]; screenOn: THREE.MeshLambertMaterial; screenOff: THREE.MeshLambertMaterial; dispose: () => void; }

export function createRoom(a: Assets, options: {team?: Team; count?: number} = {}): RoomModel {
  const team=options.team??'studio', count=Math.max(0,Math.min(10,Math.floor(options.count??10))), capacity=Math.max(1,count);
  const {width,depth}=roomDimensions(capacity),half=width/2;
  const group=new THREE.Group();group.name=`swarm-room-${team}`;group.userData={team,restArea:ROOM_REST[team]};
  const parts:StaticPart[]=[], transform=new THREE.Object3D();
  const part=(color:string,size:number[],at:number[],kind='box',rotation=0)=>{
    transform.position.set(at[0],at[1],at[2]);transform.scale.set(size[0],size[1],size[2]);transform.rotation.set(0,rotation,0);transform.updateMatrix();parts.push({color,kind,matrix:transform.matrix.clone()});
  };
  // A cutaway footprint; walls break apart above desk height rather than hiding inhabitants.
  part(P.floor,[width,.045,depth],[0,.018,0]);
  part(P.metal,[width,.18,.13],[0,.12,-5.95]);
  part(P.azure,[width*.72,.035,.045],[-width*.12,3.25,-5.9]);
  part(P.frame,[.045,3.2,.045],[-half+.08,1.6,-5.9]);
  part(P.frame,[.045,2.2,.045],[half-.08,1.1,-5.9]);
  part(P.metal,[.13,.38,8.2],[-half+.03,.2,-1.85]);
  part(P.azure,[.025,.025,6.5],[-half+.03,.43,-2.3]);
  part(P.azure,[width*.32,.025,.04],[-width*.3,.08,5.96]);
  part(P.azure,[width*.24,.025,.04],[width*.34,.08,5.96]);
  for(let i=0;i<Math.max(1,Math.floor(width/3.3));i++){
    const x=-half+1.55+i*3.15;
    part(P.glass,[2.68,1.48,.035],[x,2.28,-5.82]);
    part(P.frame,[2.7,.025,.035],[x,3.03,-5.8]);
  }
  const screenOn=a.material(P.azure,'plane','screen');
  if(!screenOn.map){
    const texture=a.texture(128,80,ctx=>{ctx.fillStyle=P.screen;ctx.fillRect(0,0,128,80);for(let i=0;i<9;i++){ctx.fillStyle=i%4===0?P.ice:P.azure;ctx.fillRect(9+i%2*6,10+i*7,22+(i*13)%74,1);}});
    screenOn.map=texture;screenOn.emissiveMap=texture;
  }
  const screenOff=a.material(P.metal,'plane'),screens:THREE.Mesh[]=[];
  for(let i=0;i<count;i++){
    const seat=seatFor(i,'working',capacity),x=seat.x,z=seat.z-1.05;
    part(P.glass,[1.9,.065,1.12],[x,1.065,z]);
    for(const dx of [-.79,.79])part(P.metal,[.055,1.03,.64],[x+dx,.515,z]);
    part(P.metal,[.035,.3,.035],[x,1.31,z-.26]);part(P.metal,[1.04,.65,.045],[x,1.72,z-.3]);
    const screen=new THREE.Mesh(new THREE.PlaneGeometry(.96,.58),screenOff);screen.position.set(x,1.73,z-.268);group.add(screen);screens.push(screen);
    part(P.muted,[.67,.018,.23],[x,1.165,z+.3]);
    part(P.metal,[.58,.09,.58],[x,.55,z+1.05]);part(P.metal,[.10,.5,.10],[x,.26,z+1.05]);
    const idle=seatFor(i,'idle',capacity),ix=idle.x,iz=idle.z;
    if(team==='studio'){
      part(P.furniture,[.96,.18,1.13],[ix,.3,iz-.16]);part(P.cushion,[.9,.22,.92],[ix,.49,iz-.08]);part(P.furniture,[.96,.65,.16],[ix,.73,iz-.63]);
    }else if(team==='development'){
      part(P.metal,[.72,.22,.84],[ix,.19,iz]);part(P.furniture,[.64,1.45,.12],[ix,.94,iz-.45]);part(P.azure,[.025,.85,.018],[ix-.23,1,iz-.38]);part(P.frame,[.6,.035,.62],[ix,.32,iz]);
    }else if(team==='game'){
      part(P.furniture,[.84,.34,.94],[ix,.24,iz-.04]);part(P.cushion,[.78,.15,.78],[ix,.48,iz]);part(P.furniture,[.82,.55,.22],[ix,.67,iz-.48]);
    }else if(team==='science'){
      part(P.metal,[.84,.13,.84],[ix,.13,iz],'cylinder');part(P.azure,[.58,.024,.58],[ix,.21,iz],'cylinder');
    }else{
      part(P.furniture,[1.7,.22,1.7],[ix,.18,iz],'cylinder');part(P.frame,[1.35,.035,1.35],[ix,.31,iz],'cylinder');
    }
  }
  // Room silhouettes are distinguishable without relying on their labels.
  if(team==='development'){
    for(let i=0;i<3;i++){const x=-half+1.0+i*.8;part(P.furniture,[.58,1.65,.5],[x,.86,-5.25]);for(let k=0;k<5;k++)part(P.azure,[.35,.014,.015],[x,.4+k*.23,-4.99]);}
  }else if(team==='studio'){
    for(let i=0;i<3;i++){const x=-half+1.6+i*2;part(P.muted,[1.35,1.3,.035],[x,1.54,-5.35],'box',i*.08-.09);part(P.frame,[.035,1.6,.035],[x,.8,-5.35]);}
  }else if(team==='game'){
    for(const dx of [-.8,.8]){part(P.furniture,[1.1,1.8,.65],[dx,.92,-5.25]);part(P.glass,[.83,.55,.04],[dx,1.55,-4.9]);}
  }else if(team==='science'){
    part(P.metal,[1.4,.8,1.4],[0,.43,-5],'cylinder');part(P.azure,[.65,.65,.65],[0,1.3,-5],'hand');
  }else{
    part(P.frame,[1.4,.025,.025],[0,2.5,-5.8]);part(P.frame,[.025,1.4,.025],[0,2.5,-5.8]);
  }
  const batches=new Map<string,StaticPart[]>();
  for(const item of parts){const key=`${item.kind}:${item.color}`;const batch=batches.get(key)??[];batch.push(item);batches.set(key,batch);}
  for(const items of batches.values()){
    const mesh=new THREE.InstancedMesh(a.geometry(items[0].kind),a.material(items[0].color,items[0].kind),items.length);
    items.forEach((item,i)=>mesh.setMatrixAt(i,item.matrix));mesh.receiveShadow=true;mesh.computeBoundingSphere();group.add(mesh);
  }
  let disposed=false;
  return {group,screens,screenOn,screenOff,dispose:()=>{if(disposed)return;disposed=true;screens.forEach(s=>s.geometry.dispose());group.traverse(o=>{if(o instanceof THREE.InstancedMesh)o.dispose();});}};
}

