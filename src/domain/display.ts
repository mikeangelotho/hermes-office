import { effectiveState } from './state.ts';
import type { OfficeAgent, OfficeParticipant, OfficeSnapshot } from './types.ts';

export type Coverage = 'verified' | 'partial' | 'unknown';

function unknownProfile(agent: OfficeAgent): OfficeAgent {
  const { activeSessions: _count, ...identity } = agent;
  return { ...identity, state: 'offline', activity: 'Activity unknown.' };
}

/** One roster for both the canvas and the inspector. Profile facts remain available to Status. */
export function officeDisplay(snapshot: OfficeSnapshot | null, mode: OfficeSnapshot['mode'], now: number, failed: boolean) {
  const source = snapshot?.mode === mode ? snapshot : null;
  const demo = mode === 'demo';
  const bridgeConnected = !demo && !failed && !!source && effectiveState('working', source.observedAt, now) === 'working';
  const current = bridgeConnected && source?.sourceHealth !== 'unavailable';
  const profiles = (source?.agents ?? []).map(agent => demo || (current && effectiveState(agent.state, agent.observedAt, now) !== 'offline') ? agent : unknownProfile(agent));
  const participants = current ? (source?.participants ?? []).filter(person => effectiveState(person.state, person.observedAt, now) !== 'offline') : [];
  const byProfile = new Map<string, OfficeParticipant[]>();
  for (const person of participants) {
    const list = byProfile.get(person.profileId);
    if (list) list.push(person); else byProfile.set(person.profileId, [person]);
  }
  const agents = profiles.flatMap<OfficeAgent>(profile => byProfile.get(profile.id) ?? [profile]);
  const known = agents.filter(agent => agent.state !== 'offline').length;
  const coverage: Coverage = demo ? 'verified' : !current || !known ? 'unknown'
    : source?.sourceHealth === 'degraded' || known !== agents.length ? 'partial' : 'verified';
  return { profiles, agents, participants, coverage, bridgeConnected };
}

/** A zero needs complete evidence; with partial coverage only positive lower bounds are known. */
export function qualifiedCount(coverage: Coverage, count?: number): string | null {
  if (count === undefined || coverage === 'unknown' || (coverage === 'partial' && count === 0)) return null;
  return coverage === 'partial' ? `At least ${count}` : String(count);
}

export function workingLabel(coverage: Coverage, count: number): string {
  const label = qualifiedCount(coverage, count);
  return label === null ? 'Activity unknown' : `${label} working`;
}

export function participantFacts(id: string | null, participants: OfficeParticipant[], profiles: OfficeAgent[]) {
  const person = participants.find(row => row.id === id);
  if (!person) return null;
  // Keys join observations; they are never a substitute for a missing display label.
  const parent = participants.find(row => row.id === person.parentId);
  return {
    kind: person.kind === 'subagent' ? 'Subagent' : 'Session',
    profile: profiles.find(row => row.id === person.profileId)?.name ?? 'Not observed',
    parent: person.parentId || person.kind === 'subagent' ? parent?.name ?? 'Not observed' : null,
    children: participants.filter(row => row.parentId === person.id).length,
  };
}
