import type { IncomingMessage, ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { TLSSocket } from 'node:tls';
import { BlockList, isIP } from 'node:net';
import { resolveOfficePython } from './python-runtime.ts';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';
import type { OfficeAgent, OfficeSnapshot } from '../src/domain/types.ts';
import { participantDetails } from '../src/domain/snapshot.ts';
import type { HistoryQuery, ReadHistory } from './history.ts';

interface MiddlewareOptions { collect: () => Promise<unknown>; now?: () => number; readHistory?: ReadHistory; }
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
  'Some participant details are unavailable; the roster may show aggregate or partial activity.',
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
  const root = object(value, ['schemaVersion', 'mode', 'source', 'observedAt', 'pollIntervalMs', 'sourceHealth', 'agents', 'warnings'], ['participants']);
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
    ...participantDetails(root, agents, root.observedAt),
  };
}

function unavailable(): OfficeSnapshot {
  return {schemaVersion: 1, mode: 'live', source: SOURCE, observedAt: new Date().toISOString(),
    pollIntervalMs: 30000, sourceHealth: 'unavailable', agents: [], warnings: ['Hermes status storage is unavailable.']};
}

/** Separate browser origins remain separate even if they are both on this computer. */
export function permitsOfficeRead(host: string | undefined, origin: string | undefined, site: string | string[] | undefined, secure: boolean): boolean {
  if (!host || !LOCAL_HOST.test(host)) return false;
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return false;
  try {
    const expected = new URL(`${secure ? 'https' : 'http'}://${host}`).origin;
    return origin === undefined || origin === expected;
  } catch { return false; }
}

const loopback = new BlockList();
loopback.addSubnet('127.0.0.0', 8, 'ipv4');
loopback.addAddress('::1', 'ipv6');
function reject(response: ServerResponse, status: number, error: string) {
  response.statusCode = status; response.end(JSON.stringify({error}));
}
function privateRead(request: IncomingMessage, response: ServerResponse) {
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET'); reject(response,405,'Only GET is supported.'); return false;
  }
  // Never substitute Host, Origin or forwarding metadata for the transport peer.
  const peer = request.socket.remoteAddress, family = peer && isIP(peer);
  if (!peer || !family || !loopback.check(peer, family === 4 ? 'ipv4' : 'ipv6') ||
      !permitsOfficeRead(request.headers.host, request.headers.origin, request.headers['sec-fetch-site'],
        request.socket instanceof TLSSocket && request.socket.encrypted === true)) {
    reject(response,403,'Only local requests are supported.'); return false;
  }
  return true;
}

export function createHistoryMiddleware(read?: ReadHistory, now=Date.now) {
  return (request: IncomingMessage, response: ServerResponse, next: Next): void => {
    const path = '/api/office/history', url = request.url ?? '';
    if (url !== path && !url.startsWith(path+'?')) { next(); return; }
    if (!privateRead(request,response)) return;
    let query:HistoryQuery = {};
    if (url !== path) {
      const match = url.length <= path.length+24 && /^\?(end|after)=(0|[1-9]\d{0,15})$/.exec(url.slice(path.length));
      if (!match || Number(match[2]) > 8_640_000_000_000_000) {reject(response,400,'Invalid recording range.');return;}
      query = match[1]==='end' ? {end:Number(match[2])} : {after:Number(match[2])};
    }
    if (!read) {reject(response,503,'Recording is unavailable.');return;}
    try {response.end(JSON.stringify(read(query,now())));}
    catch {reject(response,503,'Recording is unavailable.');}
  };
}

export function createOfficeMiddleware(options: MiddlewareOptions) {
  const now = options.now ?? Date.now;
  const history = createHistoryMiddleware(options.readHistory, now);
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
    if (request.url?.split('?')[0] !== '/api/office') { history(request,response,next); return; }
    if (!privateRead(request,response)) return;
    if (request.url?.includes('?')) {reject(response,400,'Query parameters are not supported.');return;}
    void collect().then(entry => {
      if (response.destroyed) return;
      response.statusCode = entry.status;
      response.end(JSON.stringify(entry.value));
    });
  };
}

export function createBridgeCollector(root: string, recording = false) {
  let python: string | undefined;
  return async (signal?: AbortSignal) => {
    const executable = python ??= await resolveOfficePython();
    signal?.throwIfAborted();
    return new Promise<unknown>((resolveResult, reject) => {
      execFile(executable, ['-I', '-B', resolve(root, 'bridge/collect.py'), ...(recording ? ['--recording'] : [])], {
        cwd: root, signal, timeout: 8000, maxBuffer: 256 * 1024, encoding: 'utf8', windowsHide: true,
      }, (error, stdout) => {
        if (error) { python = undefined; reject(new Error('Status collector unavailable')); return; }
        try { resolveResult(JSON.parse(stdout)); } catch { reject(new Error('Invalid status response')); }
      });
    });
  };
}

/** Normal dev, build and preview do not load or open a history database. */
export function officeApiPlugin(): Plugin {
  return {
    name: 'office-hours-local-readonly-bridge',
    configureServer(server) { server.middlewares.use(createOfficeMiddleware({collect:createBridgeCollector(server.config.root)})); },
    configurePreviewServer(server) { server.middlewares.use(createOfficeMiddleware({collect:createBridgeCollector(server.config.root)})); },
  };
}

