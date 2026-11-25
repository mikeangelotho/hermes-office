import type { IncomingMessage, ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';
import type { OfficeAgent, OfficeSnapshot } from '../src/domain/types.ts';

interface MiddlewareOptions { collect: () => Promise<unknown>; now?: () => number; }
type Next = (error?: unknown) => void;
const LOCAL_HOST = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i;
const SOURCE = 'Local Hermes status bridge';
const ACTIVITIES = new Set([
  'Current turn lease or fresh running worker observed.',
  'Fresh profile backend; no observed active turn.',
  'New work paused by ESTOP.',
  'No fresh runtime evidence; status uncertain.',
  'Current turn continues; new work paused by ESTOP.',
  'Native profile readable; no verified in-flight work.',
  'Stale or unverified runtime claims; activity uncertain.',
  'Runtime status unavailable; activity unverified.',
]);
const WARNINGS = new Set([
  'Input-waiting and blocked states are not inferred from stored messages.',
  'Hermes status storage is unavailable.',
  'Some profiles have no fresh runtime evidence; offline means uncertain.',
  'Some status stores could not be read; results are partial.',
  'Roster limit reached; additional profiles are not shown.',
  'Read time limit reached; some statuses are uncertain.',
  'New work is paused; existing turns are not stopped by ESTOP.',
  'Some backend metadata could not be verified; availability is uncertain.',
  'Some active-session totals are unavailable; no history-based estimate is used.',
  'Active-session counts include only verified in-flight work; retained chats and open windows are excluded.',
]);
const TEAMS: Record<string, string> = {studio: 'studio', dev: 'development', game: 'game', science: 'science'};

function ensure(condition: unknown): asserts condition {
  if (!condition) throw new Error('Invalid status snapshot');
}
function object(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  ensure(typeof value === 'object' && value !== null && !Array.isArray(value));
  const record = value as Record<string, unknown>;
  ensure(required.every(key => Object.hasOwn(record, key)));
  ensure(Object.keys(record).every(key => required.includes(key) || optional.includes(key)));
  return record;
}
function iso(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value)
    && Number.isFinite(Date.parse(value));
}
function label(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 80
    && !/[\\/:<>{}\[\]@\p{C}\p{Zl}\p{Zp}]/u.test(value);
}

/** Fail closed, then construct a fresh allowlisted object; never proxy stdout verbatim. */
export function validateSnapshot(value: unknown): OfficeSnapshot {
  const root = object(value, ['schemaVersion', 'mode', 'source', 'observedAt', 'pollIntervalMs', 'sourceHealth', 'agents', 'warnings']);
  ensure(root.schemaVersion === 1 && root.mode === 'live' && root.source === SOURCE && root.pollIntervalMs === 30000);
  ensure(iso(root.observedAt) && ['connected', 'degraded', 'unavailable'].includes(root.sourceHealth as string));
  ensure(Array.isArray(root.agents) && root.agents.length <= 128);
  ensure(Array.isArray(root.warnings) && root.warnings.length <= 12 && root.warnings.every(w => typeof w === 'string' && WARNINGS.has(w)));
  const ids = new Set<string>();
  const agents = root.agents.map((value): OfficeAgent => {
    const row = object(value, ['id', 'name', 'role', 'team', 'state', 'observedAt', 'activity'], ['lastActiveAt', 'activeSessions']);
    ensure(typeof row.id === 'string' && row.id.length <= 64 && /^(?:default|(?:studio|dev|game|science)-[a-z0-9]+(?:-[a-z0-9]+)*)$/.test(row.id));
    ensure(!ids.has(row.id)); ids.add(row.id);
    const isDefault = row.id === 'default';
    ensure(label(row.name) && label(row.role));
    ensure(isDefault ? row.name === 'Hermes' && row.role === 'General assistant' && row.team === 'general'
      : TEAMS[row.id.split('-')[0]] === row.team);
    ensure(['working', 'idle', 'waiting', 'blocked', 'paused', 'offline'].includes(row.state as string));
    if (Object.hasOwn(row, 'activeSessions')) {
      ensure(isDefault && typeof row.activeSessions === 'number' && Number.isInteger(row.activeSessions)
        && row.activeSessions >= 0 && row.activeSessions <= 10000);
      ensure(row.activeSessions === 0 || row.state === 'working');
    }
    ensure(row.observedAt === root.observedAt && (row.lastActiveAt === undefined || row.lastActiveAt === null || iso(row.lastActiveAt)));
    ensure(typeof row.activity === 'string' && ACTIVITIES.has(row.activity));
    return {
      id: row.id, name: row.name, role: row.role, team: row.team as OfficeAgent['team'],
      state: row.state as OfficeAgent['state'], observedAt: row.observedAt as string,
      ...(Object.hasOwn(row, 'lastActiveAt') ? {lastActiveAt: row.lastActiveAt as string | null} : {}), activity: row.activity,
      ...(Object.hasOwn(row, 'activeSessions') ? {activeSessions: row.activeSessions as number} : {}),
    };
  });
  return {
    schemaVersion: 1, mode: 'live', source: SOURCE, observedAt: root.observedAt,
    pollIntervalMs: 30000, sourceHealth: root.sourceHealth as OfficeSnapshot['sourceHealth'],
    agents, warnings: [...root.warnings] as string[],
  };
}

function unavailable(): OfficeSnapshot {
  return {schemaVersion: 1, mode: 'live', source: SOURCE, observedAt: new Date().toISOString(),
    pollIntervalMs: 30000, sourceHealth: 'unavailable', agents: [], warnings: ['Hermes status storage is unavailable.']};
}

function localOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  try {
    const url = new URL(origin);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      && url.pathname === '/' && !url.search && !url.hash;
  } catch { return false; }
}

export function createOfficeMiddleware(options: MiddlewareOptions) {
  const now = options.now ?? Date.now;
  type Entry = { status: number; value: OfficeSnapshot; expiresAt: number };
  let cached: Entry | undefined;
  let inflight: Promise<Entry> | undefined;
  const collect = (): Promise<Entry> => {
    if (cached && now() < cached.expiresAt) return Promise.resolve(cached);
    if (inflight) return inflight;
    inflight = Promise.resolve().then(options.collect).then(validateSnapshot)
      .then(value => ({ status: 200, value, expiresAt: now() + 5000 }))
      .catch(() => ({ status: 503, value: unavailable(), expiresAt: now() + 5000 }))
      .then(entry => { cached = entry; return entry; })
      .finally(() => { inflight = undefined; });
    return inflight;
  };
  return (request: IncomingMessage, response: ServerResponse, next: Next): void => {
    if (request.url?.split('?')[0] !== '/api/office') { next(); return; }
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const reject = (status: number, error: string) => {
      response.statusCode = status; response.end(JSON.stringify({error}));
    };
    if (request.method !== 'GET') {
      response.setHeader('Allow', 'GET'); reject(405, 'Only GET is supported.'); return;
    }
    if (!LOCAL_HOST.test(request.headers.host ?? '') || !localOrigin(request.headers.origin)
        || request.headers['sec-fetch-site'] === 'cross-site') {
      reject(403, 'Only local requests are supported.'); return;
    }
    if (request.url?.includes('?')) { reject(400, 'Query parameters are not supported.'); return; }
    void collect().then(entry => {
      if (response.destroyed) return;
      response.statusCode = entry.status;
      response.end(JSON.stringify(entry.value));
    });
  };
}

/** Node-only plugin: it is never bundled into the browser or hero scene. */
export function officeApiPlugin(): Plugin {
  let root = process.cwd();
  const collect = () => new Promise<unknown>((resolveResult, reject) => {
    execFile(process.env.PYTHON_BIN || 'python3', ['-B', resolve(root, 'bridge/collect.py')], {
      cwd: root, timeout: 8000, maxBuffer: 256 * 1024, encoding: 'utf8', windowsHide: true,
    }, (error, stdout) => {
      if (error) { reject(new Error('Status collector unavailable')); return; }
      try { resolveResult(JSON.parse(stdout)); } catch { reject(new Error('Invalid status response')); }
    });
  });
  const middleware = createOfficeMiddleware({ collect });
  return {
    name: 'office-hours-local-readonly-bridge',
    configResolved(config) { root = config.root; },
    configureServer(server) { server.middlewares.use(middleware); },
    configurePreviewServer(server) { server.middlewares.use(middleware); },
  };
}

