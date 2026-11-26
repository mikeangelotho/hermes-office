export type Team = 'general' | 'studio' | 'development' | 'game' | 'science';
export type AgentState = 'working' | 'idle' | 'waiting' | 'blocked' | 'paused' | 'offline';
export interface OfficeAgent {
  id: string;
  name: string;
  role: string;
  team: Team;
  state: AgentState;
  observedAt: string;
  lastActiveAt?: string | null;
  activity: string;
  /** Verified in-flight sessions only; no session IDs, titles or content. */
  activeSessions?: number;
}
/** One verified in-flight turn, never an additional profile aggregate. The bridge's opaque id is
 * `p-` + 32 lowercase hex digits; the neutral display name is Session/Subagent + its first six
 * uppercase digits. A parentId refers to another participant in this observation and profile. */
export interface OfficeParticipant extends OfficeAgent {
  kind: 'session' | 'subagent';
  profileId: string;
  parentId?: string;
}
export interface OfficeSnapshot {
  schemaVersion: 1;
  mode: 'live' | 'demo';
  source: string;
  observedAt: string;
  pollIntervalMs: number;
  sourceHealth: 'connected' | 'degraded' | 'unavailable';
  agents: OfficeAgent[];
  /** Detail for the corresponding aggregate profiles; not additional workers to count with them. */
  participants?: OfficeParticipant[];
  warnings: string[];
}
export const TEAM_LABELS: Record<Team, string> = {
  general: 'General sessions', studio: 'Creative studio', development: 'Development', game: 'Game studio', science: 'Science channel',
};
export const STATE_LABELS: Record<AgentState, string> = {
  working: 'Working', idle: 'On a break', waiting: 'Needs input', blocked: 'Blocked', paused: 'Paused', offline: 'Offline',
};
