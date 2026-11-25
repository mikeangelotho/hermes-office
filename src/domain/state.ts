import type { AgentState, OfficeAgent } from './types.ts';
export const STALE_AFTER_MS = 120_000;
export function effectiveState(state: AgentState, observedAt: string, now = Date.now()): AgentState {
  const observed = Date.parse(observedAt);
  return !Number.isFinite(observed) || now - observed > STALE_AFTER_MS || observed - now > 60_000 ? 'offline' : state;
}
/** Expired observations must lose both their pose and their live-session count. */
export function effectiveAgent(agent: OfficeAgent, now = Date.now()): OfficeAgent {
  const observed = Date.parse(agent.observedAt);
  if (Number.isFinite(observed) && now - observed <= STALE_AFTER_MS && observed - now <= 60_000) return agent;
  const { activeSessions: _expired, ...identity } = agent;
  return { ...identity, state: 'offline' };
}

