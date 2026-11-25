import type { AgentState, OfficeAgent, OfficeSnapshot, Team } from './types.ts';
const teams: { team: Team; prefix: string; roles: [string, string][] }[] = [
  { team: 'studio', prefix: 'studio', roles: [['lead', 'Studio lead'], ['designer', 'Brand designer'], ['engineer', 'Interactive engineer'], ['motion', 'Motion designer'], ['indesign', 'Print designer'], ['campaign', 'Campaign strategist'], ['email', 'Email producer'], ['quality', 'Quality engineer']] },
  { team: 'development', prefix: 'dev', roles: [['lead', 'Development lead'], ['architect', 'Software architect'], ['experience', 'Product designer'], ['web', 'Frontend engineer'], ['services', 'Backend engineer'], ['native', 'Systems engineer'], ['embedded', 'Embedded engineer'], ['platform', 'Reliability engineer'], ['security', 'Security engineer'], ['quality', 'Quality engineer']] },
  { team: 'game', prefix: 'game', roles: [['lead', 'Game director'], ['design', 'Game designer'], ['experience', 'Experience designer'], ['engineer', 'Gameplay engineer'], ['art', 'Environment artist'], ['character', 'Character artist'], ['motion', 'Animator'], ['audio', 'Sound designer'], ['platform', 'Platform engineer'], ['quality', 'Game tester']] },
  { team: 'science', prefix: 'science', roles: [['producer', 'Science producer'], ['researcher', 'Researcher'], ['studio', 'Visual storyteller'], ['reviewer', 'Scientific reviewer']] },
];
const pattern: AgentState[] = ['working', 'working', 'idle', 'working', 'idle', 'waiting', 'working', 'idle', 'blocked', 'paused'];
export function demoSnapshot(step = 0): OfficeSnapshot {
  const observedAt = new Date().toISOString();
  const agents: OfficeAgent[] = teams.flatMap(t => t.roles.map(([id, role], i) => ({
    id: `${t.prefix}-${id}`, name: role, role, team: t.team,
    state: pattern[(i + step) % pattern.length], observedAt,
    activity: 'Simulated activity. This is not a live agent run.',
  })));
  const generalState = pattern[step % pattern.length];
  agents.unshift({ id: 'default', name: 'Hermes', role: 'General assistant', team: 'general', state: generalState, observedAt, activity: 'Simulated general session. No model request is made.', activeSessions: generalState === 'working' ? 1 : 0 });
  return { schemaVersion: 1, mode: 'demo', source: 'local-simulation', sourceHealth: 'connected', observedAt, pollIntervalMs: 30000, agents, warnings: ['Demo activity is simulated locally; no agents or jobs are started.'] };
}
