import test from 'node:test';
import assert from 'node:assert/strict';
import type { OfficeAgent, Team } from '../src/domain/types.ts';
const campus = await import('../src/scene/campus.ts').catch(() => ({})) as Record<string, any>;
const teams: Team[] = ['general','studio','development','game','science'];
const fixture = (counts=[1,8,10,10,4]): OfficeAgent[] => teams.flatMap((team,t) => Array.from({length:counts[t]},(_,i)=>({id:`${team}-${i}`,name:`Agent ${i}`,role:'Fixture',team,state:'idle' as const,observedAt:new Date().toISOString(),activity:'Test fixture'})));

test('one campus places every observed agent in its own swarm room without the old ten-agent cap',()=>{
  assert.equal(typeof campus.planCampus,'function','all-swarm campus planner is missing');
  const agents=fixture(), plan=campus.planCampus(agents);
  assert.equal(plan.rooms.length,5);
  assert.equal(plan.assignments.length,33);
  assert.equal(new Set(plan.assignments.map((a:any)=>a.agent.id)).size,agents.length);
  for(const assignment of plan.assignments){
    const room=plan.rooms.find((r:any)=>r.id===assignment.roomId);
    assert.equal(room.team,assignment.agent.team);
    assert.ok(assignment.slot>=0&&assignment.slot<room.capacity);
  }
  for(let i=0;i<plan.rooms.length;i++) for(let j=i+1;j<plan.rooms.length;j++){
    const a=plan.rooms[i],b=plan.rooms[j];
    assert.ok(Math.abs(a.x-b.x)>=(a.width+b.width)/2||Math.abs(a.z-b.z)>=(a.depth+b.depth)/2,`${a.id} overlaps ${b.id}`);
  }
});
