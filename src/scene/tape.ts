import type { SceneTape } from '../domain/trace.ts';

/** Only the transport has a UTC clock. Never feed an epoch to a shader or integrate a pose from the previous frame. */
export function cursorAt(tape: SceneTape, received: number, now: number): number {
  return tape.atMs + Math.trunc(Math.max(0, now - received) * tape.rate);
}

/** A bounded, continuous scan clock even across midnight and a seek to another year. */
export function scanSeconds(atMs: number): number {
  const period = 4_096_000;
  const within = ((atMs % period) + period) % period;
  return Math.min(within, period - within) / 1000;
}

/** Independent of roster order, seat index, mount time and direction of playback. */
export function actorPhase(id: string): number {
  let seed = 2166136261;
  for (let i = 0; i < id.length; i++) seed = Math.imul(seed ^ id.charCodeAt(i), 16777619);
  return (seed >>> 0) / 0x100000000 * Math.PI * 2;
}
