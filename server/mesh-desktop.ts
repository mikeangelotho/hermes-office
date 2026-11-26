import http, { type IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { finished } from 'node:stream/promises';
import { parseTraceWindow } from '../src/domain/trace.ts';
import { validateSnapshot } from './office-api.ts';

export type DesktopSelection = 'live' | 'history' | readonly ['end' | 'after', number];
const snapshotLimit = 256 * 1024, historyLimit = 12 * 1024 * 1024;

function exchange(agent: http.Agent, signal: AbortSignal, path: string, pinned?: Socket) {
  return new Promise<{message: IncomingMessage; socket: Socket; request: http.ClientRequest}>((resolve, reject) => {
    const request = http.request({hostname: '127.0.0.1', port: 3002, agent, signal, path,
      method: pinned ? 'GET' : 'HEAD', headers: {Accept: pinned ? 'application/json' : 'text/html', 'Accept-Encoding': 'identity'},
      maxHeaderSize: 16 * 1024,
    }, message => resolve({message, socket: message.socket, request}));
    request.maxHeadersCount = 0; // No silent truncation within maxHeaderSize.
    request.once('error', reject);
    request.once('close', () => reject(new Error('Desktop disconnected')));
    // Do not send even a GET if the checked desktop connection has been replaced.
    request.once('socket', socket => {
      if (pinned && socket !== pinned) request.destroy(new Error('Desktop disconnected'));
      else request.end();
    });
  });
}

function expectType(res: IncomingMessage, mime: string) {
  const types = res.headersDistinct['content-type'];
  if (res.statusCode !== 200 || types?.length !== 1 || types[0].split(';', 1)[0].trim().toLowerCase() !== mime) {
    throw new Error('Unexpected desktop response');
  }
}
async function project(res: IncomingMessage, live: boolean) {
  expectType(res, 'application/json');
  const limit = live ? snapshotLimit : historyLimit;
  if (Number(res.headers['content-length']) > limit) throw new Error('Desktop response too large');
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of res) {
    bytes += chunk.length;
    if (bytes > limit) throw new Error('Desktop response too large');
    chunks.push(chunk);
  }
  const value = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(Buffer.concat(chunks, bytes)));
  return live ? validateSnapshot(value) : parseTraceWindow(value);
}

/** A fresh direct connection per read, no global proxy agent, redirects or inbound headers. */
export async function readDesktop(selection: DesktopSelection, signal: AbortSignal) {
  const agent = new http.Agent({keepAlive:true, maxSockets:1, maxFreeSockets:1});
  try {
    const {message: page, socket, request} = await exchange(agent, signal, '/');
    expectType(page, 'text/html');
    const signatures = page.headersDistinct['x-hermes-office-desktop'];
    if (signatures?.length !== 1 || signatures[0] !== 'office-hours-desktop-v1') throw new Error('Unrecognized desktop');
    // Vite may omit Content-Length on HEAD. Node then marks even an explicitly
    // persistent response non-reusable; HEAD has no body to delimit.
    if (page.httpVersion === '1.1' && page.headers.connection?.toLowerCase() === 'keep-alive'
        && page.headers['content-length'] === undefined && page.headers['transfer-encoding'] === undefined) request.shouldKeepAlive = true;
    if (!request.shouldKeepAlive) throw new Error('Desktop disconnected');
    page.resume(); await finished(page, {cleanup:true});
    if (!socket || socket.destroyed) throw new Error('Desktop disconnected');
    const live = selection === 'live';
    const path = live ? '/api/office' : '/api/office/history' + (selection === 'history' ? '' : `?${selection[0]}=${selection[1]}`);
    const {message} = await exchange(agent, signal, path, socket);
    return await project(message, live);
  } finally { agent.destroy(); }
}
