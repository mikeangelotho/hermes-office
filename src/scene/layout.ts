import { AGENT_HUES } from './palette.ts';
import type { AgentState } from '../domain/types.ts';
export interface Point { x: number; z: number; }
export interface Seat extends Point { rotation: number; kind: 'desk' | 'couch'; index: number; capacity: number; }
export const ROOM = { width: 14.6, depth: 11.6, capacity: 10 } as const;
export function routeFor(start: Seat, end: Seat): Point[] {
  const point = (p: Point): Point => ({ x: p.x, z: p.z });
  if (start.kind === end.kind) return [point(start), point(end)];
  const desk = start.kind === 'desk' ? start : end;
  const couch = start.kind === 'couch' ? start : end;
  const gap = desk.x + 1.27;
  const aisle = desk.capacity <= 5 ? Math.max(2.5, (desk.capacity - 1) * 2.55 / 2 + 1.6) : 6.7;
  const forward: Point[] = [point(couch), { x: couch.x, z: 4.5 }, { x: aisle, z: 4.5 }, { x: aisle, z: 1.85 }, { x: gap, z: 1.85 }, { x: gap, z: desk.z }, point(desk)];
  return start.kind === 'couch' ? forward : forward.reverse();
}
export const AGENT_COLORS = AGENT_HUES;
export function agentColor(id: string): string {
  let hash = 0; for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return AGENT_COLORS[hash % AGENT_COLORS.length];
}
export function seatFor(index: number, state: AgentState, capacity = ROOM.capacity as number): Seat {
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > ROOM.capacity || !Number.isInteger(index) || index < 0 || index >= capacity) throw new RangeError('Room capacity exceeded');
  const working = ['working', 'waiting', 'blocked'].includes(state);
  return working
    ? { x: -(Math.min(5, capacity) - 1) * 2.55 / 2 + (index % 5) * 2.55, z: index < 5 ? -2.15 : 0.75, rotation: Math.PI, kind: 'desk', index, capacity }
    : { x: capacity <= 5 ? -(capacity - 1) * .5 + index : (index < 5 ? -5.7 : 1.7) + (index % 5), z: 3.86, rotation: 0, kind: 'couch', index, capacity };
}
