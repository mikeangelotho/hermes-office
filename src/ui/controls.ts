import type { IconName } from '../components/Icon.tsx';
import type { Team } from '../domain/types.ts';
export const PANEL_CONTROLS = [
  { panel: 'team', label: 'Open team', title: 'Team', icon: 'users' },
  { panel: 'view', label: 'Open view controls', title: 'View', icon: 'sliders' },
  { panel: 'status', label: 'Open status', title: 'Status', icon: 'activity' },
  { panel: 'help', label: 'About this space', title: 'About', icon: 'info' },
] as const satisfies readonly { panel: string; label: string; title: string; icon: IconName }[];
export const TEAM_ICONS: Record<Team, IconName> = {
  general: 'message', studio: 'pen', development: 'code', game: 'gamepad', science: 'flask',
};
export const PANEL_TITLES = { team: 'Team', view: 'View', status: 'Status', help: 'About', agent: 'Agent' } as const;
