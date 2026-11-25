import type { CampusView } from '../scene/campus.ts';
export function presentationFor(search: string, preferred?: string | null): { embedded: boolean; source: 'live' | 'demo'; team: CampusView } {
  const params = new URLSearchParams(search);
  const embedded = params.get('embed') === '1' || ['embedded', 'hero'].includes(params.get('view') ?? '');
  const rawTeam = params.get('team');
  const valid = (value: unknown): value is CampusView => typeof value === 'string' && ['all','general','studio','development','game','science'].includes(value);
  const team: CampusView = valid(rawTeam) ? rawTeam : !embedded && valid(preferred) ? preferred : 'all';
  return { embedded, source: embedded || params.get('source') === 'demo' ? 'demo' : 'live', team };
}
