import type { CampusView } from '../scene/campus.ts';

export function presentationFor(search: string, preferred?: string | null, framed = false) {
  const params = new URLSearchParams(search), views = params.getAll('view');
  const embedded = framed || params.getAll('embed').includes('1') || views.some(view => view === 'embedded' || view === 'hero');
  const ambient = !embedded && views.includes('ambient');
  const source: 'live' | 'demo' = embedded || (!ambient && params.get('source') === 'demo') ? 'demo' : 'live';
  const rawTeam = params.get('team');
  const valid = (value: unknown): value is CampusView => typeof value === 'string' && ['all','general','studio','development','game','science'].includes(value);
  const team: CampusView = valid(rawTeam) ? rawTeam : !embedded && valid(preferred) ? preferred : 'all';
  return { embedded, ambient, source, team };
}
