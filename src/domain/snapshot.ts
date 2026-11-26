import type { AgentState, OfficeAgent, OfficeParticipant, OfficeSnapshot, Team } from './types.ts';
const states = new Set(['working', 'idle', 'waiting', 'blocked', 'paused', 'offline']);
const teams = new Set(['general', 'studio', 'development', 'game', 'science']);
const record = (value: unknown): Record<string, unknown> => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid status payload'); return value as Record<string, unknown>; };
const text = (value: unknown, max = 160): string => { if (typeof value !== 'string' || !value.length || value.length > max) throw new Error('Invalid status field'); return value; };
const date = (value: unknown): string => { const result = text(value, 48); if (!Number.isFinite(Date.parse(result))) throw new Error('Invalid observation time'); return result; };

const rosterLimit = 128;
const participantKey = (value: unknown): value is string => typeof value === 'string' && /^p-[a-f0-9]{32}$/.test(value);
const requiredParticipantFields = ['id', 'kind', 'profileId', 'name', 'role', 'team', 'state', 'activity', 'observedAt'];
const participantFields = new Set([...requiredParticipantFields, 'parentId', 'lastActiveAt']);
const isoStamp = (value: unknown): value is string => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value) && Number.isFinite(Date.parse(value));

/** Shared by the loopback boundary and browser; reconstruct rows rather than forwarding collector data. */
export function participantDetails(root: Record<string, unknown>, agents: OfficeAgent[], observedAt: string): Pick<OfficeSnapshot, 'participants'> {
  if (!Object.hasOwn(root, 'participants')) return {};
  const input = root.participants;
  if (!Array.isArray(input) || input.length > rosterLimit || (input.length && root.sourceHealth === 'unavailable')) throw new Error('Invalid participant roster');
  const profiles = new Map(agents.map(a => [a.id, a]));
  const counts = new Map<string, number>();
  const byId = new Map<string, OfficeParticipant>();
  for (const raw of input) {
    const row = record(raw);
    if (!requiredParticipantFields.every(k => Object.hasOwn(row, k)) || Object.keys(row).some(k => !participantFields.has(k))) throw new Error('Invalid participant fields');
    const {id, kind, profileId} = row;
    const hasParent = Object.hasOwn(row, 'parentId'), hasLastActive = Object.hasOwn(row, 'lastActiveAt');
    const parentId = hasParent ? row.parentId : undefined, lastActiveAt = hasLastActive ? row.lastActiveAt : undefined;
    const profile = typeof profileId === 'string' ? profiles.get(profileId) : undefined;
    if (!profile || profile.state !== 'working' || profile.observedAt !== observedAt || !isoStamp(observedAt)
        || (kind !== 'session' && kind !== 'subagent') || !participantKey(id) || profiles.has(id) || byId.has(id)
        || (hasParent && !participantKey(parentId))) throw new Error('Invalid participant identity');
    const title = kind === 'session' ? 'Session' : 'Subagent';
    const name = `${title} ${id.slice(2, 8).toUpperCase()}`;
    const role = kind === 'session' ? 'Active session' : 'Delegated subagent';
    const activity = 'Verified in-flight work.';
    if (row.name !== name || row.role !== role || row.activity !== activity || row.state !== 'working'
        || row.team !== profile.team || row.observedAt !== observedAt ||
        (hasLastActive && lastActiveAt !== null && !isoStamp(lastActiveAt))) throw new Error('Invalid participant fields');
    const count = (counts.get(profile.id) ?? 0) + 1;
    if (profile.activeSessions !== undefined && count > profile.activeSessions) throw new Error('Invalid participant count');
    counts.set(profile.id, count);
    byId.set(id, {id, kind, profileId: profile.id, name, role, activity, state: 'working', team: profile.team, observedAt,
      ...(typeof parentId === 'string' ? {parentId} : {}),
      ...(typeof lastActiveAt === 'string' || lastActiveAt === null ? {lastActiveAt} : {})});
  }
  if (agents.length - counts.size + byId.size > rosterLimit) throw new Error('Invalid replacement roster size');
  for (const [id, count] of counts) {
    const total = profiles.get(id)?.activeSessions;
    if (total !== undefined && total !== count && root.sourceHealth === 'connected') throw new Error('Incomplete participant coverage');
  }
  // Order-independent: a nested delegation is valid; self, cycles, absent and cross-profile parents are not.
  const checked = new Set<string>();
  for (const row of byId.values()) {
    let cursor = row;
    const path = new Set<string>();
    while (cursor.parentId && !checked.has(cursor.id)) {
      const parent = byId.get(cursor.parentId);
      if (!parent || parent.profileId !== row.profileId || path.has(cursor.id)) throw new Error('Invalid participant relationship');
      path.add(cursor.id);
      cursor = parent;
    }
    for (const id of path) checked.add(id);
  }
  return {participants: [...byId.values()]};
}

export function parseSnapshot(input: unknown): OfficeSnapshot {
  const value = record(input);
  if (value.schemaVersion !== 1 || !['live', 'demo'].includes(String(value.mode)) || !['connected', 'degraded', 'unavailable'].includes(String(value.sourceHealth))) throw new Error('Unsupported status schema');
  if (!Array.isArray(value.agents) || value.agents.length > rosterLimit || !Array.isArray(value.warnings) || value.warnings.length > 64) throw new Error('Invalid roster');
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
  const observedAt = date(value.observedAt);
  return { schemaVersion: 1, mode: value.mode as OfficeSnapshot['mode'], source: text(value.source), sourceHealth: value.sourceHealth as OfficeSnapshot['sourceHealth'], observedAt, pollIntervalMs: interval, agents, warnings: value.warnings.map(w => text(w, 300)),
    ...participantDetails(value, agents, observedAt) };
}
