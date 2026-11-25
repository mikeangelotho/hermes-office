import type { OfficeAgent, Team } from '../domain/types.ts';

export type CampusView = Team | 'all';
export interface WorldBounds { minX: number; maxX: number; minZ: number; maxZ: number; }
export interface CampusRoom { id: string; team: Team; x: number; z: number; width: number; depth: number; capacity: number; agents: OfficeAgent[]; }
export interface Assignment { agent: OfficeAgent; roomId: string; slot: number; }
export const SWARM_ORDER: Team[] = ['studio','development','science','game','general'];
export const ROOM_TITLES: Record<Team,string> = { studio:'Atelier',development:'Systems bay',game:'Play lab',science:'Observatory',general:'Quiet core' };
export const ROOM_REST: Record<Team,string> = { studio:'Lounge',development:'Recharge',game:'Unwind',science:'Levitate',general:'Rest' };
const ANCHORS: Record<Team,[number,number]> = { studio:[-8.5,7.2],development:[-8.5,-7.2],game:[8.5,7.2],science:[8.5,-7.2],general:[0,20] };
export function roomDimensions(capacity: number) {
  return {width:capacity<=5 ? Math.max(6,capacity*2.55+2.3) : 15.05,depth:12.05};
}
export function planCampus(agents: OfficeAgent[]) {
  const rooms: CampusRoom[]=[],assignments: Assignment[]=[];let annex=0;
  for(const team of SWARM_ORDER){
    const members=agents.filter(a=>a.team===team).sort((a,b)=>a.id.localeCompare(b.id));
    for(let start=0;start<Math.max(1,members.length);start+=10){
      const roomAgents=members.slice(start,start+10),capacity=Math.max(1,roomAgents.length);
      const [x,z]=start===0?ANCHORS[team]:[(annex%2?1:-1)*8.5,-21.6-Math.floor(annex++/2)*14.4];
      const id=`${team}-${start/10}`;
      rooms.push({id,team,x,z,capacity,...roomDimensions(capacity),agents:roomAgents});
      roomAgents.forEach((agent,slot)=>assignments.push({agent,roomId:id,slot}));
    }
  }
  return {rooms,assignments,bounds:boundsFor(rooms)};
}
export function boundsFor(rooms: CampusRoom[]): WorldBounds {
  if(!rooms.length)return {minX:-8,maxX:8,minZ:-6,maxZ:6};
  return {minX:Math.min(...rooms.map(r=>r.x-r.width/2)),maxX:Math.max(...rooms.map(r=>r.x+r.width/2)),minZ:Math.min(...rooms.map(r=>r.z-r.depth/2)),maxZ:Math.max(...rooms.map(r=>r.z+r.depth/2))};
}
