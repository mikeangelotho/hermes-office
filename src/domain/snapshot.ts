import type { AgentState, OfficeAgent, OfficeSnapshot, Team } from './types.ts';
const states = new Set(['working', 'idle', 'waiting', 'blocked', 'paused', 'offline']);
const teams = new Set(['general', 'studio', 'development', 'game', 'science']);
const record = (value: unknown): Record<string, unknown> => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid status payload'); return value as Record<string, unknown>; };
const text = (value: unknown, max = 160): string => { if (typeof value !== 'string' || !value.length || value.length > max) throw new Error('Invalid status field'); return value; };
const date = (value: unknown): string => { const result = text(value, 48); if (!Number.isFinite(Date.parse(result))) throw new Error('Invalid observation time'); return result; };
export function parseSnapshot(input: unknown): OfficeSnapshot {
  const value = record(input);
  if (value.schemaVersion !== 1 || !['live', 'demo'].includes(String(value.mode)) || !['connected', 'degraded', 'unavailable'].includes(String(value.sourceHealth))) throw new Error('Unsupported status schema');
  if (!Array.isArray(value.agents) || value.agents.length > 128 || !Array.isArray(value.warnings) || value.warnings.length > 64) throw new Error('Invalid roster');
  const ids = new Set<string>();
  const agents: OfficeAgent[] = value.agents.map(raw => {
    const a = record(raw); const id = text(a.id, 100);
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id) || ids.has(id) || !states.has(String(a.state)) || !teams.has(String(a.team))) throw new Error('Invalid agent identity or state');
    ids.add(id);
    if (a.activeSessions !== undefined && (typeof a.activeSessions !== 'number' || !Number.isSafeInteger(a.activeSessions) || a.activeSessions < 0 || a.activeSessions > 10000)) throw new Error('Invalid session count');
    return { id, name: text(a.name), role: text(a.role, 240), team: a.team as Team, state: a.state as AgentState, observedAt: date(a.observedAt), activity: text(a.activity, 300), ...(a.activeSessions !== undefined ? { activeSessions: a.activeSessions as number } : {}), ...(a.lastActiveAt ? { lastActiveAt: date(a.lastActiveAt) } : {}) };
  });
  const interval = Number(value.pollIntervalMs);
  if (!Number.isFinite(interval) || interval < 1000 || interval > 900000) throw new Error('Invalid refresh interval');
  return { schemaVersion: 1, mode: value.mode as OfficeSnapshot['mode'], source: text(value.source), sourceHealth: value.sourceHealth as OfficeSnapshot['sourceHealth'], observedAt: date(value.observedAt), pollIntervalMs: interval, agents, warnings: value.warnings.map(w => text(w, 300)) };
}
