import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { isMeshIPv4 } from './mesh-address.ts';
import { readDesktop, type DesktopSelection } from './mesh-desktop.ts';

type Asset = {body: Buffer; type: string};
interface MeshViewerOptions {
  host: string;
  assets: ReadonlyMap<string, Asset>;
  interfacePresent: () => boolean;
}

const assetPath = /^(?:\/|\/favicon\.svg|\/assets\/[\w-]+\.(?:js|css))$/;
const uiField = /^(?:view=(?:ambient|editor|standalone|embedded|hero)|embed=[01]|source=(?:live|demo)|team=(?:all|general|studio|development|game|science))$/;
const json = 'application/json; charset=utf-8';

// Unlike req.headers.host, headersDistinct does not silently discard a repeated Host.
function header(req: IncomingMessage, name: string) {
  const values = req.headersDistinct[name];
  return values === undefined ? undefined : values.length === 1 ? values[0] : null;
}
function privateContext(req: IncomingMessage, authority: string) {
  const origin = header(req, 'origin'), site = header(req, 'sec-fetch-site');
  const mode = header(req, 'sec-fetch-mode'), dest = header(req, 'sec-fetch-dest');
  return header(req, 'x-office-read') === '1' && (origin === undefined || origin === `http://${authority}`)
    && (site === undefined || site === 'same-origin' || site === 'none')
    && (mode === undefined || mode === 'same-origin' || mode === 'cors') && (dest === undefined || dest === 'empty');
}
function selection(live: boolean, query: string | undefined): DesktopSelection | null {
  if (query === undefined) return live ? 'live' : 'history';
  if (live || query.length > 22) return null;
  const match = /^(end|after)=(0|[1-9]\d{0,15})$/.exec(query);
  if (!match || Number(match[2]) > 8_640_000_000_000_000) return null;
  return [match[1] === 'end' ? 'end' : 'after', Number(match[2])];
}
function fail(res: ServerResponse, status: number, allow?: string) {
  res.statusCode = status;
  if (allow) res.setHeader('Allow', allow);
  res.setHeader('Content-Type', json);
  res.end(JSON.stringify({error: http.STATUS_CODES[status]}));
}

export function createMeshViewer({host, assets, interfacePresent}: MeshViewerOptions): http.Server {
  if (!isMeshIPv4(host)) throw new Error('Expected a unicast Mesh device IPv4 address.');
  const authority = `${host}:3002`, files = new Map<string, Asset>();
  for (const [path, {body, type}] of assets) {
    if (!assetPath.test(path) || !Buffer.isBuffer(body)) throw new Error('Invalid Mesh UI asset.');
    files.set(path, {body: Buffer.from(body), type});
  }
  function admitted(req: IncomingMessage) {
    const {localAddress, localPort, remoteAddress} = req.socket;
    if (localAddress !== host || localPort !== 3002 || !isMeshIPv4(remoteAddress) || header(req, 'host') !== authority) return false;
    try { return interfacePresent() === true; } catch { return false; }
  }
  async function serveRead(what: DesktopSelection, req: IncomingMessage, res: ServerResponse) {
    const cancel = new AbortController(), onClose = () => cancel.abort();
    res.once('close', onClose);
    try {
      const value = await readDesktop(what, AbortSignal.any([cancel.signal, AbortSignal.timeout(9_000)]));
      if (res.destroyed) return;
      if (!admitted(req)) return fail(res, 403);
      res.setHeader('Content-Type', json); res.end(JSON.stringify(value));
    } catch { if (!res.destroyed) fail(res, 503); }
    finally { res.off('close', onClose); }
  }
  const server = http.createServer({maxHeaderSize: 16 * 1024, headersTimeout: 10_000, requestTimeout: 15_000}, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!admitted(req)) return fail(res, 403);

    // Compare literal origin-form paths. No decoding, normalization, disk lookup or SPA fallback.
    const url = req.url ?? '', i = url.indexOf('?');
    const path = i < 0 ? url : url.slice(0, i), query = i < 0 ? undefined : url.slice(i + 1);
    if (path === '/api/office' || path === '/api/office/history') {
      if (req.method !== 'GET') return fail(res, 405, 'GET');
      if (!privateContext(req, authority)) return fail(res, 403);
      const what = selection(path === '/api/office', query);
      if (!what) return fail(res, 400);
      return void serveRead(what, req, res);
    }
    const asset = files.get(path);
    if (!asset || (query !== undefined && path !== '/')) return fail(res, 404);
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'GET, HEAD');
    if (query && (query.length > 256 || !query.split('&').every(field => uiField.test(field)))) return fail(res, 400);
    if (path === '/') res.setHeader('X-Hermes-Office-Mesh', 'office-mesh-v1');
    res.setHeader('Content-Type', asset.type);
    res.setHeader('Content-Length', asset.body.length);
    res.end(req.method === 'HEAD' ? undefined : asset.body);
  });
  // Bound bytes, not an array prefix: duplicate checks must see every parsed field.
  server.maxHeadersCount = 0;
  return server;
}
