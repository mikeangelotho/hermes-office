import * as THREE from 'three';
import type { CampusRoom } from './campus.ts';
import { interiorSurface, type InteriorLighting } from './interior-surface.ts';

type Footprint = Pick<CampusRoom, 'x' | 'z' | 'width' | 'depth'>;
type Point = [number, number, number];
type Section = { z: number; left: number; right: number };
// The room's thin translucent finish sits directly on this structural datum.
const DECK = -.0045;

function floorSections(rooms: readonly Footprint[]): Section[] {
  const rows = new Map<number, { left: number; right: number; depth: number }>();
  for (const {x,z,width,depth} of rooms) {
    const row = rows.get(z) ?? { left: Infinity, right: -Infinity, depth: 0 };
    row.left = Math.min(row.left, x-width/2-2.1); row.right = Math.max(row.right, x+width/2+1.4);
    row.depth = Math.max(row.depth, depth); rows.set(z, row);
  }
  const sections: Section[] = [];
  for (const [z, {left,right,depth}] of [...rows].sort(([a],[b]) => a-b)) {
    sections.push({z:z-depth/2,left,right}, {z:z+depth/2,left,right});
  }
  if (sections.length) {
    const back=sections[0], front=sections[sections.length-1];
    sections.unshift({...back,z:back.z-2.55});
    sections.push({...front,z:front.z+.4},{z:front.z+1.25,left:front.left+.8,right:front.right-.55});
  }
  return sections;
}

/** Small fixed meshes in world coordinates; no room-sized textures or per-frame rebuild. */
class SurfaceBatch {
  positions: number[] = [];
  colors: number[] = [];
  private tint = new THREE.Color();
  quad(a: Point,b: Point,c: Point,d: Point,ink: string,shade=1) {
    this.tint.set(ink).multiplyScalar(shade);
    for(const p of [a,b,c,a,c,d]) {
      this.positions.push(...p); this.colors.push(this.tint.r,this.tint.g,this.tint.b);
    }
  }
  box(x:number,y:number,z:number,w:number,h:number,d:number,ink:string) {
    const l=x-w/2,r=x+w/2,b=y-h/2,t=y+h/2,n=z-d/2,f=z+d/2;
    this.quad([l,t,n],[l,t,f],[r,t,f],[r,t,n],ink,1.16);
    this.quad([l,b,f],[r,b,f],[r,t,f],[l,t,f],ink);
    this.quad([r,b,n],[l,b,n],[l,t,n],[r,t,n],ink,.6);
    this.quad([r,b,f],[r,b,n],[r,t,n],[r,t,f],ink,.79);
    this.quad([l,b,n],[l,b,f],[l,t,f],[l,t,n],ink,.66);
    this.quad([l,b,n],[r,b,n],[r,b,f],[l,b,f],ink,.48);
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position',new THREE.Float32BufferAttribute(this.positions,3));
    g.setAttribute('color',new THREE.Float32BufferAttribute(this.colors,3));
    g.computeVertexNormals();g.computeBoundingSphere();return g;
  }
}

function buildDeck(sections: Section[]) {
  const batch=new SurfaceBatch(),bottom=DECK-.46;
  const floor='#34444a',edge='#232d37',apron='#2c373e',low=DECK-.27;
  const reach=(i:number)=>1.15+(i*7%5)*.26;
  for(let i=1;i<sections.length;i++) {
    const a=sections[i-1],b=sections[i];
    const al:Point=[a.left,DECK,a.z],ar:Point=[a.right,DECK,a.z],bl:Point=[b.left,DECK,b.z],br:Point=[b.right,DECK,b.z];
    batch.quad(al,bl,br,ar,floor);
    batch.quad(al,[a.left,bottom,a.z],[b.left,bottom,b.z],bl,edge);
    batch.quad(br,[b.right,bottom,b.z],[a.right,bottom,a.z],ar,edge);
    // Fragments of the substrate continue below the cut; the outer scan dissolves
    // there, not under the inhabited rooms or in their connecting corridors.
    batch.quad([a.left-reach(i-1),low,a.z],[b.left-reach(i),low,b.z],[b.left,low,b.z],[a.left,low,a.z],apron);
    batch.quad([a.right,low,a.z],[b.right,low,b.z],[b.right+reach(i+1),low,b.z],[a.right+reach(i),low,a.z],apron);
    if(i===1) batch.quad(ar,[a.right,bottom,a.z],[a.left,bottom,a.z],al,edge);
    if(i===sections.length-1) {
      batch.quad(bl,[b.left,bottom,b.z],[b.right,bottom,b.z],br,edge);
      batch.quad([b.left,low,b.z],[b.left+.55,low,b.z+1.55],[b.right-.55,low,b.z+1.55],[b.right,low,b.z],apron);
    }
  }
  const geometry=batch.geometry(),p=geometry.getAttribute('position'),clearance:number[]=[];
  // Widths differ by row and interpolate across the same two triangles as the slab.
  const byZ=new Map(sections.map(s=>[Math.fround(s.z),s]));
  for(let i=0;i<p.count;i++) {
    const section=byZ.get(p.getZ(i))??sections[sections.length-1];
    clearance.push(p.getX(i)-section.left,section.right-p.getX(i));
  }
  geometry.setAttribute('aSideDistance',new THREE.Float32BufferAttribute(clearance,2));return geometry;
}

// A stamped, stationary extraction grille. A few face strips give it a real
// silhouette at room scale without another primitive, material or moving part.
function extractor(bay: SurfaceBatch,x: number,y: number,z: number) {
  const point=(r:number,a:number,offset=0):Point=>[x+offset,y+r*Math.cos(a),z+r*Math.sin(a)];
  for(let i=0;i<12;i++) {
    const a=i*Math.PI/6,b=(i+1)*Math.PI/6;
    bay.quad(point(.52,a),point(.52,b),point(.42,b),point(.42,a),i<6?'#51616a':'#384850');
    if(i%2===0)bay.quad(point(.40,a,.012),point(.40,a+.54,.012),point(.10,a+1.0,.012),point(.10,a+.38,.012),'#3b4c55');
  }
}

function accessCover(bay: SurfaceBatch,x:number,z:number,w:number,d:number) {
  const y=.019,l=x-w/2,r=x+w/2,b=z-d/2,f=z+d/2,cut=.11;
  bay.quad([l+cut,y,b],[l,y,b+cut],[r,y,b+cut],[r-cut,y,b],'#465358');
  bay.quad([l,y,b+cut],[l,y,f-cut],[r,y,f-cut],[r,y,b+cut],'#344249');
  bay.quad([l,y,f-cut],[l+cut,y,f],[r-cut,y,f],[r,y,f-cut],'#29363b');
  for(const xx of [l+.16,r-.16])for(const zz of [b+.14,f-.14])
    bay.quad([xx-.045,.035,zz-.025],[xx-.045,.035,zz+.025],[xx+.045,.035,zz+.025],[xx+.045,.035,zz-.025],'#66716f');
  bay.box(x,.027,z,w*.34,.018,.105,'#202e34');
}

// The high masonry and services belong to the two far faces of the cutaway.
// Elsewhere, only low kickplates under the room glass interrupt the sightline.
function buildServices(sections: Section[], rooms: readonly Footprint[], lights: InteriorLighting) {
  const bay=new SurfaceBatch();
  if(!sections.length)return bay.geometry();
  const back=sections[0],left=back.left+.32,right=back.right-.34,length=right-left,z=back.z+.39;
  const cement='#374349', steel='#49575d', jamb='#536067', recess='#222c31', graphite='#28363d';
  const box=bay.box.bind(bay);
  // Asymmetric height breaks and a continuous footing, not a row of lamps or freestanding frames.
  box((left+right)/2,.17,z+.07,length,.35,.68,graphite);
  const stops=[0,.18,.51,.7,.94,1],heights=[3.05,3.65,2.64,3.24,1.94];
  for(let i=0;i<heights.length;i++) {
    const x=left+length*(stops[i]+stops[i+1])/2,w=length*(stops[i+1]-stops[i]),h=heights[i];
    box(x,h/2,z,w-.035,h,.4,i%2?cement:graphite);
    box(x,h-.055,z+.02,w-.055,.12,.49,steel);
    if(i<heights.length-1)box(x-w/2+.14,h*.48,z+.17,.22,h*.96,.28,steel);
  }
  // Inset goods hatch: thick lintel, shutter, raised jambs and a threshold.
  const hatch=left+length*.36,hw=Math.min(4.65,length*.25);
  box(hatch,1.44,z+.245,hw+.43,2.88,.18,recess);
  box(hatch,1.38,z+.34,hw,2.55,.08,'#3b484b');
  for(let j=0;j<6;j++)box(hatch,.38+j*.385,z+.39,hw-.1,.055,.055,graphite);
  for(const s of [-1,1])box(hatch+s*(hw/2+.14),1.45,z+.37,.18,2.9,.38,jamb);
  box(hatch,2.95,z+.38,hw+.6,.22,.52,steel);
  box(hatch,.082,z+.64,hw+.62,.17,.92,steel);
  const tube=Math.min(2.55,hw*.70);
  lights.hatch.set(hatch,3.09,z+.69);
  box(hatch,3.17,z+.47,tube+.32,.24,.47,graphite);
  box(hatch,3.09,z+.69,tube,.115,.15,'#ac8454');
  for(const s of [-1,1])box(hatch+s*tube*.34,3.09,z+.73,.055,.15,.15,steel);

  // Upper cable tray turns down into a louvred heat exchanger.
  const plant=left+length*.79,pw=Math.min(3.9,length*.19);
  box(plant,1.22,z+.38,pw+.32,2.44,.62,steel);
  box(plant,1.31,z+.71,pw-.12,1.72,.13,recess);
  for(let i=0;i<5;i++)box(plant,.66+i*.30,z+.81,pw-.33,.11,.17,steel);
  const start=left+length*.51,end=plant-pw*.42;
  for(const y of [2.21,2.48]) {
    box((start+end)/2,y,z+.31,end-start,.10,.17,jamb);
    box(end,y-.25,z+.31,.12,.59,.17,jamb);
  }
  // The return ends before the near corner. It steps down from a cable gallery to a sill.
  const side=back.left+.37,run=Math.min(15,sections[2].z-back.z-.42);
  for(const [a,b,h] of [[0,.41,3.18],[.41,.72,2.32],[.72,1,1.22]]) {
    const mid=z+(a+b)*run/2,d=(b-a)*run;
    box(side,h/2,mid,.43,h,d-.035,cement);box(side+.04,h-.045,mid,.54,.11,d-.05,steel);
  }
  for(const y of [.51,.77])box(side+.25,y,z+run*.46,.17,.11,run*.85,jamb);
  box(side+.29,1.36,z+run*.30,.48,2.72,1.77,graphite);
  box(side+.54,1.44,z+run*.30,.06,1.9,1.38,steel);
  box(side+.59,2.05,z+run*.30,.055,.07,.70,'#567f89');
  box(side+.59,1.26,z+run*.30,.065,1.17,1.15,recess);
  extractor(bay,side+.64,1.26,z+run*.30);

  for(const room of rooms) {
    const rz=room.z-room.depth/2-.12,w=room.width;
    for(const [lo,hi] of [[-.49,-.18],[-.14,.48]]) {
      const x=room.x+w*(lo+hi)/2,span=w*(hi-lo);
      box(x,.30,rz,span,.60,.30,graphite);box(x,.61,rz,span,.065,.34,steel);
    }
  }
  // A low relay at the last threshold gives the foreground a second, smaller practical.
  const front=rooms.reduce((a,b)=>a.z+a.depth/2>=b.z+b.depth/2?a:b);
  const px=front.x-front.width/2+.55,pz=front.z-front.depth/2+.08;
  lights.relay.set(px,1.17,pz+.38);
  lights.trench.set(front.x,front.z-front.depth/2-.40);
  box(px,.66,pz,1.12,1.32,.64,graphite);box(px,1.33,pz,1.20,.12,.69,steel);
  box(px,.94,pz+.34,.92,.56,.11,recess);box(px,1.17,pz+.38,.77,.12,.12,'#a78054');
  box(px,.17,pz+.06,1.28,.32,.84,steel);
  const rows=[...new Set(rooms.map(r=>r.z))].sort((a,b)=>a-b);
  if(rows.length>=3)accessCover(bay,front.x+1.8,(rows.at(-2)!+rows.at(-3)!)/2,2.12,1.12);
  accessCover(bay,front.x+front.width*.23,front.z+front.depth*.32,1.34,1.48);
  return bay.geometry();
}

export function createCampusInterior(rooms: readonly Footprint[]) {
  const group=new THREE.Group();group.name='inhabited-campus';
  const sections=floorSections(rooms),deck=buildDeck(sections);
  const lights:InteriorLighting={hatch:new THREE.Vector3(0,-100,0),relay:new THREE.Vector3(0,-100,0),depth:new THREE.Vector2(sections[0]?.z??0,sections.at(-1)?.z??0),trench:new THREE.Vector2()};
  const services=buildServices(sections,rooms,lights);
  const floor=new THREE.Mesh(deck,interiorSurface(lights,true));floor.name='contact-deck';group.add(floor);
  const shell=new THREE.Mesh(services,interiorSurface(lights,false));shell.name='service-shell';group.add(shell);
  let disposed=false;
  return {group,dispose(){
    if(disposed)return;disposed=true;group.removeFromParent();group.clear();
    deck.dispose();services.dispose();floor.material.dispose();shell.material.dispose();
  }};
}
