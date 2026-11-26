// Double-click launcher and `npm run desktop`: only this desktop, only loopback.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { validateSnapshot } from '../server/office-api.ts';
import { resolveOfficePython } from '../server/python-runtime.ts';

const root=fileURLToPath(new URL('../',import.meta.url));
const host='127.0.0.1', signature='office-hours-desktop-v1';
const maxSnapshotBytes = 256 * 1024; // Same upper bound as the local collector's stdout.
let server;
function openBrowser(url) {
  const [program,args]=process.platform==='win32' ? [join(process.env.SystemRoot || 'C:\\Windows','System32','rundll32.exe'),['url.dll,FileProtocolHandler',url]] : process.platform==='darwin' ? ['open',[url]] : ['xdg-open',[url]];
  const child=spawn(program,args,{stdio:'ignore',detached:true,windowsHide:true});
  child.on('error',()=>console.warn(`Open this address in your browser: ${url}`));child.unref();
}

async function startOffice(port) {
  // Python is needed for observations, not for serving the page. Keep a broken override visible.
  try { process.env.PYTHON_BIN = await resolveOfficePython(); }
  catch (error) { console.warn(`Office bridge: ${error.message}`); }
  const {build,preview}=await import('vite').catch(()=>{throw new Error('Cannot load Vite. Install this project’s dependencies with npm ci and try again.');});
  const shared={root,configFile:join(root,'vite.config.ts'),logLevel:'error',build:{outDir:join(root,'.local',`desktop-${port}`)}};
  await build(shared);
  const {desktopHistory}=await import('../server/history-desktop.ts');
  const history=desktopHistory(port);
  server=await preview({...shared,plugins:[history.plugin],preview:{host,port,strictPort:true,open:false,headers:{'X-Hermes-Office-Desktop':signature}}});
  const bound=server.httpServer.address();
  if(!bound || typeof bound==='string' || bound.address!==host || bound.port!==port)throw new Error('Office refused to start on an unexpected network interface.');
  await history.start(server);
  process.once('SIGINT',()=>void server.close());process.once('SIGTERM',()=>void server.close());
}

async function desktopObservations(origin) {
  const signal = AbortSignal.timeout(15_000);
  let body;
  try {
    const response = await fetch(`${origin}/api/office`, {
      headers: {Accept: 'application/json'}, cache: 'no-store', credentials: 'omit', redirect: 'manual', signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      return `unavailable (HTTP ${response.status})`;
    }
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body ?? []) {
      bytes += chunk.byteLength;
      if (bytes > maxSnapshotBytes) return 'unavailable (snapshot exceeds the size limit)';
      chunks.push(chunk);
    }
    body = Buffer.concat(chunks, bytes);
  } catch {
    return signal.aborted ? 'unavailable (request timed out)' : 'unavailable (request failed)';
  }
  try {
    const payload = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(body));
    if (payload?.mode === 'demo') return 'unavailable (non-live demo snapshot)';
    const {sourceHealth} = validateSnapshot(payload);
    return sourceHealth === 'degraded' ? 'degraded (partial observations)' : sourceHealth;
  } catch {
    return 'unavailable (malformed live snapshot)';
  }
}

async function main() {
  const args=process.argv.slice(2); let port=3002, open=false;
  for(let i=0;i<args.length;i++) {
    if(args[i]==='--open'){open=true;continue;}
    if(args[i]==='--port' && /^[1-9]\d{0,4}$/.test(args[i+1] || '') && Number(args[i+1])<=65535){port=Number(args[++i]);continue;}
    throw new Error('Usage: node scripts/desktop.mjs [--open] [--port 1..65535]');
  }
  const origin=`http://${host}:${port}`, address=`${origin}/?view=ambient`;
  let existing;
  try { existing=await fetch(`${origin}/`,{method:'HEAD',credentials:'omit',redirect:'manual',signal:AbortSignal.timeout(1800)}); }
  catch(e){if(e.cause?.code!=='ECONNREFUSED')throw new Error(`Port ${port} is unavailable or did not answer. No process was stopped.`);}
  if(existing) {
    if(!existing.ok || existing.headers.get('x-hermes-office-desktop')!==signature)throw new Error(`Port ${port} is in use by another service. No process was stopped.`);
  } else await startOffice(port);

  const health = await desktopObservations(origin);
  const guidance = health === 'connected' ? '' : ' See Status; demo data is not substituted.';
  console.log(`${existing ? 'Hermes Office is already running' : 'Hermes Office'}: ${address}`);
  console.log(`Desktop observations: ${health}.${guidance}`);
  if (!existing) console.log(`Bound only to ${host}:${port}. Ctrl+C in the hosting terminal stops Office.`);
  if (open) openBrowser(address);
}
main().catch(async e=>{if(server)await server.close().catch(()=>{});console.error(`Office: ${e.message}`);process.exitCode=1;});
